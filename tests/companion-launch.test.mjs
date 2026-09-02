// tests/companion-launch.test.mjs — how the companion browser gets launched,
// and how the extension gets its configuration.
//
// The launcher used to go through Playwright's launchPersistentContext, which
// injects around thirty switches of its own. Three of them make signing in
// impossible whatever the binary — --disable-sync, --password-store=basic and
// --use-mock-keychain — plus --enable-automation and a CDP channel attached
// for the whole session, which Google's sign-in reads as automation. Applying
// for jobs means signing in *inside* this browser (Google OAuth on some
// boards; a Workday candidate account whose screening questions only render
// inside the authenticated apply flow), so the working session is now a plain
// spawn with a deliberately short argument list.
//
// The extension's server URL and token used to be pushed into one profile's
// storage over CDP, which only worked when the extension had been loaded from
// exactly the checkout running setup and a throwaway debug instance could
// start — otherwise the panel came up saying "not configured", on two
// machines. It now reads extension/companion.local.json by itself, so this
// suite also guards that file: where it lives, that setup can tell current
// from stale, that it never reaches git, and that a copy of the extension
// loaded from another checkout is recognised rather than reported as "not
// loaded".
//
// All of it is pure or filesystem-only, so nothing here starts a browser.
import { pass, fail, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUNDLED_CONFIG_NAME, COMPANION_EXTENSION_NAME, DASHBOARD_URL, PROFILE_DIR_NAME,
  bundledConfigCurrent, bundledConfigIgnored, bundledConfigPath, configFingerprint,
  findCompanionExtensions, findExtension, launchArgs, profileDir, profileInUse,
  readBundledConfig, readDevToolsPort, signedInAccounts, writeBundledConfig,
} from '../extension/launch.mjs';

console.log('\ncompanion — browser launch and extension config');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const EXT = join(ROOT, 'extension');

// Switches that must never reach the session the candidate signs in on. The
// first three are why sign-in failed at all; the last two are the automation
// tells Google reads.
const FORBIDDEN = [
  '--disable-sync',
  '--password-store=basic',
  '--use-mock-keychain',
  '--enable-automation',
  '--remote-debugging-pipe',
];

// ── the plain-spawn argument list ───────────────────────────────────────────
{
  const profile = profileDir(ROOT);
  const args = launchArgs({ profileDir: profile, startUrl: 'https://example.test/x' });

  ok(args.includes(`--user-data-dir=${profile}`),
    'the launch pins its own user-data-dir (never Chrome\'s default — that is where the candidate browses)');
  ok(args.at(-1) === 'https://example.test/x', 'the start URL is the last argument, as a positional');
  ok(!args.some((a) => a.startsWith('--load-extension')),
    'no --load-extension (Chrome has ignored it since v137; passing it would be a silent lie)');
  ok(!args.some((a) => a.startsWith('--disable-extensions-except')),
    'no --disable-extensions-except — a password manager has to be able to live in this profile');
  ok(!args.some((a) => a.startsWith('--remote-debugging')), 'a normal launch opens no debug port');

  const leaked = FORBIDDEN.filter((flagName) => args.some((a) => a.startsWith(flagName)));
  ok(leaked.length === 0, `no automation switches reach the working session (${leaked.join(', ') || 'none'})`);

  ok(args.length === 4, `the list stays short — ${args.length} arguments, all of them accounted for above`);
  ok(profile.endsWith(PROFILE_DIR_NAME) && profile.startsWith(ROOT),
    'the profile lives in the repo, under the gitignored name');
}

// ── the verification launch, and only it, opens a port ──────────────────────
{
  const args = launchArgs({ profileDir: join(ROOT, PROFILE_DIR_NAME), debugPort: 0 });
  ok(args.includes('--remote-debugging-port=0'),
    'the throwaway verification instance asks for a debug port, letting the OS choose');
  ok(args.some((a) => a.startsWith('--user-data-dir=')),
    'it still carries a non-default user-data-dir — Chrome 136+ ignores the debugging switches without one');
  ok(!args.includes(DASHBOARD_URL), 'and it does not open the dashboard; it has its own start URL');
}

