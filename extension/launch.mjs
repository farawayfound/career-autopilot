// How the companion browser gets launched — where it is, what it is started
// with, and the bits of profile and checkout state the launcher reads back off
// disk.
//
// Everything here is pure or filesystem-only, so the launcher's decisions can
// be tested without starting a browser (tests/companion-launch.test.mjs).
//
// ── Branded Chrome, and only branded Chrome ────────────────────────────────
//
// Applying means signing in *inside* this browser: Google OAuth on some
// boards, and a per-tenant Workday candidate account whose screening questions
// only ever render inside the authenticated apply flow
// (see `questions: []` in autopilot/lib/jd.mjs). Branded Chrome is the only
// build with a working Google identity layer — sign-in, Google Password
// Manager, passkeys — so it is the only browser this launcher drives.
//
// The companion used to fall back to a portable Chromium or Playwright's
// bundled build. That build is Google's "Chrome for Testing", which ships
// without the API keys Chrome sign-in needs, so every one of those sign-ins
// failed in it. The fallback was retired rather than left as a trap. The
// bundled build still runs extension/smoke-test.mjs, which wants a throwaway
// browser and never signs in to anything.
//
// Chrome has ignored --load-extension since v137, so the extension is loaded
// once through chrome://extensions and the profile keeps it from then on.
// extension/setup-companion.mjs walks the candidate through that.
//
// ── Why the launcher spawns the browser itself ─────────────────────────────
//
// It used to go through Playwright's launchPersistentContext, which injects
// around thirty switches of its own. Three of them make signing in impossible
// whatever the binary: --disable-sync, --password-store=basic and
// --use-mock-keychain, plus --enable-automation (navigator.webdriver) and a
// CDP channel attached for the whole session, which Google's sign-in reads as
// automation. So the working session is a plain spawn with only the flags
// below. CDP appears exactly once, in extension/verify.mjs, against a
// throwaway instance that is closed before the candidate's session starts —
// and only to check what the extension holds, never to configure it.
//
// ── How the extension gets its server URL and token ────────────────────────
//
// It reads them itself, from companion.local.json in this directory, which
// setup writes (gitignored — see writeBundledConfig). The service worker
// imports the file into chrome.storage.local when it starts, whenever storage
// is empty, whenever the file changes, and whenever the server rejects the
// token storage holds. So any profile that loads this directory is configured
// the moment it loads, on any machine, and a rotated token propagates on its
// own.
//
// It used to be pushed into one profile's storage over CDP, from outside, and
// that only worked when every precondition lined up: the extension loaded from
// exactly this checkout's path, a throwaway debug instance able to start, the
// seed step actually reached. Load the extension from a second checkout, or
// open it in another profile, and the panel said "not configured" — which is
// what happened on two machines running. The file travels with the directory
// the extension was loaded from, and nothing is pushed anywhere.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Where the companion opens when no application URL was given. */
export const DASHBOARD_URL = 'https://davidchui.work/career';

/** The profile directory, relative to the repo. Gitignored: it holds live sessions. */
export const PROFILE_DIR_NAME = '.companion-profile-chrome';

/** The extension's manifest name — how a loaded copy is recognised whatever path it came from. */
export const COMPANION_EXTENSION_NAME = 'Career-Ops Companion';

/** The config file the extension reads, next to its own code. Gitignored. */
export const BUNDLED_CONFIG_NAME = 'companion.local.json';

/** @param {string} repo @returns {string} */
export function profileDir(repo) {
  return path.join(repo, PROFILE_DIR_NAME);
}

/**
 * Branded Chrome, in install-likelihood order. `%ProgramFiles%` is read from
 * the environment first because a 32-bit Node on 64-bit Windows sees a
 * different literal than the one hard-coded below.
 */
function chromeCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    home && path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ];
}

/**
 * Locate branded Chrome. `COMPANION_CHROME` means "this exact binary" and wins
 * — the escape hatch for an install in an unusual place.
 *
 * @returns {string|undefined} undefined when Chrome is not installed
 */
export function resolveBrowser() {
  return [process.env.COMPANION_CHROME, ...chromeCandidates()]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
}

