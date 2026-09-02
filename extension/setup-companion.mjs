#!/usr/bin/env node
// One-click setup for the Career-Ops Companion: installed, connected,
// authenticated, configured, and verified — in that order, resuming wherever
// it left off.
//
//   node extension/setup-companion.mjs               # set up, then stop
//   node extension/setup-companion.mjs --launch      # set up, then open the browser
//   node extension/setup-companion.mjs --desktop     # also drop the shortcut on the Desktop
//   node extension/setup-companion.mjs --recheck     # re-prompt for the server URL + token
//   node extension/setup-companion.mjs --verify      # on an unattended run, still ask the extension
//                                          # (from inside a throwaway browser) what it holds;
//                                          # --reseed is the old name and still works
//   node extension/setup-companion.mjs --no-prompt   # never wait for a human; report and exit
//   node extension/setup-companion.mjs --with-server # also start autopilot/server.mjs here,
//                                          # if the saved URL is loopback and nothing answers
//
// On Windows the usual entry point is double-clicking companion.cmd, which
// calls this with --launch. On macOS it is companion.command — or, once this
// script has written it, the "Career-Ops Companion" app in the repo root.
//
// Three of the steps need a human — Chrome cannot load an unpacked extension
// from the command line since v137, and nobody can type a password for you.
// Those steps open the exact page, print the exact clicks, wait, and then check
// whether it actually worked rather than assuming. Everything else is
// automatic, and every step is idempotent: a second run of a finished setup
// prompts for nothing.
//
// The design constraint is that this has to work on a PC nobody has ever set
// up before — a synced checkout and nothing else. So every step states what it
// is doing, every failure says what to do about it, and no step assumes a
// previous one left something behind.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DASHBOARD_URL, bundledConfigCurrent, bundledConfigIgnored, bundledConfigPath, configFingerprint,
  findCompanionExtensions, findExtension, launchArgs, profileDir, profileInUse, resolveBrowser,
  signedInAccounts, writeBundledConfig,
} from './launch.mjs';
import { hasCookiesFor, readConfig, testConnection, withDebugBrowser } from './verify.mjs';
import { shortcutScript, shortcutSpec, taskbarPinDir } from './shortcut.mjs';
import { APP_BUNDLE_NAME, appBundleSpec, bundleFiles } from './shortcut-mac.mjs';
import { REPO_ROOT } from '../lib/repo-root.mjs';
import { flagValue } from '../lib/cli-flags.mjs';

const REPO = REPO_ROOT;
const CONFIG = path.join(REPO, 'config', 'companion.local.json');
const ICON = path.join(REPO, 'assets', 'career-ops.ico');
const ICNS = path.join(REPO, 'assets', 'career-ops.icns');
const EXT_DIR = path.join(REPO, 'extension');
const PROFILE = profileDir(REPO);
const MIN_NODE = 20;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

// extension/fleet-hints.mjs is this project's own fleet's private discovery
// (a hardcoded tailnet IP, ssh into a specific box) — present only in this
// checkout, and deliberately excluded from the public export (see
// deploy/public/career-autopilot.yml). Loaded the same way by
// extension/smoke-test.mjs: existsSync, then a dynamic import when it is
// there, so a public clone that lacks the file simply gets the hosted
// default below instead of an ENOENT.
const FLEET_HINTS_PATH = path.join(EXT_DIR, 'fleet-hints.mjs');
const fleetHints = existsSync(FLEET_HINTS_PATH)
  ? await import(pathToFileURL(FLEET_HINTS_PATH).href)
  : null;
const HOSTED_URL = 'https://davidchui.work';
// --server (or COMPANION_URL) always wins; otherwise this fleet's own default
// when fleet-hints.mjs is present, else the hosted dashboard — which is also
// where the companion router lives (davidchui.work → /api/companion/*), so it
// doubles as the right server URL for anyone who just created a token there.
const DEFAULT_URL = flagValue(argv, '--server') || process.env.COMPANION_URL
  || (fleetHints ? fleetHints.DEFAULT_URL : HOSTED_URL);
const WINDOWS = process.platform === 'win32';
const INTERACTIVE = Boolean(process.stdin.isTTY) && !flag('no-prompt');

