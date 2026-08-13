# RSS Aggregator ↔ Zen Browser — Implementation Progress

> Living document. Updated after **every** implementation step with: what changed,
> files touched, how it was verified, and the next step. Latest entry at the bottom.

## Status at a glance

| Step | Description | Status |
|---|---|---|
| 1 | Server: `?ttl=` honored, `ttl: 0` = auto-refresh disabled, source dedup + offline tests | ✅ Done |
| 2 | Zen engine prototype (`uc.js`) + package folders (`mod/` + `uc/`) + smoke test | ✅ Done |
| 3 | Frontend "Zen integration" panel (Zen URL copy, Zen-only badge, install helper) | ✅ Done |
| 4 | Engine hardening, install checklist, publish prep | ✅ Done |

## Plan overview

- **Step 1 — Server foundations.** Make `GET /feeds/:id` honor `?ttl=` (so Zen can force
  server refreshes with `?ttl=0`), let feeds disable auto-refresh (`ttl: 0` = Zen-only),
  and dedupe identical sources inside one feed.
- **Step 2 — Zen engine + package layout.** A `uc.js` script (fx-autoconfig/Sine) that
  mirrors server feeds as native Zen Live Folders (one folder per feed, subscribed to
  `{server}/feeds/{id}?ttl=0`), plus a CSS mod for visuals/settings, in a `zen/` folder.
- **Step 3 — Frontend integration.** A "Zen" panel in the RSS Aggregator frontend:
  per-feed copy-Zen-URL, "Zen-only" badge when auto-refresh is off, install instructions.
- **Step 4 — Harden & ship.** Manual install checklist + real-profile validation, engine
  hardening (multi-window, manual-rename detection), publish the mod.

---

## Step 1 — Server: TTL, Zen-only mode & dedup ✅

**Date:** 2026-08-13 · **Goal:** make the server behave correctly as a Zen live-folder backend.

### Changes

- **`src/services/feedManager.ts`**
  - `updateFeedIfNeeded(feedId, ttl, opts)` gains `opts.force` (always re-fetch — explicit
    refresh) and `opts.disabled` (only fetch sources never fetched — Zen-only mode).
  - Per-run **source dedup**: sources with the same type + normalized URL + config are
    fetched **once**; duplicates reuse the results (items, `resolvedUrl`) and stay in sync.
- **`src/routes.ts`**
  - `GET /feeds/:id` now honors `?ttl=` (the comment claimed it, the code ignored it):
    `?ttl=0` forces a refresh on every call; `?ttl=N` uses that expiry; no param → stored TTL.
  - Stored **`ttl: 0` disables auto-refresh** (Zen-only): cache is served, only refreshed on
    explicit demand (`?ttl=0` / `POST /api/feeds/:id/refresh`) or first fetch.
  - TTL parsing fixed: `0` can now be saved (previously the falsy check silently defaulted
    to 15) and is validated as a non-negative integer.
  - `POST /api/feeds/:id/refresh` uses explicit `force`.
- **`frontend/src/App.tsx`**
  - TTL dropdown: added **"Off — no auto-refresh (Zen-only)"**.
  - Feed table shows **"Off (Zen-only)"** for `ttl: 0` feeds.
- **`scripts/test_endpoints.ts`** — new offline section (local RSS source server, no
  external network): stored `ttl: 0` disables auto-refresh but `?ttl=0` still forces;
  `?ttl=0` forces every call while unexpired TTL serves cache; duplicate sources cause
  exactly one upstream fetch with deduped RSS output.

### Verification

- `npx tsc --noEmit` — pass
- `npm run test-endpoints` — **All Tests Passed** (new offline TTL/dedup checks included)

---

## Step 2 — Zen engine prototype & package folders ✅

**Date:** 2026-08-13 · **Goal:** prove the Zen-side mechanism: mirror feeds as live folders.

### Changes

New **`zen/`** package (separate folders for the deliverables):

```
zen/
├── README.md              — overview, install + config documentation
├── mod/                   — distributable Zen mod (visual layer; CSS-only)
│   ├── chrome.css         — synced badge, RSS-orange dot, refresh pulse
│   ├── preferences.json   — server_url, auto_sync, poll_interval, folder_interval, max_items
│   └── zenMod.json        — marketplace metadata
└── uc/                    — the engine (fx-autoconfig / Sine userChrome.js)
    ├── rss-sync.uc.mjs    — polls GET /api/feeds, reconciles live folders
    └── import.uc.mjs      — fx-autoconfig import aggregator
```

