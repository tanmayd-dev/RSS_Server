// Core logic for the RSS Sync Zen installer.
//
// Windows-only (Zen's profile root is %APPDATA%\Zen Browser). Zero runtime
// dependencies beyond node builtins: node:fs / node:os / node:path /
// node:crypto / node:child_process (for sc.exe), so the whole module can be
// bundled into a single-file Windows executable.
//
// Package files (the engine, the mod and the vendored loader) are passed in via
// `files` so the same code works from the repo (dev/tests) and from the
// self-contained executable (embedded content).
//
// Design notes:
// - Default profile targeting via profiles.ini (never guessed from folder names).
// - Loader: fx-autoconfig is vendored and auto-installed (program dir + profile
//   part) unless a loader is already present; Sine and other loaders are kept.
// - Preferences are LEFT TO THE USER: the installer never writes user.js or
//   prefs.js. It reports which mod.rsssync.* prefs are set and how to set them.
// - Windows service: install() also registers the RSS Sync server as a Windows
//   service ("RSS Sync Server", auto start) when one is not already present,
//   so feeds keep syncing even when Zen is closed. Creating the service needs
//   an elevated prompt; otherwise the installer prints the exact sc.exe command.
// - Safety: atomic writes with backups, never clobber files we did not ship
//   (byte-identical check), refuse to write into a running profile without
//   --force, never write prefs.js.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Package files keyed by path relative to zen/ (e.g. "uc/rss-sync.uc.mjs"). */
export interface PackageFiles {
  [relPath: string]: string;
}

export interface ZenProfile {
  /** Name= from profiles.ini (falls back to the section name). */
  name: string;
  /** Absolute path to the profile directory. */
  dir: string;
  isDefault: boolean;
  /** True when the profile lock file exists (browser running). */
  running: boolean;
}

export interface DiscoverResult {
  /** The app data dir containing profiles.ini (null on non-Windows / not found). */
  appRoot: string | null;
  zenFound: boolean;
  profiles: ZenProfile[];
  error?: string;
}

export interface LoaderStatus {
  present: boolean;
  kind: 'fx-autoconfig' | 'sine' | 'other' | 'none';
  programDir: string | null;
  programFilesInstalled: boolean;
  profileFilesInstalled: boolean;
  notes: string[];
}

export interface StatusReport {
  appRoot: string | null;
  zenFound: boolean;
  profiles: ZenProfile[];
  target: ZenProfile | null;
  loader: LoaderStatus;
  engine: {
    present: boolean;
    matches: boolean;
    files: Array<{ file: string; present: boolean; matches: boolean }>;
  };
  mod: { modDir: boolean; themesEntry: boolean; installed: boolean };
  prefs: { set: string[]; missing: string[] };
  service: { name: string; present: boolean; running: boolean; detail?: string };
  nextSteps: string[];
}

export interface Action {
  level: 'ok' | 'warn' | 'error' | 'info' | 'skip';
  message: string;
}

export interface InstallReport {
  target: ZenProfile | null;
  dryRun: boolean;
  actions: Action[];
  nextSteps: string[];
}

export interface InstallOptions {
  /** Named profile to target (name from profiles.ini). */
  profile?: string;
  /** Install to every discovered profile. */
  all?: boolean;
  /** App data root (dir containing profiles.ini). Defaults to %APPDATA%\Zen Browser. */
  profileRoot?: string;
  /** Zen program dir override (dir containing zen.exe). */
  zenProgramDir?: string;
  dryRun?: boolean;
  /** Proceed despite a running browser / overwrite files that differ from the package copy. */
  force?: boolean;
  /** Package file contents. Defaults to the repo's zen/ directory (dev). */
  files?: PackageFiles;
  /** Register the RSS Sync server as a Windows service when missing (default true on Windows). */
  installService?: boolean;
  /** sc.exe runner override (tests inject a fake so no admin rights are needed). */
  serviceRunner?: ServiceRunner;
}

// ---------------------------------------------------------------------------
// Package file inventory
// ---------------------------------------------------------------------------

/** Files the installer ships from the package, by relative path. */
export const PACKAGE_FILE_LIST = [
  // engine
  'uc/import.uc.mjs',
  'uc/rss-sync.uc.mjs',
  // mod
  'mod/chrome.css',
  'mod/preferences.json',
  // loader program part
  'loader/program/config.js',
  'loader/program/defaults/pref/config-prefs.js',
  // loader profile part
  'loader/profile/chrome/utils/boot.sys.mjs',
  'loader/profile/chrome/utils/chrome.manifest',
  'loader/profile/chrome/utils/fs.sys.mjs',
  'loader/profile/chrome/utils/module_loader.mjs',
  'loader/profile/chrome/utils/uc_api.sys.mjs',
  'loader/profile/chrome/utils/utils.sys.mjs',
] as const;

