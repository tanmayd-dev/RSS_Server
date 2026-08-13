# RSS Sync — Manual Install & Validation Checklist

> **Automated path:** `zen-install.exe install` (Windows) automates steps 1–3
> (loader + engine + mod, default profile) and then validates with `zen-install.exe status`.
> Use this checklist when installing by hand, or to validate what the installer did.

Run through this in a real Zen profile (not the automated `test-uc`/`test-endpoints`
suites) to validate the full integration end to end.

## Prerequisites

- [ ] RSS Aggregator server running at `http://localhost:3000` (or the URL configured in
      the mod), and reachable.
- [ ] At least one feed registered in the frontend.
- [ ] Zen Browser with Live Folders support (≈ v1.19 or newer).

## 1. Install the JS loader

- [ ] Install **fx-autoconfig** (<https://github.com/MrOtherGuy/fx-autoconfig>) or
      **Sine** (<https://github.com/CosmoCreeper/Sine>) once.
- [ ] Restart Zen; confirm the loader is active (no startup errors; `chrome/JS/` exists in
      the profile if using fx-autoconfig).

## 2. Install the engine

- [ ] Copy `zen/uc/rss-sync.uc.mjs` and `zen/uc/import.uc.mjs` into
      `<profile>/chrome/JS/`.
- [ ] Restart Zen.
- [ ] Open the Browser Console (Ctrl+Shift+J) and confirm:
      `[rss-sync] Engine ready …` with **no** errors.

## 3. Install the mod (visuals + settings, optional but recommended)

- [ ] Copy `zen/mod/*` to `<profile>/chrome/zen-themes/rss-sync/` and add the
      `zen-themes.json` entry (see `zen/README.md`).
- [ ] Zen Settings → Mods → RSS Sync shows the preferences (server URL, poll interval,
      folder interval, maxItems).
- [ ] If the server is not `localhost:3000`, set `mod.rsssync.server_url` (about:config or
      the mod's settings).

## 4. Feature 1 — adding a source creates a live folder

- [ ] With feeds present, one live folder per feed appears in the sidebar within ~15 s,
      named after the feed (RSS dot shown when the mod is installed).
- [ ] Expand a folder: items appear (up to `maxItems`), each opens the correct URL.
- [ ] Add a new feed in the frontend → a new live folder appears automatically.
- [ ] Delete a feed → its live folder is removed automatically.
- [ ] Rename a feed → the folder renames automatically.
- [ ] Rename a folder manually in Zen → the engine does **not** revert it on the next poll.

## 5. Feature 2 — best-effort sync (no x+y delay)

- [ ] Set a feed to **"Off — no auto-refresh (Zen-only)"** (`ttl: 0`) in the frontend.
- [ ] `GET /feeds/<id>` without `?ttl=` serves cache (no re-scrape in `server.log`).
- [ ] Trigger a Zen folder refresh (folder context menu → Refresh): `server.log` shows the
      sources re-fetched (the folder URL uses `?ttl=0`).
- [ ] New items on the server appear in the folder within one Zen refresh cycle.

## 6. Feature 3 — force update

- [ ] Folder context menu → **Refresh**: the server re-scrapes first, then the folder's
      tabs update.
- [ ] `POST /api/feeds/<id>/refresh` followed by a Zen refresh shows the fresh data.

## 7. Restart & multi-window resilience

- [ ] Restart Zen with folders present → folders restore and stay synced (names matching
      the server are re-adopted; manually renamed folders are left alone).
- [ ] Open a second window → the same live folders appear there (Zen syncs them natively).
- [ ] Close the first window → auto-creation/deletion keeps working (election handoff).

## 8. Uninstall / cleanup

- [ ] Remove the uc files and restart → live folders remain but stop auto-syncing; they
      behave like normal Zen live folders and can be deleted via Zen's UI.

## Publishing the mod (when ready)

- [ ] Host `zen/mod/*` at HTTPS URLs (e.g. a GitHub repo) and replace the placeholder URLs
      in `zen/mod/zenMod.json` (`style`, `preferences`, `readme`, `homepage`).
- [ ] Submit through the Zen Mods submission flow and verify a marketplace install end to end.
- [ ] Bump the version on changes and keep `chrome.css` / `preferences.json` in sync with
      the engine (see `zen/README.md` for the preference keys the engine reads).
