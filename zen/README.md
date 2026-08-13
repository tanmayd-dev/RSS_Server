# Zen Browser Integration

Mirror feeds from the local RSS Aggregator server into Zen Browser **Live Folders**:

- **One live folder per feed.** The folder subscribes to `{server}/feeds/{feedId}?ttl=0`,
  so every Zen folder refresh forces a fresh server scrape (Option A: no x+y staleness).
- **Auto create / rename / delete.** The engine polls `GET /api/feeds` and reconciles
  folders when you add, rename or remove feeds in the RSS Aggregator frontend.
- **Per-feed auto-refresh can be disabled** in the server (`ttl: 0` = "Zen-only") since
  Zen's polls are the only refreshes needed.
- Duplicate sources inside one feed are fetched only once (server-side dedup).

## Quick install (Windows) — one command

Download **`zen-install.exe`** from the RSS Aggregator frontend (Zen panel → "Download
zen-install.exe") or from the [GitHub release](https://github.com/tanmayd-dev/RSS_Server/releases/latest):

```bat
zen-install.exe install      :: sets up loader + engine + mod in your default profile
zen-install.exe status       :: what's installed, per profile
zen-install.exe uninstall    :: removes engine + mod (loader kept)
zen-install.exe --help       :: all options (--profile, --all, --dry-run, --force, ...)
```

The installer is **idempotent** and safe: atomic writes with backups, never overwrites
files that differ from the shipped copies, refuses to touch a running profile without
`--force`, and never writes `user.js` / `prefs.js`.

**Prefs are left to the user.** The engine reads `mod.rsssync.*` prefs with built-in
defaults (server `http://localhost:3000`). If your server URL differs, set
`mod.rsssync.server_url` in `about:config` or Zen Settings → Mods → RSS Sync.

If the installer can't find your Zen program dir, it still installs the engine + mod
and tells you to add a loader manually (see `loader/README.md`).

> Manual install (no executable) still works — see below.

## Layout

| Path | What it is |
|---|---|
| `mod/` | The distributable Zen mod (visual layer + preferences). CSS-only — the mod system cannot run JS. |
| `uc/`  | The engine: a userChrome.js script loaded via fx-autoconfig / Sine. Does all the logic. |
| `loader/` | Vendored **fx-autoconfig** script loader (program + profile parts), pinned + attributed. |
| `INSTALL_CHECKLIST.md` | Manual install + validation checklist for a real Zen profile. |

## Install

### 1. Engine (required — this is what creates and syncs the folders)

1. Install an autoconfig loader once: **[fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)**
   (or the **[Sine](https://github.com/CosmoCreeper/Sine)** mod manager, which supports
   JS scripts).
2. Copy `uc/rss-sync.uc.mjs` and `uc/import.uc.mjs` into your Zen profile's
   `chrome/JS/` folder.
   - On Windows: `%APPDATA%\Zen Browser\Profiles\<profile>\chrome\JS\`
   - Find the profile via `about:support` → "Profile Folder".
3. Restart Zen. Live folders appear within a few seconds of the server responding.

### 2. Mod (optional, visual layer + settings)

The engine reads its settings from the mod's preferences, with sensible built-in
defaults (server `http://localhost:3000`, 15 s server poll, 30 min folder refresh,
50 items). Two ways to install the mod:

- **From the [Zen Mods marketplace](https://zen-browser.app/mods/)** once published (see `mod/zenMod.json`).
- **Manual (local dev):** copy `mod/` to
  `<profile>/chrome/zen-themes/rss-sync/` (i.e. `chrome.css` and `preferences.json`
  directly in `rss-sync/`), then — with Zen closed — add this entry to
  `<profile>/zen-themes.json`:

  ```json
  {
    "rss-sync": {
      "id": "rss-sync",
      "name": "RSS Sync",
      "version": "0.1.0",
      "enabled": true,
      "description": "Visual layer for RSS Aggregator live folders",
      "author": "RSS Aggregator"
    }
  }
  ```

Settings can also be set manually in `about:config`:

- `mod.rsssync.server_url` (string) — default `http://localhost:3000`
- `mod.rsssync.auto_sync` (boolean) — default `true`
- `mod.rsssync.poll_interval` (string ms) — default `15000`
- `mod.rsssync.folder_interval` (string ms) — default `1800000`
- `mod.rsssync.max_items` (string) — default `50`

## Server-side requirements

Implemented in step 1 of the design:

- `GET /feeds/:id` honors `?ttl=0` (forces a refresh) and stored `ttl: 0` disables
  auto-refresh (Zen-only feeds).
- Duplicate sources in one feed are fetched once.

## Notes & limitations

- Relies on Zen **internal** APIs (`ZenLiveFoldersManager`, `gZenFolders`,
  `nsRssLiveFolderProvider`); a Zen update may break it. The script idles gracefully
  (logs to the Browser Console) rather than crashing.
- **Multi-window:** the reconcile loop runs only in Zen's first synced window, re-elected
  on every poll tick, so sync hands over automatically when windows open/close. Folders
  themselves sync across windows natively via `ZenWindowSync`.
- **Manual renames are preserved.** The engine only renames a folder whose current name is
  the one it last applied (tracked via `data-rss-sync-name`). After a restart the record is
  gone: folders whose name still matches the server are re-adopted; any other folder is
  treated as user-owned and left alone from then on.
- **Refresh state:** folders carry `rss-sync-refreshing` while a fetch is in flight and
  `data-rss-sync-last-fetched` afterwards; the mod's `chrome.css` styles the former.
- Marketplace mods are CSS-only, so the JS engine can never ship *as* the mod — the
  bundle is always mod + uc.js script.
- The `zenMod.json` URLs are placeholders; replace them with real HTTPS asset URLs before
  publishing (see `INSTALL_CHECKLIST.md`).

## Testing

See `scripts/test_endpoints.ts` for offline tests of the `?ttl` / `ttl=0` / dedup
behaviors the engine depends on (`npm run test-endpoints`).