let step = 0;
const say = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n[${++step}] ${msg}`);
const die = (msg, fix) => {
  console.error(`\n  ✗ ${msg}`);
  if (fix) console.error(`    ${fix}`);
  process.exit(1);
};
// What still needs a human, collected as we go and repeated at the end. A
// summary nobody has to scroll back for is the difference between "it works"
// and "I think it worked".
const outstanding = [];

/**
 * Walk the candidate through something only they can do: print the steps, open
 * the page they need, wait, then check whether it actually happened.
 *
 * @param {{title: string, steps: string[], url?: string, browser?: string,
 *          note?: string, check: () => boolean}} opts
 * @returns {Promise<boolean>} whether the check passes now
 */
async function guide({ title, steps, url, check, browser, note }) {
  if (check()) return true;
  if (!INTERACTIVE) {
    say(`! ${title} — needs a person, and there is no terminal to ask on.`);
    steps.forEach((s) => say(`    ${s}`));
    outstanding.push({ title, steps });
    return false;
  }
  console.log('');
  say(`${title} — this one needs you.`);
  steps.forEach((s) => say(`    ${s}`));
  if (note) say(`    ${note}`);
  if (url && browser) {
    const child = spawn(browser, launchArgs({ profileDir: PROFILE, startUrl: url }), {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    say('    (a browser window just opened on the right page)');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Chrome flushes Preferences on exit, so "close it first" is not politeness
    // — it is what makes the check below see the truth.
    await rl.question('\n  Close the browser when you are done, then press Enter here… ');
  } finally { rl.close(); }
  const ok = check();
  say(ok ? '✓ confirmed' : '! still not done — rerun this script when you have.');
  if (!ok) outstanding.push({ title, steps });
  return ok;
}

function savedConfig() {
  if (!existsSync(CONFIG)) return null;
  try {
    const saved = JSON.parse(readFileSync(CONFIG, 'utf8'));
    return saved && saved.token ? saved : null;
  } catch { return null; }
}

console.log('\nCareer-Ops Companion — setup');
console.log(`  repo: ${REPO}`);

// ── 1. Node ─────────────────────────────────────────────────────────────────
heading('Node.js');
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE) {
  die(`Node ${process.versions.node} is too old (need ${MIN_NODE} or newer).`,
    'Install the LTS build from https://nodejs.org, then run this again.');
}
say(`✓ v${process.versions.node}`);

// ── 2. Dependencies ─────────────────────────────────────────────────────────
// Playwright is what asks the extension, from inside the browser, whether the
// config it reads by itself actually landed — so its presence is the real
// test; a node_modules/ left half-written by an interrupted install is not.
//
// The public companion repo ships with NO declared dependencies at all (see
// deploy/public/career-autopilot.yml's overlay package.json) — a bare
// `npm install` there installs nothing, silently. So the step is skipped
// outright when package.json has none to install, rather than "succeeding"
// at doing nothing and then failing the verification step below with a
// confusing MODULE_NOT_FOUND. Playwright stays entirely optional for a public
// install: extension/verify.mjs is still loaded dynamically, and step 7 notes
// how to add it back for anyone who wants the in-browser check.
heading('Dependencies');
const npm = WINDOWS ? 'npm.cmd' : 'npm';
const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const declaresDeps = Boolean(
  (pkg.dependencies && Object.keys(pkg.dependencies).length)
  || (pkg.devDependencies && Object.keys(pkg.devDependencies).length),
);
let playwrightAvailable = existsSync(path.join(REPO, 'node_modules', 'playwright'));
if (!declaresDeps) {
  say('- nothing declared in package.json — skipped');
  say('  optional: `npm install playwright` enables the in-browser verification step below');
} else if (playwrightAvailable) {
  say('✓ already installed');
} else {
  say('installing (first run — this takes a few minutes)…');
  const res = spawnSync(npm, ['install'], { cwd: REPO, stdio: 'inherit', shell: WINDOWS });
  if (res.status !== 0) {
    die('npm install failed — the output above says why.',
      'A proxy or offline machine is the usual cause. Fix that, then run this again.');
  }
  playwrightAvailable = existsSync(path.join(REPO, 'node_modules', 'playwright'));
}

// ── 3. Browser ──────────────────────────────────────────────────────────────
// Branded Chrome, and nothing else. Applying means signing in inside this
// browser — Google OAuth on some boards, a Workday candidate account whose
// screening questions only render once you are signed in — and Chrome is the
// only build with a working Google identity layer. The old Chromium fallback
// could not sign in to any of that, so it was retired rather than left as a
// trap for whoever hit it first.
heading('Google Chrome');
const browser = resolveBrowser();
if (!browser) {
  die('Google Chrome is not installed here, and it is the only browser the companion runs in.',
    'Install it from https://www.google.com/chrome/, then run this again. '
    + '(Or point COMPANION_CHROME at the executable if you keep it somewhere unusual.)');
}
say(`✓ ${browser}`);

// ── 4. Server connection ────────────────────────────────────────────────────
heading('Career-ops server');

function discoverToken() {
  if (process.env.COMPANION_TOKEN) {
    return { token: process.env.COMPANION_TOKEN.trim(), baseUrl: DEFAULT_URL, from: 'COMPANION_TOKEN' };
  }
  // --server (or COMPANION_URL) is an explicit request for a specific server
  // and must win even when a token is auto-discovered elsewhere below — e.g.
  // the autopilot runs in a container/VM reachable only at a LAN address, not
  // at the loopback or fleet address the discovery below would otherwise
  // return. Keep whatever token discovery finds; only ever override the URL.
  const explicitUrl = flagValue(argv, '--server') || process.env.COMPANION_URL;
  // Fleet-specific discovery (this project's own hardware) when it is
  // available — absent from a public clone, which falls through to the
  // local-machine check below instead.
  if (fleetHints) {
    const found = fleetHints.discoverToken(REPO);
    if (found) return explicitUrl ? { ...found, baseUrl: explicitUrl } : found;
  }
  // Not on the fleet: still worth checking whether the server runs on THIS
  // machine — the ordinary self-host case, and the one local check that
  // belongs here rather than in fleet-hints.mjs.
  const localCfg = path.join(REPO, 'config', 'autopilot.local.yml');
  if (existsSync(localCfg)) {
    const m = readFileSync(localCfg, 'utf8').match(/^\s*token:\s*(\S+)/m);
    if (m) return { token: m[1], baseUrl: explicitUrl || 'http://127.0.0.1:8377', from: 'config/autopilot.local.yml (this machine runs the server)' };
  }
  return null;
}

/** Read a secret from a terminal without echoing it. */
function askSecret(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const chars = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf) => {
      for (const byte of buf) {
        if (byte === 0x0d || byte === 0x0a) {            // Enter
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(chars.join('').trim());
        }
        if (byte === 0x03) { process.stdout.write('\n'); process.exit(130); } // Ctrl-C
        if (byte === 0x7f || byte === 0x08) {            // Backspace
          if (chars.pop()) process.stdout.write('\b \b');
        } else if (byte >= 0x20) {
          chars.push(String.fromCharCode(byte));
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * Two lines off a pipe: URL then token. Scripted setup (and this project's own
 * tests) run without a terminal, and readline's promise-based question() never
 * settles once a piped stdin has hit EOF — so read the whole thing up front
 * rather than asking twice and hanging on the second.
 */
async function readPipedAnswers() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((line) => line.trim());
}

function writeConfig(saved) {
  mkdirSync(path.dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify({ baseUrl: saved.baseUrl, token: saved.token }, null, 2)}\n`, 'utf8');
  if (!WINDOWS) chmodSync(CONFIG, 0o600);
}