const ENGINE_FILES = ['uc/import.uc.mjs', 'uc/rss-sync.uc.mjs'];
const MOD_FILES = ['mod/chrome.css', 'mod/preferences.json'];
const LOADER_PROGRAM_FILES = [
  'loader/program/config.js',
  'loader/program/defaults/pref/config-prefs.js',
];
const LOADER_PROFILE_FILES = PACKAGE_FILE_LIST.filter((f) =>
  f.startsWith('loader/profile/')
);

/** Prefs the engine reads (mod preferences). The installer never sets these. */
export const ENGINE_PREFS = [
  'mod.rsssync.server_url',
  'mod.rsssync.auto_sync',
  'mod.rsssync.poll_interval',
  'mod.rsssync.folder_interval',
  'mod.rsssync.max_items',
];

/** Read the ship-able package files from a repo checkout (dev / tests). */
export function readPackageFilesFromDisk(zenDir = path.join(process.cwd(), 'zen')): PackageFiles {
  const files: PackageFiles = {};
  for (const rel of PACKAGE_FILE_LIST) {
    const full = path.join(zenDir, ...rel.split('/'));
    files[rel] = fs.readFileSync(full, 'utf8');
  }
  return files;
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

export function defaultAppRoot(): string | null {
  if (process.env.ZEN_PROFILE_ROOT) {
    return process.env.ZEN_PROFILE_ROOT;
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Zen Browser');
  }
  // Windows-only installer; other platforms are not supported.
  return null;
}

export function parseProfilesIni(text: string): Array<{
  section: string;
  name: string;
  pathValue: string;
  isRelative: boolean;
  isDefault: boolean;
}> {
  const entries: Array<{
    section: string;
    name: string;
    pathValue: string;
    isRelative: boolean;
    isDefault: boolean;
  }> = [];
  let section = '';
  let current: (typeof entries)[number] | null = null;

  const commit = () => {
    if (current && current.pathValue) {
      entries.push(current);
    }
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      commit();
      section = sectionMatch[1];
      if (/^Profile\d+$/i.test(section)) {
        current = { section, name: section, pathValue: '', isRelative: true, isDefault: false };
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.toLowerCase() === 'name') current.name = value;
    else if (key.toLowerCase() === 'path') current.pathValue = value;
    else if (key.toLowerCase() === 'isrelative') current.isRelative = value !== '0';
    else if (key.toLowerCase() === 'default') current.isDefault = value === '1';
  }
  commit();

  // If no section was flagged Default, treat the first profile as default
  // (matches Firefox behaviour with StartWithLastProfile etc.).
  const hasDefault = entries.some((e) => e.isDefault);
  if (!hasDefault && entries.length > 0) {
    entries[0].isDefault = true;
  }
  return entries;
}

export function isProfileRunning(profileDir: string): boolean {
  return (
    fs.existsSync(path.join(profileDir, 'parent.lock')) ||
    fs.existsSync(path.join(profileDir, '.parentlock'))
  );
}

export function discoverProfiles(appRoot?: string): DiscoverResult {
  const root = appRoot ?? defaultAppRoot();
  if (!root) {
    return { appRoot: null, zenFound: false, profiles: [], error: 'Zen is only supported on Windows for this installer.' };
  }
  const iniPath = path.join(root, 'profiles.ini');
  if (!fs.existsSync(iniPath)) {
    return { appRoot: root, zenFound: false, profiles: [], error: `No profiles.ini at ${iniPath} — is Zen installed?` };
  }
  let text: string;
  try {
    text = fs.readFileSync(iniPath, 'utf8');
  } catch (err) {
    return { appRoot: root, zenFound: false, profiles: [], error: `Could not read ${iniPath}: ${(err as Error).message}` };
  }
  const entries = parseProfilesIni(text);
  const profiles: ZenProfile[] = entries.map((e) => {
    const dir = e.isRelative ? path.resolve(root, e.pathValue) : path.resolve(e.pathValue);
    return {
      name: e.name,
      dir,
      isDefault: e.isDefault,
      running: isProfileRunning(dir),
    };
  });
  return { appRoot: root, zenFound: profiles.length > 0, profiles };
}

/** Pick the profile(s) an operation should target. */
export function resolveTarget(
  discovery: DiscoverResult,
  opts: { profile?: string; all?: boolean }
): { profiles: ZenProfile[]; error?: string } {
  if (discovery.profiles.length === 0) {
    return { profiles: [], error: discovery.error ?? 'No Zen profiles found.' };
  }
  if (opts.all) {
    return { profiles: discovery.profiles };
  }
  if (opts.profile) {
    const wanted = opts.profile.toLowerCase();
    const match = discovery.profiles.find((p) => p.name.toLowerCase() === wanted);
    if (!match) {
      const names = discovery.profiles.map((p) => `"${p.name}"`).join(', ');
      return { profiles: [], error: `No profile named "${opts.profile}". Available: ${names}.` };
    }
    return { profiles: [match] };
  }
  const defaults = discovery.profiles.filter((p) => p.isDefault);
  if (defaults.length === 1) {
    return { profiles: [defaults[0]] };
  }
  if (defaults.length > 1) {
    return {
      profiles: [],
      error: 'Multiple default profiles — pass --profile <name>.',
    };
  }
  if (discovery.profiles.length === 1) {
    return { profiles: [discovery.profiles[0]] };
  }
  return {
    profiles: [],
    error: 'No default profile flagged in profiles.ini — pass --profile <name>.',
  };
}

// ---------------------------------------------------------------------------
// Zen program dir (for the loader's program part)
// ---------------------------------------------------------------------------

function pathExists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? '');
}

