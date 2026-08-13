// Build zen-install.exe and publish it to GitHub Releases using the gh CLI.
//
// Tag: zen-installer-v<package.json version>. Uploads with --clobber if the
// release already exists (re-run to refresh the asset). Prints the stable
// "latest" download URL the frontend links to.
//
// Requires: gh CLI authenticated, esbuild + postject installed.
// Run: npm run publish-installer

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = path.join(ROOT, 'dist-zen', 'zen-install.exe');

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: 'inherit' });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

console.log('[publish] building installer');
run(process.execPath, [path.join(ROOT, 'scripts', 'build_installer.mjs')]);

if (!fs.existsSync(EXE)) {
  console.error('[publish] build did not produce ' + EXE);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const tag = `zen-installer-v${version}`;
const repo = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
console.log(`[publish] repo: ${repo} · tag: ${tag}`);

const notes = `# RSS Sync — Zen Browser installer (Windows)

One-command setup of the [RSS Aggregator ↔ Zen](https://github.com/${repo}) live-folder integration:

- **Engine** — \`rss-sync.uc.mjs\` + \`import.uc.mjs\` into the default profile's \`chrome/JS/\`
- **Mod** — visual layer into \`chrome/zen-themes/rss-sync/\` + \`zen-themes.json\` entry
- **Loader** — vendors and installs [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) (skipped when another loader, e.g. Sine, is present)

Usage (double-click to run, or from a terminal):

\`\`\`
zen-install.exe install      # install into the default profile (idempotent)
zen-install.exe status       # what is installed / missing
zen-install.exe uninstall    # remove engine + mod (loader kept)
\`\`\`

Options: \`--profile <name>\`, \`--all\`, \`--profile-root <dir>\`, \`--zen-program-dir <dir>\`, \`--dry-run\`, \`--force\`, \`--help\`.

> **Prefs are left to the user**: the installer never writes \`user.js\` / \`prefs.js\`.
> Set \`mod.rsssync.*\` in \`about:config\` (or Zen Settings → Mods → RSS Sync) if
> your server is not \`http://localhost:3000\`.

Restart Zen after installing — live folders appear within seconds of the server responding.
`;

let result;
try {
  capture('gh', ['release', 'view', tag, '--repo', repo]);
  console.log('[publish] release exists — uploading asset (--clobber)');
  run('gh', ['release', 'upload', tag, EXE, '--repo', repo, '--clobber']);
  result = 'updated';
} catch {
  console.log('[publish] creating release');
  run('gh', [
    'release', 'create', tag, EXE,
    '--repo', repo,
    '--title', `Zen Integration Installer v${version}`,
    '--notes', notes,
  ]);
  result = 'created';
}

const downloadUrl = `https://github.com/${repo}/releases/latest/download/zen-install.exe`;
console.log(`[publish] ${result} — ${tag}`);
console.log(`[publish] download URL (use in the frontend): ${downloadUrl}`);
