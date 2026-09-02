#!/usr/bin/env node
// Career-Ops Companion — launcher.
//
//   npm run companion                       # dashboard
//   npm run companion -- <job-page-url>      # straight onto an application
//   node extension/dev-launch.mjs [url]      # same thing, long form
//
// Opens the companion browser. Nothing more: extension/setup-companion.mjs is what
// installs, connects, authenticates and verifies — run that (or double-click
// companion.cmd) when something is not yet in place, and this will say so
// rather than guessing.
//
// The session is a plain spawn — no Playwright, no CDP, none of the automation
// switches that make Google refuse to sign you in. See extension/launch.mjs.
//
// Most launches do not need this script at all: the shortcut setup writes goes
// straight to chrome.exe with these same arguments. This exists for the
// terminal, and for the checks it does before opening anything.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_URL, bundledConfigCurrent, bundledConfigIgnored, bundledConfigPath, findCompanionExtensions,
  findExtension, launchArgs, profileDir, resolveBrowser, writeBundledConfig,
} from './launch.mjs';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(EXT_DIR, '..');
const PROFILE_DIR = profileDir(REPO);
const START_URL = process.argv[2] || DASHBOARD_URL;

const setupHint = 'Run `node extension/setup-companion.mjs` (or double-click companion.cmd) — it walks through the rest.';

function savedConfig() {
  const file = path.join(REPO, 'config', 'companion.local.json');
  if (!existsSync(file)) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return saved && saved.token ? saved : null;
  } catch { return null; }
}

const browser = resolveBrowser();
if (!browser) {
  console.error('Google Chrome is not installed here, and it is the only browser the companion runs in.');
  console.error('Install it from https://www.google.com/chrome/, or point COMPANION_CHROME at the executable.');
  process.exit(1);
}

// Two things have to be true before a launch is worth anything, and a third
// this script can put right itself. Each is cheap to check from outside the
// browser, and each has a specific fix.
const saved = savedConfig();
// Loaded from this checkout, or — a worktree, an older clone — from another
// checkout of this repo: either runs, but the extension reads its config from
// the directory it was loaded from, so that is the directory to keep current.
const installed = findExtension(PROFILE_DIR, EXT_DIR) || findCompanionExtensions(PROFILE_DIR)[0] || null;

if (!saved) {
  console.error('No server URL or API token saved for this machine (config/companion.local.json).');
  console.error(setupHint);
  process.exit(1);
}
if (!installed) {
  console.error('The extension is not loaded in this profile yet — Chrome needs it loaded once by hand.');
  console.error(setupHint);
  process.exit(1);
}

// The extension reads extension/companion.local.json by itself when it starts.
// Keeping that file in step with what setup saved is cheap and idempotent, and
// it is what makes a rotated token (setup --recheck) reach the extension on its
// next start without another full setup run.
const loadedDir = installed.path;
const sameCheckout = path.resolve(loadedDir).toLowerCase() === path.resolve(EXT_DIR).toLowerCase();
if (!bundledConfigCurrent(loadedDir, saved.baseUrl, saved.token)) {
  if (!sameCheckout && !bundledConfigIgnored(loadedDir)) {
    console.error(`The extension is loaded from ${loadedDir}, and that checkout does not gitignore`);
    console.error('extension/companion.local.json — a live token will not be written where `git add` could publish it.');
    console.error(`Update that checkout, or remove the extension at chrome://extensions and Load unpacked from ${EXT_DIR}.`);
    process.exit(1);
  }
  writeBundledConfig(loadedDir, saved);
  console.log(`Config  : wrote ${bundledConfigPath(loadedDir)} — the extension imports it when it starts`);
}

console.log(`Browser : ${browser}`);
console.log(`Profile : ${PROFILE_DIR}`);
if (!sameCheckout) console.log(`Loaded  : from ${loadedDir} (another checkout — its config file is the one that counts)`);
console.log(`Server  : ${saved.baseUrl} (token ${saved.token.length} chars, value not shown)`);

const child = spawn(browser, launchArgs({ profileDir: PROFILE_DIR, startUrl: START_URL }), {
  detached: true,
  stdio: 'ignore',
});
child.unref();

console.log(`
Ready (pid ${child.pid}). ${START_URL}
  - Open a job application page from your queue: on known ATS hosts the panel
    auto-opens and fills when the URL matches an active item.
  - Manual trigger: puzzle-piece menu -> Career-Ops Companion, or Alt+Shift+C.
  - After editing extension code: hit reload on the card at chrome://extensions.
  - If the panel says "not configured": reload the extension once — it reads
    extension/companion.local.json when it starts.
The browser keeps running after this command exits.`);
