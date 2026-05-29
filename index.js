const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');

// ====================== CONFIG ======================
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CACHE_TTL_MS = IS_PRODUCTION 
  ? 30 * 24 * 60 * 60 * 1000   // 30 days (1 month) in production before re-scraping MAL
  : 4 * 60 * 60 * 1000;        // 4 hours in development
const IMDB_CACHE_FILE = './data/imdb-cache.json';
const HTTP_CACHE_MAX_AGE = IS_PRODUCTION ? 3600 : 5; // 1 hour in prod, 5s in dev (for fast iteration)

// ====================== MANIFEST ======================
const manifest = {
  id: 'com.malstremio.seasonal',
  version: '1.0.0',
  name: 'MAL Seasonal Anime',
  description: 'Highest rated seasonal anime from MyAnimeList using IMDb tt IDs resolved from MAL external links.',
  resources: ['catalog', 'meta'],
  types: ['series'],
  idPrefixes: ['tt']
  // catalogs are generated dynamically below
};

// ====================== CACHE ======================
// Data cache TTL is 1 month in production (IS_PRODUCTION), 4 hours in development.
// See CONFIG section above.

// New general cache for all seasons: key = `${year}-${season}-${'popular'|'rated'}`
const seasonDataCache = new Map();

// ====================== SEASON UTILITIES ======================
const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const SEASON_DISPLAY = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall'
};

/**
 * Returns seasons starting from Spring 2026 and going backwards ~5 years.
 * Most recent first. Uses standard season ordering
 * (Spring 2026 is preceded by Winter 2026, etc.).
 */
function getRecentSeasons(yearsBack = 5) {
  const results = [];

  // Hard cap to the current known season: Spring 2026
  let year = 2026;
  let seasonIdx = 1; // 0=winter, 1=spring, 2=summer, 3=fall

  const totalToAdd = yearsBack * 4 + 2;

  while (results.length < totalToAdd) {
    const season = SEASONS[seasonIdx];
    results.push({
      year,
      season,
      key: `${year}-${season}`,
      label: `${SEASON_DISPLAY[season]} ${year}`
    });

    // Move backwards one season using standard ordering
    seasonIdx--;
    if (seasonIdx < 0) {
      seasonIdx = 3;
      year--;
    }

    // Safety: don't go before ~2020
    if (year < 2020) break;
  }

  return results;
}

const ALL_SEASONS = getRecentSeasons(1);

// ====================== HELPERS ======================
function toMetaPreview(anime) {
  const name = anime.title_english || anime.title || 'Unknown Title';
  const poster = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url;
  const year = anime.year || (anime.aired?.from ? new Date(anime.aired.from).getFullYear() : null);

  // We only output raw tt (IMDb) IDs. If we don't have one, the caller should drop the item.
  const imdbId = anime.imdb_id;
  if (!imdbId) {
    return null;
  }

  const meta = {
    id: imdbId,                    // raw "tt1234567"
    type: 'series',
    name,
    poster,
    background: poster,
    description: anime.synopsis ? anime.synopsis.slice(0, 280) + (anime.synopsis.length > 280 ? '...' : '') : '',
    genres: (anime.genres || []).map(g => g.name),
    year: year ? String(year) : undefined,
    releaseInfo: year ? String(year) : undefined,
    imdbRating: anime.score ? anime.score.toFixed(1) : undefined,
    runtime: anime.duration || undefined,
    country: 'JP',
    status: anime.status || 'Released',
    language: 'ja',
    // Extra fields that help Torrentio and other stream addons
    cast: undefined,
    director: undefined,
    writer: undefined
  };

  if (anime._raw?.url || anime.url) {
    meta.links = [
      {
        name: 'MyAnimeList',
        category: 'general',
        url: anime._raw?.url || anime.url
      }
    ];
  }

  return meta;
}

/**
 * Scrape a single MAL anime page and extract useful data:
 * - IMDb ID from External Links (if present)
 * - Best English title from the "Alternative Titles" section
 *
 * We do this in one request per title for efficiency and politeness.
 */
