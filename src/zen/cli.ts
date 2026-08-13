// CLI entry for the RSS Sync Zen installer. Bundled into zen-install.exe.
// In the executable the package files come from the embedded module; in dev
// (tsx / npm scripts) the stub is empty and files are read from the repo.

import { builtFromDir, embeddedPackageFiles } from './generated/embedded.js';
import {
  discoverProfiles,
  install,
  readPackageFilesFromDisk,
  status,
  uninstall,
  type PackageFiles,
} from './installer.js';

const HELP = `RSS Sync — Zen Browser installer (Windows)

Just double-click zen-install.exe — it sets everything up for your main
Zen profile. Everything below is for when you want more control:

Usage:
  zen-install            Install into your default profile (same as double-clicking)
  zen-install status     Report what is installed per profile
  zen-install install    Install (explicit)
  zen-install uninstall  Remove the integration (the script loader is kept)

Options:
  --profile <name>       Target a named profile (from profiles.ini)
  --all                  Target every discovered profile
  --profile-root <dir>   Zen app data root (default: %APPDATA%\\Zen, falls back to %APPDATA%\\Zen Browser)
  --zen-program-dir <dir>  Zen program dir containing zen.exe
  --server-root <dir>    RSS server folder (contains package.json + scripts/keep_alive.cjs)
  --dry-run              Show what would happen without writing anything
  --force                Proceed while Zen is running; overwrite files that differ
  --no-service           Skip registering the RSS Sync server as a Windows service
  --verbose              Show the detailed per-file log
  --json                 Machine-readable output (status only)
  -h, --help             Show this help

The installer also registers the RSS Sync server as a Windows service
("RSS Sync Server", auto start) when one is not present, so your feeds
keep syncing even when Zen is closed. That step needs an elevated prompt:
run zen-install.exe as administrator (or run the printed sc.exe command).
If the server folder is not detected, pass --server-root <dir>.

If your server runs at a different address than http://localhost:3000,
set it in Zen: Settings -> Mods -> RSS Sync.
`;

interface CliOptions {
  command?: 'status' | 'install' | 'uninstall';
  profile?: string;
  all: boolean;
  profileRoot?: string;
  zenProgramDir?: string;
  serverRoot?: string;
  dryRun: boolean;
  force: boolean;
  noService: boolean;
  verbose: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): { opts: CliOptions; error?: string } {
  const opts: CliOptions = { all: false, dryRun: false, force: false, noService: false, verbose: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { opts, error: '__help__' };
      case '--profile': {
        const v = argv[++i];
        if (!v) return { opts, error: '--profile requires a value' };
        opts.profile = v;
        break;
      }
      case '--profile-root': {
        const v = argv[++i];
        if (!v) return { opts, error: '--profile-root requires a value' };
        opts.profileRoot = v;
        break;
      }
      case '--zen-program-dir': {
        const v = argv[++i];
        if (!v) return { opts, error: '--zen-program-dir requires a value' };
        opts.zenProgramDir = v;
        break;
      }
      case '--server-root': {
        const v = argv[++i];
        if (!v) return { opts, error: '--server-root requires a value' };
        opts.serverRoot = v;
        break;
      }
      case '--all':
        opts.all = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--no-service':
        opts.noService = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        if (arg.startsWith('-')) {
          return { opts, error: `Unknown option: ${arg}` };
        }
        positional.push(arg);
    }
  }
  if (positional.length > 1) {
    return { opts, error: `Unexpected arguments: ${positional.slice(1).join(' ')}` };
  }
  const cmd = positional[0];
  if (cmd && !['status', 'install', 'uninstall'].includes(cmd)) {
    return { opts, error: `Unknown command: ${cmd}` };
  }
  // No command = install: double-clicking the exe should just set things up.
  opts.command = (cmd as CliOptions['command']) ?? 'install';
  return { opts };
}

// --- output helpers ---------------------------------------------------------