/**
 * The full argv for a plain, un-automated spawn.
 *
 * Deliberately short. Every switch beyond these is something Playwright used
 * to add on our behalf, and the reason signing in did not work. Note the
 * absence of --load-extension (Chrome ignores it since v137, so passing it
 * would be a silent lie) and of --disable-extensions-except, which used to
 * mean no password manager could ever live in this profile.
 *
 * `debugPort` is only ever passed by extension/verify.mjs, for the throwaway
 * instance it uses to ask the extension what it holds. 0 lets the OS choose;
 * the real port lands in the profile's DevToolsActivePort.
 *
 * @param {{profileDir: string, extDir?: string, startUrl?: string, debugPort?: number}} opts
 * @returns {string[]}
 */
export function launchArgs({ profileDir: dir, startUrl, debugPort }) {
  const args = [
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (debugPort !== undefined) args.push(`--remote-debugging-port=${debugPort}`);
  if (startUrl) args.push(startUrl);
  return args;
}

/**
 * Chrome's record of every extension in a profile: `extensions.settings` in
 * `Default/Secure Preferences`, keyed by id, each with the `path` it was
 * loaded from. Unpacked extensions record an absolute path; store-installed
 * ones a relative "id/version".
 *
 * @param {string} dir profile directory
 * @returns {Record<string, {path?: string}>} empty when unreadable
 */
function extensionSettings(dir) {
  const file = path.join(dir, 'Default', 'Secure Preferences');
  if (!existsSync(file)) return {};
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8'))?.extensions?.settings;
    return settings && typeof settings === 'object' ? settings : {};
  } catch { return {}; }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Find the companion extension in a profile, by the directory it was loaded
 * from. This is how setup tells "never loaded" from "ready to go", and how it
 * learns the extension's id without re-implementing Chrome's path hashing.
 *
 * @param {string} dir profile directory
 * @param {string} extDir the repo's extension/ directory
 * @returns {{id: string, path: string}|null}
 */
export function findExtension(dir, extDir) {
  for (const [id, entry] of Object.entries(extensionSettings(dir))) {
    const where = entry && typeof entry.path === 'string' ? entry.path : null;
    if (where && path.isAbsolute(where) && samePath(where, extDir)) {
      return { id, path: where };
    }
  }
  return null;
}

/**
 * Every unpacked copy of the companion in a profile, whatever checkout it was
 * loaded from — recognised by the manifest name at the loaded path, not by
 * the path itself.
 *
 * This is the case findExtension() cannot see: a profile whose extension was
 * loaded from ANOTHER checkout of this repo (a worktree, an older clone a
 * Desktop shortcut still points at). Setup used to report that as "not
 * loaded" and skip configuring it, which is how a working-looking browser
 * came up with an unconfigured panel. The extension reads its config from the
 * directory it was loaded from, so the caller needs that path.
 *
 * @param {string} dir profile directory
 * @returns {{id: string, path: string}[]}
 */
export function findCompanionExtensions(dir) {
  const found = [];
  for (const [id, entry] of Object.entries(extensionSettings(dir))) {
    const where = entry && typeof entry.path === 'string' ? entry.path : null;
    if (!where || !path.isAbsolute(where)) continue;
    let name;
    try {
      name = JSON.parse(readFileSync(path.join(where, 'manifest.json'), 'utf8'))?.name;
    } catch { continue; }
    if (name === COMPANION_EXTENSION_NAME) found.push({ id, path: where });
  }
  return found;
}

/**
 * The Google accounts this profile is signed in to, which is what brings the
 * candidate's saved passwords, autofill and password generator with it.
 *
 * @param {string} dir profile directory
 * @returns {string[]} email addresses, empty when signed out
 */
export function signedInAccounts(dir) {
  const file = path.join(dir, 'Default', 'Preferences');
  if (!existsSync(file)) return [];
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'))?.account_info;
    if (!Array.isArray(info)) return [];
    return info.map((a) => (a && a.email) || '(unknown)').filter(Boolean);
  } catch { return []; }
}

/**
 * The port Chrome bound, written into the profile at startup. Line 1 is the
 * port; line 2 is the browser's websocket path.
 *
 * @param {string} dir profile directory
 * @returns {number|null}
 */