async function fetchMalPageInfo(malId) {
  if (!malId) return { imdbId: null, englishTitle: null };

  const url = `https://myanimelist.net/anime/${malId}`;

  try {
    await new Promise(r => setTimeout(r, 1400)); // polite delay

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) return { imdbId: null, englishTitle: null };

    const html = await res.text();
    const $ = cheerio.load(html);

    // === 1. Extract IMDb ID from External Links ===
    let imdbId = null;

    $('a[href*="imdb.com/title/tt"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/tt\d{7,10}/);
      if (match) {
        imdbId = match[0].startsWith('tt') ? match[0] : `tt${match[0]}`;
        return false;
      }
    });

    if (!imdbId) {
      const regexMatch = html.match(/imdb\.com\/title\/(tt\d{7,10})/i);
      if (regexMatch) imdbId = regexMatch[1].startsWith('tt') ? regexMatch[1] : `tt${regexMatch[1]}`;
    }

    // === 2. Extract English title from Alternative Titles section ===
    let englishTitle = null;

    // Try the most common modern structure
    $('.js-alternative-titles .spaceit_pad, .alternative-titles .spaceit_pad').each((i, el) => {
      const $el = $(el);
      const fullText = $el.text().trim();
      const label = $el.find('.dark_text').text().trim().toLowerCase();

      if (label === 'english:' || fullText.toLowerCase().startsWith('english:')) {
        englishTitle = fullText.replace(/^english:\s*/i, '').trim();
      }
    });

    // Fallback: broader search for "English:" anywhere in alternative titles area
    if (!englishTitle) {
      const altContainer = $('.js-alternative-titles, [class*="alternative"]');
      altContainer.find('span, div, p').each((i, el) => {
        const txt = $(el).text();
        const match = txt.match(/English:\s*(.+)/i);
        if (match && match[1]) {
          englishTitle = match[1].trim();
        }
      });
    }

    // Another common pattern on some pages
    if (!englishTitle) {
      $('span:contains("English:")').each((i, el) => {
        const parentText = $(el).parent().text();
        const match = parentText.match(/English:\s*(.+)/i);
        if (match) englishTitle = match[1].trim();
      });
    }

    // === 3. Also extract Japanese title (very useful for search engines on anime)
    let japaneseTitle = null;
    $('.js-alternative-titles .spaceit_pad, .alternative-titles .spaceit_pad').each((i, el) => {
      const $el = $(el);
      const fullText = $el.text().trim();
      const label = $el.find('.dark_text').text().trim().toLowerCase();

      if (label === 'japanese:' || fullText.toLowerCase().startsWith('japanese:')) {
        japaneseTitle = fullText.replace(/^japanese:\s*/i, '').trim();
      }
    });

    if (!japaneseTitle) {
      const altContainer = $('.js-alternative-titles, [class*="alternative"]');
      altContainer.find('span, div, p').each((i, el) => {
        const txt = $(el).text();
        const match = txt.match(/Japanese:\s*(.+)/i);
        if (match && match[1]) japaneseTitle = match[1].trim();
      });
    }

    return { imdbId, englishTitle, japaneseTitle };
  } catch (err) {
    console.warn(`[mal] Failed to scrape MAL page mal:${malId}: ${err.message}`);
    return { imdbId: null, englishTitle: null, japaneseTitle: null };
  }
}

function sanitizeTitleForSearch(str) {
  if (!str) return '';
  return str
    .replace(/[^\w\s]/g, ' ')   // remove all special characters
    .replace(/\s+/g, ' ')       // collapse multiple spaces
    .trim();
}

/**
 * Aggressively removes season, part, cour, and similar qualifiers from the title.
 * This helps when searching IMDb for the main series page.
 *
 * Examples:
 *   "Re:Zero 4th Season" → "Re Zero"
 *   "Solo Leveling Season 2: Arise from the Shadow" → "Solo Leveling"
 *   "Witch Watch Season 2 Part 2" → "Witch Watch"
 *   "That Time I Got Reincarnated as a Slime Season 4" → "That Time I Got Reincarnated as a Slime"
 */
