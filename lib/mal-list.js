const cheerio = require('cheerio');
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

function isLegacyListLayout(html) {
  return /class="table_header"/.test(html) && !extractDataItemsAttribute(html);
}

function parseLegacyListItemsFromHtml(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('a.animetitle').each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';
    const idMatch = href.match(/\/anime\/(\d+)/);
    if (!idMatch) return;

    const row = link.closest('tr');
    const cells = row.find('td');
    const scoreClass = row.find('.score-label').attr('class') || '';
    const scoreMatch = scoreClass.match(/score-(\d+)/);
    const epsText = cells.eq(4).text().replace(/\s+/g, '');
    const epsMatch = epsText.match(/(\d+)\/(\d+)/);

    items.push({
      mal_id: parseInt(idMatch[1], 10),
      title: link.find('span').text().trim() || link.text().trim(),
      title_english: link.find('span').text().trim() || link.text().trim(),
      title_japanese: null,
      images: { jpg: { large_image_url: null, image_url: null } },
      score: null,
      user_score: scoreMatch ? parseInt(scoreMatch[1], 10) : 0,
      popularity: null,
      genres: [],
      year: null,
      num_episodes: epsMatch ? parseInt(epsMatch[2], 10) : null,
      num_watched_episodes: epsMatch ? parseInt(epsMatch[1], 10) : 0,
      status: null,
      media_type: cells.eq(3).text().trim() || null,
      updated_at: null,
      url: href.startsWith('http') ? href : `https://myanimelist.net${href}`
    });
  });

  return items;
}

function parseListItemsFromHtml(html) {
  const raw = extractDataItemsAttribute(html);

  if (raw) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(raw));
      const entries = Array.isArray(parsed) ? parsed : [];
      return { items: entries.map(mapListItem), error: null };
    } catch (err) {
      return { items: [], error: `parse_error:${err.message}` };
    }
  }

  if (isLegacyListLayout(html)) {
    return { items: parseLegacyListItemsFromHtml(html), error: null };
  }

  return { items: [], error: 'no_list_table' };
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

  return items;
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