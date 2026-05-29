# MAL Seasonal Anime — Stremio Addon

A lightweight Stremio addon that brings the **highest-rated seasonal anime** directly into your Stremio library using data from MyAnimeList.

This addon provides catalogs and metadata only. Pair it with Torrentio (or similar) for streams.

![Stremio](https://img.shields.io/badge/Stremio-Addon-blue)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- Catalogs named **MAL Top Rated - {Season} {Year}**
- Includes the current season + previous seasons going back ~5 years
  - Examples: "Spring 2025", "Winter 2024", "Fall 2021", etc.
  - ~22 catalogs total
  - All support search + pagination
- Rich metadata pages (synopsis, genres, MAL score, trailers when available, direct MAL link)
- Polite rate limiting + retries + on-demand loading for older seasons
- Uses only raw `tt` (IMDb) IDs — e.g. `tt1234567` (idPrefixes: ["tt"])
- IMDb IDs are resolved live by scraping each anime's MyAnimeList page and extracting the link from the "External Links" section.
- Only titles that have a public IMDb entry linked on MAL are included (this means some seasons will have fewer than 25 titles).
- Designed for maximum compatibility with Torrentio and similar stream addons that work best with standard IMDb IDs.

## Installation

### Local Development

```bash
git clone https://github.com/yourname/mal-stremio.git
cd mal-stremio
npm install
npm start
```

Then open Stremio → Add-ons → **Add addon** and paste:

```
http://127.0.0.1:3001/manifest.json
```

### Production (Recommended)

Deploy with one click on **Railway**, **Render**, or **Fly.io**:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/yourname/mal-stremio)

Or manually:

1. Push this repo to GitHub
2. Connect to Railway / Render / any Node host
3. Set start command: `npm start`
4. Use the generated public URL + `/manifest.json`

Example public manifest URL:
```
https://your-app.up.railway.app/manifest.json
```

## How to Use

1. Install the addon using the manifest URL.
2. Go to **Discover** (or **Board**).
3. You will see catalogs named:
   - **MAL Top Rated - Spring 2026** (current season)
   - **MAL Top Rated - Winter 2025**, **MAL Top Rated - Fall 2025**, etc. for previous seasons
4. Search inside the rows using the search bar.
5. Click any title to see full details (synopsis, genres, trailer, MAL link).

### Streams (Torrentio Recommended)

This addon provides **catalogs and metadata only**. It does **not** provide any streams or external links.

**For actual playable streams**, install **Torrentio** (or another stream addon):

1. Install Torrentio (https://torrentio.strem.fun/)
2. In Stremio → Settings → Add-ons, make sure **Torrentio** has higher priority than this addon for streams.
3. Open any title from the "MAL Top Rated" catalogs — Torrentio will automatically provide streams using the raw `tt` (IMDb) IDs.

Because we use standard IMDb IDs (resolved from MAL), compatibility with Torrentio and most other stream addons is excellent. Note that only titles that have an IMDb link listed on their MyAnimeList page will appear in the catalogs.

## Technical Details

| Aspect           | Implementation                                      |
|------------------|-----------------------------------------------------|
| Data source      | Direct scraping of myanimelist.net/anime/season (respectful, slow) |
| Seasons covered  | Current season + last ~5 years                      |
| Focus            | Highest rated only (`anime_score`)                  |
| Update frequency | Every 4 hours (recent seasons)                      |
| Max titles       | Up to 500 titles per season (with pagination)       |
| Caching          | Per-season, 4h TTL + on-demand loading              |
| Rate limit       | Polite client-side limiting                         |
| Authentication   | None (public scraping with delays)                  |
| ID scheme        | Raw `tt` (IMDb) IDs only. Resolved using `name-to-imdb` (official Stremio recommendation) + titles from MAL pages. Cached locally in `data/imdb-cache.json`. |

## Development

```bash
npm run dev     # auto-reload on file changes (Node 22+)
```

### Environment Variables

- `PORT` — HTTP server port (default: 3001)
- `NODE_ENV=production` — Enables production mode:
  - Season data is cached for **1 month** before re-scraping MyAnimeList.
  - HTTP cache headers are set to 1 hour (instead of 5 seconds).

No API keys or secrets are required.

All IMDb IDs are resolved using the `name-to-imdb` package + titles scraped from MyAnimeList.

## Why "Highest Rated Seasonal"?

MyAnimeList publishes seasonal pages (https://myanimelist.net/anime/season) that list every anime airing that season, with community scores. This addon scrapes the first page of each season (respectfully) and returns only the highest-rated TV titles, sorted by MAL score.

We scrape the public seasonal pages directly (instead of the official MAL API) because it gives us the full first-page results that users actually see on the website, with no artificial limits.

## Troubleshooting

**No titles (or very few titles) showing in a catalog?**
- Many seasonal anime simply do not have an IMDb page (or no link on MAL). Those titles are intentionally dropped so we only ever output valid `tt` IDs.
- Check the server logs — you will see messages like `[imdb] No IMDb external link found for mal:XXXXX — dropping from catalog`.
- The first load of each season is slower because we do an extra polite request per title to its MAL page to find the IMDb link (cached for 4 hours after that).

**Streams not appearing for a title?**
- Make sure Torrentio is installed and has **higher priority** than this addon in Stremio's add-on settings.
- Only titles that have an IMDb link on their MAL page appear (raw `tt` IDs). Try a hard refresh after adding.
- Some very new or obscure titles may have fewer seeders.

**Addon not appearing in Discover / catalogs not updating?**
- Use the timestamped manifest URL (`?t=...`) when adding.
- After any manifest change, you usually need to **remove the addon completely from Stremio and re-add it**.
- On Stremio Web, do a hard refresh (Ctrl/Cmd + Shift + R) after re-adding.

**Want more catalogs?**
This addon is intentionally focused only on the highest-rated titles from each seasonal page. For many additional MAL/AniList catalogs (genres, studios, top all-time, etc.) consider pairing it with the excellent [Anime Catalogs](https://github.com/jaruba/stremio-anime-catalogs) community addon.

**Scraping issues or blocked requests?**
- The scraper adds delays (~4.5s between season requests) to be respectful to MAL.
- If selectors break (MAL changes their HTML), titles may be missing — check the logs and open an issue.

## Credits

- Data scraped respectfully from [MyAnimeList](https://myanimelist.net/) seasonal pages (first page only)
- IMDb IDs discovered from "External Links" on MyAnimeList title pages
- Built with the official [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- Inspired by the vibrant Stremio anime community

## License

MIT

---

Made for anime fans who want the current season's best shows in one place inside Stremio.
