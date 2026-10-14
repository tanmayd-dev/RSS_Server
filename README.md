# rss-aggregator

Self-hosted feed aggregator that merges **RSS, scraped websites, Reddit, YouTube, and 4chan** into unified feeds — each with its own public RSS URL and a built-in reader UI.

## Features

- **Multi-source feeds** — combine any number of sources into one feed:
  - `rss` — any standard RSS/Atom feed
  - `html` — scrape any webpage with CSS selectors (title, link, description, date)
  - `reddit` — any subreddit (`r/selfhosted` or full URL)
  - `youtube` — channels, handles, or existing feed URLs, with optional **Shorts filtering** (HEAD-request detection + DB-cached channel resolution)
  - `4chan` — catalog search with wildcard queries, ranked by reply count
- **Smart refresh** — per-feed TTL caching (`0` = refresh on demand only), forced refresh, and duplicate-source fetch deduplication
- **Reader UI** — paginated reader with unread badges/counts, unread-only filter, single/bulk mark-as-read, live source tester, dark mode
- **Public RSS output** — every feed gets a shareable `GET /feeds/:id` RSS 2.0 endpoint (latest 50 items, newest first)
- **Resilient scraping** — retries with backoff, desktop user-agents, relative-URL resolution
- **One-binary deploy** — Express serves the built React frontend + API; ships with a systemd user unit

## Tech Stack

- **Backend:** TypeScript, Express 5, Prisma 7 + SQLite (libSQL), `rss-parser`, `axios` + `cheerio`, `feed` (RSS emit)
- **Frontend:** React 18, Vite 5, TypeScript, Tailwind CSS, lucide-react
- **Infra:** systemd user service, Playwright + tsx integration scripts

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# 1. Backend
npm install
echo 'DATABASE_URL="file:./prisma/dev.db"' > .env
npx prisma generate
npx prisma migrate deploy

# 2. Frontend (separate project)
cd frontend && npm install && npm run build && cd ..
```

### Run

```bash
# Development (backend :3000, frontend dev server :5173 proxies /api and /feeds)
npm run dev
cd frontend && npm run dev

# Production (serves API + built frontend on :3000)
npm run build
npm start
```

Open `http://localhost:3000` (prod) or `http://localhost:5173` (dev).

### Deploy (systemd)

```bash
./systemd/install.sh
systemctl enable --now --user rss-server
```

## API Reference

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `POST` | `/api/feeds` | Create feed `{name, sources[{url, type, config?}], ttl?}` |
| `GET` | `/api/feeds` | List feeds with unread counts |
| `GET` | `/api/feeds/:id` | Feed + sources + items |
| `PUT` | `/api/feeds/:id` | Update feed (transactional source sync) |
| `DELETE` | `/api/feeds/:id` | Delete feed (cascades) |
| `GET` | `/api/items?feedId=&unreadOnly=&limit=&offset=&since=` | Query items (max 200/page) |
| `PATCH` | `/api/items/:id` | Set `{read: boolean}` |
| `POST` | `/api/items/read` | Mark `{ids?}` / `{feedId?}` / all as read |
| `POST` | `/api/feeds/test` | Dry-run a source, preview parsed items |
| `POST` | `/api/feeds/:id/refresh` | Force refresh now |
| `GET` | `/feeds/:id?ttl=` | Public RSS 2.0 XML |
| `GET` | `/health` | Health check |

Source `type` is one of `rss | html | reddit | youtube | fourchan`. HTML sources take `{itemSelector, titleSelector, linkSelector, descriptionSelector?, pubDateSelector?}`; YouTube takes `{includeShorts?}`; 4chan takes `{board, query, topN?}`.

## Project Structure

```
src/
├── index.ts            # Express app, static frontend serving, SPA fallback
├── routes.ts           # REST API
├── types.ts            # Shared feed/source types
└── services/
    ├── db.ts           # Prisma + SQLite singleton
    ├── feedManager.ts  # TTL scheduling, dedup, fetch orchestration
    ├── scraper.ts      # RSS/HTML/Reddit/YouTube/4chan fetchers
    └── feedGenerator.ts# RSS 2.0 XML generation
prisma/                 # Schema + migrations (Feed, FeedSource, FeedItem)
frontend/src/           # React reader UI (feed table, reader modal, editor)
scripts/                # Endpoint, browser, and DB test scripts
systemd/                # Production service unit + installer
```
