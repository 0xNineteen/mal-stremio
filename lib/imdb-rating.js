const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'imdb-ratings.json');
const POSITIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

let cache = null;
let writeTimer = null;
const inflight = new Map();

function loadCache() {
  if (cache) return cache;

  try {
    cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  } catch (_) {
    cache = {};
  }

  return cache;
}

function scheduleWrite() {
  if (writeTimer) return;

  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(loadCache()));
    } catch (err) {
      console.warn('[imdb-rating] cache write failed:', err.message);
    }
  }, 1000);
  writeTimer.unref?.();
}

async function fetchCinemetaRating(imdbId) {
  for (const type of ['series', 'movie']) {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'mal-stremio' }
    });

    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`cinemeta ${res.status}`);

    const body = await res.json();
    if (!body?.meta) continue;
    return body.meta.imdbRating ? String(body.meta.imdbRating) : null;
  }

  return null;
}

// settled: Cinemeta answered, so a missing rating can be cached.
// Unsettled means the lookup failed and the poster should be rendered
// without writing a long-lived file.
async function getImdbRating(imdbId) {
  const store = loadCache();
  const hit = store[imdbId];

  if (hit) {
    const age = Date.now() - hit.at;
    const ttl = hit.rating ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (age < ttl) return { rating: hit.rating || null, settled: true };
  }

  if (!inflight.has(imdbId)) {
    const job = (async () => {
      try {
        const rating = await fetchCinemetaRating(imdbId);
        store[imdbId] = { rating, at: Date.now() };
        scheduleWrite();
        return { rating, settled: true };
      } catch (err) {
        console.warn(`[imdb-rating] ${imdbId}: ${err.message}`);
        return { rating: null, settled: false };
      } finally {
        inflight.delete(imdbId);
      }
    })();
    inflight.set(imdbId, job);
  }

  return inflight.get(imdbId);
}

module.exports = { getImdbRating };
