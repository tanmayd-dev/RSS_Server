# Installer Plan — One-command Zen Integration Setup

> Status: **implemented (Windows)** — the user's answers to the open decisions below
> landed as: a standalone **Windows executable** hosted on GitHub Releases and
> downloadable from the frontend Zen panel. See **What shipped** at the bottom.
> This plan documents the original design and the decisions that shaped it.

## The problem

Installing the integration today means running through an 8-section manual checklist
(`zen/INSTALL_CHECKLIST.md`): install a JS loader, copy the two `uc` scripts into
`<profile>/chrome/JS/`, copy the mod into `zen-themes/rss-sync/`, hand-edit
`zen-themes.json`, set `about:config` prefs, restart, validate. It is:

- **Error-prone** — a malformed `zen-themes.json` edit or a mistyped path breaks the install.
- **Repeated per profile** — nothing remembers what was installed where.
- **Hard to undo** — uninstall means remembering every file that was touched.
- **Not validated** — nothing confirms the engine is present, the mod is enabled, or the
  server is reachable until the user manually opens the Browser Console.

## Goal

A small, dependency-free installer that does everything the checklist does, safely:

| Command | What it does |
|---|---|
| `npm run zen-status` | Reports per profile: Zen found? loader present? engine files present? mod enabled in `zen-themes.json`? prefs set? server reachable? |
| `npm run zen-install` | Finds the default profile, installs loader + engine + mod, sets prefs, validates, prints what to do next (restart Zen). Idempotent — safe to re-run. |
| `npm run zen-uninstall` | Reverses the install: removes only files we created, restores `zen-themes.json`, strips the prefs we added. Keeps the loader (see safety rules). |
| `npm run zen-install -- --profile <name> \| --all \| --dry-run` | Scope flags + preview mode. |

### Non-goals (v1)

- No marketplace publishing (that stays manual, per `INSTALL_CHECKLIST.md`).
- No auto-download/auto-install of Zen Browser itself.
- No background watcher that syncs new profiles — `zen-status` surfaces them instead.
- No GUI — a CLI now; a frontend button in a later step (see Step 3).

## Design

### Architecture

- Core logic in **`src/zen/installer.ts`** (TypeScript, like the rest of `src/`) so the
  server can import it later for the HTTP endpoint. Exports pure functions:
  `discoverProfiles()`, `status(profile)`, `install(profile, opts)`, `uninstall(profile)`.
- A thin CLI wrapper **`scripts/zen_install.mjs`** with flag parsing and colored
  output — same pattern as the existing `scripts/test_*` scripts.
- **Zero new dependencies**: `node:fs`, `node:os`, `node:path`, `node:crypto` only.

### Profile discovery

Find profile roots per platform (Zen is a Firefox fork, so paths follow Firefox
conventions with the "Zen Browser" name):