let conn = flag('recheck') ? null : savedConfig();
if (conn) {
  say(`✓ using saved settings (${CONFIG.replace(REPO + path.sep, '')})`);
} else {
  const found = discoverToken();
  if (found) {
    conn = { baseUrl: found.baseUrl, token: found.token };
    say(`✓ token found via ${found.from}`);
  } else {
    say('No token found on this machine. Two values are needed, once:');
    say('  • the server URL — your own dashboard if you use the hosted service, or wherever your autopilot server listens if you self-host');
    say('  • an API token — create one at davidchui.work → Career → Companion (Create token), or use `server.token` from config/autopilot.local.yml if you self-host');
    let url;
    let token;
    if (INTERACTIVE) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        url = (await rl.question(`\n  Server URL [${DEFAULT_URL}]: `)).trim();
        token = await askSecret('  API token (not shown as you type): ');
      } finally { rl.close(); }
    } else if (!process.stdin.isTTY) {
      [url, token] = await readPipedAnswers();
    }
    if (!token) {
      if (INTERACTIVE) die('No token given.', 'Run this again once you have it.');
      // Unattended, with nothing to ask on: the machine is still worth
      // finishing. Everything below that needs the server skips itself with a
      // reason, the launcher still gets written, and the closing summary says
      // exactly what is missing — a dead stop here would leave no launcher at
      // all on a machine that only lacked a credential.
      say('! no token available — needs a person, or COMPANION_TOKEN (and COMPANION_URL) in the environment.');
      outstanding.push({
        title: 'Give setup the server URL and API token',
        steps: [
          'Run: node extension/setup-companion.mjs --recheck   (or double-click the launcher shortcut)',
          'Create a token at davidchui.work → Career → Companion (Create token) — or, if you self-host, use `server.token` from config/autopilot.local.yml.',
        ],
      });
      conn = null;
    } else {
      conn = { baseUrl: (url || DEFAULT_URL).replace(/\/+$/, ''), token };
    }
  }
  if (conn) {
    writeConfig(conn);
    say(`✓ saved to ${CONFIG.replace(REPO + path.sep, '')} (gitignored — never committed)`);
  }
}
if (conn) say(`  server: ${conn.baseUrl}   token: ${conn.token.length} characters (value not shown)`);