function stripSeasonPartInfo(title) {
  if (!title) return '';

  let t = title;

  // Remove everything after common season/part indicators (case insensitive)
  // Covers: Season 2, 2nd Season, Season 4: Foo, - Season 2, : Part 3, Cour 2, S2, etc.
  t = t.replace(/\s*[-–—:]\s*(?:season|part|cour|s)\s*\d*.*$/i, '');
  t = t.replace(/\s*\b(?:season|part|cour)\s*\d*(?:st|nd|rd|th)?\b.*$/i, '');
  t = t.replace(/\s*\b\d+(?:st|nd|rd|th)?\s*(?:season|part|cour)\b.*$/i, '');
  t = t.replace(/\s*\bS\d{1,2}\b.*$/i, '');           // S2, S04 at end
  t = t.replace(/\s*\bSeason\s*\d+\b.*$/i, '');
  t = t.replace(/\s*\bPart\s*\d+\b.*$/i, '');

  // Final general sanitization (remove special chars, collapse spaces)
  t = t.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  return t;
}

/**
 * Prepares a title for searching on IMDb (or Google/DDG).
 * Combines season stripping + general sanitization.
 */
function prepareSearchTitle(title) {
  if (!title) return '';
  const stripped = stripSeasonPartInfo(title);
  return sanitizeTitleForSearch(stripped) || sanitizeTitleForSearch(title);
}

/**
 * Resolve a (cleaned) title to an IMDb ID using the method recommended
 * in the official Stremio Addon SDK documentation.
 */
async function searchForImdbId(title) {
  if (!title) return null;

  const cleanTitle = prepareSearchTitle(title);
  if (!cleanTitle) return null;

  // Load disk cache first (fast path)
  const cache = loadImdbCache();

  // Check under original title
  if (cache[title]) {
    return cache[title];
  }

  // Check under cleaned title
  if (cleanTitle && cache[cleanTitle]) {
    return cache[cleanTitle];
  }

  // Also try a normalized version of the original title (defensive)
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');
  if (normalizedTitle !== title && cache[normalizedTitle]) {
    return cache[normalizedTitle];
  }

  const nameToImdb = require('name-to-imdb');

  return new Promise((resolve) => {
    nameToImdb({
      name: cleanTitle,
      type: 'series'   // we only deal with anime series
    }, (err, res) => {
      if (err) {
        console.warn(`[name-to-imdb] Error for "${cleanTitle}": ${err.message || err}`);
        return resolve(null);
      }

      if (res && /^tt\d+$/.test(res)) {
        // Prefer saving the cleaned title. The save function will prevent
        // duplicate tt IDs from being stored under multiple names.
        saveToImdbCache(cleanTitle || title, res);

        return resolve(res);
      }

      resolve(null);
    });
  });
}