export function findZenProgramDir(override?: string): string | null {
  if (override) {
    const d = expandEnv(override);
    return pathExists(path.join(d, 'zen.exe')) ? d : null;
  }
  if (process.env.ZEN_PROGRAM_DIR) {
    const d = expandEnv(process.env.ZEN_PROGRAM_DIR);
    if (pathExists(path.join(d, 'zen.exe'))) return d;
  }
  // PATH lookup
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, 'zen.exe');
    if (pathExists(exe)) return dir;
  }
  // Common install locations (Zen is usually a portable/per-user install).
  const candidates = [
    '%LOCALAPPDATA%\\zen',
    '%LOCALAPPDATA%\\Programs\\zen',
    '%LOCALAPPDATA%\\Programs\\Zen Browser',
    '%LOCALAPPDATA%\\zen\\bin',
    '%ProgramFiles%\\Zen Browser',
    '%ProgramFiles%\\zen',
    '%ProgramFiles(x86)%\\Zen Browser',
    '%USERPROFILE%\\zen',
    '%USERPROFILE%\\Downloads\\zen',
  ];
  for (const c of candidates) {
    const dir = expandEnv(c);
    if (dir && pathExists(path.join(dir, 'zen.exe'))) {
      return dir;
    }
  }
  return null;
}

function isWritableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loader detection
// ---------------------------------------------------------------------------

export function detectLoader(
  profileDir: string,
  programDir: string | null,
  files: PackageFiles
): LoaderStatus {
  const notes: string[] = [];
  const sineMod = path.join(profileDir, 'chrome', 'zen-themes', 'sine');
  const sinePresent = fs.existsSync(sineMod);

  let programFilesInstalled = false;
  let programConfigDiffers = false;
  if (programDir) {
    const progConfig = path.join(programDir, 'config.js');
    if (fs.existsSync(progConfig)) {
      const onDisk = fs.readFileSync(progConfig);
      programFilesInstalled = Buffer.compare(
        onDisk,
        Buffer.from(files['loader/program/config.js'], 'utf8')
      ) === 0;
      if (!programFilesInstalled) {
        programConfigDiffers = true;
        notes.push('A different config.js exists in the Zen program dir (another loader such as Sine, or a different fx-autoconfig version).');
      }
    }
  }

  let profileFilesInstalled = false;
  let profileUtilsDiffers = false;
  const utilsDir = path.join(profileDir, 'chrome', 'utils');
  if (fs.existsSync(path.join(utilsDir, 'boot.sys.mjs'))) {
    const onDisk = fs.readFileSync(path.join(utilsDir, 'boot.sys.mjs'));
    profileFilesInstalled =
      Buffer.compare(onDisk, Buffer.from(files['loader/profile/chrome/utils/boot.sys.mjs'], 'utf8')) === 0;
    if (!profileFilesInstalled) {
      profileUtilsDiffers = true;
      notes.push('A different chrome/utils/boot.sys.mjs exists in the profile (a different loader version).');
    }
  }

  let kind: LoaderStatus['kind'] = 'none';
  if (programFilesInstalled && profileFilesInstalled) {
    kind = 'fx-autoconfig';
  } else if (sinePresent || programConfigDiffers || profileUtilsDiffers) {
    kind = sinePresent ? 'sine' : 'other';
  }

  return {
    present: kind !== 'none',
    kind,
    programDir,
    programFilesInstalled,
    profileFilesInstalled,
    notes,
  };
}

// ---------------------------------------------------------------------------
// File helpers (atomic, backed up, byte-identical policies)
// ---------------------------------------------------------------------------

