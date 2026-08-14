# Vendored loader: fx-autoconfig

This directory vendors **[fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)** —
the userChrome.js / autoconfig script loader that the RSS Sync engine runs under.
The engine files (`zen/uc/*`) are plain user scripts; they need a loader to be
executed inside Zen.

| Path | Goes to | Purpose |
|---|---|---|
| `program/config.js` | the Zen program dir (next to `zen.exe`) | bootstraps the loader from the current profile's `chrome/utils/` |
| `program/defaults/pref/config-prefs.js` | the Zen program dir `defaults/pref/` | sets `general.config.filename`, disables the autoconfig sandbox |
| `profile/chrome/utils/*` | `<profile>/chrome/utils/` | the loader itself (`boot.sys.mjs` + helpers + `chrome.manifest`) |

The loader scans `<profile>/chrome/JS/` for `*.uc.js` / `*.uc.mjs` scripts and loads
them, which is how `rss-sync.uc.mjs` runs.

## Pinned source

- Upstream: <https://github.com/MrOtherGuy/fx-autoconfig>
- Pinned commit: `dfdab5684faffc112b76ccb1d8cab7f75da0102c` (see `.pinned-commit`)
- License: **MPL-2.0** — see `LICENSE` (copied from upstream). This vendored copy is
  unmodified except for file placement.

## Why it is vendored

The installer (`zen-install.exe`) is a self-contained executable: it has no network
access at install time, so the loader ships inside the binary. The pinned commit keeps
installs reproducible; `zen-status` reports drift if a newer loader is expected.

## Manual install (fallback)

If you prefer to install the loader by hand (or the installer cannot find your Zen
program dir), copy `program/config.js` and `program/defaults/pref/config-prefs.js`
next to `zen.exe`, copy `profile/chrome/utils/` into the profile's `chrome/` folder,
and restart Zen. See the upstream README for details.

> Note: a *different* existing `config.js` in the program dir usually means another
> loader (e.g. Sine) is already installed — leave it alone; the engine works under
> any loader that scans `chrome/JS/`.