function loadImdbCache() {
  try {
    const fs = require('fs');
    if (fs.existsSync(IMDB_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(IMDB_CACHE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveToImdbCache(title, ttId) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(IMDB_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cache = loadImdbCache();

    // Normalize title slightly to reduce accidental duplicates
    const normalizedTitle = title.trim().replace(/\s+/g, ' ');

    // Don't overwrite if this exact title is already mapped to the same ID
    if (cache[normalizedTitle] === ttId) return;

    // Prevent saving duplicate names for the same IMDb ID
    const alreadyHasThisId = Object.values(cache).some(id => id === ttId);
    if (alreadyHasThisId) return;

    cache[normalizedTitle] = ttId;
    fs.writeFileSync(IMDB_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('[cache] Failed to save IMDb cache:', e.message);
  }
}

function prepareCatalog(rawList, catalogId, searchTerm = '', skip = 0, pageSize = 100) {
  let list = rawList;

  if (searchTerm && searchTerm.trim()) {
    const q = searchTerm.toLowerCase().trim();
    list = list.filter(item => {
      const titles = [
        item.title,
        item.title_english,
        item.title_japanese,
        ...(item.titles || []).map(t => t.title)
      ].filter(Boolean);
      return titles.some(t => t.toLowerCase().includes(q));
    });
  }

  let sorted;
  if (catalogId === 'seasonal-score' || catalogId.startsWith('season-')) {
    // All our "MAL Top Rated" catalogs should be sorted by MAL score (highest first)
    sorted = [...list].sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (a.popularity || 99999) - (b.popularity || 99999);
    });
  } else {
    // popularity (lower number = more popular) - fallback for any other catalogs
    sorted = [...list].sort((a, b) => (a.popularity || 99999) - (b.popularity || 99999));
  }

  const page = sorted.slice(skip, skip + pageSize);
  return page.map(toMetaPreview).filter(Boolean);
}

/**
 * Scrape the first page of a MAL seasonal anime page.
 * Done slowly and respectfully.
 * Returns up to the first 25 TV series found on the page.
 */
async function scrapeMalSeasonalPage(year, season) {
  const url = `https://myanimelist.net/anime/season/${year}/${season}`;

  // Be very polite to MAL
  await new Promise(resolve => setTimeout(resolve, 1500));

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch seasonal page: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const animes = [];

  // Try multiple selectors because MAL changes their HTML often
  const cards = $('.seasonal-anime, div.js-anime-category-producer, .js-seasonal-anime');
  if (cards.length === 0) {
    console.warn(`[scrape] WARNING: No anime cards found using common selectors on ${url}`);
    console.warn(`[scrape] This season may have very few entries, or MAL changed their page structure.`);
  }

  cards.each((index, el) => {
    if (animes.length >= 25) return false;

    const $el = $(el);

    // Try several possible title link selectors
    const link = $el.find('a.link-title, .title-text a, h2 a, .js-title a').attr('href') || '';
    const malIdMatch = link.match(/\/anime\/(\d+)/);
    const mal_id = malIdMatch ? parseInt(malIdMatch[1], 10) : null;

    if (!mal_id) return;

    // Title
    const title = $el.find('.title-text a, p.title-text a, .js-title a, h2 a').first().text().trim();

    // Score - more robust extraction for MAL seasonal pages
    let score = null;
    const scoreEl = $el.find('.scormm .score, .score, [class*="score"]').first();
    if (scoreEl.length) {
      const scoreText = scoreEl.text().trim();
      const match = scoreText.match(/[\d.]+/);
      if (match) {
        score = parseFloat(match[0]);
      }
    }

    // Members / popularity
    const membersText = $el.find('.member').text().replace(/,/g, '').trim();
    const popularity = parseInt(membersText, 10) || null;

    // Image
    const img = $el.find('img').attr('data-src') || $el.find('img').attr('src') || '';

    // Synopsis (short)
    const synopsis = $el.find('.synopsis').text().trim().substring(0, 280);

    // Genres
    const genres = [];
    $el.find('.genres a, .genre a').each((i, g) => {
      const gName = $(g).text().trim();
      if (gName) genres.push({ name: gName });
    });

    animes.push({
      mal_id,
      title,
      title_english: title,
      images: {
        jpg: {
          large_image_url: img
        }
      },
      score,
      popularity,
      synopsis,
      genres,
      year,
      duration: undefined,
      media_type: 'tv'
    });
  });

  if (animes.length === 0) {
    console.warn(`[scrape] Scraped 0 titles from first page of ${url}. Check if the season has content or if selectors need updating.`);
  }

  return animes;
}

// IMDb IDs are resolved exclusively by scraping the individual MAL title page
// "External Links" section (see fetchImdbIdFromMalExternalLinks).


/**
 * Fetch seasonal data by scraping MAL website (slow & respectful).
 * Only the first page, top 25 TV series.
 *
 * IMDb tt IDs are obtained by scraping each title's MAL page "External Links"
 * section. Titles without an IMDb link are dropped so we only ever emit raw tt IDs.
 */
async function getSeasonData(year, season, sort = 'rated') {
  const cacheKey = `${year}-${season}-${sort}`;

  const cached = seasonDataCache.get(cacheKey);
  const now = Date.now();

  if (cached && (now - cached.lastUpdated < CACHE_TTL_MS) && cached.data.length > 0) {
    return cached.data;
  }

  try {
    let scraped = await scrapeMalSeasonalPage(year, season);

    // Resolve tt (IMDb) IDs using a single MAL page request per title.
    // Progress bar for the season's title enrichment.
    const total = scraped.length;
    let processed = 0;
    const seasonLabel = `${SEASON_DISPLAY[season]} ${year}`;

    const resolved = [];
    if (total > 0) {
      for (const item of scraped) {
        processed++;
        const percent = Math.floor((processed / total) * 100);
        const barLen = 20;
        const filled = Math.floor((processed / total) * barLen);
        const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
        process.stdout.write(`\r[${bar}] ${processed}/${total} (${percent}%) ${seasonLabel}`);

        if (!item.mal_id) continue;

        const { imdbId: malImdb, englishTitle, japaneseTitle } = await fetchMalPageInfo(item.mal_id);

        let finalImdbId = malImdb;

        if (!finalImdbId) {
          const candidates = [
            englishTitle,
            japaneseTitle,
            item.title_english,
            item.title
          ].filter(Boolean);

          for (const rawTitle of candidates) {
            if (finalImdbId) break;

            finalImdbId = await searchForImdbId(rawTitle);
          }
        }

        if (finalImdbId) {
          item.imdb_id = finalImdbId;
          resolved.push(item);
        } else {
          console.error(`[error] Could not resolve IMDb ID for mal:${item.mal_id} — "${item.title}" — dropping`);
        }
      }

      process.stdout.write('\n');
    }

    scraped = resolved;

    // Sort by MAL score (highest first)
    if (sort === 'rated') {
      scraped = scraped.sort((a, b) => {
        const sa = typeof a.score === 'number' ? a.score : -1;
        const sb = typeof b.score === 'number' ? b.score : -1;
        return sb - sa;
      });
    }

    // Cap at 25
    const finalData = scraped.slice(0, 25);

    seasonDataCache.set(cacheKey, {
      data: finalData,
      lastUpdated: now,
      info: `${SEASON_DISPLAY[season]} ${year} (${sort})`
    });

    if (finalData.length === 0) {
      console.warn(`[scrape] Got 0 titles for ${season} ${year} after processing.`);
    }
    return finalData;

  } catch (err) {
    console.error(`[scrape] Failed ${year}-${season} (${sort}):`, err.message);

    if (cached && cached.data.length > 0) {
      return cached.data;
    }

    if (seasonDataCache.size === 0) {
      const mockKey = 'mock-popular';
      seasonDataCache.set(mockKey, {
        data: MOCK_SEASONAL,
        lastUpdated: Date.now(),
        info: 'Mock Data'
      });
      return MOCK_SEASONAL;
    }

    return [];
  }
}

// ====================== DYNAMIC MANIFEST (with all seasons) ======================
function buildCatalogs() {
  const catalogs = [];

  // Order by year then season, starting with most recent
  for (const s of ALL_SEASONS) {
    const isCurrent = s.key === ALL_SEASONS[0].key;

    catalogs.push({
      type: 'series',
      id: isCurrent ? 'seasonal-score' : `season-${s.key}`,
      name: `MAL Top Rated - ${s.label}`,
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    });
  }

  return catalogs;
}

const fullManifest = {
  ...manifest,
  description: 'Highest rated anime from the current season and every season going back 5 years, sourced from MyAnimeList seasonal pages. Uses raw tt (IMDb) IDs resolved from each title\'s External Links on MAL.',
  catalogs: buildCatalogs()
};



// ====================== ADDON HANDLERS ======================
const builder = new addonBuilder(fullManifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  if (type !== 'series') {
    return { metas: [] };
  }

  const skip = parseInt(extra.skip || '0', 10);
  const search = extra.search || '';

  try {
    let rawData = [];

    if (id === 'seasonal-score') {
      // Current season - highest rated only
      const current = ALL_SEASONS[0];
      rawData = await getSeasonData(current.year, current.season, 'rated');
    } else if (id.startsWith('season-')) {
      // Historical season - always highest rated (e.g. id: season-2025-spring)
      const keyPart = id.replace('season-', '');
      const [yearStr, season] = keyPart.split('-');
      const year = parseInt(yearStr, 10);

      if (year && season) {
        rawData = await getSeasonData(year, season, 'rated');
      }
    }

    const metas = prepareCatalog(rawData, id, search, skip, 100);
    return { metas };
  } catch (err) {
    console.error('Catalog handler error:', err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'series' || !id || !id.startsWith('tt')) {
    return { meta: null };
  }

  const imdbId = id; // raw tt value

  // Serve from our scraped + resolved seasonal cache
  try {
    for (const entry of seasonDataCache.values()) {
      const found = entry.data.find(a => a.imdb_id === imdbId);

      if (found) {
        const meta = toMetaPreview(found);

        // Force-enrich
        meta.country = 'JP';
        meta.status = found.status || 'Released';
        meta.language = 'ja';
        meta.links = [
          {
            name: 'MyAnimeList',
            category: 'general',
            url: `https://myanimelist.net/anime/${found.mal_id}`
          }
        ];

        if (found._raw) {
          if (found._raw.studios && found._raw.studios.length > 0) {
            meta.director = found._raw.studios[0].name;
          }
        }

        // Last-chance resolution if needed (rare)
        if (!meta.id || !meta.id.startsWith('tt')) {
          const { imdbId } = await fetchMalPageInfo(found.mal_id);
          if (imdbId) {
            meta.id = imdbId;
          } else if (found.title || found.title_english) {
            const candidates = [found.title_english, found.title].filter(Boolean);
            for (const t of candidates) {
              if (meta.id && meta.id.startsWith('tt')) break;
              const id = await searchForImdbId(t);
              if (id) {
                meta.id = id;
                break;
              }
            }
          }
        }

        return { meta };
      }
    }
  } catch (_) {}

  return { meta: null };
});

// Note: This addon intentionally does NOT implement a stream handler.
// It only provides catalogs and metadata using raw `tt` (IMDb) IDs (resolved via name-to-imdb + MAL titles).
// Pair with Torrentio (or AIOStreams/MediaFusion) for streams.

// ====================== SERVER ======================
serveHTTP(builder.getInterface(), {
  port: PORT,
  cacheMaxAge: HTTP_CACHE_MAX_AGE
}).then(async ({ url }) => {
  const timestampedManifest = `${url}?t=${Date.now()}`;

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          MAL Seasonal Anime — Stremio Addon                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Server running at: ${url.replace('/manifest.json', '')}`);
  console.log(`  Manifest URL (recommended): ${timestampedManifest}`);
  console.log('');

  // Load cached IMDb ID resolutions
  const fs = require('fs');
  const path = require('path');
  const cachePath = path.join(__dirname, 'data', 'imdb-cache.json');
  let cachedCount = 0;
  try {
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      cachedCount = Object.keys(cache).length;
    }
  } catch (_) {}
  console.log(`  IMDb cache: ${cachedCount} title(s) pre-resolved`);

  console.log('  Catalogs provided:');
  console.log(`    • ${fullManifest.catalogs.length} total`);
  console.log('    • Catalog names:');
  fullManifest.catalogs.slice(0, 8).forEach(c => {
    console.log(`        - ${c.name}`);
  });
  if (fullManifest.catalogs.length > 8) {
    console.log(`        ... and ${fullManifest.catalogs.length - 8} more`);
  }
  console.log('');
  console.log('  Install in Stremio → Add-ons → Enter the Manifest URL shown above');
  console.log('  (the ?t= timestamp helps bypass caching)');
  console.log('');

  // Preload seasons by scraping MAL website slowly (one request every ~4.5s)
  const eagerSeasons = ALL_SEASONS.slice(0, 6);
  (async () => {
    for (const s of eagerSeasons) {
      await getSeasonData(s.year, s.season, 'rated').catch(() => {});
      await new Promise(r => setTimeout(r, 350));
    }
  })();
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
