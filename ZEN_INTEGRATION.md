# Zen Browser Integration — Research & Design Sketch

> Status: research + rough sketch only. No code changes made.
> Research date: 2026-08-13, against Zen `stable` branch source
> (zen-browser/desktop, Live Folders feature since ~v1.19, March 2026).
>
> **Updated 2026-08-13 (decisions made & step 1 shipped):**
> - One folder per feed (with source dedup) — mapping (a) is the chosen design.
> - Option A (`?ttl=0` folder URLs) plus a per-feed **auto-refresh disabled** mode (`ttl: 0`):
>   if a feed is only consumed by Zen, Zen's polls are the only refreshes, no server-side auto-refresh.
> - Step 1 of "Suggested next steps" is **done**: `GET /feeds/:id` now honors `?ttl=`
>   (stored `ttl: 0` disables auto-refresh; `?ttl=0` always forces), duplicate sources
>   in one feed are fetched only once, and offline tests cover all three behaviors.

## 1. How Zen mods work (verified in source)

A Zen mod is a folder in the profile at `chrome/zen-themes/<modId>/` containing:

- `chrome.css` — the mod's styling
- `preferences.json` — user-facing settings (checkbox / dropdown / string), surfaced
  as CSS variables and `@media (-moz-pref("..."))` queries
- (from the marketplace) `zenMod.json` metadata

The loader (`src/zen/mods/ZenMods.mjs`) concatenates every enabled mod's `chrome.css`
into `chrome/zen-themes.css` and injects it into browser windows. **That is all mods
do — they are strictly CSS + static preferences. There is no JavaScript execution
whatsoever in the mod system.** A mod cannot create folders, call the network, or talk
to our RSS server.

To run JS with full browser-chrome privileges on Zen, the community-standard mechanism
is an **autoconfig loader** — `fx-autoconfig` (MrOtherGuy) or the Sine mod manager —
which evaluates `.uc.mjs` scripts placed in `<profile>/chrome/JS/`. This is confirmed
working on Zen (e.g. github.com/BibekBhusal0/zen-custom-js). Such scripts run in the
browser window context with access to `gBrowser`, `Services`, and all Zen internals.

## 2. The Zen APIs we would use

The big finding: **Zen ships a native "Live Folders" feature** that already does 90% of
what we want — sidebar folders that auto-poll an RSS/Atom URL (or GitHub), keep only
new items, and update automatically. We should build on it, not reinvent it.

Relevant internals (from `stable` source):

| Module | Role |
|---|---|
| `resource:///modules/zen/ZenLiveFoldersManager.sys.mjs` | Singleton manager. `createFolder(type)`, `deleteFolder(id)`, `getFolder(id)`, `liveFolders` Map (folderId → provider). State persisted to `zen-live-folders.jsonlz4` in the profile. Holds the provider registry. |
| `resource:///modules/zen/RssLiveFolder.sys.mjs` | `nsRssLiveFolderProvider` (`type = "rss"`). State: `{ url, maxItems (default 10), timeRange (default 0 = all time), interval (default 30 min), lastFetched }`. `fetchItems()` fetches the URL, parses RSS 2.0/Atom, keeps only http/https items that have a date, dedupes by `guid` (falls back to url), then creates pinned lazy tabs via `gBrowser.addTrustedTab(url, {createLazyBrowser, inBackground, lazyTabTitle})` + `pinTab`. |
| `resource:///modules/zen/ZenLiveFolder.sys.mjs` | Base provider. `start()` = `DeferredTask` timer at `state.interval`; `refresh()` = immediate fetch (re-arms timer); `stop()`. `fetch()` uses a privileged channel (cookies + container context respected). |
| `ZenLiveFoldersUI` | Per-folder context menu: **Refresh** (`option-key="refresh"` → `refresh()`), fetch interval (15 min–8 h), feed URL, maxItems, timeRange. |
| `gZenFolders` (`src/zen/folders/ZenFolders.mjs`) | Folder primitives: `createFolder(tabs, {label, isLiveFolder, collapsed, id, workspaceId})`, `setFolderUserIcon`, `folder.label`, `folder.delete()`, `folder.rename()`. Live folders are created exactly like this + registered in the manager. |

No WebExtension API exposes live folders (no relevant patches under
`browser/components/extensions`), so a plain extension **cannot** create/manage them;
chrome JS is required.

## 3. Design sketch

### 3.1 Architecture — two pieces shipped as one package

1. **A real Zen mod** (`chrome/zen-themes/rss-sync/`): `chrome.css` + `preferences.json`
   for the *visual* part and user config (server URL, poll interval, maxItems, mapping
   mode, "sync" badge styling, optional refresh button styling). Distributable via the
   mod marketplace, but it cannot do logic.
2. **A `.uc.mjs` script** (`fx-autoconfig` / Sine) — the *engine*:
   - Polls `GET http://localhost:3000/api/feeds` every ~15–30 s (trivial load on a
     local server) and diffs against existing live folders.
   - **Create:** mirror `ZenLiveFoldersManager.createFolder()` but skip the URL prompt —
     build `nsRssLiveFolderProvider` directly with `{ url: SERVER + /feeds/<feedId>,
     maxItems: 50, timeRange: 0, interval: <pref> }`, register in `manager.liveFolders`,
     then `start()` + `saveState()`.
   - **Delete:** `manager.deleteFolder(folderId, true)` when a feed is removed.
   - **Rename:** update `folder.label` when a feed name changes.