- **`zen/uc/rss-sync.uc.mjs`** — the engine (prototype):
  - Runs only in browser windows; waits for `ZenLiveFoldersManager` to restore state and
    pick its synced window (single-window guard).
  - Polls `GET {server}/api/feeds` (default 15 s), reconciles:
    - **Create** one live folder per feed via `gZenFolders.createFolder` +
      `nsRssLiveFolderProvider`, registered in `manager.liveFolders`, URL
      `{server}/feeds/{feedId}?ttl=0` (so every Zen refresh forces a server refresh).
    - **Rename** folder to match the server feed name.
    - **Delete** folder when the feed is removed (`manager.deleteFolder(id, true)`).
  - Config from the mod's prefs (`mod.rsssync.*` in `Services.prefs`) with built-in
    defaults; feature-detected — logs and idles if a Zen update breaks an internal API.
  - Only manages folders whose URL points at the configured server.
- **`scripts/test_uc_engine.mjs`** (`npm run test-uc`) — Node smoke test that stubs the
  Zen chrome APIs and runs the real script's reconcile logic: create one-per-feed with
  `?ttl=0` + correct config, rename, delete.
- **`package.json`** — added `test-uc` script.

### Verification

- `node --check` on the engine + JSON validation of mod files — pass
- `npm run test-uc` — **pass** (create / rename / delete asserted)
- `npx tsc --noEmit` — pass · `npm run test-endpoints` — **All Tests Passed**

### Caveats (documented in `zen/README.md`)

- Relies on Zen **internal** APIs (fragile across Zen releases; script degrades gracefully).
- Single-window: reconcile loop runs in Zen's first synced window.
- Engine renames override manual folder renames.

---

## Step 3 — Frontend "Zen integration" panel ✅

**Date:** 2026-08-13 · **Goal:** make the Zen integration visible and usable from the
RSS Aggregator frontend.

### Changes