// The extension reads its server URL and token from a file next to its own
// code — extension/companion.local.json, gitignored — the moment any profile
// loads it. Written here, BEFORE the load-unpacked step, so the first load is
// a configured load; rewritten whenever the values change, so a rotation
// reaches the extension on its next start. This replaced pushing the values
// into one profile's storage over CDP, which only worked when the extension
// had been loaded from exactly this checkout and a debug instance could start
// — and left the panel saying "not configured" whenever it had not.
if (conn) {
  const bundled = path.relative(REPO, bundledConfigPath(EXT_DIR));
  if (bundledConfigCurrent(EXT_DIR, conn.baseUrl, conn.token)) {
    say(`✓ ${bundled} is current — the extension reads it when it starts`);
  } else {
    writeBundledConfig(EXT_DIR, conn);
    say(`✓ wrote ${bundled} — the extension reads it when it starts (gitignored — never committed)`);
  }
}

// ── 4b. Local server (opt-in) ───────────────────────────────────────────────
// "One launcher" on a single machine: when the companion points at loopback
// and nothing answers, start autopilot/server.mjs --daemon detached, logging
// to data/autopilot-server-*.log, and wait for /health. Only ever on loopback —
// a fleet URL means the server lives elsewhere and is not ours to start.
const isLoopback = (u) => { try { return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(u).hostname); } catch { return false; } };
// Unauthenticated on purpose, so this can run before a token is even known.
// /api/companion/health is the ChunkyLink companion router's own route (and
// the autopilot's, once that lands); /health is the autopilot's bare route,
// which is all an older self-hosted server has.
async function serverAnswers(baseUrl, timeoutMs = 2500) {
  for (const probe of ['/api/companion/health', '/health']) {
    try {
      const res = await fetch(`${baseUrl}${probe}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return true;
    } catch { /* try the next path */ }
  }
  return false;
}
if (flag('with-server')) {
  heading('Local autopilot server');
  if (!conn) {
    say('- skipped: no server URL + token yet');
  } else if (!isLoopback(conn.baseUrl)) {
    say(`- skipped: ${conn.baseUrl} is not this machine (start that server where it lives)`);
  } else if (await serverAnswers(conn.baseUrl)) {
    say('✓ already running');
  } else if (!existsSync(path.join(REPO, 'config', 'autopilot.local.yml'))) {
    say('! no config/autopilot.local.yml here — cannot start a server without its token; skipped');
  } else {
    const { openSync } = await import('node:fs');
    mkdirSync(path.join(REPO, 'data'), { recursive: true });
    const out = openSync(path.join(REPO, 'data', 'autopilot-server-stdout.log'), 'a');
    const err = openSync(path.join(REPO, 'data', 'autopilot-server-stderr.log'), 'a');
    const child = spawn(process.execPath, [path.join(REPO, 'autopilot', 'server.mjs'), '--daemon'],
      { cwd: REPO, detached: true, stdio: ['ignore', out, err], windowsHide: true });
    child.unref();
    say(`  started (pid ${child.pid}) — logs in data/autopilot-server-*.log`);
    const t0 = Date.now();
    let up = false;
    while (!up && Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 1000));
      up = await serverAnswers(conn.baseUrl, 1500);
    }
    say(up ? '✓ server is up' : '! server did not answer /health within 30s — check data/autopilot-server-stderr.log');
  }
}

// A wrong token is the single most common failure and it is silent from inside
// the browser, so find out here instead.
let serverReachable = false;
if (conn) {
  try {
    const res = await fetch(`${conn.baseUrl}/api/companion/plan?url=`, {
      headers: { authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      die('The server is up but rejected that token.',
        'It was probably rotated. Rerun with --recheck and paste the current one.');
    }
    const plan = await res.json().catch(() => ({}));
    serverReachable = res.ok;
    say(`✓ reachable — HTTP ${res.status}, profile plan with ${(plan.fields || []).length} contact fields`);
  } catch (err) {
    say(`! cannot reach ${conn.baseUrl}: ${String(err.message).split('\n')[0]}`);
    say('  Setup continues — fix connectivity, then rerun. Everything else still works.');
  }
}

// ── 5. The extension, loaded by hand once ───────────────────────────────────
heading('Extension');
// Loaded from this checkout is the normal case. Loaded from ANOTHER checkout
// of this repo — a worktree, an older clone a Desktop shortcut still points at
// — also counts as loaded: it is the same extension. But it reads its config
// from THAT directory, so the file has to be current there, or the panel comes
// up saying "not configured" however many times setup runs here.
const loadedElsewhere = () => findCompanionExtensions(PROFILE)
  .filter((e) => path.resolve(e.path).toLowerCase() !== path.resolve(EXT_DIR).toLowerCase());
let extensionOk = await guide({
  title: 'Chrome has to load the extension once',
  steps: [
    '1. Turn on Developer mode — the toggle at the top right',
    '2. Click "Load unpacked"',
    `3. Choose:  ${EXT_DIR}`,
  ],
  note: 'Chrome has ignored --load-extension since v137, so this cannot be scripted. Do it once and the profile keeps it.',
  url: 'chrome://extensions',
  browser,
  check: () => Boolean(findExtension(PROFILE, EXT_DIR)) || loadedElsewhere().length > 0,
});
let installed = findExtension(PROFILE, EXT_DIR);
if (installed) {
  say(`✓ loaded (id ${installed.id})`);
} else if (extensionOk) {
  installed = loadedElsewhere()[0];
  const otherRepo = path.dirname(installed.path);
  say(`! loaded from a different checkout: ${installed.path}`);
  say('  It reads its server URL and token from companion.local.json in THAT directory.');
  if (!conn) {
    say('  (nothing to write there yet — no server URL + token)');
  } else if (bundledConfigCurrent(installed.path, conn.baseUrl, conn.token)) {
    say('  ✓ and that file is current — same server and token');
  } else if (bundledConfigIgnored(installed.path)) {
    writeBundledConfig(installed.path, conn);
    say(`  ✓ wrote it there too: ${bundledConfigPath(installed.path)}`);
  } else {
    say('  ! that checkout does not gitignore extension/companion.local.json, so a live token');
    say('    was not written where `git add` could publish it.');
    outstanding.push({
      title: 'The extension is loaded from a different checkout',
      steps: [
        `Either remove it at chrome://extensions and Load unpacked from  ${EXT_DIR}`,
        `or update that checkout (git pull in ${otherRepo}) and run setup there.`,
      ],
    });
    extensionOk = false;
  }
}
// Where the extension actually reads its config from — this checkout unless
// it was loaded from another one — and whether that file says what setup
// saved. The shortcut's fast target and the closing verdict both hang on it.
const loadedDir = () => (installed ? installed.path : EXT_DIR);
const configReady = () => extensionOk && Boolean(conn) && bundledConfigCurrent(loadedDir(), conn.baseUrl, conn.token);

