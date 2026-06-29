const fs = require('fs');
const path = require('path');

const USER_LISTS_DIR = path.join(__dirname, '..', 'data', 'user-lists');

function sanitizeUsername(username) {
  return username.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cacheFilePath(username, statusKey) {
  return path.join(USER_LISTS_DIR, sanitizeUsername(username), `${statusKey}.json`);
}

function loadUserListCache(username, statusKey) {
  try {
    const filePath = cacheFilePath(username, statusKey);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[cache] Failed to load list cache for ${username}/${statusKey}:`, err.message);
    return null;
  }
}

function saveUserListCache(username, statusKey, data) {
  try {
    const filePath = cacheFilePath(username, statusKey);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ ...data, username }, null, 2));
  } catch (err) {
    console.warn(`[cache] Failed to save list cache for ${username}/${statusKey}:`, err.message);
  }
}

function listCachedUsernames() {
  const usernames = new Set();

  try {
    if (!fs.existsSync(USER_LISTS_DIR)) return [];

    for (const entry of fs.readdirSync(USER_LISTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(USER_LISTS_DIR, entry.name);
      const cacheFile = fs.readdirSync(dirPath).find(name => name.endsWith('.json'));
      if (!cacheFile) continue;

      try {
        const data = JSON.parse(fs.readFileSync(path.join(dirPath, cacheFile), 'utf8'));
        usernames.add((data.username || entry.name).trim());
      } catch (_) {
        usernames.add(entry.name);
      }
    }
  } catch (err) {
    console.warn('[cache] Failed to list cached usernames:', err.message);
  }

  return [...usernames].filter(Boolean);
}

module.exports = {
  loadUserListCache,
  saveUserListCache,
  listCachedUsernames
};