function backupFile(file: string, dryRun: boolean): string | null {
  if (dryRun || !fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.rss-sync-backup-${stamp}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function writeFileAtomic(file: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

type CopyResult = 'copied' | 'identical' | 'skipped-differs';

/** Copy package content into the profile only when missing or byte-identical. */
function copyIfNeeded(content: string, dest: string, dryRun: boolean, force: boolean): CopyResult {
  if (fs.existsSync(dest)) {
    const onDisk = fs.readFileSync(dest);
    if (Buffer.compare(onDisk, Buffer.from(content, 'utf8')) === 0) {
      return 'identical';
    }
    if (!force) {
      return 'skipped-differs';
    }
  }
  writeFileAtomic(dest, content, dryRun);
  return 'copied';
}

// ---------------------------------------------------------------------------
// zen-themes.json
// ---------------------------------------------------------------------------

export function themesEntry(): Record<string, unknown> {
  return {
    id: 'rss-sync',
    name: 'RSS Sync',
    version: '0.1.0',
    enabled: true,
    description: 'Visual layer for RSS Aggregator live folders',
    author: 'RSS Aggregator',
  };
}

export function readThemesFile(profileDir: string): Record<string, unknown> {
  const p = path.join(profileDir, 'zen-themes.json');
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`zen-themes.json is not valid JSON (${p}): ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`zen-themes.json must be a JSON object (${p})`);
  }
  return parsed as Record<string, unknown>;
}

export function hasThemesEntry(profileDir: string): boolean {
  try {
    const themes = readThemesFile(profileDir);
    const entry = themes['rss-sync'];
    return !!entry && typeof entry === 'object';
  } catch {
    return false;
  }
}

function mergeThemesEntry(profileDir: string, dryRun: boolean): { backup: string | null } {
  const themesPath = path.join(profileDir, 'zen-themes.json');
  const themes = readThemesFile(profileDir);
  themes['rss-sync'] = themesEntry();
  const backup = backupFile(themesPath, dryRun);
  writeFileAtomic(themesPath, JSON.stringify(themes, null, 2) + '\n', dryRun);
  return { backup };
}

function removeThemesEntry(profileDir: string, dryRun: boolean): { backup: string | null } {
  const themesPath = path.join(profileDir, 'zen-themes.json');
  const themes = readThemesFile(profileDir);
  delete themes['rss-sync'];
  const backup = backupFile(themesPath, dryRun);
  writeFileAtomic(themesPath, JSON.stringify(themes, null, 2) + '\n', dryRun);
  return { backup };
}

// ---------------------------------------------------------------------------
// Prefs (read-only — left to the user)
// ---------------------------------------------------------------------------

/** Which engine prefs are set in the profile's user.js (read-only check). */
export function prefsSetInUserJs(profileDir: string): string[] {
  const userJs = path.join(profileDir, 'user.js');
  if (!fs.existsSync(userJs)) return [];
  const text = fs.readFileSync(userJs, 'utf8');
  const set = new Set<string>();
  for (const pref of ENGINE_PREFS) {
    if (new RegExp(`\\b${pref.replace(/\./g, '\\.')}\\b`).test(text)) {
      set.add(pref);
    }
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Windows service (RSS Sync server)
// ---------------------------------------------------------------------------
// The RSS Sync server (dist/index.js via scripts/keep_alive.cjs) is registered
// as a real Windows service so feeds keep syncing even when Zen is closed and
// no one is logged in. keep_alive.cjs spawns the server with the project root
// as its working directory, which matters because the server resolves paths
// (frontend/dist, prisma db) relative to cwd.
//
// Creating a service needs an elevated prompt; when sc.exe is denied, the
// installer reports the exact command to run as administrator instead.

/** Display name shown in the Windows Services console. */
export const SERVICE_DISPLAY_NAME = 'RSS Sync Server';

/** Canonical service name. Override with RSS_SERVICE_NAME (mainly for tests). */
export function serviceName(): string {
  return (process.env.RSS_SERVICE_NAME ?? '').trim() || 'RSSSyncServer';
}

export interface ServiceState {
  present: boolean;
  running: boolean;
  /** Detail when the presence check itself failed (e.g. sc.exe missing). */
  detail?: string;
}

export interface ScResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs sc.exe; injectable so install/status are testable without admin rights. */
export type ServiceRunner = (args: string[]) => ScResult;

export function defaultServiceRunner(args: string[]): ScResult {
  try {
    const stdout = execFileSync('sc.exe', args, { encoding: 'utf8', windowsHide: true });
    return { ok: true, code: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      code: e.status ?? -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/** Query a service by name (sc query). Exit code 1060 = not registered. */
export function queryService(
  name: string,
  runner: ServiceRunner = defaultServiceRunner
): ServiceState {
  const r = runner(['query', name]);
  if (r.ok) {
    const m = r.stdout.match(/STATE\s*:\s*(\d+)\s+(\w+)/);
    return {
      present: true,
      running: !!m && (m[1] === '4' || /running/i.test(m[2])),
    };
  }
  if (r.code === 1060) return { present: false, running: false };
  return {
    present: false,
    running: false,
    detail: (r.stderr || r.stdout).trim() || `sc.exe exited with code ${r.code}`,
  };
}

/** Absolute path to node.exe for the service, or null. */
export function findNodeExe(): string | null {
  if (process.env.RSS_NODE_PATH) {
    const p = path.resolve(process.env.RSS_NODE_PATH);
    if (fs.existsSync(p)) return p;
  }
  // Dev mode (tsx / npm scripts): the current process is node itself.
  if (path.basename(process.execPath).toLowerCase() === 'node.exe') {
    return process.execPath;
  }
  // PATH lookup
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, 'node.exe');
    if (fs.existsSync(exe)) return exe;
  }
  // Common install locations
  for (const c of [
    '%ProgramFiles%\\nodejs\\node.exe',
    '%ProgramFiles(x86)%\\nodejs\\node.exe',
    '%LOCALAPPDATA%\\Programs\\nodejs\\node.exe',
    '%LOCALAPPDATA%\\nodejs\\node.exe',
  ]) {
    const p = expandEnv(c);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function isServiceRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'package.json')) &&
    fs.existsSync(path.join(dir, 'scripts', 'keep_alive.cjs'))
  );
}

/**
 * Where the RSS server lives (must contain package.json + scripts/keep_alive.cjs).
 * Resolution: RSS_SERVER_ROOT env → current dir → next to the installer exe.
 */
export function findServiceRoot(): string | null {
  if (process.env.RSS_SERVER_ROOT) {
    const p = path.resolve(process.env.RSS_SERVER_ROOT);
    if (isServiceRoot(p)) return p;
  }
  for (const candidate of [process.cwd(), path.dirname(path.dirname(process.execPath))]) {
    if (isServiceRoot(candidate)) return candidate;
  }
  return null;
}

/** Command to run in an elevated prompt to register the service manually. */
export function serviceCreateCommand(name: string, nodeExe: string, script: string): string {
  const binPath = `"${nodeExe}" "${script}"`;
  return (
    `sc create ${name} binPath= "${binPath.replace(/"/g, '\\"')}" ` +
    `start= auto DisplayName= "${SERVICE_DISPLAY_NAME.replace(/"/g, '\\"')}"`
  );
}