// ── 6. Signed in to Chrome ──────────────────────────────────────────────────
// This is what makes the profile usable day to day: signing in syncs the
// candidate's saved passwords, autofill and password generator into it, which
// is the whole reason creating a Workday account here no longer means
// switching to another browser to look a credential up.
heading('Google sign-in');
await guide({
  title: 'Sign this profile in to Chrome',
  steps: [
    '1. Click "Sign in" (or the profile circle, top right)',
    '2. Use the Google account whose saved passwords you want here',
    '3. Say yes to sync — that is what brings the passwords across',
  ],
  note: 'Skip it if you would rather keep passwords out of this profile; everything else still works.',
  url: 'chrome://settings/people',
  browser,
  check: () => signedInAccounts(PROFILE).length > 0,
});
const accounts = signedInAccounts(PROFILE);
if (accounts.length) say(`✓ signed in as ${accounts.join(', ')} — saved passwords and autofill are available here`);

// ── 7. What the extension actually holds ────────────────────────────────────
// The file is in place; this asks the extension, from inside a throwaway
// browser over CDP, whether it imported it, and makes it call the server
// through its own fetch with its own stored token. "curl reached the server"
// would not prove that chain. Verification only — nothing is written into the
// browser from here any more, so a run that cannot open a browser (unattended,
// or one already running on the profile) loses a check, not the setup.
heading('Extension config');
let verified = null;
let dashboardLoggedIn = false;
const wantVerify = INTERACTIVE || flag('verify') || flag('reseed');
if (!extensionOk) {
  say('- skipped: nothing to verify until the extension is loaded');
} else if (!conn) {
  say('- skipped: no server URL + token yet');
} else if (!playwrightAvailable) {
  say('- skipped: playwright is not installed (optional: `npm install playwright` enables this check)');
  say('  The config file is in place; the extension imports it when it starts.');
} else if (!wantVerify) {
  say('- not verified from inside the browser on an unattended run (pass --verify to do that)');
  say('  The config file is in place; the extension imports it when it starts.');
} else if (profileInUse(PROFILE)) {
  say('! the companion browser is open on this profile, so it cannot be verified from inside right now.');
  say('  The config file is in place. A running extension picks it up on its next start, or');
  say('  from its options page → "Reload from setup file". Close the browser and rerun to verify.');
} else {
  say('asking the extension…');
  try {
    verified = await withDebugBrowser(
      { browser, profileDir: PROFILE, startUrl: `chrome-extension://${installed.id}/options.html` },
      async ({ context }) => ({
        stored: await readConfig(context, installed.id),
        test: await testConnection(context, installed.id),
        dash: await hasCookiesFor(context, DASHBOARD_URL),
      }),
    );
    dashboardLoggedIn = verified.dash;
    const { stored } = verified;
    const expected = configFingerprint(conn.baseUrl, conn.token);
    if (stored.reloaded) say('  (the extension was running code from before the config file existed — reloaded it from disk)');
    if (stored.storedFingerprint === expected && stored.bundledFingerprint === expected) {
      say(`✓ the extension imported the config file by itself: ${stored.baseUrl} (token ${stored.tokenLength} chars)`);
    } else if (stored.storedFingerprint === expected) {
      say(`✓ the extension holds ${stored.baseUrl} (token ${stored.tokenLength} chars) — the right values, though not`);
      say(`  imported from the file${stored.answered ? '' : ' (its worker did not answer — reload it at chrome://extensions)'}.`);
    } else {
      say(`! the extension holds ${stored.baseUrl || 'no server URL'} (token ${stored.tokenLength} chars), not what setup wrote.`);
      say('  Its options page → "Reload from setup file" makes the file win.');
    }
    say(verified.test.ok
      ? `✓ the extension reached the server itself — ${verified.test.fields} contact fields`
      : `! the extension could not reach the server: ${verified.test.error || `HTTP ${verified.test.status}`}`);
  } catch (err) {
    say(`! could not verify from inside the browser: ${String(err.message).split('\n')[0]}`);
    say('  Not fatal — the config file is in place and the extension imports it when it starts.');
    say('  If the panel still says "not configured": reload the extension at chrome://extensions,');
    say('  or open its options page and press "Reload from setup file".');
  }
}

