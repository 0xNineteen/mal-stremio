const express = require('express');
const path = require('path');
const cors = require('cors');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const configurePage = require('./lib/configure-page');
const {
  getSeasonData,
  seasonFromGenre,
  buildSeasonalCatalogs,
  prepareSeasonalCatalog,
  findInSeasonCache,
  preloadAllSeasons,
  scheduleCurrentSeasonRefresh,
  getCurrentSeason
} = require('./lib/seasonal');
const {
  getListData,
  getUsersToPreload,
  preloadAllUserLists,
  listStatusFromGenre,
  buildUserListCatalogs,
  prepareUserCatalog,
  findInUserCache
} = require('./lib/user-lists');
const { fetchMalPageInfo, searchForImdbId, loadImdbCache } = require('./lib/imdb');
const { buildPosterPath, isAllowedImageUrl, renderRatedPoster } = require('./lib/poster');
const { formatScore } = require('./lib/badge');

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

function sourcePoster(anime) {
  const raw = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';

  try {
    const url = new URL(raw);
    const pathName = url.pathname;
    const isMalPoster = url.protocol === 'https:'
      && (url.hostname === 'cdn.myanimelist.net' || url.hostname === 'myanimelist.net')
      && pathName.includes('/images/anime/')
      && !pathName.endsWith('.gif');
    return isMalPoster ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function malLink(anime) {
  const malUrl = anime.url || (anime.mal_id ? `https://myanimelist.net/anime/${anime.mal_id}` : null);
  if (!malUrl) return null;

  const score = formatScore(anime.score);
  return {
    name: score || 'MyAnimeList',
    category: 'MAL',
    url: malUrl
  };
}

function toMetaPreview(anime, catalogGenre) {
  const name = anime.title_english || anime.title || 'Unknown Title';
  const artwork = sourcePoster(anime);
  const year = anime.year || (anime.aired?.from ? new Date(anime.aired.from).getFullYear() : null);
  const imdbId = anime.imdb_id;

  if (!imdbId) return null;

  const ratedPoster = buildPosterPath(imdbId, anime.score, artwork);
  const link = malLink(anime);
  const genres = (anime.genres || []).map((g) => g.name).filter(Boolean);
  if (catalogGenre && !genres.some((g) => g.toLowerCase() === catalogGenre.toLowerCase())) {
    genres.unshift(catalogGenre);
  }
  const meta = {
    id: imdbId,
    type: 'series',
    name,
    poster: ratedPoster || artwork || undefined,
    background: artwork || undefined,
    description: anime.synopsis
      ? anime.synopsis.slice(0, 280) + (anime.synopsis.length > 280 ? '...' : '')
      : '',
    genres,
    year: year ? String(year) : undefined,
    releaseInfo: catalogGenre || (year ? String(year) : undefined),
    runtime: anime.duration || undefined,
    country: 'JP',
    status: anime.status || 'Released',
    language: 'ja'
  };

  if (link) meta.links = [link];

  return meta;
}

function enrichMeta(meta, found) {
  meta.country = 'JP';
  meta.language = 'ja';
  const link = malLink(found);
  if (link) meta.links = [link];
  return meta;
}

function publicBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

const manifestBase = {
  id: 'com.malstremio.anime',
  version: '2.0.2',
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
    if (id === 'my-mal') {
      const username = getUsername(config);
      if (!username) return { metas: [] };

      const status = listStatusFromGenre(extra.genre);
      if (!status) return { metas: [] };
      const rawData = await getListData(username, status);
      const page = prepareUserCatalog(rawData, search, skip);
      return { metas: page.map((anime) => toMetaPreview(anime)).filter(Boolean) };
    }

    let rawData = [];
    let seasonLabel;

    if (id === 'mal-top-rated') {
      const season = seasonFromGenre(extra.genre);
      seasonLabel = season?.label;
      console.log(`[catalog] mal-top-rated genre=${JSON.stringify(extra.genre)} -> ${seasonLabel || 'none'}`);
      if (season) {
        rawData = await getSeasonData(season.year, season.season, 'rated');
      }
    }

    const page = prepareSeasonalCatalog(rawData, id, search, skip, 100);
    return { metas: page.map((anime) => toMetaPreview(anime, seasonLabel)).filter(Boolean) };
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
app.set('trust proxy', true);
app.use((_, res, next) => {
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', `max-age=${HTTP_CACHE_MAX_AGE}, public`);
  }
  next();
});

app.get('/poster/:imdbFile', async (req, res) => {
  const match = String(req.params.imdbFile || '').match(/^(tt\d+)\.jpg$/);
  const src = String(req.query.src || '');

  if (!match) {
    res.status(404).end();
    return;
  }

  try {
    const jpeg = await renderRatedPoster({
      imdbId: match[1],
      score: req.query.score,
      src
    });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.end(jpeg);
  } catch (err) {
    console.warn(`[poster] ${match[1]}: ${err.message}`);
    if (isAllowedImageUrl(src)) {
      res.redirect(src);
      return;
    }
    res.status(404).end();
  }
});

// Stremio requires absolute poster URLs. Catalog responses are built without
// the request host, so rewrite the relative /poster paths here.
app.use((req, res, next) => {
  if (!/\/(catalog|meta)\//.test(req.path)) {
    next();
    return;
  }

  const origEnd = res.end;
  res.end = function (chunk, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }

    if (chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (text.includes('"/poster/')) {
        chunk = text.replaceAll('"/poster/', `"${publicBase(req)}/poster/`);
      }
    }

    return origEnd.call(this, chunk, encoding, cb);
  };

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
  const current = getCurrentSeason();
  console.log(`  Catalogs: ${seasonalCount} seasonal (+ ${userCount} personal when username configured)`);
  if (IS_PRODUCTION && current) {
    console.log(`  Current season (${current.label}): rescraped weekly for updated ratings`);
  }
  console.log('');
  console.log('  Install seasonal catalogs without a username, or add your MAL username');
  console.log('  on the configure page for personal list catalogs at the top. List must be public.');
  console.log('');

  (async () => {
    await preloadAllUserLists();
    await preloadAllSeasons();
    scheduleCurrentSeasonRefresh();
  })();
});

server.on('error', err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});