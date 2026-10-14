# AGENTS.md

## What this is

RSS aggregator: Express 5 + Prisma 7 (SQLite via libsql) backend, React 18 + Vite
frontend. The backend serves the built frontend as static files. Formerly a Windows
+ Zen-browser project; all Zen/installer code was deliberately removed — do not
reintroduce it (no `src/zen/`, no `zen/`, no Windows service code, no `keep_alive.cjs`).

Two separate npm projects (not a workspace): repo root = backend, `frontend/` = UI.
Each needs its own `npm install`.

## Build & run

```bash
# Backend (tsc -> dist/, typecheck = the build, no separate lint/typecheck script)
npm install && npm run build

# Frontend (tsc && vite build -> frontend/dist/)
cd frontend && npm install && npm run build

# Migrations (needs DATABASE_URL from .env; prisma.config.ts reads it)
npx prisma migrate deploy        # apply existing
npx prisma migrate dev           # create a new migration after editing schema.prisma
npx prisma generate              # re-run after any schema change

npm run dev                      # backend with tsx watch (port 3000)
cd frontend && npm run dev       # vite dev server on :5173, proxies /api and /feeds to :3000
```

Order matters on a fresh checkout: `npm install` -> `prisma generate` -> `migrate deploy`
-> `build` -> start. The UI is served from `process.cwd()/frontend/dist` (SPA fallback
500s without it), so always build the frontend and start node from the repo root.

## Environment & database gotchas

- `.env` is gitignored; create it with `DATABASE_URL="file:./prisma/dev.db"`.
  Both the Prisma CLI and runtime resolve this relative to the repo root.
  Do not use `file:./dev.db`: the CLI would create it at the repo root while
  `src/services/db.ts` remaps that exact string to `prisma/dev.db` — they diverge.
- DB file is `prisma/dev.db` (gitignored via `*.db`). Delete it and re-run
  `migrate deploy` to reset.
- `npm install` (npm 12) blocks postinstall scripts; `package.json` `allowScripts`
  already approves prisma/@prisma/engines/esbuild. Approve new ones with
  `npm install-scripts approve <pkg>` or installs will silently lack binaries.
- ESM + NodeNext: every relative import in `src/` and `scripts/` must end in `.js`
  even though the source is `.ts`. Express 5 wildcard routes use `/*splat`, not `*`.

## API semantics worth knowing

- `ttl` on a feed: minutes between auto-refreshes. `ttl = 0` means auto-refresh is
  disabled — the feed is only fetched if never fetched, or on explicit refresh
  (`?ttl=0` on `GET /feeds/:id`, or `POST /api/feeds/:id/refresh`). This is intentional,
  not a bug (vestige of the removed Zen integration).
- `POST /api/items/read` with no `ids`/`feedId` marks **every** unread item read.

## Tests

- `npm run test-endpoints` — spins its own server on port 3001 (plus 3002/3003 for
  fixture feed servers). Hits the live internet (YouTube, Reddit, 4chan) and mutates
  `prisma/dev.db` (creates/deletes named test feeds, bulk-marks items read). Flaky by
  nature; not offline-safe.
- `npm run test-browser` — Playwright on port 3002; requires `npx playwright install chromium`.
- `frontend` `lint` script exists but there is no ESLint config — it will fail. Ignore it.
- There is no CI.

## Deployment

systemd **user** service; unit template lives in the repo (`systemd/rss-server.service`).

```bash
./systemd/install.sh                    # renders unit with absolute repo paths -> ~/.config/systemd/user/
systemctl enable --now --user rss-server
systemctl --user restart rss-server     # after rebuilds (npm run build in both dirs first)
```

The installed unit bakes in absolute paths at install time — if the repo moves, re-run
`install.sh`. `loginctl enable-linger $USER` is needed for boot start before login.
