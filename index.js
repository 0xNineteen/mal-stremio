const express = require('express');
const path = require('path');
const cors = require('cors');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const configurePage = require('./lib/configure-page');
const {
  ALL_SEASONS,
  getSeasonData,
  buildSeasonalCatalogs,
  prepareSeasonalCatalog,
  findInSeasonCache,
  preloadAllSeasons
} = require('./lib/seasonal');
const {
  LIST_STATUSES,
  getListData,
  getUsersToPreload,
  preloadAllUserLists,
  buildUserListCatalogs,
  prepareUserCatalog,
  findInUserCache
} = require('./lib/user-lists');
const { fetchMalPageInfo, searchForImdbId, loadImdbCache } = require('./lib/imdb');

// ====================== CONFIG ======================
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HTTP_CACHE_MAX_AGE = IS_PRODUCTION ? 3600 : 5;

function getUsername(config) {
  return (config?.username || '').trim() || null;
}

function parseConfigParam(configParam) {
  if (!configParam) return {};

  try {
    return JSON.parse(decodeURIComponent(configParam));
  } catch (_) {
    try {
      return JSON.parse(configParam);
    } catch (_) {
      return {};
    }
  }
}

function buildCatalogsForConfig(config = {}) {
  const catalogs = [];
  const username = getUsername(config);

  if (username) {
    catalogs.push(...buildUserListCatalogs());
  }

  catalogs.push(...buildSeasonalCatalogs());
  return catalogs;
}

function buildManifestForConfig(config = {}) {
  const hasConfig = config && Object.keys(config).length > 0;
  const behaviorHints = { ...manifestBase.behaviorHints };

  if (hasConfig) {
    delete behaviorHints.configurationRequired;
    delete behaviorHints.configurable;
  }

  return {
    ...manifestBase,
    behaviorHints,
    catalogs: buildCatalogsForConfig(config)
  };
}

function toMetaPreview(anime) {
  const name = anime.title_english || anime.title || 'Unknown Title';
  const poster = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url;
  const year = anime.year || (anime.aired?.from ? new Date(anime.aired.from).getFullYear() : null);
  const imdbId = anime.imdb_id;

  if (!imdbId) return null;

  const meta = {
    id: imdbId,
    type: 'series',
    name,
    poster,
    background: poster,
    description: anime.synopsis
      ? anime.synopsis.slice(0, 280) + (anime.synopsis.length > 280 ? '...' : '')
      : '',
    genres: (anime.genres || []).map(g => g.name),
    year: year ? String(year) : undefined,
    releaseInfo: year ? String(year) : undefined,
    imdbRating: anime.score ? anime.score.toFixed(1) : undefined,
    runtime: anime.duration || undefined,
    country: 'JP',
    status: anime.status || 'Released',
    language: 'ja'
  };

  const malUrl = anime.url || (anime.mal_id ? `https://myanimelist.net/anime/${anime.mal_id}` : null);
  if (malUrl) {
    meta.links = [{ name: 'MyAnimeList', category: 'general', url: malUrl }];
  }

  return meta;
}

function enrichMeta(meta, found) {
  meta.country = 'JP';
  meta.language = 'ja';
  meta.links = [
    {
      name: 'MyAnimeList',
      category: 'general',
      url: found.url || `https://myanimelist.net/anime/${found.mal_id}`
    }
  ];
  return meta;
}