export function readDevToolsPort(dir) {
  const file = path.join(dir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  try {
    const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

/**
 * Whether a Chrome is running on this profile right now. A second Chrome
 * started on a profile in use hands its arguments to the first and exits, so
 * the throwaway verification instance would never open its debug port — this
 * is how setup says so up front instead of waiting out a timeout.
 *
 * Windows: Chrome holds `lockfile` open (share-read, delete-on-close) for as
 * long as it runs, so the file existing is the signal. Elsewhere Chrome leaves
 * a `SingletonLock` symlink whose target is `host-pid`; the link outlives a
 * crash, so the pid is checked too.
 *
 * @param {string} dir profile directory
 * @returns {boolean}
 */
export function profileInUse(dir) {
  if (process.platform === 'win32') return existsSync(path.join(dir, 'lockfile'));
  let target;
  try { target = readlinkSync(path.join(dir, 'SingletonLock')); } catch { return false; }
  const pid = Number(target.split('-').pop());
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) { return err.code === 'EPERM'; }
}

// ── the config file the extension reads ─────────────────────────────────────

/** @param {string} extDir @returns {string} */
export function bundledConfigPath(extDir) {
  return path.join(extDir, BUNDLED_CONFIG_NAME);
}

const normalizeUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

/**
 * What the extension will read from a given extension directory.
 *
 * @param {string} extDir
 * @returns {{baseUrl: string, token: string}|null} null when absent, unreadable, or incomplete
 */
export function readBundledConfig(extDir) {
  const file = bundledConfigPath(extDir);
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    const baseUrl = normalizeUrl(cfg && cfg.baseUrl);
    const token = String((cfg && cfg.token) || '').trim();
    return baseUrl && token ? { baseUrl, token } : null;
  } catch { return null; }
}

/**
 * Write the file the extension reads. Written whole and renamed into place, so
 * a worker that happens to read it mid-write sees the old file or the new one,
 * never half of either; owner-only on POSIX, since it holds a live credential.
 *
 * @param {string} extDir
 * @param {{baseUrl: string, token: string}} cfg
 * @returns {string} the path written
 */
export function writeBundledConfig(extDir, { baseUrl, token }) {
  const file = bundledConfigPath(extDir);
  const body = `${JSON.stringify({
    _about: 'Written by extension/setup-companion.mjs for this machine. The Career-Ops Companion extension reads it when it starts. Gitignored — never commit it.',
    baseUrl: normalizeUrl(baseUrl),
    token: String(token).trim(),
  }, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // The rename can lose to a reader holding the file open for an instant;
    // a direct write is the fallback, not a silent skip.
    rmSync(tmp, { force: true });
    writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

/**
 * Whether the file the extension reads already says exactly this. What setup
 * and the launcher check before writing, and what the shortcut's fast target
 * depends on.
 *
 * @param {string} extDir
 * @param {string} baseUrl
 * @param {string} token
 * @returns {boolean}
 */
export function bundledConfigCurrent(extDir, baseUrl, token) {
  const cur = readBundledConfig(extDir);
  return Boolean(cur) && cur.baseUrl === normalizeUrl(baseUrl) && cur.token === String(token).trim();
}

/**
 * Whether the checkout an extension directory belongs to gitignores the
 * config file — the precondition for writing a live token into a checkout
 * other than this one (an older clone may predate the ignore rule, and a
 * reflexive `git add -A` there would publish it).
 *
 * @param {string} extDir
 * @returns {boolean} false when git cannot answer
 */
export function bundledConfigIgnored(extDir) {
  const r = spawnSync('git', ['-C', extDir, 'check-ignore', '-q', BUNDLED_CONFIG_NAME], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Identifies one server URL + token pair without containing either — the
 * same SHA-256 the extension computes when it imports the file, so setup can
 * tell that what the extension holds came from the file it wrote.
 *
 * @param {string} baseUrl
 * @param {string} token
 * @returns {string} 64 hex characters
 */
export function configFingerprint(baseUrl, token) {
  return createHash('sha256').update(`${normalizeUrl(baseUrl)}\n${String(token).trim()}`).digest('hex');
}
