const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { formatScore, renderBadgeSvg } = require('./badge');
const { getImdbRating } = require('./imdb-rating');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'posters');
const ALLOWED_HOSTS = new Set(['cdn.myanimelist.net', 'myanimelist.net']);
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
};

const renders = new Map();

function isAllowedImageUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && ALLOWED_HOSTS.has(url.hostname)
      && url.pathname.includes('/images/');
  } catch (_) {
    return false;
  }
}

function imageCandidates(src) {
  const urls = [];

  try {
    const url = new URL(src);
    const upgradedPath = url.pathname.replace(/\/r\/\d+x\d+\//, '/');
    if (upgradedPath !== url.pathname) {
      urls.push(`${url.origin}${upgradedPath}`);
    }
  } catch (_) {
    return [];
  }

  urls.push(src);
  return [...new Set(urls)].filter(isAllowedImageUrl);
}

function buildPosterPath(imdbId, score, imageUrl) {
  const malScore = formatScore(score);
  if (!/^tt\d+$/.test(imdbId || '') || !malScore || !isAllowedImageUrl(imageUrl)) {
    return null;
  }

  const query = new URLSearchParams({ score: malScore, src: imageUrl });
  return `/poster/${imdbId}.jpg?${query}`;
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) throw new Error(`image ${res.status}`);
  if (!isAllowedImageUrl(res.url)) throw new Error('image host redirected');

  return Buffer.from(await res.arrayBuffer());
}

async function loadSourceImage(src) {
  let lastError = null;

  for (const url of imageCandidates(src)) {
    try {
      return await fetchImage(url);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('image unavailable');
}

function cacheFile(imdbId, malScore, imdbRating) {
  const imdbKey = (imdbRating || 'na').replace(/[^0-9.]/g, '');
  return path.join(CACHE_DIR, `${imdbId}-${malScore}-${imdbKey || 'na'}.jpg`);
}

async function compositePoster(source, imdbRating, malScore) {
  const imdbText = imdbRating ? formatScore(imdbRating) : null;
  const badge = renderBadgeSvg(imdbText, malScore);
  let quality = 74;
  let jpeg = await sharp(source)
    .resize(400, 600, { fit: 'cover', position: 'centre' })
    .composite([{ input: badge, gravity: 'northwest' }])
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  if (jpeg.length > 100 * 1024) {
    quality = 58;
    jpeg = await sharp(source)
      .resize(400, 600, { fit: 'cover', position: 'centre' })
      .composite([{ input: badge, gravity: 'northwest' }])
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  return jpeg;
}

async function renderRatedPoster({ imdbId, score, src }) {
  if (!/^tt\d+$/.test(imdbId || '')) throw new Error('bad id');

  const malScore = formatScore(score);
  if (!malScore) throw new Error('bad score');
  if (!isAllowedImageUrl(src)) throw new Error('bad image url');

  const { rating: imdbRating, settled } = await getImdbRating(imdbId);
  const file = cacheFile(imdbId, malScore, settled ? imdbRating : null);

  if (settled && fs.existsSync(file)) {
    return fs.readFileSync(file);
  }

  const key = `${imdbId}:${malScore}:${settled ? imdbRating || 'na' : 'pending'}`;
  if (!renders.has(key)) {
    const job = (async () => {
      const source = await loadSourceImage(src);
      const jpeg = await compositePoster(source, imdbRating, malScore);
      if (settled) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, jpeg);
      }
      return jpeg;
    })().finally(() => {
      renders.delete(key);
    });
    renders.set(key, job);
  }

  return renders.get(key);
}

module.exports = {
  buildPosterPath,
  isAllowedImageUrl,
  renderRatedPoster
};
