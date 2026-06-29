const { LIST_STATUSES, scrapeUserAnimelist } = require("./mal-list");
const {
  resolveImdbIdForAnime,
  lookupCachedImdbId,
  flushImdbCaches,
} = require("./imdb");
const { mapPool } = require("./pool");
const {
  loadUserListCache,
  saveUserListCache,
  listCachedUsernames,
} = require("./user-cache");

const LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRELOAD_USERNAMES = (process.env.MAL_USERNAMES || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const RESOLVE_CONCURRENCY = parseInt(
  process.env.MAL_RESOLVE_CONCURRENCY || "5",
  10,
);
const MAX_CATALOG_ITEMS = 20;

const listDataCache = new Map();
const refreshInFlight = new Map();

function sortListItems(list) {
  return [...list].sort((a, b) => {
    const userScoreDiff = (b.user_score || 0) - (a.user_score || 0);
    if (userScoreDiff !== 0) return userScoreDiff;
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
}

function mergeCachedItem(cached, scraped) {
  return {
    ...cached,
    ...scraped,
    imdb_id: cached.imdb_id,
    title: scraped.title,
    title_english: scraped.title_english,
    title_japanese: scraped.title_japanese,
    user_score: scraped.user_score,
    num_watched_episodes: scraped.num_watched_episodes,
    num_episodes: scraped.num_episodes,
    updated_at: scraped.updated_at,
    score: scraped.score,
    images: scraped.images,
    genres: scraped.genres,
    popularity: scraped.popularity,
    media_type: scraped.media_type,
    url: scraped.url,
  };
}

async function enrichListWithImdbIds(items, statusLabel) {
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
      `\r[${bar}] ${processed}/${total} (${percent}%) ${statusLabel}`,
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

async function refreshListData(username, statusKey, diskCache) {
  const statusConfig = LIST_STATUSES[statusKey];
  const scraped = sortListItems(
    await scrapeUserAnimelist(username, statusKey),
  ).slice(0, MAX_CATALOG_ITEMS);

  const cachedByMalId = new Map();
  for (const item of diskCache?.items || []) {
    if (item.mal_id) cachedByMalId.set(item.mal_id, item);
  }

  const existingItems = [];
  const newItems = [];

  for (const scrapedItem of scraped) {
    const cached = cachedByMalId.get(scrapedItem.mal_id);
    if (cached?.imdb_id) {
      existingItems.push(mergeCachedItem(cached, scrapedItem));
    } else {
      newItems.push(scrapedItem);
    }
  }

  if (newItems.length > 0) {
    console.log(
      `[refresh] ${username} / ${statusConfig.name}: resolving ${newItems.length} new title(s), ${existingItems.length} cached`,
    );
  } else {
    console.log(
      `[refresh] ${username} / ${statusConfig.name}: no new titles (${existingItems.length} cached)`,
    );
  }

  const resolvedNew = await enrichListWithImdbIds(
    newItems,
    `${statusConfig.name} (${username})`,
  );
  const allItems = [...existingItems, ...resolvedNew];
  const now = Date.now();

  const cacheEntry = { lastScraped: now, items: allItems };
  const cacheKey = `${username}:${statusKey}`;

  listDataCache.set(cacheKey, cacheEntry);
  saveUserListCache(username, statusKey, cacheEntry);

  return allItems;
}

async function getListData(username, statusKey) {
  const cacheKey = `${username}:${statusKey}`;
  const now = Date.now();

  const diskCache = loadUserListCache(username, statusKey);
  const memoryCache = listDataCache.get(cacheKey);

  if (memoryCache && now - memoryCache.lastScraped < LIST_CACHE_TTL_MS) {
    return memoryCache.items;
  }

  if (
    !memoryCache &&
    diskCache &&
    now - diskCache.lastScraped < LIST_CACHE_TTL_MS
  ) {
    listDataCache.set(cacheKey, diskCache);
    return diskCache.items;
  }

  if (refreshInFlight.has(cacheKey)) {
    return refreshInFlight.get(cacheKey);
  }

  const promise = refreshListData(
    username,
    statusKey,
    diskCache || memoryCache,
  );
  refreshInFlight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    refreshInFlight.delete(cacheKey);
  }
}

function getUsersToPreload() {
  return [...new Set([...PRELOAD_USERNAMES, ...listCachedUsernames()])].filter(
    Boolean,
  );
}

async function preloadAllUserLists() {
  const users = getUsersToPreload();
  if (users.length === 0) return;

  console.log(
    `  Preloading user lists for ${users.length} user(s): ${users.join(", ")}`,
  );

  await Promise.all(
    users.map(async (username) => {
      await Promise.all(
        Object.keys(LIST_STATUSES).map((statusKey) =>
          getListData(username, statusKey).catch((err) => {
            console.error(
              `[preload] Failed ${username}/${statusKey}:`,
              err.message,
            );
          }),
        ),
      );
    }),
  );

  console.log("  User list preload complete.");
}

function buildUserListCatalogs() {
  return Object.values(LIST_STATUSES).map((status) => ({
    type: "series",
    id: status.catalogId,
    name: `MAL — ${status.name}`,
    extra: [
      { name: "skip", isRequired: false },
      { name: "search", isRequired: false },
    ],
  }));
}

function prepareUserCatalog(rawList, searchTerm = "", skip = 0) {
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

  return sortListItems(list)
    .slice(0, MAX_CATALOG_ITEMS)
    .slice(skip, skip + MAX_CATALOG_ITEMS);
}

function findInUserCache(username, imdbId) {
  const prefix = `${username}:`;

  for (const [key, entry] of listDataCache.entries()) {
    if (!key.startsWith(prefix)) continue;
    const found = entry.items.find((a) => a.imdb_id === imdbId);
    if (found) return found;
  }

  for (const statusKey of Object.keys(LIST_STATUSES)) {
    const diskCache = loadUserListCache(username, statusKey);
    const found = diskCache?.items?.find((a) => a.imdb_id === imdbId);
    if (found) return found;
  }

  return null;
}

module.exports = {
  LIST_STATUSES,
  MAX_CATALOG_ITEMS,
  listDataCache,
  getListData,
  getUsersToPreload,
  preloadAllUserLists,
  buildUserListCatalogs,
  prepareUserCatalog,
  findInUserCache,
};
