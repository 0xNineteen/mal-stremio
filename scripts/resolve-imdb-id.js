#!/usr/bin/env node
/**
 * IMDb resolver script
 *
 * Uses the officially recommended `name-to-imdb` package
 * (see Stremio Addon SDK docs).
 *
 * Usage:
 *   node scripts/resolve-imdb-id.js "Solo Leveling Season 2"
 *   node scripts/resolve-imdb-id.js "Re:Zero 4th Season" "Witch Watch"
 *
 * Strips season/part info first for better accuracy on anime.
 * Results saved to data/imdb-cache.json.
 */

const fs = require('fs');
const path = require('path');

// Simple persistent cache for name-to-imdb resolutions.
// Duplicate IMDb IDs are not stored under multiple names.
const CACHE_FILE = path.join(__dirname, '..', 'data', 'imdb-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveToCache(title, ttId) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cache = loadCache();

    const normalizedTitle = title.trim().replace(/\s+/g, ' ');

    // Don't overwrite if this exact title already has the same ID
    if (cache[normalizedTitle] === ttId) return;

    // Prevent storing duplicate names for the same IMDb ID
    const alreadyHasThisId = Object.values(cache).some(id => id === ttId);
    if (alreadyHasThisId) return;

    cache[normalizedTitle] = ttId;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`[saved] ${normalizedTitle} → ${ttId}`);
  } catch (e) {
    console.error('Failed to write cache:', e.message);
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sanitizeTitleForSearch(str) {
  if (!str) return '';
  return str
    .replace(/[^\w\s]/g, ' ')   // remove all special characters
    .replace(/\s+/g, ' ')       // collapse multiple spaces
    .trim();
}

/**
 * Removes season/part/cour info so we search IMDb for the main series.
 */
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

async function searchForImdbId(title) {
  const cleanTitle = prepareSearchTitle(title);
  if (!cleanTitle) {
    console.log(`  No usable title after sanitization`);
    return null;
  }

  // Load disk cache first (fast path)
  const cache = loadCache();

  if (cache[title]) {
    return cache[title];
  }
  if (cleanTitle && cache[cleanTitle]) {
    return cache[cleanTitle];
  }

  // Defensive normalized lookup
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');
  if (normalizedTitle !== title && cache[normalizedTitle]) {
    return cache[normalizedTitle];
  }

  // Use the officially recommended name-to-imdb package
  // (see Stremio Addon SDK docs)
  const nameToImdb = require('name-to-imdb');

  return new Promise((resolve) => {
    nameToImdb({
      name: cleanTitle,
      type: 'series'
    }, (err, res) => {
      if (err) {
        console.log(`  [name-to-imdb] Error: ${err.message || err}`);
        return resolve(null);
      }
      if (res && /^tt\d+$/.test(res)) {
        console.log(`  → ${res}`);

        // Prefer the cleaned title. saveToCache will prevent duplicate tt IDs.
        saveToCache(cleanTitle || title, res);

        return resolve(res);
      }
      console.log(`  No result`);
      resolve(null);
    });
  });
}