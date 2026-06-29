const cheerio = require("cheerio");
const { fetchMal } = require("./mal-fetch");
const {
  resolveImdbIdForAnime,
  lookupCachedImdbId,
  flushImdbCaches,
} = require("./imdb");
const { mapPool } = require("./pool");

const SEASONS = ["winter", "spring", "summer", "fall"];
const SEASON_DISPLAY = {
  winter: "Winter",
  spring: "Spring",
  summer: "Summer",
  fall: "Fall",
};

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const CACHE_TTL_MS = IS_PRODUCTION
  ? 30 * 24 * 60 * 60 * 1000
  : 4 * 60 * 60 * 1000;
const NUMBER_OF_SEASONS = IS_PRODUCTION ? 5 : 1;
const RESOLVE_CONCURRENCY = parseInt(
  process.env.MAL_RESOLVE_CONCURRENCY || "5",
  10,
);

const seasonDataCache = new Map();

function getMalSeasonIndexForMonth(month) {
  if (month >= 1 && month <= 3) return 0;
  if (month >= 4 && month <= 6) return 1;
  if (month >= 7 && month <= 9) return 2;
  return 3;
}

function getRecentSeasons(yearsBack = 5) {
  const results = [];
  const seen = new Set();
  const now = new Date();
  const month = now.getMonth() + 1;
  let year = now.getFullYear();
  let seasonIdx = getMalSeasonIndexForMonth(month);
  const totalToAdd = yearsBack * 4 + 2;

  const pushSeason = (y, idx) => {
    const season = SEASONS[idx];
    const key = `${y}-${season}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      year: y,
      season,
      key,
      label: `${SEASON_DISPLAY[season]} ${y}`,
    });
  };

  // May/June: MAL's upcoming summer page is live — include it before spring ends
  if (month >= 5 && month <= 6 && seasonIdx === 1) {
    pushSeason(year, 2);
  }

  while (results.length < totalToAdd) {
    pushSeason(year, seasonIdx);

    seasonIdx--;
    if (seasonIdx < 0) {
      seasonIdx = 3;
      year--;
    }

    if (year < 2020) break;
  }

  return results;
}

const ALL_SEASONS = getRecentSeasons(NUMBER_OF_SEASONS);

async function scrapeMalSeasonalPage(year, season) {
  const url = `https://myanimelist.net/anime/season/${year}/${season}`;
  const res = await fetchMal(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch seasonal page: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const animes = [];
  const cards = $(
    ".seasonal-anime, div.js-anime-category-producer, .js-seasonal-anime",
  );

  cards.each((_, el) => {
    if (animes.length >= 25) return false;

    const $el = $(el);
    const link =
      $el.find("a.link-title, .title-text a, h2 a, .js-title a").attr("href") ||
      "";
    const malIdMatch = link.match(/\/anime\/(\d+)/);
    const mal_id = malIdMatch ? parseInt(malIdMatch[1], 10) : null;
    if (!mal_id) return;

    const title = $el
      .find(".title-text a, p.title-text a, .js-title a, h2 a")
      .first()
      .text()
      .trim();

    let score = null;
    const scoreEl = $el
      .find('.scormm .score, .score, [class*="score"]')
      .first();
    if (scoreEl.length) {
      const match = scoreEl
        .text()
        .trim()
        .match(/[\d.]+/);
      if (match) score = parseFloat(match[0]);
    }

    const membersText = $el.find(".member").text().replace(/,/g, "").trim();
    const popularity = parseInt(membersText, 10) || null;
    const img =
      $el.find("img").attr("data-src") || $el.find("img").attr("src") || "";
    const synopsis = $el.find(".synopsis").text().trim().substring(0, 280);
    const genres = [];
    $el.find(".genres a, .genre a").each((__, g) => {
      const gName = $(g).text().trim();
      if (gName) genres.push({ name: gName });
    });

    animes.push({
      mal_id,
      title,
      title_english: title,
      images: { jpg: { large_image_url: img } },
      score,
      popularity,
      synopsis,
      genres,
      year,
      media_type: "tv",
    });
  });

  return animes;
}

async function enrichSeasonWithImdbIds(items, label) {
  const total = items.length;
  if (total === 0) return [];

  let processed = 0;

  const results = await mapPool(items, RESOLVE_CONCURRENCY, async (item) => {
    processed++;
    const percent = Math.floor((processed / total) * 100);
    const barLen = 20;
    const filled = Math.floor((processed / total) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    process.stdout.write(
      `\r[${bar}] ${processed}/${total} (${percent}%) ${label}`,
    );

    if (!item.mal_id) return null;
    if (item.imdb_id) return item;

    const cachedId = lookupCachedImdbId(item);
    if (cachedId) {
      item.imdb_id = cachedId;
      return item;
    }

    const imdbId = await resolveImdbIdForAnime(item);
    if (imdbId) {
      item.imdb_id = imdbId;
      return item;
    }

    console.error(
      `\n[error] Could not resolve IMDb ID for mal:${item.mal_id} — "${item.title}" — dropping`,
    );
    return null;
  });

  process.stdout.write("\n");
  flushImdbCaches();
  return results.filter(Boolean);
}

async function getSeasonData(year, season, sort = "rated") {
  const cacheKey = `${year}-${season}-${sort}`;
  const cached = seasonDataCache.get(cacheKey);
  const now = Date.now();

  if (
    cached &&
    now - cached.lastUpdated < CACHE_TTL_MS &&
    cached.data.length > 0
  ) {
    return cached.data;
  }

  try {
    let scraped = await scrapeMalSeasonalPage(year, season);
    const seasonLabel = `${SEASON_DISPLAY[season]} ${year}`;
    scraped = await enrichSeasonWithImdbIds(scraped, seasonLabel);

    if (sort === "rated") {
      scraped = scraped.sort((a, b) => (b.score || -1) - (a.score || -1));
    }

    const finalData = scraped.slice(0, 25);

    seasonDataCache.set(cacheKey, {
      data: finalData,
      lastUpdated: now,
      info: seasonLabel,
    });

    return finalData;
  } catch (err) {
    console.error(`[scrape] Failed ${year}-${season} (${sort}):`, err.message);
    if (cached?.data?.length) return cached.data;
    return [];
  }
}

function buildSeasonalCatalogs() {
  return ALL_SEASONS.map((s, index) => ({
    type: "series",
    id: index === 0 ? "seasonal-score" : `season-${s.key}`,
    name: `MAL Top Rated - ${s.label}`,
    extra: [
      { name: "skip", isRequired: false },
      { name: "search", isRequired: false },
    ],
  }));
}

function prepareSeasonalCatalog(
  rawList,
  catalogId,
  searchTerm = "",
  skip = 0,
  pageSize = 100,
) {
  let list = rawList;

  if (searchTerm?.trim()) {
    const q = searchTerm.toLowerCase().trim();
    list = list.filter((item) => {
      const titles = [
        item.title,
        item.title_english,
        item.title_japanese,
      ].filter(Boolean);
      return titles.some((t) => t.toLowerCase().includes(q));
    });
  }

  const sorted = [...list].sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.popularity || 99999) - (b.popularity || 99999);
  });

  return sorted.slice(skip, skip + pageSize);
}

function findInSeasonCache(imdbId) {
  for (const entry of seasonDataCache.values()) {
    const found = entry.data.find((a) => a.imdb_id === imdbId);
    if (found) return found;
  }
  return null;
}

async function preloadAllSeasons() {
  for (const s of ALL_SEASONS) {
    await getSeasonData(s.year, s.season, "rated").catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
  }
}

module.exports = {
  ALL_SEASONS,
  SEASON_DISPLAY,
  seasonDataCache,
  getSeasonData,
  buildSeasonalCatalogs,
  prepareSeasonalCatalog,
  findInSeasonCache,
  preloadAllSeasons,
};