// ── 8. Signed in to the dashboard ───────────────────────────────────────────
heading('Dashboard sign-in');
if (!extensionOk) {
  say('- skipped');
} else if (dashboardLoggedIn) {
  // The honest answer, from the cookie jar itself — but it is only available
  // on a run that opened a browser we could talk to, i.e. one that verified.
  say(`✓ signed in to ${DASHBOARD_URL} (cookies present)`);
} else if (await guide({
  title: 'Sign in to your pipeline dashboard',
  steps: [
    `1. The dashboard is at ${DASHBOARD_URL}`,
    '2. Sign in with GitHub when it asks',
  ],
  note: 'The profile keeps this, so it is the last time you will be asked.',
  url: DASHBOARD_URL,
  browser,
  // Reading the cookie jar needs a browser we can drive, and this run may not
  // have opened one. The cookie store existing at all is the weaker stand-in;
  // a run that verifies from inside the browser reports the real answer above.
  check: () => existsSync(path.join(PROFILE, 'Default', 'Network', 'Cookies')),
})) {
  say('✓ the profile has a cookie store — sign-in not re-checked this run');
  say(`  (--verify opens a browser and reports whether ${new URL(DASHBOARD_URL).host} cookies are really there)`);
}

// ── 9. Launcher shortcut ────────────────────────────────────────────────────
// Where the user's Desktop really is. os.homedir()/Desktop does not exist on
// machines with a redirected Desktop — OneDrive's known-folder move (the
// default on most Windows 11 setups) is the common case — so ask the shell
// first (User Shell Folders registry) and only fall back to filesystem
// guesses. Returns null when nothing plausible is found; the caller says so
// instead of failing silently.
function desktopPath() {
  if (!WINDOWS) return null;
  try {
    const out = execFileSync('reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(\S[^\r\n]*)/);
    if (m) {
      const expanded = m[1].trim()
        .replace(/^%USERPROFILE%/i, os.homedir())
        .replace(/^%HOMEDRIVE%%HOMEPATH%/i, os.homedir())
        .replace(/%([^%]+)%/g, (all, name) => process.env[name] || all);
      if (existsSync(expanded)) return expanded;
    }
  } catch { /* registry unreadable — fall through to the filesystem guesses */ }
  return [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
  ].find((candidate) => existsSync(candidate)) || null;
}

heading('Launcher shortcut');
if (WINDOWS) {
  if (!existsSync(ICON)) die(`Missing ${ICON}`, 'Run: node scripts/system/make-icon.mjs');

  // Point the shortcut straight at Chrome once there is nothing left for a
  // launch to do — no console window, no Node, no server round-trip. Until
  // then it has to go through companion.cmd, which is what does the setting up.
  const ready = configReady();
  const spec = shortcutSpec({
    browser, repo: REPO, profileDir: PROFILE, startUrl: DASHBOARD_URL, icon: ICON, ready,
  });

  // Refresh every copy that already exists, wherever the candidate put it — a
  // stale Desktop or taskbar copy still pointing at the old target is worse
  // than no copy, because it looks like it works.
  const shortcutPath = path.join(REPO, 'Career-Ops Companion.lnk');
  const targets = [shortcutPath];
  const desktop = desktopPath();
  const desktopLink = desktop && path.join(desktop, 'Career-Ops Companion.lnk');
  if (desktopLink && (flag('desktop') || existsSync(desktopLink))) targets.push(desktopLink);
  // The taskbar pin is left alone, deliberately, and this is the expensive
  // lesson: rewriting a pinned .lnk in place makes Explorer re-resolve it
  // against the Taskband registry blob, decide it no longer matches, and
  // silently delete the pin. Observed on 2026-08-29 — the pin vanished the
  // moment its target became chrome.exe. Creating one is not possible either;
  // Windows has blocked programmatic pinning for years. So: report, never
  // touch, and let the candidate right-click once.
  const pinDir = taskbarPinDir();
  const pinnedLink = pinDir && path.join(pinDir, 'Career-Ops Companion.lnk');
  const pinned = Boolean(pinnedLink && existsSync(pinnedLink));

  const scriptFile = path.join(os.tmpdir(), `career-ops-shortcut-${process.pid}.ps1`);
  writeFileSync(scriptFile, shortcutScript({ spec, paths: targets }), 'utf8');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { stdio: 'pipe', timeout: 60_000 });
    say(spec.kind === 'fast'
      ? '✓ opens Chrome directly — no console window, nothing to wait for'
      : `✓ runs companion.cmd — ${spec.why}`);
    say('✓ Career-Ops Companion.lnk (in the repo root)');
    if (targets.includes(desktopLink)) say(`✓ Desktop (${desktop})`);
    if (pinned) {
      say('! a taskbar pin exists and was left untouched — rewriting one makes Explorer delete it.');
      say('  If it no longer opens the right thing: unpin it, then right-click the Desktop');
      say('  shortcut → Pin to taskbar.');
    } else {
      say('  To pin it: right-click the Desktop shortcut → Pin to taskbar.');
    }
    if (spec.appId) say(`  taskbar identity: ${spec.appId} (so the pin merges with the running window)`);
  } catch (err) {
    say(`! could not create the shortcut: ${String(err.message).split('\n')[0]}`);
    say('  Not fatal — double-click companion.cmd in the repo root instead.');
  } finally {
    rmSync(scriptFile, { force: true });
  }
} else {
  const command = path.join(REPO, 'companion.command');
  if (existsSync(command)) {
    chmodSync(command, 0o755);
    say('✓ companion.command is executable — the double-click terminal fallback');
  }
  if (process.platform === 'darwin') {
    // The macOS analog of the .lnk: a real app bundle, so the Dock can pin it
    // and Finder shows the icon. Same fast/setup decision as Windows; the
    // bundle is rewritten in place on every run, which macOS — unlike
    // Explorer's Taskband — is fine with, because the Dock pins by path.
    if (!existsSync(ICNS)) die(`Missing ${ICNS}`, 'Run: node scripts/system/make-icon.mjs');
    const ready = configReady();
    const spec = appBundleSpec({ browser, repo: REPO, profileDir: PROFILE, startUrl: DASHBOARD_URL, ready });
    const appDir = path.join(REPO, APP_BUNDLE_NAME);
    try {
      for (const file of bundleFiles({ spec })) {
        const dest = path.join(appDir, file.path);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, file.content, 'utf8');
        chmodSync(dest, file.mode);
      }
      mkdirSync(path.join(appDir, 'Contents', 'Resources'), { recursive: true });
      copyFileSync(ICNS, path.join(appDir, 'Contents', 'Resources', 'career-ops.icns'));
      // Finder caches a bundle's icon against the directory's mtime; bump it
      // so a rewritten bundle shows the icon without poking Finder.
      utimesSync(appDir, new Date(), new Date());
      say(spec.kind === 'fast'
        ? '✓ opens Chrome directly — no Terminal window, nothing to wait for'
        : `✓ opens Terminal on companion.command — ${spec.why}`);
      say(`✓ ${APP_BUNDLE_NAME} (in the repo root) — drag it onto the Dock to pin it`);

      // The Desktop copy is a symlink to the bundle in the repo, so it can
      // never go stale the way a copied shortcut can — a rerun that flips the
      // target refreshes every entry point at once.
      const desktop = path.join(os.homedir(), 'Desktop');
      const desktopApp = path.join(desktop, APP_BUNDLE_NAME);
      const linkThere = (() => { try { lstatSync(desktopApp); return true; } catch { return false; } })();
      if (existsSync(desktop) && (flag('desktop') || linkThere)) {
        rmSync(desktopApp, { recursive: true, force: true });
        symlinkSync(appDir, desktopApp);
        say(`✓ Desktop (a symlink to the repo bundle, so it cannot go stale)`);
      }
    } catch (err) {
      say(`! could not write the app bundle: ${String(err.message).split('\n')[0]}`);
      say('  Not fatal — double-click companion.command in the repo root instead.');
    }
  }
  if (process.platform === 'linux') {
    const desktopEntry = path.join(REPO, 'career-ops-companion.desktop');
    writeFileSync(desktopEntry, [
      '[Desktop Entry]', 'Type=Application', 'Name=Career-Ops Companion',
      'Comment=Set up and launch the Career-Ops Companion browser',
      `Exec=${command}`, `Icon=${ICON}`, `Path=${REPO}`, 'Terminal=true', 'Categories=Development;',
    ].join('\n') + '\n', 'utf8');
    chmodSync(desktopEntry, 0o755);
    say('✓ career-ops-companion.desktop (in the repo root) — copy it to ~/.local/share/applications/');
  }
}