- **`frontend/src/App.tsx`**
  - **Per-feed "Copy Zen URL"** button in the RSS URL cell — copies
    `{origin}/feeds/{feedId}?ttl=0` (the exact URL for a Zen live folder) with a green
    check feedback; the URL cell was widened to fit both copy buttons.
  - **"Zen-only" badge** in the Cache Refresh column for `ttl: 0` feeds (orange pill with
    a Zap icon + tooltip explaining Zen's folder refresh drives updates).
  - **Zen Browser Integration panel** below the feed table (collapsible):
    - server URL (with copy button) + explanation of the `/feeds/<id>?ttl=0` mapping,
    - status: feeds → live folders count, how many are Zen-only,
    - one-time install steps (fx-autoconfig, copy `zen/uc/*`, install the mod, restart),
      with a pointer to `zen/README.md`.
  - Small `copyText` helper + `zenOnlyCount` derived value.

### Verification

- `npx tsc --noEmit` (frontend) — pass · `npm run build` (production build) — pass
- **Live preview** against the running server: copy button shows check feedback; with a
  feed set to `ttl: 0` the "Zen-only" badge renders and the panel counts update.
- Note: the running server previously predated step 1 (its `ttl: 0` was silently saved as
  `15`). Rebuilt `dist/` and restarted the keep-alive server so the backend runs the
  step-1 code; the tested feed's TTL was restored to its original value afterwards.

---

## Step 4 — Harden & ship ✅

**Date:** 2026-08-13 · **Goal:** move from prototype to a validated, installable integration.

### Changes

- **`zen/uc/rss-sync.uc.mjs`** — engine hardening:
  - **Multi-window:** per-tick window election (`manager.window === win`) replaces the
    one-time gate, so the reconcile loop takes over automatically when windows open,
    close, or the first synced window changes. Folders sync across windows natively via
    `ZenWindowSync`.
  - **Manual renames preserved:** `data-rss-sync-name` tracks the last name the engine
    applied; the engine only renames a folder whose current name matches that record.
    After a restart (record gone) folders whose name matches the server are re-adopted;
    anything else is treated as user-owned and left alone.
  - **Refresh-state surface:** folders carry `rss-sync-refreshing` while a fetch is in
    flight and `data-rss-sync-last-fetched` afterwards (styled by the mod's `chrome.css`).
- **`scripts/test_uc_engine.mjs`** — extended to cover: create (URL/config/attrs),
  refresh-state attributes, server rename, **manual-rename preservation**, **window
  election**, and delete.
- **`zen/INSTALL_CHECKLIST.md`** (new) — manual install + validation checklist: loader,
  engine, mod install, features 1–3, restart/multi-window resilience, uninstall, and
  publishing steps.
- **`zen/README.md`** — layout and notes updated (multi-window, manual renames,
  refresh state, publishing note).

### Verification

- `node --check` — pass · `npm run test-uc` — **pass** (all 6 hardened scenarios)
- `npx tsc --noEmit` (server + frontend) — pass · `npm run test-endpoints` — **All Tests Passed**

### Remaining (user-side, documented in the checklist)

- Real-profile validation via `zen/INSTALL_CHECKLIST.md`.
- Publish the mod: replace `zenMod.json` placeholder URLs with hosted HTTPS assets and submit.

---

## Follow-up — Real links for install steps ✅

**Date:** 2026-08-13 · **Goal:** replace generic "install a loader" text with concrete, working URLs.

### Changes

- **`frontend/src/App.tsx`** — the Zen panel's install steps now link to the real tools:
  - [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)
  - [Sine](https://github.com/CosmoCreeper/Sine)
  - [Zen Mods marketplace](https://zen-browser.app/mods/)
- **`zen/README.md`** and **`zen/INSTALL_CHECKLIST.md`** — same links added to the docs.

### Verification

- `npx tsc --noEmit` (frontend) — pass · `npm run build` (production build) — pass

---

## Step 5 — Windows installer executable (GitHub Releases) ✅

**Date:** 2026-08-13 · **Goal:** turn the manual install into a downloadable Windows
installer, per the user's answers to the installer-plan decisions (executable hosted on
GitHub Releases + downloadable from the UI; vendor + auto-install the loader; prefs left
to the user; default-profile targeting; Windows only).

### Changes

- **`src/zen/installer.ts`** (new) — core installer module, zero runtime deps:
  `discoverProfiles` (profiles.ini parsing, default profile, running detection),
  `status` / `install` / `uninstall` with atomic writes + timestamped backups, a
  byte-identical overwrite policy (never clobbers user-edited files), lock-file refusal
  without `--force`, and **prefs left to the user** (never writes `user.js`/`prefs.js`).
- **`src/zen/cli.ts`** (new) — the CLI (`status` / `install` / `uninstall`, flags
  `--profile`, `--all`, `--profile-root`, `--zen-program-dir`, `--dry-run`, `--force`,
  `--json`); runs via tsx in dev and is the exe's entry in production.
- **`zen/loader/`** (new) — vendored **fx-autoconfig** (pinned commit `dfdab568`,
  MPL-2.0 attribution in `zen/loader/README.md`): `program/` files go next to `zen.exe`
  (found via `--zen-program-dir`, PATH, or common install folders), `profile/chrome/utils/`
  goes into the profile. Auto-installed when no loader is detected; Sine and other
  existing loaders are detected and left alone.
- **`scripts/test_installer.ts`** (`npm run test-installer`) — 17 offline tests on a fake
  profile tree: install placement, idempotency (no writes/backups on re-run),
  zen-themes.json merge preserving other mods, running-profile refusal, user-edit
  no-clobber, dry-run, invalid-JSON degradation, uninstall round-trip.
- **`scripts/build_installer.mjs`** (`npm run build-installer`) — embeds the zen/ package
  files, bundles the CLI with esbuild, and builds a Node **Single Executable
  Application** (SEA + postject) → `dist-zen/zen-install.exe` (~99 MB, self-contained).
- **`scripts/publish_release.mjs`** (`npm run publish-installer`) — publishes via `gh`:
  tag `zen-installer-v<version>`, create-or-clobber asset, prints the `latest/download`
  URL. **`zen-installer-v1.0.0` is live** on
  <https://github.com/tanmayd-dev/RSS_Server/releases> (repo is private — downloads
  require a GitHub login in the browser).
- **`frontend/src/App.tsx`** — the Zen panel's "Install (one-time)" steps are replaced
  with a **"Download zen-install.exe"** button (GitHub latest-release asset URL), the
  exe command summary, the manual-prefs note, and the old steps collapsed under
  "Manual install (fallback)".
- **`package.json`** — scripts: `zen-status`, `zen-install`, `zen-uninstall`,
  `test-installer`, `build-installer`, `publish-installer`; devDeps: `esbuild`,
  `postject`. `INSTALLER_PLAN.md` status → implemented.

### Verification

- `npm run test-installer` — **17 passed, 0 failed**
- `npx tsc --noEmit` (server) — pass · `cd frontend && npm run build` — pass
- `npm run test-endpoints` / `npm run test-uc` — pass (regressions) — see final run below
- exe smoke test: `--help`, `status` on this machine (Zen not installed → graceful
  "Zen not found"), and a full install → status → uninstall round-trip against a fake
  profile tree inside the exe (embedded files verified working).

### Remaining (user-side)

- Real-profile validation on a machine with Zen installed (`zen/INSTALL_CHECKLIST.md`).
- Marketplace publishing of the mod stays manual.

---

## 🎉 Plan complete

All four steps are done. Features 1–3 (live folder per feed, best-effort sync with Zen's
refresh, force update server-then-Zen) are implemented across the server, the Zen engine,
and the frontend, with automated tests plus a manual checklist for real-profile validation.

**Next (user-side, documented in `zen/INSTALL_CHECKLIST.md`):**
1. Real-profile install + validation (loader → engine → mod → features 1–3).
2. Publish the mod: replace `zenMod.json` placeholder URLs with hosted HTTPS assets and submit.
