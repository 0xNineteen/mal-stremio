const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchMal } = require('./mal-fetch');

const IMDB_CACHE_FILE = path.join(__dirname, '..', 'data', 'imdb-cache.json');
const MAL_IMDB_CACHE_FILE = path.join(__dirname, '..', 'data', 'mal-imdb-cache.json');

let titleCache = null;
let malIdCache = null;
let cachesLoaded = false;

function ensureCachesLoaded() {
  if (cachesLoaded) return;

  try {
    titleCache = fs.existsSync(IMDB_CACHE_FILE)
      ? JSON.parse(fs.readFileSync(IMDB_CACHE_FILE, 'utf8'))
      : {};
  } catch (_) {
    titleCache = {};
  }

  try {
    malIdCache = fs.existsSync(MAL_IMDB_CACHE_FILE)
      ? JSON.parse(fs.readFileSync(MAL_IMDB_CACHE_FILE, 'utf8'))
      : {};
  } catch (_) {
    malIdCache = {};
  }

  cachesLoaded = true;
}

function loadImdbCache() {
  ensureCachesLoaded();
  return titleCache;
}

function flushImdbCaches() {
  ensureCachesLoaded();

  try {
    const dir = path.dirname(IMDB_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(IMDB_CACHE_FILE, JSON.stringify(titleCache, null, 2));
    fs.writeFileSync(MAL_IMDB_CACHE_FILE, JSON.stringify(malIdCache, null, 2));
  } catch (e) {
    console.warn('[cache] Failed to flush IMDb caches:', e.message);
  }
}

function saveToImdbCache(title, ttId) {
  ensureCachesLoaded();

  const normalizedTitle = title.trim().replace(/\s+/g, ' ');
  if (!normalizedTitle || !ttId) return;

  if (titleCache[normalizedTitle] === ttId) return;
  if (Object.values(titleCache).some(id => id === ttId)) return;

  titleCache[normalizedTitle] = ttId;
}

function saveMalIdCache(malId, ttId) {
  ensureCachesLoaded();
  if (!malId || !ttId) return;
  malIdCache[String(malId)] = ttId;
}

function lookupTitleInCache(title) {
  if (!title) return null;

  ensureCachesLoaded();

  const cleanTitle = prepareSearchTitle(title);
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');

  return titleCache[title]
    || titleCache[normalizedTitle]
    || (cleanTitle && titleCache[cleanTitle])
    || null;
}

function lookupCachedImdbId(item) {
  if (!item) return null;

  ensureCachesLoaded();

  if (item.mal_id && malIdCache[String(item.mal_id)]) {
    return malIdCache[String(item.mal_id)];
  }

  const candidates = [
    item.title_english,
    item.title,
    item.title_japanese
  ].filter(Boolean);

  for (const title of candidates) {
    const id = lookupTitleInCache(title);
    if (id) return id;
  }

  return null;
}

function sanitizeTitleForSearch(str) {
  if (!str) return '';
  return str
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSeasonPartInfo(title) {
  if (!title) return '';

  let t = title;
  t = t.replace(/\s*[-–—:]\s*(?:season|part|cour|s)\s*\d*.*$/i, '');
  t = t.replace(/\s*\b(?:season|part|cour)\s*\d*(?:st|nd|rd|th)?\b.*$/i, '');
  t = t.replace(/\s*\b\d+(?:st|nd|rd|th)?\s*(?:season|part|cour)\b.*$/i, '');
  t = t.replace(/\s*\bS\d{1,2}\b.*$/i, '');
  t = t.replace(/\s*\bSeason\s*\d+\b.*$/i, '');
  t = t.replace(/\s*\bPart\s*\d+\b.*$/i, '');
  t = t.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  return t;
}

function prepareSearchTitle(title) {
  if (!title) return '';
  const stripped = stripSeasonPartInfo(title);
  return sanitizeTitleForSearch(stripped) || sanitizeTitleForSearch(title);
}

async function fetchMalPageInfo(malId) {
  if (!malId) return { imdbId: null, englishTitle: null, japaneseTitle: null };

  const url = `https://myanimelist.net/anime/${malId}`;

  try {
    const res = await fetchMal(url);

    if (!res.ok) return { imdbId: null, englishTitle: null, japaneseTitle: null };

    const html = await res.text();
    const $ = cheerio.load(html);

    let imdbId = null;

    $('a[href*="imdb.com/title/tt"]').each((_, el) => {
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

    let englishTitle = null;

    $('.js-alternative-titles .spaceit_pad, .alternative-titles .spaceit_pad').each((_, el) => {
      const $el = $(el);
      const fullText = $el.text().trim();
      const label = $el.find('.dark_text').text().trim().toLowerCase();

      if (label === 'english:' || fullText.toLowerCase().startsWith('english:')) {
        englishTitle = fullText.replace(/^english:\s*/i, '').trim();
      }
    });

    if (!englishTitle) {
      const altContainer = $('.js-alternative-titles, [class*="alternative"]');
      altContainer.find('span, div, p').each((_, el) => {
        const txt = $(el).text();
        const match = txt.match(/English:\s*(.+)/i);
        if (match && match[1]) englishTitle = match[1].trim();
      });
    }

    let japaneseTitle = null;
    $('.js-alternative-titles .spaceit_pad, .alternative-titles .spaceit_pad').each((_, el) => {
      const $el = $(el);
      const fullText = $el.text().trim();
      const label = $el.find('.dark_text').text().trim().toLowerCase();

      if (label === 'japanese:' || fullText.toLowerCase().startsWith('japanese:')) {
        japaneseTitle = fullText.replace(/^japanese:\s*/i, '').trim();
      }
    });

    return { imdbId, englishTitle, japaneseTitle };
  } catch (err) {
    console.warn(`[mal] Failed to scrape MAL page mal:${malId}: ${err.message}`);
    return { imdbId: null, englishTitle: null, japaneseTitle: null };
  }
}

async function searchForImdbId(title) {
  if (!title) return null;

  const cached = lookupTitleInCache(title);
  if (cached) return cached;

  const cleanTitle = prepareSearchTitle(title);
  if (!cleanTitle) return null;

  const nameToImdb = require('name-to-imdb');

  return new Promise((resolve) => {
    nameToImdb({
      name: cleanTitle,
      type: 'series'
    }, (err, res) => {
      if (err) {
        console.warn(`[name-to-imdb] Error for "${cleanTitle}": ${err.message || err}`);
        return resolve(null);
      }

      if (res && /^tt\d+$/.test(res)) {
        saveToImdbCache(cleanTitle || title, res);
        return resolve(res);
      }

      resolve(null);
    });
  });
}

function rememberResolvedId(item, imdbId) {
  if (!imdbId) return;
  if (item.mal_id) saveMalIdCache(item.mal_id, imdbId);

  const titles = [item.title_english, item.title, item.title_japanese].filter(Boolean);
  for (const title of titles) {
    saveToImdbCache(title, imdbId);
  }
}

async function resolveImdbIdForAnime(item) {
  const cached = lookupCachedImdbId(item);
  if (cached) return cached;

  const { imdbId: malImdb, englishTitle, japaneseTitle } = await fetchMalPageInfo(item.mal_id);
  if (malImdb) {
    rememberResolvedId(item, malImdb);
    return malImdb;
  }

  const candidates = [
    englishTitle,
    japaneseTitle,
    item.title_english,
    item.title
  ].filter(Boolean);

  for (const rawTitle of candidates) {
    const id = await searchForImdbId(rawTitle);
    if (id) {
      rememberResolvedId(item, id);
      return id;
    }
  }

  return null;
}

module.exports = {
  fetchMalPageInfo,
  searchForImdbId,
  resolveImdbIdForAnime,
  lookupCachedImdbId,
  loadImdbCache,
  flushImdbCaches,
  prepareSearchTitle
};