/**
 * Register the RSS Sync server as a Windows service when one is not present.
 * Pushes actions/next-steps; never throws.
 */
function ensureServerService(opts: InstallOptions, actions: Action[], nextSteps: string[]): void {
  const ok = (m: string) => actions.push({ level: 'ok', message: m });
  const warn = (m: string) => actions.push({ level: 'warn', message: m });
  const info = (m: string) => actions.push({ level: 'info', message: m });
  const skip = (m: string) => actions.push({ level: 'skip', message: m });

  if (opts.installService === false) {
    skip('Windows service: skipped (--no-service).');
    return;
  }
  if (process.platform !== 'win32') {
    skip('Windows service: skipped (not Windows).');
    return;
  }

  const name = serviceName();
  const dryRun = !!opts.dryRun;
  const runner = opts.serviceRunner ?? defaultServiceRunner;

  if (dryRun) {
    info(`Windows service: would register "${name}" if it is missing (runs the RSS server at boot).`);
    return;
  }

  const state = queryService(name, runner);
  if (state.present) {
    skip(`Windows service: "${name}" already registered${state.running ? ' and running' : ''} — nothing to do.`);
    return;
  }
  if (state.detail) {
    warn(`Windows service: could not check for "${name}" (${state.detail}).`);
  }

  const nodeExe = findNodeExe();
  const root = findServiceRoot();
  if (!nodeExe || !root) {
    warn(
      `Windows service: cannot register "${name}" — node.exe: ${nodeExe ?? 'not found'}, ` +
        `server root: ${root ?? 'not found'}. Register it manually in an elevated prompt: ` +
        `sc create ${name} binPath= "<node.exe> <root>\\scripts\\keep_alive.cjs" start= auto`
    );
    return;
  }

  const script = path.join(root, 'scripts', 'keep_alive.cjs');
  if (!fs.existsSync(script)) {
    warn(`Windows service: ${script} not found — cannot register "${name}".`);
    return;
  }

  const createCmd = serviceCreateCommand(name, nodeExe, script);
  const res = runner([
    'create',
    name,
    'binPath=',
    `"${nodeExe}" "${script}"`,
    'start=',
    'auto',
    'DisplayName=',
    SERVICE_DISPLAY_NAME,
  ]);
  if (!res.ok) {
    actions.push({
      level: 'error',
      message:
        `Windows service: could not register "${name}" ` +
        `(${(res.stderr || res.stdout).trim() || `sc.exe exited with code ${res.code}`}). ` +
        `Run as administrator: ${createCmd}`,
    });
    nextSteps.push(`Open an elevated prompt and run: ${createCmd}`);
    return;
  }
  ok(`Windows service: registered "${name}" (auto start at boot, runs ${script}).`);

  const startRes = runner(['start', name]);
  if (startRes.ok) {
    ok(`Windows service: started "${name}".`);
  } else {
    info(`Windows service: registered but could not be started now — it will start at next boot (or run: sc start ${name}).`);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function status(opts: InstallOptions = {}): StatusReport {
  const files = opts.files ?? readPackageFilesFromDisk();
  const discovery = discoverProfiles(opts.profileRoot);
  const { profiles, error } = resolveTarget(discovery, opts);
  const target = profiles.length > 0 ? profiles[0] : null;

  let loader: LoaderStatus;
  let engine = { present: false, matches: false, files: [] as StatusReport['engine']['files'] };
  let mod = { modDir: false, themesEntry: false, installed: false };
  let prefs = { set: [] as string[], missing: [...ENGINE_PREFS] };

  if (target) {
    const programDir = findZenProgramDir(opts.zenProgramDir);
    loader = detectLoader(target.dir, programDir, files);
    engine.files = ENGINE_FILES.map((rel) => {
      const p = path.join(target.dir, 'chrome', 'JS', path.basename(rel));
      const present = fs.existsSync(p);
      const matches = present
        ? Buffer.compare(fs.readFileSync(p), Buffer.from(files[rel], 'utf8')) === 0
        : false;
      return { file: rel, present, matches };
    });
    engine.present = engine.files.some((f) => f.present);
    engine.matches = engine.files.every((f) => f.present && f.matches);
    mod.modDir = fs.existsSync(path.join(target.dir, 'chrome', 'zen-themes', 'rss-sync'));
    mod.themesEntry = hasThemesEntry(target.dir);
    mod.installed = mod.modDir && mod.themesEntry;
    const set = prefsSetInUserJs(target.dir);
    prefs = { set, missing: ENGINE_PREFS.filter((p) => !set.includes(p)) };
  } else {
    loader = { present: false, kind: 'none', programDir: null, programFilesInstalled: false, profileFilesInstalled: false, notes: [] };
  }

  const service =
    process.platform === 'win32'
      ? { name: serviceName(), ...queryService(serviceName(), opts.serviceRunner ?? defaultServiceRunner) }
      : { name: serviceName(), present: false, running: false };

  const nextSteps: string[] = [];
  if (target) {
    nextSteps.push('Restart Zen for changes to take effect.');
    if (prefs.missing.length > 0) {
      nextSteps.push(
        `Set the engine prefs manually (about:config or Zen Settings → Mods → RSS Sync): ${prefs.missing.join(', ')} — defaults work if your server is http://localhost:3000.`
      );
    }
    if (!loader.present) {
      nextSteps.push(
        'No script loader detected — install fx-autoconfig or Sine, or re-run the installer once the Zen program dir is found.'
      );
    }
  } else if (error) {
    nextSteps.push(error);
  }

  return { appRoot: discovery.appRoot, zenFound: discovery.zenFound, profiles: discovery.profiles, target, loader, engine, mod, prefs, service, nextSteps };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function install(opts: InstallOptions = {}): InstallReport {
  const files = opts.files ?? readPackageFilesFromDisk();
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;
  const actions: Action[] = [];
  const nextSteps: string[] = [];

  const discovery = discoverProfiles(opts.profileRoot);

  if (dryRun) {
    actions.push({ level: 'info', message: 'DRY RUN — nothing will be written.' });
  }

  // --- Windows service (RSS Sync server) ----------------------------------
  ensureServerService(opts, actions, nextSteps);

  const { profiles, error } = resolveTarget(discovery, opts);
  if (profiles.length === 0) {
    return {
      target: null,
      dryRun,
      actions: [...actions, { level: 'error', message: error ?? 'No profiles to install into.' }],
      nextSteps,
    };
  }

  const ok = (m: string) => actions.push({ level: 'ok', message: m });
  const warn = (m: string) => actions.push({ level: 'warn', message: m });
  const info = (m: string) => actions.push({ level: 'info', message: m });
  const skip = (m: string) => actions.push({ level: 'skip', message: m });

  for (const profile of profiles) {
    try {
    if (opts.all || profiles.length > 1) {
      info(`Profile: ${profile.name} (${profile.dir})`);
    }

    // Refuse to write into a running profile unless forced.
    if (profile.running && !force) {
      actions.push({
        level: 'error',
        message: `Zen appears to be running (lock file in ${profile.dir}). Close Zen and re-run, or pass --force to proceed anyway.`,
      });
      nextSteps.push('Close Zen, then re-run the installer.');
      continue;
    }

    // --- Loader -----------------------------------------------------------
    const programDir = findZenProgramDir(opts.zenProgramDir);
    const loader = detectLoader(profile.dir, programDir, files);

    if (loader.present) {
      if (loader.kind === 'fx-autoconfig') {
        ok('Loader: fx-autoconfig already installed — keeping it.');
      } else {
        ok(`Loader: ${loader.kind === 'sine' ? 'Sine' : 'a different loader'} detected — leaving it alone (the engine works with it).`);
      }
      for (const n of loader.notes) {
        info(n);
      }
    } else {
      if (!programDir) {
        warn(
          'Loader: could not find the Zen program dir (zen.exe) — skipping loader install. Engine and mod are still installed; add fx-autoconfig or Sine manually.'
        );
        nextSteps.push('Install a script loader manually (fx-autoconfig or Sine), then restart Zen.');
      } else if (!isWritableDir(programDir)) {
        warn(
          `Loader: the Zen program dir (${programDir}) is not writable — skipping loader install. Install the loader manually or run the installer as administrator.`
        );
        nextSteps.push('Install a script loader manually (fx-autoconfig or Sine), then restart Zen.');
      } else {
        // program part
        for (const rel of LOADER_PROGRAM_FILES) {
          const dest = path.join(programDir, ...rel.replace('loader/program/', '').split('/'));
          const result = copyIfNeeded(files[rel], dest, dryRun, force);
          if (result === 'copied') ok(dryRun ? `Loader: would write ${rel} → ${dest}` : `Loader: wrote ${rel} → ${dest}`);
          else if (result === 'identical') skip(`Loader: ${rel} already in place (${dest})`);
          else warn(`Loader: ${dest} differs from the vendored copy — not overwriting${force ? '' : ' (use --force)'}.`);
        }
        // profile part
        for (const rel of LOADER_PROFILE_FILES) {
          const dest = path.join(profile.dir, ...rel.replace('loader/profile/', '').split('/'));
          const result = copyIfNeeded(files[rel], dest, dryRun, force);
          if (result === 'copied') ok(dryRun ? `Loader: would write ${rel} → ${dest}` : `Loader: wrote ${rel} → ${dest}`);
          else if (result === 'identical') skip(`Loader: ${rel} already in place`);
          else warn(`Loader: ${dest} differs from the vendored copy — not overwriting${force ? '' : ' (use --force)'}.`);
        }
        ok(`Loader: fx-autoconfig installed (program dir: ${programDir}).`);
      }
    }

    // --- Engine -----------------------------------------------------------
    for (const rel of ENGINE_FILES) {
      const dest = path.join(profile.dir, 'chrome', 'JS', path.basename(rel));
      const result = copyIfNeeded(files[rel], dest, dryRun, force);
      if (result === 'copied') ok(dryRun ? `Engine: would write ${rel} → ${dest}` : `Engine: wrote ${rel} → ${dest}`);
      else if (result === 'identical') skip(`Engine: ${rel} already in place`);
      else warn(`Engine: ${dest} differs (user-edited?) — not overwriting${force ? '' : ' (use --force)'}.`);
    }

    // --- Mod --------------------------------------------------------------
    for (const rel of MOD_FILES) {
      const dest = path.join(profile.dir, 'chrome', 'zen-themes', 'rss-sync', path.basename(rel));
      const result = copyIfNeeded(files[rel], dest, dryRun, force);
      if (result === 'copied') ok(dryRun ? `Mod: would write ${rel} → ${dest}` : `Mod: wrote ${rel} → ${dest}`);
      else if (result === 'identical') skip(`Mod: ${rel} already in place`);
      else warn(`Mod: ${dest} differs — not overwriting${force ? '' : ' (use --force)'}.`);
    }
    if (hasThemesEntry(profile.dir)) {
      skip('Mod: zen-themes.json entry already present.');
    } else {
      const { backup } = mergeThemesEntry(profile.dir, dryRun);
      if (dryRun) {
        ok('Mod: would add rss-sync entry to zen-themes.json');
      } else {
        ok(`Mod: added rss-sync entry to zen-themes.json${backup ? ` (backup: ${backup})` : ''}`);
      }
    }

    // --- Prefs (left to the user) -----------------------------------------
    const set = prefsSetInUserJs(profile.dir);
    const missing = ENGINE_PREFS.filter((p) => !set.includes(p));
    info(
      missing.length
        ? 'If your server runs at a different address than http://localhost:3000, set it in Zen: Settings → Mods → RSS Sync.'
        : 'Your server address is already configured in Zen — nothing to set.'
    );
    nextSteps.push('If your server runs at a different address than http://localhost:3000, set it in Zen: Settings → Mods → RSS Sync.');
    } catch (err) {
      actions.push({ level: 'error', message: `${profile.name}: ${(err as Error).message}` });
    }
  }

  nextSteps.push('Restart Zen — live folders appear within seconds of the server responding.');
  return { target: profiles[0], dryRun, actions, nextSteps };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export function uninstall(opts: InstallOptions = {}): InstallReport {
  const files = opts.files ?? readPackageFilesFromDisk();
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;
  const actions: Action[] = [];
  const nextSteps: string[] = [];

  const discovery = discoverProfiles(opts.profileRoot);
  const { profiles, error } = resolveTarget(discovery, opts);
  if (profiles.length === 0) {
    return { target: null, dryRun, actions: [{ level: 'error', message: error ?? 'No profiles to uninstall from.' }], nextSteps };
  }

  if (dryRun) {
    actions.push({ level: 'info', message: 'DRY RUN — nothing will be written.' });
  }

  const ok = (m: string) => actions.push({ level: 'ok', message: m });
  const warn = (m: string) => actions.push({ level: 'warn', message: m });
  const info = (m: string) => actions.push({ level: 'info', message: m });
  const skip = (m: string) => actions.push({ level: 'skip', message: m });

  for (const profile of profiles) {
    try {
    if (profile.running && !force) {
      actions.push({
        level: 'error',
        message: `Zen appears to be running (lock file in ${profile.dir}). Close Zen and re-run, or pass --force.`,
      });
      continue;
    }

    // Engine files — remove only byte-identical copies.
    for (const rel of ENGINE_FILES) {
      const dest = path.join(profile.dir, 'chrome', 'JS', path.basename(rel));
      if (!fs.existsSync(dest)) {
        skip(`Engine: ${rel} not present — nothing to remove.`);
        continue;
      }
      const matches =
        Buffer.compare(fs.readFileSync(dest), Buffer.from(files[rel], 'utf8')) === 0;
      if (matches) {
        if (!dryRun) fs.unlinkSync(dest);
        ok(`Engine: removed ${rel}${dryRun ? ' (dry run)' : ''}`);
      } else {
        warn(`Engine: ${rel} differs from the shipped copy (user-edited?) — left in place. Remove it manually if you want.`);
      }
    }

    // Mod files + zen-themes.json entry.
    for (const rel of MOD_FILES) {
      const dest = path.join(profile.dir, 'chrome', 'zen-themes', 'rss-sync', path.basename(rel));
      if (!fs.existsSync(dest)) {
        skip(`Mod: ${rel} not present.`);
        continue;
      }
      const matches =
        Buffer.compare(fs.readFileSync(dest), Buffer.from(files[rel], 'utf8')) === 0;
      if (matches) {
        if (!dryRun) fs.unlinkSync(dest);
        ok(`Mod: removed ${rel}${dryRun ? ' (dry run)' : ''}`);
      } else {
        warn(`Mod: ${rel} differs from the shipped copy — left in place.`);
      }
    }
    const modDir = path.join(profile.dir, 'chrome', 'zen-themes', 'rss-sync');
    if (!dryRun && fs.existsSync(modDir) && fs.readdirSync(modDir).length === 0) {
      fs.rmdirSync(modDir);
    }
    if (hasThemesEntry(profile.dir)) {
      const { backup } = removeThemesEntry(profile.dir, dryRun);
      if (dryRun) {
        ok('Mod: would remove the rss-sync entry from zen-themes.json');
      } else {
        ok(`Mod: removed rss-sync entry from zen-themes.json${backup ? ` (backup: ${backup})` : ''}`);
      }
    } else {
      skip('Mod: no rss-sync entry in zen-themes.json.');
    }

    // Loader — kept on purpose (other scripts may depend on it).
    info('The script loader was left in place so your other Zen scripts keep working.');
    } catch (err) {
      actions.push({ level: 'error', message: `${profile.name}: ${(err as Error).message}` });
    }
  }

  nextSteps.push('Restart Zen. Live folders remain but stop auto-syncing (you can delete them via Zen\'s UI).');
  return { target: profiles[0], dryRun, actions, nextSteps };
}