// ── done ────────────────────────────────────────────────────────────────────
const complete = configReady() && serverReachable;
const configLine = !conn
  ? 'NOT CONFIGURED — see "Still to do" below'
  : bundledConfigCurrent(loadedDir(), conn.baseUrl, conn.token)
    ? `${path.relative(REPO, bundledConfigPath(loadedDir()))} — current; the extension reads it when it starts`
    : `${bundledConfigPath(loadedDir())} — NOT WRITTEN, see "Still to do" below`;
console.log(`\n${'─'.repeat(66)}`);
console.log(complete ? '  Ready.' : '  Set up, with the gaps below.');
console.log(`    browser    ${browser}`);
console.log(`    profile    ${PROFILE}`);
console.log(`    extension  ${installed ? `loaded (${installed.id})${findExtension(PROFILE, EXT_DIR) ? '' : ` from ${installed.path}`}` : 'NOT LOADED'}`);
console.log(`    config     ${configLine}`);
console.log(`    signed in  ${accounts.length ? accounts.join(', ') : 'no Google account — saved passwords will not be here'}`);
console.log(`    server     ${conn ? `${conn.baseUrl}${serverReachable ? ' — reachable' : ' — UNREACHABLE'}` : 'NOT CONFIGURED — see "Still to do" below'}`);
if (verified) {
  console.log(`    verified   ${verified.test.ok
    ? `the extension reached the server itself (${verified.test.fields} contact fields)`
    : `the extension could NOT reach the server: ${verified.test.error || `HTTP ${verified.test.status}`}`}`);
}

if (outstanding.length) {
  console.log('\n  Still to do:');
  for (const item of outstanding) {
    console.log(`    • ${item.title}`);
    item.steps.forEach((s) => console.log(`        ${s}`));
  }
  console.log('\n  Then run this again — it picks up where it left off.');
}
console.log('─'.repeat(66));

if (!flag('launch')) {
  console.log('\n  Launch it with the "Career-Ops Companion" shortcut, or: npm run companion\n');
  process.exit(0);
}

// Hand over to the launcher. It spawns the browser detached, so this returns
// in a moment and closing the console no longer takes the browser with it.
const launch = spawnSync(process.execPath, [path.join(REPO, 'extension', 'dev-launch.mjs'), ...argv.filter((a) => !a.startsWith('--'))],
  { cwd: REPO, stdio: 'inherit' });
process.exit(launch.status ?? 0);