const manifestBase = {
  id: 'com.malstremio.anime',
  version: '2.0.0',
  name: 'MAL Anime',
  description: 'Top-rated seasonal anime from MyAnimeList plus your personal lists (Watching, Completed, On Hold, Plan to Watch). Uses raw tt (IMDb) IDs resolved from MAL external links and name-to-imdb.',
  background: '/goku-backdrop.jpg',
  logo: '/dragon-ball.svg',
  resources: ['catalog', 'meta'],
  types: ['series'],
  idPrefixes: ['tt'],
  config: [
    {
      key: 'username',
      type: 'text',
      title: 'MyAnimeList Username',
      required: false
    }
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

const manifest = {
  ...manifestBase,
  catalogs: buildCatalogsForConfig({})
};

// ====================== ADDON HANDLERS ======================
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {}, config }) => {
  if (type !== 'series') return { metas: [] };

  const skip = parseInt(extra.skip || '0', 10);
  const search = extra.search || '';

  try {
    if (LIST_STATUSES[id]) {
      const username = getUsername(config);
      if (!username) return { metas: [] };

      const rawData = await getListData(username, id);
      const page = prepareUserCatalog(rawData, search, skip);
      return { metas: page.map(toMetaPreview).filter(Boolean) };
    }

    let rawData = [];

    if (id === 'seasonal-score') {
      const current = ALL_SEASONS[0];
      rawData = await getSeasonData(current.year, current.season, 'rated');
    } else if (id.startsWith('season-')) {
      const keyPart = id.replace('season-', '');
      const [yearStr, season] = keyPart.split('-');
      const year = parseInt(yearStr, 10);
      if (year && season) {
        rawData = await getSeasonData(year, season, 'rated');
      }
    }

    const page = prepareSeasonalCatalog(rawData, id, search, skip, 100);
    return { metas: page.map(toMetaPreview).filter(Boolean) };
  } catch (err) {
    console.error('Catalog handler error:', err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id, config }) => {
  if (type !== 'series' || !id || !id.startsWith('tt')) {
    return { meta: null };
  }

  try {
    const username = getUsername(config);
    if (username) {
      const userFound = findInUserCache(username, id);
      if (userFound) {
        const meta = enrichMeta(toMetaPreview(userFound), userFound);
        return { meta };
      }
    }

    const seasonFound = findInSeasonCache(id);
    if (seasonFound) {
      let meta = enrichMeta(toMetaPreview(seasonFound), seasonFound);

      if (!meta.id?.startsWith('tt')) {
        const { imdbId } = await fetchMalPageInfo(seasonFound.mal_id);
        if (imdbId) meta.id = imdbId;
      }

      return { meta };
    }
  } catch (err) {
    console.error('Meta handler error:', err.message);
  }

  return { meta: null };
});

// ====================== SERVER ======================
const app = express();
const addonInterface = builder.getInterface();

app.use(cors());
app.use((_, res, next) => {
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', `max-age=${HTTP_CACHE_MAX_AGE}, public`);
  }
  next();
});

function serveManifest(req, res) {
  const config = parseConfigParam(req.params.config);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(buildManifestForConfig(config)));
}

app.get('/:config/manifest.json', serveManifest);
app.get('/manifest.json', serveManifest);
app.use(getRouter(addonInterface));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.redirect('/configure'));
app.get('/configure', (_, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(configurePage({ ...manifestBase, catalogs: buildCatalogsForConfig({}) }));
});

function buildManifestUrl(baseUrl, username, timestamp = Date.now()) {
  const config = username ? { username } : {};
  const configPart = encodeURIComponent(JSON.stringify(config));
  return `${baseUrl}/${configPart}/manifest.json?t=${timestamp}`;
}

const server = app.listen(PORT, () => {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const timestamp = Date.now();
  const configureUrl = `${baseUrl}/configure?t=${timestamp}`;
  const usersToLink = getUsersToPreload();

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          MAL Anime — Stremio Addon                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Server running at: ${baseUrl}`);
  console.log(`  Configure & install: ${configureUrl}`);
  console.log(`  Seasonal manifest: ${buildManifestUrl(baseUrl, null, timestamp)}`);
  console.log('');

  if (usersToLink.length > 0) {
    console.log('  User list install links (cache-busted):');
    for (const username of usersToLink) {
      const manifestUrl = buildManifestUrl(baseUrl, username, timestamp);
      console.log(`    ${username}:`);
      console.log(`      Manifest: ${manifestUrl}`);
      console.log(`      Install:  ${manifestUrl.replace(/^http/, 'stremio')}`);
    }
    console.log('');
  }

  const cache = loadImdbCache();
  console.log(`  IMDb cache: ${Object.keys(cache).length} title(s) pre-resolved`);
  const seasonalCount = buildSeasonalCatalogs().length;
  const userCount = buildUserListCatalogs().length;
  console.log(`  Catalogs: ${seasonalCount} seasonal (+ ${userCount} personal when username configured)`);
  console.log('');
  console.log('  Install seasonal catalogs without a username, or add your MAL username');
  console.log('  on the configure page for personal list catalogs at the top. List must be public.');
  console.log('');

  (async () => {
    await preloadAllUserLists();
    await preloadAllSeasons();
  })();
});

server.on('error', err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});