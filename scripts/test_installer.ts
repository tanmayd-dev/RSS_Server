// Offline tests for the RSS Sync Zen installer (src/zen/installer.ts).
// Builds a fake Zen app-data tree in a temp dir and asserts install/status/
// uninstall behaviour: file placement, idempotency, backups, byte-identical
// deletion, lock-file refusal, and "prefs left to the user". Run: npm run test-installer

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appRootCandidates,
  defaultAppRoot,
  discoverProfiles,
  findNodeExe,
  findServiceRoot,
  findZenProgramDir,
  hasZenProcessInTasklist,
  install,
  parseInstallDefaults,
  parseProfilesIni,
  pickAppRoot,
  queryService,
  readPackageFilesFromDisk,
  resolveTarget,
  serviceCreateCommand,
  status,
  uninstall,
  type ScResult,
  type ServiceRunner,
} from '../src/zen/installer.js';

const REPO_ZEN_DIR = fileURLToPath(new URL('../zen/', import.meta.url));
const files = readPackageFilesFromDisk(REPO_ZEN_DIR);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${(err as Error).message}`);
  }
}

// --- fixtures ---------------------------------------------------------------

function makeFakeZenTree(): { root: string; programDir: string; defaultProfile: string; otherProfile: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-installer-test-'));
  const root = path.join(base, 'Zen Browser');
  const programDir = path.join(base, 'zen-program');
  const profilesDir = path.join(root, 'Profiles');
  const defaultProfile = path.join(profilesDir, 'aaa.default');
  const otherProfile = path.join(profilesDir, 'bbb.dev');
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.mkdirSync(programDir, { recursive: true });
  fs.mkdirSync(defaultProfile, { recursive: true });
  fs.mkdirSync(otherProfile, { recursive: true });
  fs.writeFileSync(path.join(programDir, 'zen.exe'), 'fake zen binary');
  fs.writeFileSync(
    path.join(root, 'profiles.ini'),
    [
      '[General]',
      'StartWithLastProfile=1',
      'Version=2',
      '',
      '[Profile0]',
      'Name=default',
      'IsRelative=1',
      'Path=Profiles/aaa.default',
      'Default=1',
      '',
      '[Profile1]',
      'Name=dev',
      'IsRelative=1',
      'Path=Profiles/bbb.dev',
      '',
    ].join('\r\n')
  );
  return { root, programDir, defaultProfile, otherProfile };
}

const optsFor = (root: string, programDir: string, extra: Record<string, unknown> = {}) => ({
  profileRoot: root,
  zenProgramDir: programDir,
  // Every install/status call goes through a fresh fake sc.exe so the suite
  // never touches the real Service Control Manager.
  serviceRunner: fakeScRunner(),
  ...extra,
});

// In-memory stand-in for sc.exe: tracks created services, exits 1060 for
// unknown ones, mirrors the real sc.exe exit codes.
function fakeScRunner(): ServiceRunner {
  const services = new Set<string>();
  return (args: string[]): ScResult => {
    const [cmd, name] = args;
    if (cmd === 'query') {
      if (!services.has(name)) {
        return { ok: false, code: 1060, stdout: '', stderr: '' };
      }
      return {
        ok: true,
        code: 0,
        stdout: `SERVICE_NAME: ${name}\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING`,
        stderr: '',
      };
    }
    if (cmd === 'create') {
      if (services.has(name)) {
        return {
          ok: false,
          code: 1073,
          stdout: '',
          stderr: '[SC] OpenService FAILED 1073: The specified service already exists.',
        };
      }
      services.add(name);
      return { ok: true, code: 0, stdout: '[SC] CreateService SUCCESS', stderr: '' };
    }
    if (cmd === 'start') {
      if (!services.has(name)) {
        return { ok: false, code: 1060, stdout: '', stderr: '' };
      }
      return { ok: true, code: 0, stdout: '[SC] StartService SUCCESS', stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: `unknown sc.exe command: ${cmd}` };
  };
}

// --- tests ------------------------------------------------------------------

section('profiles.ini parsing');
check('parses sections, names, default flag and relative paths', () => {
  const entries = parseProfilesIni(
    '[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/aaa.default\nDefault=1\n\n[Profile1]\nName=dev\nPath=Profiles/bbb.dev\n'
  );
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].name, 'default');
  assert.strictEqual(entries[0].isDefault, true);
  assert.strictEqual(entries[0].pathValue, 'Profiles/aaa.default');
  assert.strictEqual(entries[1].isDefault, false);
});

check('falls back to first profile as default when none flagged', () => {
  const entries = parseProfilesIni('[Profile0]\nName=only\nPath=p\n');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].isDefault, true);
});

check('parseInstallDefaults extracts Default= from [Install*] sections only', () => {
  const text = [
    '[InstallF0DC299D809B9700]',
    'Default=Profiles/a1fslygp.Default (release)',
    'Locked=1',
    '',
    '[Profile0]',
    'Name=Default (release)',
    'IsRelative=1',
    'Path=Profiles/a1fslygp.Default (release)',
    'Default=1',
    '',
    '[General]',
    'StartWithLastProfile=1',
  ].join('\r\n');
  assert.deepStrictEqual(parseInstallDefaults(text), ['Profiles/a1fslygp.Default (release)']);
  assert.deepStrictEqual(parseInstallDefaults('[Profile0]\nDefault=1\n'), []);
});

section('app root detection');
check('appRootCandidates prefers the current Zen folder over the legacy one', () => {
  const base = path.join(os.tmpdir(), 'zen-appdata');
  const candidates = appRootCandidates(base);
  assert.deepStrictEqual(candidates, [
    path.join(base, 'Zen'),
    path.join(base, 'Zen Browser'),
  ]);
});

check('pickAppRoot picks the candidate with profiles.ini, else the first', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-root-test-'));
  const current = path.join(base, 'Zen');
  const legacy = path.join(base, 'Zen Browser');
  const candidates = appRootCandidates(base);

  // neither folder has profiles.ini -> first candidate (current location)
  assert.strictEqual(pickAppRoot(candidates), current);

  // only the legacy folder has one -> legacy wins
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'profiles.ini'), '');
  assert.strictEqual(pickAppRoot(candidates), legacy);

  // once the current folder has one too, current wins
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, 'profiles.ini'), '');
  assert.strictEqual(pickAppRoot(candidates), current);

  assert.strictEqual(pickAppRoot([]), null);
  fs.rmSync(base, { recursive: true, force: true });
});

check('defaultAppRoot resolves to the real install location on Windows', () => {
  if (process.platform !== 'win32') {
    assert.strictEqual(defaultAppRoot(), null);
    return;
  }
  const appData = path.join(os.homedir(), 'AppData', 'Roaming');
  const root = defaultAppRoot();
  assert.ok(root, 'defaultAppRoot must resolve on Windows');
  const hasCurrent = fs.existsSync(path.join(appData, 'Zen', 'profiles.ini'));
  const hasLegacy = fs.existsSync(path.join(appData, 'Zen Browser', 'profiles.ini'));
  if (hasCurrent) assert.strictEqual(root, path.join(appData, 'Zen'));
  else if (hasLegacy) assert.strictEqual(root, path.join(appData, 'Zen Browser'));
  else assert.strictEqual(root, path.join(appData, 'Zen'), 'falls back to the current location for error messages');
});

section('discovery & targeting');
check('discovers profiles with running detection', () => {
  const { root, defaultProfile } = makeFakeZenTree();
  const d = discoverProfiles(root);
  assert.strictEqual(d.zenFound, true);
  assert.strictEqual(d.profiles.length, 2);
  assert.strictEqual(d.profiles[0].isDefault, true);
  assert.strictEqual(d.profiles[0].running, false);
  // a lock file alone (stale after an unclean exit) is NOT running…
  fs.writeFileSync(path.join(defaultProfile, 'parent.lock'), '');
  assert.strictEqual(discoverProfiles(root, { processCheck: () => false }).profiles[0].running, false);
  // …but it IS running when a Zen browser process actually exists.
  assert.strictEqual(discoverProfiles(root, { processCheck: () => true }).profiles[0].running, true);
  fs.rmSync(root, { recursive: true, force: true });
});

check('hasZenProcessInTasklist matches only the browser main process', () => {
  const sample = [
    '"zen.exe","1234","Console","1","123,456 K"',
    '"zen-install.exe","5678","Console","1","45,678 K"',
    '"explorer.exe","9999","Console","1","10,000 K"',
  ].join('\r\n');
  assert.strictEqual(hasZenProcessInTasklist(sample), true, 'zen.exe matches');
  assert.strictEqual(
    hasZenProcessInTasklist('".\\zen.exe","1","Console","1","1 K"'),
    false,
    'a path prefix (\\zen.exe) is not the main process'
  );
  assert.strictEqual(
    hasZenProcessInTasklist('\n"zen-twilight.exe","2","Console","1","2 K"\n'),
    true,
    'zen-twilight.exe matches'
  );
  assert.strictEqual(
    hasZenProcessInTasklist('"zen-install.exe","3","Console","1","3 K"'),
    false,
    'the installer exe must not match'
  );
});

check('install-section default wins over the Default=1 flag', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-install-test-'));
  const root = path.join(base, 'Zen');
  const profilesDir = path.join(root, 'Profiles');
  const used = path.join(profilesDir, 'aaa.used');
  const flagged = path.join(profilesDir, 'bbb.flagged');
  fs.mkdirSync(used, { recursive: true });
  fs.mkdirSync(flagged, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'profiles.ini'),
    [
      '[InstallF0DC299D809B9700]',
      'Default=Profiles/aaa.used',
      'Locked=1',
      '',
      '[Profile0]',
      'Name=Flagged',
      'IsRelative=1',
      'Path=Profiles/bbb.flagged',
      'Default=1',
      '',
      '[Profile1]',
      'Name=Used',
      'IsRelative=1',
      'Path=Profiles/aaa.used',
      '',
    ].join('\r\n')
  );
  const d = discoverProfiles(root);
  const usedProfile = d.profiles.find((p) => p.name === 'Used');
  assert.ok(usedProfile?.isDefault, 'install-referenced profile must be the default');
  assert.strictEqual(d.profiles.find((p) => p.name === 'Flagged')?.isDefault, false);
  assert.strictEqual(resolveTarget(d, {}).profiles[0].name, 'Used');
  fs.rmSync(base, { recursive: true, force: true });
});

check('resolveTarget: default, named, all, unknown', () => {
  const { root, defaultProfile } = makeFakeZenTree();
  const d = discoverProfiles(root);
  const def = resolveTarget(d, {});
  assert.strictEqual(def.profiles.length, 1);
  assert.strictEqual(def.profiles[0].dir, defaultProfile);
  assert.strictEqual(resolveTarget(d, { profile: 'dev' }).profiles[0].name, 'dev');
  assert.strictEqual(resolveTarget(d, { all: true }).profiles.length, 2);
  assert.ok(resolveTarget(d, { profile: 'nope' }).error);
  fs.rmSync(root, { recursive: true, force: true });
});

check('findZenProgramDir: override and PATH', () => {
  const { programDir } = makeFakeZenTree();
  assert.strictEqual(findZenProgramDir(programDir), programDir);
  assert.strictEqual(findZenProgramDir(path.join(programDir, '..')), null);
  const saved = process.env.PATH;
  process.env.PATH = `${programDir}${path.delimiter}${saved ?? ''}`;
  assert.strictEqual(findZenProgramDir(), programDir);
  if (saved === undefined) delete process.env.PATH;
  else process.env.PATH = saved;
});

section('install');
check('installs loader + engine + mod into default profile and program dir', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  const r = install(optsFor(root, programDir));
  assert.strictEqual(r.actions.filter((a) => a.level === 'error').length, 0, JSON.stringify(r.actions));

  // loader program part
  assert.ok(fs.existsSync(path.join(programDir, 'config.js')));
  assert.ok(fs.existsSync(path.join(programDir, 'defaults', 'pref', 'config-prefs.js')));
  // loader profile part
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'utils', 'boot.sys.mjs')));
  // engine
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'JS', 'rss-sync.uc.mjs')));
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'JS', 'import.uc.mjs')));
  // mod + entry
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'zen-themes', 'rss-sync', 'chrome.css')));
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'zen-themes', 'rss-sync', 'preferences.json')));
  const themes = JSON.parse(fs.readFileSync(path.join(defaultProfile, 'zen-themes.json'), 'utf8'));
  assert.strictEqual(themes['rss-sync'].id, 'rss-sync');
  assert.strictEqual(themes['rss-sync'].enabled, true);
  // prefs left to the user: user.js must NOT exist
  assert.ok(!fs.existsSync(path.join(defaultProfile, 'user.js')), 'user.js must not be created');
  fs.rmSync(root, { recursive: true, force: true });
});

check('install is idempotent and creates no new backups on re-run', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  fs.writeFileSync(path.join(defaultProfile, 'zen-themes.json'), JSON.stringify({ other: {} }, null, 2));
  install(optsFor(root, programDir));
  const backupsAfterFirst = fs
    .readdirSync(defaultProfile)
    .filter((f) => f.includes('rss-sync-backup'));
  assert.strictEqual(backupsAfterFirst.length, 1, 'one backup from the first merge');

  const r2 = install(optsFor(root, programDir));
  const writes = r2.actions.filter((a) => /wrote|would write/.test(a.message));
  assert.strictEqual(writes.length, 0, `re-run should write nothing: ${JSON.stringify(r2.actions)}`);
  const backupsAfterSecond = fs
    .readdirSync(defaultProfile)
    .filter((f) => f.includes('rss-sync-backup'));
  assert.strictEqual(backupsAfterSecond.length, 1, 'no new backups on idempotent re-run');
  fs.rmSync(root, { recursive: true, force: true });
});

check('zen-themes.json merge preserves other mods', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  fs.writeFileSync(
    path.join(defaultProfile, 'zen-themes.json'),
    JSON.stringify({ 'some-other-mod': { id: 'some-other-mod', enabled: true } }, null, 2)
  );
  install(optsFor(root, programDir));
  const themes = JSON.parse(fs.readFileSync(path.join(defaultProfile, 'zen-themes.json'), 'utf8'));
  assert.ok(themes['some-other-mod'], 'other mod preserved');
  assert.ok(themes['rss-sync'], 'rss-sync added');
  fs.rmSync(root, { recursive: true, force: true });
});

check('refuses to write into a running profile unless forced', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  fs.writeFileSync(path.join(defaultProfile, '.parentlock'), '');
  // deterministic: pretend a Zen process is alive so the refusal is about the lock
  const r = install(optsFor(root, programDir, { processCheck: () => true }));
  assert.ok(r.actions.some((a) => a.level === 'error' && a.message.includes('running')));
  assert.ok(!fs.existsSync(path.join(defaultProfile, 'chrome', 'JS')), 'nothing written');
  const rf = install(optsFor(root, programDir, { force: true }));
  assert.strictEqual(rf.actions.filter((a) => a.level === 'error').length, 0);
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'JS', 'rss-sync.uc.mjs')));
  fs.rmSync(root, { recursive: true, force: true });
});

check('does not clobber a user-edited engine file (unless forced)', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  const jsDir = path.join(defaultProfile, 'chrome', 'JS');
  fs.mkdirSync(jsDir, { recursive: true });
  fs.writeFileSync(path.join(jsDir, 'rss-sync.uc.mjs'), '// user edited');
  const r = install(optsFor(root, programDir));
  assert.ok(r.actions.some((a) => a.level === 'warn' && a.message.includes('differs')));
  assert.strictEqual(fs.readFileSync(path.join(jsDir, 'rss-sync.uc.mjs'), 'utf8'), '// user edited');
  install(optsFor(root, programDir, { force: true }));
  assert.notStrictEqual(fs.readFileSync(path.join(jsDir, 'rss-sync.uc.mjs'), 'utf8'), '// user edited');
  fs.rmSync(root, { recursive: true, force: true });
});

check('dry-run writes nothing', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  const r = install(optsFor(root, programDir, { dryRun: true }));
  assert.ok(r.actions.some((a) => a.message.includes('DRY RUN')));
  assert.ok(!fs.existsSync(path.join(programDir, 'config.js')));
  assert.ok(!fs.existsSync(path.join(defaultProfile, 'chrome')));
  assert.ok(!fs.existsSync(path.join(defaultProfile, 'zen-themes.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

check('invalid zen-themes.json produces a clear error', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  fs.writeFileSync(path.join(defaultProfile, 'zen-themes.json'), '{ not json');
  const r = install(optsFor(root, programDir));
  assert.ok(r.actions.some((a) => a.level === 'error' && a.message.includes('not valid JSON')));
  fs.rmSync(root, { recursive: true, force: true });
});

check('unknown profile name is rejected', () => {
  const { root, programDir } = makeFakeZenTree();
  const r = install(optsFor(root, programDir, { profile: 'missing' }));
  assert.ok(r.actions.some((a) => a.level === 'error'));
  fs.rmSync(root, { recursive: true, force: true });
});

section('status');
check('status reflects an installed integration', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  install(optsFor(root, programDir));
  const s = status(optsFor(root, programDir));
  assert.strictEqual(s.target?.name, 'default');
  assert.strictEqual(s.loader.present, true);
  assert.strictEqual(s.loader.kind, 'fx-autoconfig');
  assert.strictEqual(s.engine.present, true);
  assert.strictEqual(s.engine.matches, true);
  assert.strictEqual(s.mod.installed, true);
  assert.strictEqual(s.prefs.missing.length, 5, 'prefs reported as not set (left to user)');
  // program dir is the fake one
  assert.strictEqual(s.loader.programDir, programDir);
  fs.rmSync(root, { recursive: true, force: true });
});

check('status reports no Zen when the app root is missing', () => {
  const s = status({ profileRoot: path.join(os.tmpdir(), 'definitely-not-zen-' + Date.now()) });
  assert.strictEqual(s.zenFound, false);
  assert.strictEqual(s.target, null);
});

section('uninstall');
check('uninstall removes engine + mod, keeps the loader, preserves other mods', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  fs.writeFileSync(
    path.join(defaultProfile, 'zen-themes.json'),
    JSON.stringify({ 'some-other-mod': { id: 'some-other-mod', enabled: true } }, null, 2)
  );
  install(optsFor(root, programDir));
  const r = uninstall(optsFor(root, programDir));
  assert.strictEqual(r.actions.filter((a) => a.level === 'error').length, 0, JSON.stringify(r.actions));

  assert.ok(!fs.existsSync(path.join(defaultProfile, 'chrome', 'JS', 'rss-sync.uc.mjs')));
  assert.ok(!fs.existsSync(path.join(defaultProfile, 'chrome', 'JS', 'import.uc.mjs')));
  assert.ok(!fs.existsSync(path.join(defaultProfile, 'chrome', 'zen-themes', 'rss-sync')));
  const themes = JSON.parse(fs.readFileSync(path.join(defaultProfile, 'zen-themes.json'), 'utf8'));
  assert.ok(themes['some-other-mod'], 'other mod preserved after uninstall');
  assert.ok(!themes['rss-sync'], 'rss-sync entry removed');
  // loader is kept
  assert.ok(fs.existsSync(path.join(programDir, 'config.js')), 'program loader kept');
  assert.ok(fs.existsSync(path.join(defaultProfile, 'chrome', 'utils', 'boot.sys.mjs')), 'profile loader kept');
  fs.rmSync(root, { recursive: true, force: true });
});

check('uninstall leaves a user-edited engine file alone', () => {
  const { root, programDir, defaultProfile } = makeFakeZenTree();
  install(optsFor(root, programDir));
  const enginePath = path.join(defaultProfile, 'chrome', 'JS', 'rss-sync.uc.mjs');
  fs.writeFileSync(enginePath, '// user edited');
  const r = uninstall(optsFor(root, programDir));
  assert.ok(r.actions.some((a) => a.level === 'warn' && a.message.includes('differs')));
  assert.strictEqual(fs.readFileSync(enginePath, 'utf8'), '// user edited');
  fs.rmSync(root, { recursive: true, force: true });
});

section('windows service');
check('queryService: missing vs registered service', () => {
  const runner = fakeScRunner();
  const missing = queryService('RSSSyncServer', runner);
  assert.strictEqual(missing.present, false);
  assert.strictEqual(missing.running, false);
  assert.strictEqual(missing.detail, undefined, '1060 must not surface as a detail');

  runner(['create', 'RSSSyncServer', 'binPath=', '"C:\\node.exe" "C:\\keep_alive.cjs"', 'start=', 'auto', 'DisplayName=', 'RSS Sync Server']);
  const present = queryService('RSSSyncServer', runner);
  assert.strictEqual(present.present, true);
  assert.strictEqual(present.running, true);
});

check('install registers the service when missing, skips on re-run', () => {
  const { root, programDir } = makeFakeZenTree();
  const runner = fakeScRunner();
  const r1 = install(optsFor(root, programDir, { serviceRunner: runner }));
  assert.ok(
    r1.actions.some((a) => a.level === 'ok' && a.message.includes('registered')),
    JSON.stringify(r1.actions)
  );
  const r2 = install(optsFor(root, programDir, { serviceRunner: runner }));
  assert.ok(
    r2.actions.some((a) => a.level === 'skip' && a.message.includes('already registered')),
    JSON.stringify(r2.actions)
  );
  fs.rmSync(root, { recursive: true, force: true });
});

check('install --no-service skips the service step', () => {
  const { root, programDir } = makeFakeZenTree();
  const r = install(optsFor(root, programDir, { installService: false }));
  assert.ok(
    r.actions.some((a) => a.level === 'skip' && a.message.includes('--no-service')),
    JSON.stringify(r.actions)
  );
  fs.rmSync(root, { recursive: true, force: true });
});

check('serviceCreateCommand quotes paths for an elevated prompt', () => {
  const cmd = serviceCreateCommand(
    'RSSSyncServer',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\RSS_Server\\scripts\\keep_alive.cjs'
  );
  assert.ok(cmd.startsWith('sc create RSSSyncServer'), cmd);
  // sc.exe wants inner quotes escaped with backslashes inside binPath= "..."
  assert.ok(cmd.includes('\\"C:\\Program Files\\nodejs\\node.exe\\"'), cmd);
  assert.ok(cmd.includes('\\"C:\\RSS_Server\\scripts\\keep_alive.cjs\\"'), cmd);
  assert.ok(cmd.includes('start= auto'), cmd);
  assert.ok(cmd.includes('DisplayName= "RSS Sync Server"'), cmd);
});

check('findNodeExe / findServiceRoot resolve on the dev machine', () => {
  assert.ok(findNodeExe(), 'node.exe must be resolvable');
  assert.ok(findServiceRoot(), 'the repo root must be resolvable as the service root');
});

check('findServiceRoot honors an override and rejects bogus dirs', () => {
  assert.strictEqual(findServiceRoot(process.cwd()), process.cwd());
  assert.strictEqual(findServiceRoot('C:\\definitely-not-a-server'), null);
});

check('install warns (not errors) when the server root cannot be found', () => {
  const { root, programDir } = makeFakeZenTree();
  const r = install(optsFor(root, programDir, { serverRoot: 'C:\\definitely-not-a-server' }));
  const warn = r.actions.find(
    (a) => a.level === 'warn' && a.message.includes('cannot register')
  );
  assert.ok(warn, JSON.stringify(r.actions));
  assert.ok(warn!.message.includes('sc create'), 'manual command must be printed');
  fs.rmSync(root, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
