// tests/companion-shortcut.test.mjs — what the launcher shortcut points at.
//
// The shortcut is the only thing most launches ever touch, and both ways it can
// be wrong are silent:
//
//   - Pointing at companion.cmd when nothing needs setting up costs a console
//     window, two Node starts and two server round-trips on every launch. It
//     still works, so nobody investigates.
//   - A quoting or AppUserModelID slip produces a shortcut that launches a
//     browser but the wrong one: a fresh profile with no extension in it, or a
//     second taskbar button that will not merge with the running window.
//
// Neither is visible from the machine that generated it — the same class of bug
// tests/companion-setup.test.mjs already exists to catch.
import { pass, fail, ROOT } from './helpers.mjs';
import path from 'path';
import { chromeAppId, quoteArg, shortcutScript, shortcutSpec, taskbarPinDir } from '../extension/shortcut.mjs';

console.log('\ncompanion — launcher shortcut');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));

const BACKSLASH = String.fromCharCode(92);
const ICON = path.join(ROOT, 'assets', 'career-ops.ico');
const CHROME_EXE = path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const base = (over = {}) => ({
  browser: CHROME_EXE,
  repo: ROOT,
  profileDir: path.join(ROOT, '.companion-profile-chrome'),
  startUrl: 'https://example.test/career',
  icon: ICON,
  ready: true,
  ...over,
});

// ── the taskbar identity ────────────────────────────────────────────────────
// Measured against a live companion window on 2026-08-29: Chrome reports
// exactly this AppUserModelID for a --user-data-dir of .companion-profile-chrome.
// A pinned shortcut only merges with that window if it carries the same id.
{
  const id = chromeAppId({ userDataDir: path.join(ROOT, '.companion-profile-chrome') });
  ok(id === 'Chrome..companionprofilechrome.Default',
    `the id matches what Chrome actually reports for this profile (${id})`);

  ok(chromeAppId({ userDataDir: path.join('x', '.companion-profile') }) === 'Chrome..companionprofile.Default',
    'the sanitiser keeps the leading dot and drops hyphens, as Chrome does');
  ok(chromeAppId({ userDataDir: path.join('x', 'p'), profileDirName: 'Profile 1' }) === 'Chrome.p.Profile1',
    'a non-default profile directory is sanitised too');
  ok(chromeAppId({ userDataDir: path.join('x', 'p'), baseAppId: null }) === null,
    'a caller that cannot vouch for the base id gets null, not a guess');
  ok(chromeAppId({ userDataDir: '' }) === null, 'no profile dir means no id');
}

// ── argument quoting ────────────────────────────────────────────────────────
// The bug this exists for: quoting with JSON.stringify escapes backslashes, so
// a Windows path reaches Chrome doubled and unopenable — and the browser comes
// up silently on a brand-new profile with no extension in it.
{
  const spaced = path.join('C:', 'Some Dir', 'profile');
  ok(quoteArg(`--user-data-dir=${spaced}`) === `--user-data-dir="${spaced}"`,
    'a value with a space is wrapped in quotes, verbatim — separators are never escaped');

  const backslashed = `C:${BACKSLASH}a b${BACKSLASH}c`;
  ok(quoteArg(`--user-data-dir=${backslashed}`).includes(backslashed),
    'the path survives byte-for-byte inside the quotes');
  ok(!quoteArg(`--user-data-dir=${backslashed}`).includes(BACKSLASH + BACKSLASH),
    'no backslash is ever doubled');

  ok(quoteArg('--no-first-run') === '--no-first-run', 'a bare flag is left alone');
  ok(quoteArg('--user-data-dir=/tmp/p') === '--user-data-dir=/tmp/p',
    'a value with no space needs no quotes');
  ok(quoteArg('https://example.test/x') === 'https://example.test/x', 'the URL is left alone');
}

// ── which target ────────────────────────────────────────────────────────────
{
  const fast = shortcutSpec(base());
  ok(fast.kind === 'fast', 'a ready profile gets the browser directly — no console window, no Node');
  ok(fast.target === CHROME_EXE, 'the target is the browser itself');
  ok(fast.args.includes(path.join(ROOT, '.companion-profile-chrome')), 'it carries the companion profile');
  ok(fast.args.includes('https://example.test/career'), 'and the start URL');
  ok(!fast.args.includes('--load-extension'),
    'chrome mode passes no --load-extension (ignored since v137; the profile holds the extension)');
  ok(fast.appId === 'Chrome..companionprofilechrome.Default', 'and the taskbar identity to pin against');

  const notReady = shortcutSpec(base({ ready: false }));
  ok(notReady.kind === 'setup',
    'a profile that still needs setting up goes through companion.cmd, which is what does it');
  ok(notReady.args.includes('companion.cmd'), 'the setup target runs the launcher script');
  ok(/cmd\.exe$/i.test(notReady.target),
    'it targets cmd.exe, not the .cmd file — Windows will not pin a shortcut to a batch file');
  ok(notReady.appId === null, 'the setup target claims no browser identity');

  const noBrowser = shortcutSpec(base({ browser: null }));
  ok(noBrowser.kind === 'setup', 'no resolvable browser also falls back to setup rather than a broken target');

  const relocated = shortcutSpec(base({ baseAppId: null }));
  ok(relocated.kind === 'fast' && relocated.appId === null,
    'a Chrome whose base id we cannot vouch for still gets a working shortcut, just no pin identity');
}

// ── the generated PowerShell ────────────────────────────────────────────────
{
  const spec = shortcutSpec(base());
  const two = [path.join(ROOT, 'a.lnk'), path.join(ROOT, 'b.lnk')];
  const script = shortcutScript({ spec, paths: two });
  ok(two.every((p) => script.includes(p)), 'every requested location is written');
  ok((script.match(/CreateShortcut/g) || []).length === two.length, 'one shortcut per location, no more');
  ok(script.includes('LnkAppId'),
    'the property-store shim is included, because WScript.Shell cannot set an AppUserModelID');
  ok(script.includes(spec.appId), 'and the id is handed to it');

  const plain = shortcutScript({ spec: shortcutSpec(base({ ready: false })), paths: [two[0]] });
  ok(!plain.includes('LnkAppId'), 'no id means no shim — the script stays a plain CreateShortcut');

  // A single quote terminates a PowerShell literal; a repo path holding one
  // would otherwise end the string early and run whatever followed it.
  const quoted = shortcutScript({ spec, paths: [path.join(ROOT, "it's.lnk")] });
  ok(quoted.includes("it''s.lnk"), 'a single quote in a path is doubled, not left to break out of the literal');
}

// ── where a pin lives ───────────────────────────────────────────────────────
{
  const dir = taskbarPinDir();
  ok(dir === null || dir.includes('User Pinned'),
    `the taskbar pin folder resolves from APPDATA (${dir || 'unset on this platform'})`);
}