| Platform | Root |
|---|---|
| Windows | `%APPDATA%\Zen Browser\Profiles\` |
| macOS | `~/Library/Application Support/Zen Browser/Profiles/` |
| Linux (tarball) | `~/.zen/` |
| Linux (newer/XDG) | `~/.local/share/zen/` |
| Linux (Flatpak) | `~/.var/app/app.zen_browser.zen/.zen/` |

Implementation notes:

- Parse **`profiles.ini`** (Firefox convention) for the real profile directory names and
  the default profile; don't guess from folder names.
- Honor an **`ZEN_PROFILE_ROOT`** env override and `--profile-root` flag (Flatpak/snap
  and dev builds live in non-standard places — the exact roots are confirmed at
  implementation time).
- `--profile <name>` picks a named profile, `--all` installs to every profile found,
  no flag = the default profile (with a prompt if ambiguous).

### Checklist → code mapping

| Manual step (checklist) | Installer action |
|---|---|
| 1. Install fx-autoconfig / Sine loader | Detect existing loader (`config.js` in profile root for fx-autoconfig, Sine's marker files). If none: **vendor** `config.js` + `config-prefs.js` under `zen/loader/` (pinned fx-autoconfig release, MPL-2.0, attribution in a README) and copy them into the profile root — works offline and is unit-testable. |
| 2. Copy `uc/rss-sync.uc.mjs` + `import.uc.mjs` → `chrome/JS/` | `mkdir -p` and copy; overwrite only when the existing file differs from the repo copy (never clobber a user's edited engine). |
| 3. Copy mod + add `zen-themes.json` entry | Copy `zen/mod/*` → `chrome/zen-themes/rss-sync/`. Read `zen-themes.json` → `JSON.parse` → set the `rss-sync` key → **atomic write** (temp file + `rename`) with a timestamped backup of the original. Preserves every other mod's entry. |
| 4. Set `mod.rsssync.*` prefs | Append lines to `<profile>/user.js` (`user.js` is re-applied at startup and idempotent — never touch `prefs.js`, the browser owns and rewrites it). |
| 5. Validate | Re-run the `status` checks and print the result + "restart Zen" next step. |

**Uninstall** removes the copied `uc` files **only if byte-identical** to the repo copies
(user-edited files are left alone and reported), restores `zen-themes.json` from the
backup, and strips the exact `user.js` lines we added. The loader is **kept** (other
people's scripts may depend on it) — the uninstall output tells the user how to remove it
manually if they want.

### Safety rules

- Never write `prefs.js`.
- Atomic writes (temp + rename) for every mutated JSON file.
- Backup before every mutation; print the backup path.
- Only ever delete byte-identical copies of files we shipped.
- Every command is idempotent: re-running `zen-install` is a no-op.
- Detect a running browser via the profile lock file and **refuse to write** unless
  `--force` is passed (Zen rewrites profile files while running; mid-write corruption
  is the main risk this installer must not introduce).

## Implementation steps

### Step 1 — Core module + CLI ✅ planned

- `src/zen/installer.ts` — `discoverProfiles`, `status`, `install`, `uninstall` with the
  safety rules above.
- `scripts/zen_install.mjs` — CLI: `status` / `install` / `uninstall`, flags
  `--profile`, `--all`, `--dry-run`, `--force`, `--profile-root`.
- `zen/loader/` — vendored fx-autoconfig `config.js` + `config-prefs.js` + attribution.
- `package.json` — add `zen-status`, `zen-install`, `zen-uninstall` scripts.
- **Verify:** `node --check` on both files, `npx tsc --noEmit`.

### Step 2 — Offline tests ✅ planned

- `scripts/test_installer.mjs` (`npm run test-installer`) — build a **fake profile tree**
  in a temp dir (mirrors `scripts/test_uc_engine.mjs`'s stub approach) and assert:
  - install creates all files with the right contents; idempotent re-run changes nothing;
  - `zen-themes.json` merge keeps other mods, creates the file when missing, writes a
    backup, and produces valid JSON;
  - uninstall removes only our files and leaves a user-edited engine untouched;
  - `user.js` prefs appended once, not duplicated;
  - lock-file present → install refuses without `--force`.
- **Verify:** `npm run test-installer` green, `npx tsc --noEmit`.

### Step 3 — Frontend integration (one-click install) ✅ planned

The RSS Aggregator server runs **on the same machine** as Zen, so the browser UI can
trigger a real install through it:

- `POST /api/zen/install`, `POST /api/zen/uninstall`, `GET /api/zen/status` — thin
  wrappers over `src/zen/installer.ts`, streaming progress lines back to the client.
- The existing **"Zen Browser Integration" panel** in `frontend/src/App.tsx` gains an
  Install / Uninstall / Status control that renders the streamed output inline (the
  panel already shows install steps; this replaces reading them by hand).
- **Security guard:** only enable these endpoints when the server binds to loopback and
  the server URL is `localhost`/`127.0.0.1`; a misconfigured bind logs a warning and
  refuses to serve them.
- **Verify:** `npx tsc --noEmit`, `npm run build`, live preview: `status` shows the real
  profile, install + uninstall round-trip against a scratch profile.

### Step 4 — Real-profile validation & docs ✅ planned

- Run `zen-status` / `zen-install --dry-run` / `zen-install` against a real (scratch)
  Zen profile; confirm folders appear after restart and uninstall leaves no trace.
- `zen/README.md`: replace the manual install section with a pointer to the installer
  (manual path stays as a fallback). `zen/INSTALL_CHECKLIST.md`: mark automation as the
  primary path.
- **Verify:** full checklist pass on the real profile.

## Open decisions — resolved by the user

1. **Distribution?** → *A downloadable Windows executable, hosted on GitHub Releases,
   downloadable from the frontend UI* (this replaced the CLI+endpoint plan). Built as a
   Node Single Executable Application (`scripts/build_installer.mjs`), published with
   `gh` (`scripts/publish_release.mjs`). **Windows only** — too many platforms is too much.
2. **Vendor the loader files or download at install time?** → *Vendor.* Offline, pinned,
   testable. MPL-2.0 attribution ships next to the files.
3. **Auto-install the loader, or require one?** → *Auto-install.* Vendored **fx-autoconfig**
   (program part next to `zen.exe` + profile part) is installed when no loader is
   detected; Sine and other existing loaders are kept and never clobbered.
4. **Prefs via `user.js` or leave to the user?** → *Leave to the user.* The installer
   never writes `user.js` / `prefs.js`; it reports which `mod.rsssync.*` prefs are set
   and how to set them (about:config / Zen Settings → Mods → RSS Sync).
5. **Profile targeting?** → *Default profile by default*; `--profile` / `--all` for the
   rest. Never guess from folder names — always `profiles.ini`.

> **Loader reality check (2026):** fx-autoconfig no longer has a profile-only install —
> its `program/` part must sit next to `zen.exe`. The installer locates the program dir
> (override, PATH, common install folders); if it can't (or it's not writable) it installs
> the engine + mod anyway and tells the user to add a loader manually.

## Risks & mitigations

- **Profile paths vary by OS/build** (Flatpak, snap, dev builds). → `profiles.ini` +
  `ZEN_PROFILE_ROOT` override; roots confirmed empirically in Step 4.
- **`zen-themes.json` format may change across Zen releases.** → Validate on read,
  back up before write, degrade with a clear error instead of guessing.
- **Writing into a live profile can corrupt it.** → Lock-file refusal, atomic writes,
  backups, byte-identical deletion.
- **An HTTP endpoint that writes files is a foot-gun.** → Loopback-only binding +
  localhost URL check + explicit opt-in (Step 3).
- **Zen updates may move or rewrite loader files.** → `zen-status` detects drift and
  re-offers install; installer never fights the browser.

## What shipped

- **`src/zen/installer.ts`** — core module: `discoverProfiles`, `status`, `install`,
  `uninstall`. Zero runtime deps (node built-ins). Windows-only profile root
  (`%APPDATA%\Zen Browser`), prefs left to the user, byte-identical overwrite policy,
  atomic writes with backups, lock-file refusal.
- **`src/zen/cli.ts` + `zen-status` / `zen-install` / `zen-uninstall` npm scripts** —
  the same CLI that ships inside the exe (dev runs it via tsx).
- **`zen/loader/`** — vendored fx-autoconfig (pinned commit `dfdab568`, MPL-2.0
  attribution), program + profile parts.
- **`scripts/test_installer.ts`** (`npm run test-installer`) — 17 offline tests against
  a fake profile tree: placement, idempotency, backups, merge preservation, running
  refusal, no-clobber, dry-run, uninstall round-trip.
- **`scripts/build_installer.mjs`** (`npm run build-installer`) — embeds the zen/
  package files, esbuild-bundles the CLI, injects into node.exe via Node SEA + postject
  → `dist-zen/zen-install.exe` (~99 MB).
- **`scripts/publish_release.mjs`** (`npm run publish-installer`) — `gh release create`
  / upload, tag `zen-installer-v<version>`.
- **Frontend** — the Zen panel now has a "Download zen-install.exe" button (GitHub
  `latest/download` URL), the exe command summary, the manual-prefs note, and the manual
  steps collapsed as a fallback.
- **Published:** `zen-installer-v1.0.0` on
  <https://github.com/tanmayd-dev/RSS_Server/releases> (private repo — downloads need a
  GitHub login).

## Remaining (user-side)

1. Real-profile validation: run the exe on a machine with Zen installed, restart,
   confirm folders appear (see `zen/INSTALL_CHECKLIST.md`).
2. Publishing the mod to the Zen marketplace stays manual (out of scope).
