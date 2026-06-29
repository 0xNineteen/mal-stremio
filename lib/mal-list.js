const { fetchMal } = require('./mal-fetch');

const LIST_STATUSES = {
  watching: { malStatus: 1, catalogId: 'watching', name: 'Watching' },
  completed: { malStatus: 2, catalogId: 'completed', name: 'Completed' },
  'on-hold': { malStatus: 3, catalogId: 'on-hold', name: 'On Hold' },
  'plan-to-watch': { malStatus: 6, catalogId: 'plan-to-watch', name: 'Plan to Watch' }
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function extractDataItemsAttribute(html) {
  const match = html.match(/<table[^>]*class="list-table"[^>]*data-items="([^"]+)"/i)
    || html.match(/data-items="([^"]+)"/);

  return match ? match[1] : null;
}

function parseListItemsFromHtml(html) {
  const raw = extractDataItemsAttribute(html);

  if (!raw) {
    return { items: [], error: 'no_list_table' };
  }

  try {
    const parsed = JSON.parse(decodeHtmlEntities(raw));
    return { items: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (err) {
    return { items: [], error: `parse_error:${err.message}` };
  }
}

function mapListItem(entry) {
  const genres = (entry.genres || []).map(g => ({ name: g.name }));

  return {
    mal_id: entry.anime_id,
    title: entry.anime_title,
    title_english: entry.anime_title_eng || entry.anime_title,
    title_japanese: entry.title_localized || null,
    images: {
      jpg: {
        large_image_url: entry.anime_image_path,
        image_url: entry.anime_image_path
      }
    },
    score: typeof entry.anime_score_val === 'number' ? entry.anime_score_val : null,
    user_score: entry.score || 0,
    popularity: entry.anime_popularity || null,
    genres,
    year: null,
    num_episodes: entry.anime_num_episodes,
    num_watched_episodes: entry.num_watched_episodes,
    status: entry.anime_airing_status,
    media_type: entry.anime_media_type_string,
    updated_at: entry.updated_at,
    url: entry.anime_url ? `https://myanimelist.net${entry.anime_url}` : `https://myanimelist.net/anime/${entry.anime_id}`
  };
}

async function fetchListPage(username, malStatus, offset = 0) {
  const url = `https://myanimelist.net/animelist/${encodeURIComponent(username)}?status=${malStatus}&offset=${offset}`;

  const res = await fetchMal(url);

  if (res.status === 404) {
    throw new Error(`MAL user "${username}" not found`);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch animelist page: HTTP ${res.status}`);
  }

  const html = await res.text();

  if (/This list is private/i.test(html) || /list is not available/i.test(html)) {
    throw new Error(`MAL list for "${username}" is private or unavailable`);
  }

  const { items, error } = parseListItemsFromHtml(html);

  if (error === 'no_list_table') {
    if (offset === 0) {
      throw new Error(`Could not parse animelist for "${username}" — page structure may have changed`);
    }
    return [];
  }

  return items.map(mapListItem);
}

async function scrapeUserAnimelist(username, statusKey) {
  const statusConfig = LIST_STATUSES[statusKey];
  if (!statusConfig) {
    throw new Error(`Unknown list status: ${statusKey}`);
  }

  // One MAL request per list — caller caps how many titles are kept/resolved.
  return fetchListPage(username, statusConfig.malStatus, 0);
}

module.exports = {
  LIST_STATUSES,
  scrapeUserAnimelist
};