// ── reading the profile back ────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'co-launch-'));
  try {
    const profile = join(dir, 'profile');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    const secure = join(profile, 'Default', 'Secure Preferences');
    const prefs = join(profile, 'Default', 'Preferences');

    ok(findExtension(profile, EXT) === null, 'a profile with no Secure Preferences reads as "not loaded yet"');
    ok(findCompanionExtensions(profile).length === 0, 'and holds no copy of the companion from anywhere');

    writeFileSync(secure, JSON.stringify({
      extensions: {
        settings: {
          // A store-installed extension records a relative "id/version" path;
          // only an unpacked one carries an absolute path.
          ahfgeienlihckogmohjhadlkjgocpleb: { manifest: { name: 'Web Store' }, path: 'ahfgeienlihckogmohjhadlkjgocpleb/0.2' },
          hijonplicngomicckdihejlcpffhilgj: { path: EXT },
        },
      },
    }), 'utf8');
    const found = findExtension(profile, EXT);
    ok(found?.id === 'hijonplicngomicckdihejlcpffhilgj',
      'the extension is found by the directory it was loaded from, and yields its id');
    ok(findExtension(profile, join(ROOT, 'templates')) === null,
      'a different directory does not match — a moved checkout counts as not loaded');
    ok(findCompanionExtensions(profile).length === 1 && findCompanionExtensions(profile)[0].path === EXT,
      'findCompanionExtensions() recognises this checkout\'s copy by its manifest name');

    // A copy loaded from ANOTHER checkout of this repo — a worktree, an older
    // clone a Desktop shortcut still points at. findExtension() cannot see it
    // (the path differs); findCompanionExtensions() reads the manifest at the
    // loaded path instead, which is what setup needs to stop reporting it as
    // "not loaded" and to know where it reads its config from.
    const other = join(dir, 'elsewhere', 'extension');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'manifest.json'), JSON.stringify({ name: COMPANION_EXTENSION_NAME }), 'utf8');
    const stranger = join(dir, 'stranger');
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, 'manifest.json'), JSON.stringify({ name: 'Some Other Extension' }), 'utf8');
    writeFileSync(secure, JSON.stringify({
      extensions: {
        settings: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { path: other },
          bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { path: stranger },
          cccccccccccccccccccccccccccccccc: { path: join(dir, 'gone', 'extension') }, // loaded once, since deleted
          dddddddddddddddddddddddddddddddd: { path: 'dddddddddddddddddddddddddddddddd/1.0' },
        },
      },
    }), 'utf8');
    ok(findExtension(profile, EXT) === null, 'a copy loaded from another checkout is not THIS checkout\'s');
    const copies = findCompanionExtensions(profile);
    ok(copies.length === 1 && copies[0].id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' && copies[0].path === other,
      'but it is found by manifest name, with the directory it reads its config from — not a stranger, not a deleted one');

    writeFileSync(secure, '{ this is not json', 'utf8');
    ok(findExtension(profile, EXT) === null, 'a corrupt Secure Preferences reads as "not loaded", never throws');
    ok(findCompanionExtensions(profile).length === 0, 'and yields no copies, never throws');

    // Signing in is what syncs the candidate's saved passwords into the
    // profile, so setup reports on it rather than leaving it to chance.
    ok(signedInAccounts(profile).length === 0, 'no Preferences file means no signed-in account');
    writeFileSync(prefs, JSON.stringify({ account_info: [{ email: 'someone@example.test' }] }), 'utf8');
    ok(signedInAccounts(profile)[0] === 'someone@example.test', 'a signed-in account is read from account_info');
    writeFileSync(prefs, JSON.stringify({ account_info: [] }), 'utf8');
    ok(signedInAccounts(profile).length === 0, 'an empty account_info reads as signed out');
    writeFileSync(prefs, 'not json either', 'utf8');
    ok(signedInAccounts(profile).length === 0, 'a corrupt Preferences reads as signed out, never throws');

    // DevToolsActivePort: line 1 is the port, line 2 the websocket path.
    ok(readDevToolsPort(profile) === null, 'no port file yet reads as null');
    writeFileSync(join(profile, 'DevToolsActivePort'), '54321\n/devtools/browser/abc\n', 'utf8');
    ok(readDevToolsPort(profile) === 54321, 'the port is read from the first line');
    writeFileSync(join(profile, 'DevToolsActivePort'), 'not-a-port\n', 'utf8');
    ok(readDevToolsPort(profile) === null, 'a garbled port file reads as null rather than producing NaN');

    // Whether a Chrome is running on the profile — what decides if the
    // verification instance can start at all. Windows: Chrome holds
    // `lockfile` (delete-on-close) while it runs. Elsewhere: a SingletonLock
    // symlink to host-pid, which outlives a crash, so the pid is checked.
    ok(profileInUse(profile) === false, 'a profile no Chrome holds reads as not in use');
    if (process.platform === 'win32') {
      writeFileSync(join(profile, 'lockfile'), '', 'utf8');
      ok(profileInUse(profile) === true, 'Chrome\'s lockfile present means a Chrome is running on it');
    } else {
      symlinkSync(`somehost-${process.pid}`, join(profile, 'SingletonLock'));
      ok(profileInUse(profile) === true, 'a SingletonLock pointing at a live pid means a Chrome is running on it');
      rmSync(join(profile, 'SingletonLock'));
      symlinkSync('somehost-999999999', join(profile, 'SingletonLock'));
      ok(profileInUse(profile) === false, 'a SingletonLock left by a crashed Chrome (dead pid) reads as not in use');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the file the extension reads ────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'co-config-'));
  try {
    const ext = join(dir, 'extension');
    mkdirSync(ext);
    ok(BUNDLED_CONFIG_NAME === 'companion.local.json' && bundledConfigPath(ext) === join(ext, BUNDLED_CONFIG_NAME),
      'the file lives next to the extension code, where chrome.runtime.getURL() reaches it and a web page cannot');
    ok(readBundledConfig(ext) === null, 'no file reads as null — the extension then says setup has not run');
    ok(!bundledConfigCurrent(ext, 'http://s', 'tok'), 'and never as current');

    const written = writeBundledConfig(ext, { baseUrl: 'http://s:8377/', token: ' tok ' });
    ok(written === bundledConfigPath(ext), 'writeBundledConfig() returns the path it wrote');
    const back = readBundledConfig(ext);
    ok(back?.baseUrl === 'http://s:8377' && back?.token === 'tok',
      'the values round-trip normalised — no trailing slash, no stray whitespace — exactly as the worker normalises them');
    ok(bundledConfigCurrent(ext, 'http://s:8377/', 'tok'), 'the same server and token read as current');
    ok(!bundledConfigCurrent(ext, 'http://s:8377', 'rotated'), 'a rotated token reads as stale — setup rewrites, the worker re-imports');
    ok(!bundledConfigCurrent(ext, 'http://other', 'tok'), 'so does a changed server URL');
    ok(JSON.parse(readFileSync(written, 'utf8'))._about.includes('never commit'),
      'the file explains itself to whoever opens it');
    ok(!readFileSync(written, 'utf8').includes('.tmp') && readFileSync(written, 'utf8').endsWith('}\n'),
      'it is written whole and renamed into place, with nothing of the temporary file left in it');
    if (process.platform !== 'win32') {
      ok((statSync(written).mode & 0o777) === 0o600, 'owner-only on POSIX — it holds a live credential');
    }

    writeFileSync(written, '{ "baseUrl": "http://s" }', 'utf8');
    ok(readBundledConfig(ext) === null, 'a file with no token reads as null, not as half a config');
    writeFileSync(written, 'not json', 'utf8');
    ok(readBundledConfig(ext) === null, 'a corrupt file reads as null, never throws');

    // Writing into another checkout is gated on that checkout ignoring the
    // file — an older clone may predate the rule, and `git add -A` there would
    // publish a live token.
    ok(bundledConfigIgnored(EXT), 'this checkout gitignores it, so setup and the launcher may write it here');
    ok(!bundledConfigIgnored(ext), 'a directory git knows nothing about is never written to');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the fingerprint setup and the worker agree on ───────────────────────────
{
  const a = configFingerprint('http://server:8377', 'token-one');
  ok(a === configFingerprint('http://server:8377/', ' token-one '),
    'the fingerprint normalises the same way the values are stored, so a trailing slash cannot look like a rotation');
  ok(!a.includes('token-one') && /^[0-9a-f]{64}$/.test(a),
    'it is a hash, not the value — it gets printed and compared');
  ok(a !== configFingerprint('http://server:8377', 'token-two'), 'a different token is a different fingerprint');
  // The worker hashes the same string with the same algorithm (sw.js
  // `fingerprint`). If the two ever diverge, setup can never confirm that
  // what the extension holds came from the file it wrote.
  const sw = readFileSync(join(ROOT, 'extension', 'sw.js'), 'utf8');
  ok(/crypto\.subtle\.digest\('SHA-256', new TextEncoder\(\)\.encode\(`\$\{baseUrl\}\\n\$\{token\}`\)\)/.test(sw),
    'sw.js hashes `${baseUrl}\\n${token}` with SHA-256 — the formula configFingerprint() uses');
}

// ── neither the profile nor the config file ever reaches the repo ───────────
{
  const ignored = (rel) => {
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  ok(ignored(`${PROFILE_DIR_NAME}/`),
    'the profile is gitignored (it holds live Google, dashboard and ATS session cookies)');
  ok(ignored(`extension/${BUNDLED_CONFIG_NAME}`),
    'the config file the extension reads is gitignored (it holds the live API token)');
  ok(execFileSync('git', ['ls-files', `extension/${BUNDLED_CONFIG_NAME}`], { cwd: ROOT, encoding: 'utf8' }).trim() === '',
    'and has never been committed');
}