The script stays thin: it only reconciles the feed↔folder mapping and lets Zen's native
poller do the fetching/rendering.

### 3.2 Feature mapping

**Feature 1 — "Adding a source should create a new live folder"**

Two mappings, flagged as an open question:

- **(a) One folder per feed** (recommended default): the server already aggregates all
  of a feed's sources into one RSS XML at `/feeds/:feedId`. Zero server changes; creating
  a feed (with sources) in the frontend → one live folder appears in Zen.
- **(b) One folder per source**: requires a new per-source RSS endpoint on the server
  (e.g. `GET /feeds/:feedId/sources/:sourceId/rss`, emitting items filtered by
  `sourceId`). The script then diffs at source granularity. Pick this only if per-source
  folders are truly wanted — it needs a small server addition.

**Feature 2 — best-effort sync with Zen refresh (avoid x+y delay)**

Today: Zen polls live folders at `interval` (default 30 min) and the server refreshes
its cache at the feed TTL (default 15 min). Worst case staleness ≈ interval + TTL.

Fix so the server refreshes on Zen's schedule:

- **Option A (zero JS):** point the live folder at
  `http://localhost:3000/feeds/<feedId>?ttl=0`. Every Zen poll then forces a server
  re-scrape and serves fresh XML; the worst-case delay collapses to Zen's interval alone.
  **Requires a one-line server fix:** `GET /feeds/:id` currently *ignores* the `?ttl=`
  query param — the comment claims support ("TTL determined dynamically: 1. from query
  param") but the code uses only `feed.ttl ?? 15`.
- **Option B (JS, refined best-effort):** the uc.js wraps the provider so that before a
  Zen fetch it calls `POST /api/feeds/:id/refresh` **only when the server's `lastFetched`
  is older than ~half the folder interval**; otherwise Zen hits a warm cache. Saves
  re-scrapes while keeping worst case ≈ Zen interval.

Recommendation: land the `?ttl` fix and start with Option A; upgrade to Option B later
if scraping cost matters (e.g. YouTube Shorts checks on every poll).

**Feature 3 — "Force update in Zen → force update RSS server, then in Zen"**

The native folder context menu already has **Refresh**, which calls `liveFolder.refresh()`
→ `fetchItems()` → fetch the folder URL. With the `?ttl=0` URL, that single action
already does: server force-refresh (`updateFeedIfNeeded(id, 0)` re-scrapes) **then** Zen
updates its tabs. Requirement met with no extra UI.

Optional polish: the uc.js adds a dedicated "Sync now" button on each folder
(XUL element + CSS from the mod) that runs `POST /api/feeds/:id/refresh` first (so the
scrape finishes and the cache is warm), then `liveFolder.refresh()`.

### 3.3 Server-side changes (small, deferred)

1. Honor `?ttl=` in `GET /feeds/:id` (or add an explicit `?refresh=1`). One line; the
   endpoint and tests already assume it works.
2. (Only for mapping (b)) a per-source RSS endpoint.
3. Nothing else — `GET /api/feeds` (list) and `POST /api/feeds/:id/refresh` (force)
   already exist and are exactly what the script needs.

### 3.4 Packaging & install flow

- Repo layout: `mod/` (the CSS mod, installable from the marketplace) + `uc/` (the
  `.uc.mjs` engine + `import.uc.mjs`), plus a README with the one-time fx-autoconfig
  setup and copy-in steps.
- Optionally, the RSS frontend gains a "Zen integration" panel that shows the server
  URL, prints/installs instructions, and (if it can locate the profile) writes the
  script + enables the mod automatically.

### 3.5 Risks / caveats

- **Internal APIs are unstable:** `ZenLiveFoldersManager` / `gZenFolders` are private,
  not a public SDK; Zen updates can break the script. Mitigate with feature detection
  and keeping the script minimal (it should degrade to "no auto-create" rather than
  crash the browser).
- **Marketplace mods are CSS-only:** the JS must ship via fx-autoconfig/Sine, so the
  deliverable is a mod + script bundle, not a single marketplace install.
- **Re-scrape cost:** `?ttl=0` re-scrapes every source on every Zen poll. Fine for small
  feeds; revisit with Option B for heavy ones.
- **Multi-window:** the manager targets the first synced window (`ZenWindowSync`); the
  script must handle window open/close or pin to a single window.
- **maxItems:** Zen defaults to 10 items per folder; set it to match the server's 50-item
  feed output (or expose as a preference).
- **Dismissed items** are stored per-folder in the manager state; deleting a feed's
  folder wipes them (expected).

## 4. Suggested next steps (when we start building)

1. Fix `?ttl=` handling in `src/routes.ts` (`GET /feeds/:id`), add a test for it.
2. Prototype the uc.js reconciliation loop in a scratch profile (create/delete/rename
   live folders against `GET /api/feeds`), using a couple of existing feeds.
3. Wrap the folder URL as `/feeds/<id>?ttl=0`; verify "Refresh" forces server + Zen.
4. Build the CSS mod (styling + preferences) and package the bundle; add the frontend
   "Zen integration" panel last.
