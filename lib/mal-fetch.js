const { RateLimiter } = require('./rate-limit');

const MAL_REQUEST_INTERVAL_MS = parseInt(process.env.MAL_REQUEST_INTERVAL_MS || '350', 10);

const malRateLimiter = new RateLimiter(MAL_REQUEST_INTERVAL_MS);

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

function fetchMal(url) {
  return malRateLimiter.schedule(() => fetch(url, { headers: FETCH_HEADERS }));
}

module.exports = {
  fetchMal,
  MAL_REQUEST_INTERVAL_MS
};