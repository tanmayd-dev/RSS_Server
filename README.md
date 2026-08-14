# RSS Aggregator + RSS Sync (Zen Browser)

A local RSS aggregation stack with three parts:

| Part | What it is |
|---|---|
| **Server** (`src/`) | Express + Prisma (SQLite) API that collects feeds from RSS, HTML scraping, Reddit, YouTube and 4chan, and re-serves them as a single RSS feed per aggregation. |
| **Frontend** (`frontend/`) | React + Vite + Tailwind UI to manage feeds, test sources, and read items (read/unread state). Built to `frontend/dist` and served by the server. |
| **Zen integration** (`zen/`) | Mirrors each feed into a Zen Browser **live folder** — folders appear, rename and delete automatically as feeds change. |

The whole stack is designed to run locally (server defaults to `http://localhost:3000`).

## Documentation map

- **[`zen/README.md`](zen/README.md)** — the Zen Browser integration: what it does, installer, manual install, autostart of the RSS server, mod preferences.
- **[`zen/INSTALL_CHECKLIST.md`](zen/INSTALL_CHECKLIST.md)** — step-by-step manual install + validation checklist for a real Zen profile.
- **[`zen/loader/README.md`](zen/loader/README.md)** — vendored **fx-autoconfig** script loader (third-party, pinned) used by the Zen engine.
- **[`frontend/README.md`](frontend/README.md)** — the web UI: dev server, production build, structure.
- **`src/`** — server source. Entry: `src/index.ts`; routes: `src/routes.ts`; feed fetching: `src/services/scraper.ts` + `src/services/feedManager.ts`; RSS generation: `src/services/feedGenerator.ts`; DB: `src/services/db.ts`.
- **`scripts/`** — utilities and test suites (see [Testing](#testing)).

## Quick start

Requirements: **Node ≥ 22** (the installer SEA build needs it; 20+ works for the server), npm.

```bash
# 1. Install dependencies
npm install
cd frontend && npm install && cd ..

# 2. Prepare the database (SQLite file, migrations in prisma/migrations)
npx prisma migrate deploy

# 3. Run the server (tsx watch in dev, or build + start)
npm run dev            # http://localhost:3000

# 4. Frontend — either the Vite dev server (hot reload) or a production build
cd frontend
npm run dev            # dev UI at http://localhost:5173 (API still on :3000)
# or
npm run build          # static build → served by the server at http://localhost:3000
```

Then open the UI, add a feed, and (optionally) set up the Zen integration —
see [zen/README.md](zen/README.md) and the **Autostart the RSS server** section
there so the server is running whenever Zen syncs.

## Source types

Each feed contains one or more **sources**. A feed is refreshed when its TTL
expires, and its items are aggregated into one RSS feed.

| Type | URL | Config (JSON) |
|---|---|---|
| `rss` | any RSS/Atom feed URL | — |
| `html` | any static page | `{ "itemSelector", "titleSelector", "linkSelector", "descriptionSelector"?, "pubDateSelector"? }` |
| `reddit` | subreddit URL or `r/javascript`-style handle | — |
| `youtube` | channel URL or `@handle` (channel IDs work too) | `{ "includeShorts"?: boolean }` (default `true`) |
| `fourchan` | any board URL | `{ "board": "g", "query": "search", "topN"?: number }` (default `topN` 10) |

> YouTube channel pages and their RSS feeds intermittently answer with Google
> 404/500 pages even for valid channels (bot mitigation). The server retries
> these transient failures automatically, so a single flaky answer doesn't fail
> a refresh.

## TTL & refresh semantics

- The stored feed **TTL** is the number of minutes between automatic re-scrapes.
- **TTL `0`** disables auto-refresh (a "Zen-only" feed): it is fetched only when
  never fetched, or when explicitly asked to refresh.
- `GET /feeds/:id?ttl=0` **forces** a refresh — this is what Zen live folders use,
  so every folder refresh re-scrapes.
- `POST /api/feeds/:id/refresh` forces a refresh too (returns JSON).
- Duplicate sources inside one feed are fetched only once per refresh.

## API

The server is loopback-oriented (bound to `localhost`; CORS is open for the
frontend and the Zen mod). JSON API unless noted.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/api/feeds` | Create feed: `{ name, sources: [{url, type, config?}], ttl? }` |
| `GET` | `/api/feeds` | List feeds (with `unreadCount` per feed) |
| `GET` | `/api/feeds/:id` | Feed detail + sources + items |
| `PUT` | `/api/feeds/:id` | Update feed metadata and sync sources |
| `DELETE` | `/api/feeds/:id` | Delete feed (cascades sources + items) |
| `POST` | `/api/feeds/test` | Test a source without saving: `{ type, url, config? }` |
| `POST` | `/api/feeds/:id/refresh` | Force a refresh and return the updated feed |
| `GET` | `/feeds/:id` | Generated **RSS XML** for the feed (`?ttl=N` overrides, `?ttl=0` forces) |
| `GET` | `/api/items` | Reader listing: `?feedId`, `?unreadOnly=true`, `?limit` (≤200), `?offset`, `?since` |
| `PATCH` | `/api/items/:id` | Mark item read: `{ read: boolean }` |
| `POST` | `/api/items/read` | Bulk mark read: `{ ids? }` or `{ feedId? }` or `{}` (everything) |
| `GET` | `/api/zen/status` | Read-only status of the Zen integration |

## Testing

| Command | What it covers |
|---|---|
| `npm run test-endpoints` | HTTP endpoints end-to-end: sources, TTL/`?ttl=0`, dedup, reader read/unread, Zen status (uses the dev DB, cleans up after itself) |
| `npm run test-installer` | Zen installer: discovery, install/status/uninstall, idempotency, safety (offline, no admin) |
| `npm run test-uc` | Zen userChrome engine logic (offline mocks) |
| `npm run test-browser` | Playwright-driven browser checks |
| `npx tsc --noEmit` | Typecheck the server |

## Scripts & tools

- `npm run dev` / `npm start` — server (watch / built `dist/`).
- `scripts/keep_alive.cjs` — keep-alive wrapper: starts `dist/index.js` and
  restarts it if it exits (logs to `server.log`). Used by the autostart scripts.
- `scripts/start_hidden.ps1`, `start.bat` — launch `keep_alive.cjs` headless
  (paths inside are hardcoded to this checkout — edit before using elsewhere).
- `npm run build-installer` — build `dist-zen/zen-install.exe` (Node SEA) for the
  Zen integration one-command installer.
- `npm run zen-install` / `zen-status` / `zen-uninstall` — run the installer CLI
  from source (see `src/zen/cli.ts`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `DATABASE_URL` | `file:dev.db` | SQLite database file (relative to the project root) |

`ZEN_PROFILE_ROOT` / `ZEN_PROGRAM_DIR` (installer-only) override Zen discovery;
see `src/zen/installer.ts`. The Zen engine reads `mod.rsssync.*` preferences —
documented in [zen/README.md](zen/README.md).
