// tests/companion-shortcut-mac.test.mjs — what the macOS app bundle launches.
//
// The .app is the Mac's only Dock-pinnable launcher, and the same two silent
// failure modes exist as for the Windows .lnk:
//
//   - Opening Terminal on companion.command when nothing needs setting up
//     costs a Terminal window and two Node starts on every launch. It still
//     works, so nobody investigates.
//   - A quoting slip in the launcher script starts a browser but the wrong
//     one: a fresh profile with no extension in it. Chrome's install path has
//     a space in it on every Mac, so quoting is not an edge case here.
//
// Plus two macOS-specific ways to break:
//
//   - A changed CFBundleIdentifier makes LaunchServices treat the next rewrite
//     as a brand-new app, so the plist has to stay constant while the launcher
//     flips between setup and fast.
//   - A launcher that execs the Chrome binary itself starts a browser that
//     works, signs in, and loads every page 5–50× slower than the candidate's
//     everyday Chrome: macOS leaves the exec'd tree in the background
//     scheduling band it gave the script. The fast target must go through
//     `open` so Chrome is the application being launched.
import { pass, fail, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import {
  APP_BUNDLE_NAME, BUNDLE_ID, appBundleOf, appBundleSpec, bundleFiles, infoPlist, launcherScript, shellQuote, xmlEscape,
} from '../extension/shortcut-mac.mjs';

console.log('\ncompanion — macOS launcher app bundle');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = (over = {}) => ({
  browser: CHROME_MAC,
  repo: ROOT,
  profileDir: path.join(ROOT, '.companion-profile-chrome'),
  startUrl: 'https://example.test/career',
  ready: true,
  ...over,
});

// ── which target ────────────────────────────────────────────────────────────
{
  const fast = appBundleSpec(base());
  ok(fast.kind === 'fast', 'a ready profile gets the browser directly — no Terminal window, no Node');
  ok(fast.exec[0] === 'open' && fast.exec[1] === '-n' && fast.exec[2] === '/Applications/Google Chrome.app',
    'the target is Chrome opened as an application (open -n Chrome.app) — an exec of the binary runs throttled');
  ok(fast.exec[3] === '--args' && fast.exec.indexOf('--args') < fast.exec.findIndex((a) => a.startsWith('--user-data-dir=')),
    'Chrome\'s own arguments come after --args, so open does not eat them');
  ok(!fast.exec.slice(1).includes(CHROME_MAC), 'the binary path itself never appears — open resolves the bundle');
  ok(appBundleOf(CHROME_MAC) === '/Applications/Google Chrome.app', 'the bundle is derived from the binary path');
  ok(appBundleOf('/opt/google/chrome/chrome') === null, 'a bare binary has no bundle');
  const bare = appBundleSpec(base({ browser: '/opt/google/chrome/chrome' }));
  ok(bare.kind === 'fast' && bare.exec[0] === '/opt/google/chrome/chrome',
    'a browser that is not an .app is still exec\'d directly rather than handed to open, which cannot open it');
  ok(fast.exec.some((a) => a.includes(path.join(ROOT, '.companion-profile-chrome'))),
    'it carries the companion profile');
  ok(fast.exec.includes('https://example.test/career'), 'and the start URL');
  ok(!fast.exec.some((a) => a.includes('--load-extension')),
    'no --load-extension (ignored since v137; the profile holds the extension)');

  const notReady = appBundleSpec(base({ ready: false }));
  ok(notReady.kind === 'setup',
    'a profile that still needs setting up goes through companion.command, which is what does it');
  ok(notReady.exec[0] === 'open' && notReady.exec.includes('Terminal'),
    'the setup target opens Terminal — setup asks questions, and a bundle executable has no terminal of its own');
  ok(notReady.exec.some((a) => a.endsWith('companion.command')), 'and it runs the existing entry point');

  const noBrowser = appBundleSpec(base({ browser: null }));
  ok(noBrowser.kind === 'setup', 'no resolvable browser also falls back to setup rather than a broken target');
}

// ── shell quoting ───────────────────────────────────────────────────────────
// The bug this exists for: Chrome's macOS path has a space in it, and a repo
// under a name like "it's" holds a single quote. Either, unquoted or
// mis-escaped, launches the wrong browser or nothing — silently.
{
  ok(shellQuote('/plain/path') === "'/plain/path'", 'every argument is single-quoted, spaces or not');
  ok(shellQuote(CHROME_MAC) === `'${CHROME_MAC}'`, "a path with spaces survives byte-for-byte inside the quotes");
  ok(shellQuote("it's") === "'it'\\''s'",
    'a single quote in a value is closed, escaped and reopened — not left to end the string early');
  ok(shellQuote('a$b`c\\d') === "'a$b`c\\d'",
    'dollar signs, backticks and backslashes stay literal inside single quotes');
}

// ── the launcher script ─────────────────────────────────────────────────────
{
  const fast = launcherScript(appBundleSpec(base()));
  ok(fast.startsWith('#!/bin/bash'), 'the launcher starts with a shebang — it is the bundle executable');
  ok(fast.includes("exec 'open' '-n' '/Applications/Google Chrome.app' '--args'"),
    'the fast launcher execs open -n on the Chrome bundle; the profile singleton still folds a second click into the live session');
  ok(!fast.includes(`exec '${CHROME_MAC}'`),
    'it never execs the Chrome binary from the bundle script — that is the launch that runs every page 5–50× slower');
  ok(fast.includes("'https://example.test/career'"), 'the start URL is carried, quoted');

  const setup = launcherScript(appBundleSpec(base({ ready: false })));
  ok(setup.includes("exec 'open' '-a' 'Terminal'"), 'the setup launcher opens Terminal');
  ok(setup.includes('companion.command'), 'on companion.command');
}

// ── the plist stays constant ────────────────────────────────────────────────
{
  ok(BUNDLE_ID === 'work.davidchui.career-ops.companion',
    `the bundle id is pinned (${BUNDLE_ID}) — changing it makes LaunchServices see a brand-new app`);
  ok(APP_BUNDLE_NAME === 'Career-Ops Companion.app',
    'the bundle name matches what the docs and the Dock show');

  const plist = infoPlist();
  ok(plist.includes(`<string>${BUNDLE_ID}</string>`), 'the plist carries the pinned id');
  ok(plist.includes('<string>launcher</string>'), 'CFBundleExecutable names the launcher script');
  ok(plist.includes('<string>career-ops</string>'), 'CFBundleIconFile names the committed icns');

  const fastFiles = bundleFiles({ spec: appBundleSpec(base()) });
  const setupFiles = bundleFiles({ spec: appBundleSpec(base({ ready: false })) });
  const plistOf = (files) => files.find((f) => f.path.endsWith('Info.plist')).content;
  ok(plistOf(fastFiles) === plistOf(setupFiles),
    'the plist is byte-identical across setup/fast — only the launcher flips, so a Dock pin survives the flip');

  const launcher = fastFiles.find((f) => f.path === 'Contents/MacOS/launcher');
  ok(Boolean(launcher) && launcher.mode === 0o755, 'the launcher is written executable (a 644 bundle does nothing)');
  ok(fastFiles.some((f) => f.path === 'Contents/PkgInfo' && f.content === 'APPL????'), 'PkgInfo marks it an application');

  ok(xmlEscape('a&b<c>') === 'a&amp;b&lt;c&gt;', 'plist strings are XML-escaped, so an & in a path cannot truncate it');
}

// ── the icon is a real multi-size ICNS ──────────────────────────────────────
// The macOS mirror of the .ico checks in companion-setup.test.mjs: a committed
// binary nobody re-opens is a committed binary nobody notices is broken.
{
  const file = path.join(ROOT, 'assets', 'career-ops.icns');
  ok(existsSync(file), 'assets/career-ops.icns exists (the app bundle copies it in)');
  const icns = readFileSync(file);
  ok(icns.toString('ascii', 0, 4) === 'icns', 'it has the ICNS magic');
  ok(icns.readUInt32BE(4) === icns.length, `the declared length matches the file (${icns.length} bytes — no truncation)`);

  const EXPECT = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  const seen = {};
  let intact = true;
  for (let o = 8; o < icns.length;) {
    const type = icns.toString('ascii', o, o + 4);
    const len = icns.readUInt32BE(o + 4);
    const png = icns.subarray(o + 8, o + len);
    // Every chunk must be a complete PNG whose pixel size matches its slot.
    if (o + len > icns.length || png.readUInt32BE(0) !== 0x89504e47
      || png.subarray(png.length - 8, png.length - 4).toString('ascii') !== 'IEND') intact = false;
    const width = png.readUInt32BE(16); // IHDR width: 8 sig + 4 len + 4 'IHDR'
    if (EXPECT[type] !== width) intact = false;
    seen[type] = width;
    o += len;
  }
  ok(intact, 'every chunk is a complete PNG whose size matches its slot type');
  const sizes = Object.values(seen);
  ok(Math.min(...sizes) <= 16, `it includes a 16px entry for Finder lists (smallest ${Math.min(...sizes)}px)`);
  ok(Math.max(...sizes) >= 512, `it includes a 512px entry for the Dock and Quick Look (largest ${Math.max(...sizes)}px)`);
  ok(/career-ops\.icns/.test(readFileSync(path.join(ROOT, 'scripts', 'system', 'make-icon.mjs'), 'utf8')),
    'the icns can be regenerated (scripts/system/make-icon.mjs) rather than being an unexplained binary');
}

// ── the bundle never reaches the repo, and setup wires it ───────────────────
{
  const ignored = (rel) => {
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  ok(ignored(APP_BUNDLE_NAME + '/Contents/Info.plist'),
    'the generated app bundle is gitignored (it hard-codes one machine\'s repo path)');

  const setup = readFileSync(path.join(ROOT, 'extension/setup-companion.mjs'), 'utf8');
  ok(/appBundleSpec\(/.test(setup) && /bundleFiles\(/.test(setup),
    'setup builds the app bundle on macOS the same way it builds the .lnk on Windows');
  // Fleet-specific token discovery (an ssh lookup against this project's own
  // hardware) lives in extension/fleet-hints.mjs — excluded from the public
  // export by deploy/public/career-autopilot.yml — and setup loads it only
  // when the file is actually there, falling back to the hosted default
  // otherwise. This test file is itself exported verbatim into the public
  // repo, where fleet-hints.mjs legitimately does not exist — so this checks
  // the WIRING (setup can load it, guarded), never the file's presence,
  // which differs between the private repo and the public export by design.
  // It also may not name this fleet's own hosts itself — hence no literal
  // hostname below either.
  ok(/FLEET_HINTS_PATH/.test(setup) && /existsSync\(FLEET_HINTS_PATH\)/.test(setup) && /await import\(pathToFileURL\(FLEET_HINTS_PATH\)\.href\)/.test(setup),
    'setup loads fleet-hints.mjs dynamically, guarded by existsSync — a public clone without the file still runs');
  const fleetHostNeedle = ['nuc', 'box'].join('');
  ok(!new RegExp(fleetHostNeedle).test(setup),
    "setup-companion.mjs itself names none of this fleet's own hosts any more — that knowledge moved to fleet-hints.mjs");
}