const c = (code: number, s: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s;
const green = (s: string) => c(32, s);
const yellow = (s: string) => c(33, s);
const red = (s: string) => c(31, s);
const dim = (s: string) => c(90, s);
const bold = (s: string) => c(1, s);

function printActions(actions: Array<{ level: string; message: string }>): void {
  for (const a of actions) {
    const mark =
      a.level === 'ok' ? green('  ✓') :
      a.level === 'warn' ? yellow('  !') :
      a.level === 'error' ? red('  ✗') :
      a.level === 'skip' ? dim('  ·') :
      '  ·';
    const color =
      a.level === 'ok' ? green(a.message) :
      a.level === 'warn' ? yellow(a.message) :
      a.level === 'error' ? red(a.message) :
      a.message;
    console.log(`${mark} ${color}`);
  }
}

function printNextSteps(steps: string[]): void {
  if (steps.length === 0) return;
  console.log();
  console.log(bold('Next steps:'));
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}

// --- commands ---------------------------------------------------------------

function cmdStatus(opts: CliOptions, files: PackageFiles): void {
  const report = status({
    profile: opts.profile,
    all: opts.all,
    profileRoot: opts.profileRoot,
    zenProgramDir: opts.zenProgramDir,
    files,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(bold('RSS Sync — Zen integration status'));
  console.log();

  if (!report.appRoot) {
    console.log(red('Zen is not supported on this platform (Windows-only installer).'));
    return;
  }
  if (!report.zenFound) {
    console.log(`${red('Zen not found.')} No profiles.ini under ${report.appRoot}.`);
    console.log('Install Zen Browser, or pass --profile-root <dir>.');
    return;
  }

  console.log(`  Zen app data root : ${report.appRoot}`);
  if (report.profiles.length === 0) {
    console.log(red('  No profiles found in profiles.ini.'));
    return;
  }
  console.log(`  Profiles          :`);
  for (const p of report.profiles) {
    const flags = [
      p.isDefault ? 'default' : null,
      p.running ? yellow('RUNNING') : null,
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`    - ${p.name}${flags ? ` (${flags})` : ''}${report.target?.dir === p.dir ? green('  ← target') : ''}`);
    console.log(dim(`      ${p.dir}`));
  }

  if (!report.target) {
    console.log();
    console.log(red('No target profile selected — pass --profile <name>.'));
    return;
  }

  const target = report.target;
  console.log();
  console.log(`${bold('Target:')} ${target.name} (${target.dir})`);

  console.log();
  console.log(bold('Loader'));
  const loaderMark = report.loader.present ? green('installed') : red('NOT installed');
  console.log(`  ${loaderMark} (${report.loader.kind})`);
  if (report.loader.programDir) {
    console.log(dim(`  program dir: ${report.loader.programDir}`));
  }
  for (const n of report.loader.notes) {
    console.log(yellow(`  ! ${n}`));
  }

  console.log();
  console.log(bold('Engine (chrome/JS)'));
  for (const f of report.engine.files) {
    const state = !f.present
      ? red('missing')
      : f.matches
        ? green('ok')
        : yellow('differs from shipped copy');
    console.log(`  ${f.file.padEnd(30)} ${state}`);
  }

  console.log();
  console.log(bold('Mod (visual layer)'));
  const modParts = [
    report.mod.modDir ? green('mod folder present') : red('mod folder missing'),
    report.mod.themesEntry ? green('zen-themes.json entry present') : red('zen-themes.json entry missing'),
  ];
  console.log(`  ${modParts.join(' · ')}`);
  console.log(report.mod.installed ? green('  Mod fully installed.') : yellow('  Mod incomplete.'));

  console.log();
  console.log(bold('Prefs (mod.rsssync.* — left to the user, never written)'));
  if (report.prefs.set.length === 0 && report.prefs.missing.length === 0) {
    console.log('  no profile target');
  } else {
    for (const p of report.prefs.set) console.log(`  ${p.padEnd(34)} ${green('set')}`);
    for (const p of report.prefs.missing) console.log(`  ${p.padEnd(34)} ${dim('not set (defaults apply)')}`);
  }

  console.log();
  console.log(bold('Windows service (RSS Sync server)'));
  if (process.platform !== 'win32') {
    console.log(`  ${dim('n/a (not Windows)')}`);
  } else if (report.service.present) {
    console.log(
      `  ${report.service.running ? green('registered and running') : yellow('registered (not running)')} (${report.service.name})`
    );
  } else {
    console.log(
      `  ${yellow('not registered')} (${report.service.name}) — re-run the installer as administrator`
    );
  }

  printNextSteps(report.nextSteps);
}

function printFriendly(report: { actions: Array<{ level: string; message: string }>; dryRun: boolean }, done: string, already: string): void {
  const errors = report.actions.filter((a) => a.level === 'error');
  const warns = report.actions.filter((a) => a.level === 'warn');
  const infos = report.actions.filter((a) => a.level === 'info');
  for (const a of errors) console.log(`${red('  ✗')} ${red(a.message)}`);
  for (const a of warns) console.log(`${yellow('  !')} ${yellow(a.message)}`);
  for (const a of infos) console.log(`  · ${a.message}`);
  if (report.dryRun) {
    console.log(yellow('  DRY RUN — nothing was written.'));
  } else if (errors.length === 0) {
    const changed = report.actions.some((a) => /wrote|would write|removed|added|registered/.test(a.message));
    console.log(green(`  ✓ ${changed ? done : already}`));
  }
}

function cmdInstall(opts: CliOptions, files: PackageFiles): void {
  const report = install({
    profile: opts.profile,
    all: opts.all,
    profileRoot: opts.profileRoot,
    zenProgramDir: opts.zenProgramDir,
    dryRun: opts.dryRun,
    force: opts.force,
    installService: !opts.noService,
    // Baked at build time so the published exe knows where the server lives
    // even when downloaded outside the repo; --server-root wins over it.
    serverRoot: opts.serverRoot ?? builtFromDir ?? undefined,
    files,
  });
  if (opts.verbose) {
    console.log(bold('RSS Sync — installing'));
    printActions(report.actions);
  } else {
    console.log(bold('Setting up Zen for your feeds…'));
    printFriendly(report, 'Everything is set up. Restart Zen and your feeds will appear as folders.', 'Already set up — nothing needed changing.');
  }
  printNextSteps(report.nextSteps);
  const hasError = report.actions.some((a) => a.level === 'error');
  process.exitCode = hasError ? 1 : 0;
}

function cmdUninstall(opts: CliOptions, files: PackageFiles): void {
  const report = uninstall({
    profile: opts.profile,
    all: opts.all,
    profileRoot: opts.profileRoot,
    zenProgramDir: opts.zenProgramDir,
    dryRun: opts.dryRun,
    force: opts.force,
    files,
  });
  if (opts.verbose) {
    console.log(bold('RSS Sync — uninstalling'));
    printActions(report.actions);
  } else {
    console.log(bold('Removing the Zen integration…'));
    printFriendly(report, 'Removed. Restart Zen to finish.', 'Nothing to remove — the integration wasn\'t installed.');
  }
  printNextSteps(report.nextSteps);
  const hasError = report.actions.some((a) => a.level === 'error');
  process.exitCode = hasError ? 1 : 0;
}

// --- main -------------------------------------------------------------------

function main(): void {
  const { opts, error } = parseArgs(process.argv.slice(2));
  if (error === '__help__') {
    console.log(HELP);
    return;
  }
  if (error) {
    console.error(red(error));
    console.error(`Run 'zen-install --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  const files: PackageFiles =
    Object.keys(embeddedPackageFiles).length > 0
      ? embeddedPackageFiles
      : readPackageFilesFromDisk();

  switch (opts.command) {
    case 'install':
      cmdInstall(opts, files);
      break;
    case 'uninstall':
      cmdUninstall(opts, files);
      break;
    default:
      cmdStatus(opts, files);
  }
}

main();
