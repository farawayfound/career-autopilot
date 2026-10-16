#!/usr/bin/env node
// autopilot/discovery-node-start.mjs — install, configure and START the
// CareerAutopilot discovery node on this computer, from one command.
//
//   discovery-node.cmd            (Windows: double-click)
//   discovery-node.command        (macOS: double-click)
//   ./discovery-node.sh           (Linux / macOS terminal)
//   node autopilot/discovery-node-start.mjs [--reconfigure] [--port N] [--no-open]
//                                           [--token-file PATH] [--url URL] [--name NAME]
//
// What it does, in order: checks Node.js, installs the one dependency it needs if
// that is missing, asks a few questions the first time (your CareerAutopilot
// address, a discovery token, a name for this computer), saves them, then runs the
// node IN THIS WINDOW and prints the address of its local dashboard.
//
// What it will never do: install anything that outlives this window. There is no
// service, no scheduled task, no launch agent, no startup entry, no cron line, no
// registry key. Close the window (or press Ctrl+C, or press Stop on the dashboard)
// and the node is gone; run this script again to start it again. That is a
// promise about the whole package, not a default — nothing here has a switch for
// it.
//
// Import discipline: the dependency (js-yaml) may not be installed yet when this
// file starts, so everything it imports at the top is a Node built-in or a leaf
// helper that is itself built-ins only. The modules that need js-yaml are
// import()ed AFTER the install step.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { hostname, userInfo } from 'node:os';
import { isMainModule } from '../lib/is-main-module.mjs';
import { REPO_ROOT } from '../lib/repo-root.mjs';

const ROOT = REPO_ROOT;
const SELF = fileURLToPath(import.meta.url);
export const DEFAULT_SITE_URL = 'https://davidchui.work';
export const MIN_NODE_MAJOR = 20;

const PATHS = {
  config: join(ROOT, 'config', 'discovery-node.yml'),
  example: join(ROOT, 'config', 'discovery-node.user.example.yml'),
  overlay: join(ROOT, 'config', 'discovery-node.local.yml'),
  lockfile: join(ROOT, 'package-lock.json'),
};

const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOKEN_RE = /^cot_[A-Za-z0-9_-]{8,200}$/;

// ── Arguments ────────────────────────────────────────────────────────────

export const START_USAGE = `Usage: discovery-node [options]

  --reconfigure        change the site address, token or computer name, then start
  --port N             use dashboard port N (default 8390; the next free one if busy)
  --no-open            do not open the dashboard page in your browser (it opens without
                       the access key, which is printed in this window only)
  --token-file PATH    read the token from a file (the first run asks for it otherwise)
  --url URL            the CareerAutopilot address (default ${DEFAULT_SITE_URL})
  --name NAME          a name for this computer (letters, digits and hyphens)
  --help               show this

The token can also come from the CAREER_OPS_NODE_TOKEN environment variable, or be
typed at a hidden prompt. It is never accepted as a command-line argument: other
programs on this computer can read a process's arguments.`;

/**
 * @param {string[]} argv
 * @returns {{reconfigure: boolean, noOpen: boolean, help: boolean, port: number|null, tokenFile: string|null, url: string|null, name: string|null, errors: string[]}}
 */
export function parseStartArgs(argv) {
  const out = { reconfigure: false, noOpen: false, help: false, port: null, tokenFile: null, url: null, name: null, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = () => (eq === -1 ? argv[++i] : arg.slice(eq + 1));
    if (flag === '--reconfigure') out.reconfigure = true;
    else if (flag === '--no-open') out.noOpen = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--port') {
      const raw = value();
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) out.port = n;
      else out.errors.push(`--port needs a whole number from 1 to 65535 (got ${JSON.stringify(String(raw ?? ''))})`);
    } else if (flag === '--token-file') {
      const raw = value();
      if (raw) out.tokenFile = String(raw); else out.errors.push('--token-file needs a file path');
    } else if (flag === '--url') {
      const raw = value();
      if (raw) out.url = String(raw); else out.errors.push('--url needs an address');
    } else if (flag === '--name') {
      const raw = value();
      if (raw) out.name = String(raw); else out.errors.push('--name needs a name');
    } else if (flag === '--token') {
      if (eq === -1) i++; // the value is not reported back: it would be the token
      out.errors.push('there is no --token option: a token on the command line can be read by other programs on this computer. '
        + 'Type it at the prompt, set CAREER_OPS_NODE_TOKEN, or use --token-file PATH.');
    } else {
      // Only something shaped like an option is echoed: a stray argument might be a pasted secret.
      const shown = /^-{1,2}[A-Za-z0-9-]{1,30}/.exec(arg)?.[0];
      out.errors.push(shown ? `unknown option ${shown}` : 'unexpected argument');
    }
  }
  return out;
}

// ── Pure helpers (exported for the test suite) ───────────────────────────

/** Node.js major version from `process.versions.node`-style text. */
export const nodeMajor = (version = process.versions.node) => Number(String(version).split('.')[0]);

/** A node name from a machine's hostname that the hub will accept. */
export function defaultNodeName(host = hostname()) {
  const slug = String(host ?? '').toLowerCase().replace(/\.local$/, '')
    .replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
  return NODE_NAME_RE.test(slug) ? slug : 'my-computer';
}

export const isNodeName = (v) => NODE_NAME_RE.test(String(v ?? ''));
export const isTokenShape = (v) => TOKEN_RE.test(String(v ?? ''));

/**
 * Put the chosen name and site address into the user example config, keeping its
 * comments. Only `node.name` and `hub.url` change; both must be present or this
 * throws, rather than writing a config that silently ignores the answers.
 *
 * @param {string} text - config/discovery-node.user.example.yml (or the existing config, when reconfiguring).
 * @param {{name: string, url: string}} values - already validated.
 */
export function renderUserConfig(text, { name, url }) {
  if (!isNodeName(name)) throw new Error('refusing to write an invalid node name');
  let section = null;
  let nameDone = false;
  let urlDone = false;
  const lines = String(text).split(/\r?\n/).map((line) => {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) section = top[1];
    if (section === 'node' && !nameDone && /^ {2}name:\s/.test(line)) { nameDone = true; return `  name: ${name}`; }
    if (section === 'hub' && !urlDone && /^ {2}url:\s/.test(line)) { urlDone = true; return `  url: ${JSON.stringify(url)}`; }
    return line;
  });
  if (!nameDone || !urlDone) throw new Error('the config has no node.name or hub.url line to update');
  return lines.join('\n');
}

/** The overlay file holding the token — the one file here that is a secret. */
export function renderTokenOverlay(token) {
  return [
    '# Written by autopilot/discovery-node-start.mjs. This file holds your CareerAutopilot token:',
    '# keep it private, never commit it, and never paste it anywhere. Run discovery-node --reconfigure to replace it.',
    'hub:',
    `  token: ${JSON.stringify(token)}`,
    '',
  ].join('\n');
}

/** What the site's answer to the token check means for the person at the keyboard. */
export function classifyProbe(status, json) {
  const raw = json?.error ?? json?.detail?.error ?? json?.detail;
  const code = typeof raw === 'string' ? raw.slice(0, 60) : null;
  if (status === 200) return json?.token_scope === 'discovery' ? { kind: 'ok' } : { kind: 'wrong_scope' };
  // 409: the token is fine and reached the account; there is just nothing to
  // search for until the Profile tab is filled in.
  if (status === 409 && code === 'profile_incomplete') return { kind: 'profile_incomplete' };
  if (status === 401) return { kind: 'bad_token' };
  if (status === 403) {
    if (code === 'token_scope') return { kind: 'wrong_scope' };
    if (['stopped_by_administrator', 'discovery_node_disabled', 'careerops_access_required'].includes(code)) return { kind: 'blocked', code };
    return { kind: 'forbidden', code };
  }
  if (status === 429) return { kind: 'rate_limited' };
  return { kind: 'error', status };
}

/** Human text for a classifyProbe() result: `{ok, lines}`. Never contains the token. */
export function describeProbe(probe, siteUrl) {
  const create = [
    `  Open ${siteUrl}, sign in, then go to CareerAutopilot > Targeting > "Discovery on your computer"`,
    '  and press "Create discovery token". Copy it (it is shown once), then run this again with --reconfigure.',
  ];
  switch (probe.kind) {
    case 'ok': return { ok: true, lines: ['  The token works.'] };
    case 'profile_incomplete': return { ok: true, lines: [
      '  The token works, but your CareerAutopilot profile is not finished, so there is nothing to search for yet.',
      `  Add your resume or a short bio on the Profile tab at ${siteUrl}. The node starts working as soon as you do.`,
    ] };
    case 'bad_token': return { ok: false, lines: ['  The site did not accept that token (it may be mistyped, expired or revoked).', ...create] };
    case 'wrong_scope': return { ok: false, lines: ['  That is not a discovery token. The ones for the browser extension do not work here.', ...create] };
    case 'blocked': return { ok: false, lines: [`  The site is not allowing discovery for this account right now (${probe.code}).`, '  If that is a surprise, contact the person who runs your CareerAutopilot account.'] };
    case 'forbidden': return { ok: false, lines: ['  The site refused the token.', ...create] };
    case 'rate_limited': return { ok: false, lines: ['  The site says too many checks were made. Wait a few minutes and run this again.'] };
    case 'network': return { ok: false, lines: [`  Could not reach ${siteUrl} (${probe.detail}). Check the address and your internet connection.`] };
    default: return { ok: false, lines: [`  The site answered unexpectedly (HTTP ${probe.status ?? '?'}). Check the address, or try again later.`] };
  }
}

/**
 * Ask the site whether this token may use discovery. One bounded request, no
 * redirects (the token is in the header), and the token appears in no message.
 */
export async function probeCriteria(siteUrl, token, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${siteUrl}/api/companion/discovery/criteria`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const redirected = /redirect/i.test(String(err?.cause?.message || err?.message || ''));
    return { kind: 'network', detail: redirected ? 'the address redirected somewhere else, which is refused' : (err?.cause?.code || err?.name || 'network error') };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return classifyProbe(res.status, json);
}

/**
 * The address the browser is opened on: the dashboard link WITHOUT its access key.
 * A command line is readable by every other program (and, on a shared computer,
 * every other user) for as long as the process lives, and `xdg-open`, `open` and
 * `cmd /c start` all carry the address in theirs (a browser that was not already
 * running keeps it for its whole life). So the key is shown in this window only,
 * and the page asks for it (the person pastes the printed link into it).
 */
export function dashboardOpenUrl(dashboardUrl) {
  const bare = new URL(dashboardUrl);
  bare.hash = '';
  bare.search = '';
  return bare.href;
}

/** The text printed once the node is running. The only place the dashboard link, with its key, is shown. */
export function directionsText({ url, launcher = 'discovery-node', opened = false }) {
  return [
    '',
    '  CareerAutopilot discovery node is running.',
    '',
    '  Dashboard (copy this whole link into your browser\'s address bar):',
    `    ${url}`,
    '    It works only on this computer, and only while this window stays open.',
    ...(opened ? [
      '    Your browser was also opened on the same page WITHOUT the access key at the end of this',
      '    link, so other programs cannot read it from the browser\'s command line. If that page',
      '    asks for the link, paste this one into it.',
    ] : []),
    '',
    '  - Pause, resume or stop the node from the dashboard, or press Ctrl+C in this window.',
    '  - Nothing keeps running after you close this window. To start the node again, run',
    `    ${launcher} again.`,
    `  - To change the site address, token or this computer's name: ${launcher} --reconfigure`,
    '',
  ].join('\n');
}

// ── Terminal helpers ─────────────────────────────────────────────────────

const say = (line = '') => console.log(line);

/**
 * Read a secret without echoing it: raw mode, nothing written back but a newline.
 * Needs a real terminal; there is deliberately no fallback that echoes.
 *
 * @param {string} prompt
 * @param {{stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream}} [io] - test seam.
 * @returns {Promise<string>} The trimmed input. Rejects with code CANCELLED on Ctrl+C.
 */
export function askSecret(prompt, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('no terminal to read the token from'));
      return;
    }
    stdout.write(prompt);
    const chars = [];
    stdin.setRawMode(true);
    stdin.resume();
    const done = (fn) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(); };
    // 0: plain, 1: just saw ESC, 2: inside an ESC [ ... sequence (arrow keys, the
    // markers some terminals wrap a paste in). Such sequences are dropped whole,
    // so their letters never end up in the secret.
    let esc = 0;
    const onData = (buf) => {
      for (const byte of buf) {
        if (esc === 1) { esc = byte === 0x5b ? 2 : 0; continue; }
        if (esc === 2) { if (byte >= 0x40 && byte <= 0x7e) esc = 0; continue; }
        if (byte === 0x1b) { esc = 1; continue; }
        if (byte === 0x0d || byte === 0x0a) return done(() => resolve(chars.join('').trim()));
        if (byte === 0x03) return done(() => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }))); // Ctrl+C
        if (byte === 0x7f || byte === 0x08) chars.pop();
        else if (byte >= 0x20 && byte < 0x7f) chars.push(String.fromCharCode(byte));
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(question, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return answer || fallback || '';
  } finally { rl.close(); }
}

function readTokenFile(path) {
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch (err) { throw new Error(`could not read the token file (${err.code || 'error'})`); }
  if (text.length > 2048) throw new Error('that does not look like a token file (it is too large)');
  return text.trim();
}

/** Restrict a file to the current user: chmod 600, or icacls on Windows. @returns {boolean} whether it could. */
function restrictToCurrentUser(file) {
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${userInfo().username}:(F)`], { stdio: 'ignore' });
    } else {
      chmodSync(file, 0o600);
    }
    return true;
  } catch {
    return false;
  }
}

function writeSecretFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 });
  const restricted = restrictToCurrentUser(tmp);
  renameSync(tmp, file);
  return restricted;
}

/** The program and arguments that open `url` in the default browser on this platform. */
export function browserCommand(url, platform = process.platform) {
  return platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
}

// `url` is whatever the caller passes: main() hands it dashboardOpenUrl(), never the keyed link.
function openBrowser(url) {
  try {
    const [cmd, args] = browserCommand(url);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// ── Steps ────────────────────────────────────────────────────────────────

function npmCommand() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { cmd: process.execPath, prefix: [cli], shell: false };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: process.platform === 'win32' };
}

async function jsYamlAvailable() {
  try {
    await import('js-yaml');
    return true;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return false;
    throw err;
  }
}

/** Install the runtime dependency. `npm ci` when a lockfile ships (exact versions), else `npm install`. */
function installDependencies() {
  const { cmd, prefix, shell } = npmCommand();
  const verb = existsSync(PATHS.lockfile) ? 'ci' : 'install';
  say(`  Installing the one dependency this needs (npm ${verb}). This happens once.`);
  const res = spawnSync(cmd, [...prefix, verb, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell });
  return res.status === 0;
}

async function runSetup({ args, lib, yaml, interactive, existing }) {
  say('');
  say('  First-time setup: three questions. Nothing is sent anywhere except to your own CareerAutopilot account.');
  say('');
  const existingCfg = existing ? lib.loadNodeConfig() : null;

  // 1. The site address.
  const urlDefault = existingCfg?.hub?.url || DEFAULT_SITE_URL;
  let siteUrl = null;
  for (let attempt = 0; attempt < 3 && !siteUrl; attempt++) {
    const raw = args.url || (interactive ? await ask('CareerAutopilot address', urlDefault) : urlDefault);
    const checked = lib.checkHubUrl(raw);
    if (checked.ok) siteUrl = checked.url;
    else { say(`  ${checked.reason}.`); if (args.url || !interactive) break; }
  }
  if (!siteUrl) return { ok: false };

  // 2. The token: environment, file, the saved one (reconfigure), or a hidden prompt.
  let token = process.env.CAREER_OPS_NODE_TOKEN?.trim() || '';
  if (!token && args.tokenFile) token = readTokenFile(args.tokenFile);
  if (!token && existingCfg?.hub?.token && interactive) {
    const keep = await ask('Keep the saved token? (y/n)', 'y');
    if (/^y/i.test(keep)) token = existingCfg.hub.token;
  }
  if (!token) {
    if (!interactive) {
      say('  There is no terminal to ask for the token on. Set CAREER_OPS_NODE_TOKEN, or pass --token-file PATH.');
      return { ok: false };
    }
    say(`  Create a discovery token at ${siteUrl}: CareerAutopilot > Targeting > "Discovery on your computer" > Create discovery token.`);
    token = await askSecret('  Paste the token (it is not shown as you type): ');
    if (token) say(`  Received a token of ${token.length} characters.`);
  }
  if (!isTokenShape(token)) {
    say('  That does not look like a CareerAutopilot token (they start with "cot_"). Nothing was saved.');
    return { ok: false };
  }
  say('  Checking the token with your account...');
  const verdict = describeProbe(await probeCriteria(siteUrl, token), siteUrl);
  for (const line of verdict.lines) say(line);
  if (!verdict.ok) return { ok: false };

  // 3. A name for this computer.
  const nameDefault = existingCfg?.node?.name || defaultNodeName();
  let name = args.name || (interactive ? await ask('A name for this computer', nameDefault) : nameDefault);
  name = String(name).trim().toLowerCase();
  if (!isNodeName(name)) {
    say('  A name can use lowercase letters, digits and hyphens, up to 32 characters.');
    return { ok: false };
  }

  // Write: the config (from the example, or the existing file when reconfiguring) and the token file.
  const base = existing ? readFileSync(PATHS.config, 'utf-8') : readFileSync(PATHS.example, 'utf-8');
  const text = renderUserConfig(base, { name, url: siteUrl });
  const check = yaml.load(text);
  if (check?.node?.name !== name || check?.hub?.url !== siteUrl || check?.hub?.mode !== 'companion') {
    throw new Error('the config would not read back as written; nothing was saved');
  }
  mkdirSync(dirname(PATHS.config), { recursive: true });
  writeFileSync(PATHS.config, text, 'utf-8');

  let overlayText = renderTokenOverlay(token);
  if (existsSync(PATHS.overlay)) {
    // Keep anything else the user put in the overlay; replace only the token.
    try {
      const doc = yaml.load(readFileSync(PATHS.overlay, 'utf-8')) || {};
      doc.hub = { ...(doc.hub || {}), token };
      overlayText = `${renderTokenOverlay(token).split('\n').slice(0, 2).join('\n')}\n${yaml.dump(doc)}`;
    } catch { /* unreadable overlay: replace it */ }
  }
  const restricted = writeSecretFile(PATHS.overlay, overlayText);
  say('');
  say(`  Saved: config/discovery-node.yml and config/discovery-node.local.yml (your token).`);
  if (!restricted) {
    say('  WARNING: could not limit who can read config/discovery-node.local.yml. It holds your token:');
    say('  do not share it, commit it or copy it anywhere.');
  }
  return { ok: true };
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code to leave with, or -1 when the node is
 *   now running and the process should stay alive.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseStartArgs(argv);
  if (args.help) { say(START_USAGE); return 0; }
  if (args.errors.length) {
    for (const e of args.errors) console.error(`  ${e}`);
    console.error(`\n${START_USAGE}`);
    return 2;
  }

  if (nodeMajor() < MIN_NODE_MAJOR) {
    console.error(`  Node.js ${MIN_NODE_MAJOR} or newer is required (this is ${process.versions.node}). Install the LTS version from https://nodejs.org and run this again.`);
    return 1;
  }

  // Dependencies first: the modules below import js-yaml at load time.
  if (!(await jsYamlAvailable())) {
    if (process.env.CAREER_OPS_DISCOVERY_REEXEC === '1') {
      console.error('  js-yaml is still not available after installing. Run "npm install --omit=dev --ignore-scripts" in this folder and read what it says.');
      return 1;
    }
    if (!installDependencies()) {
      console.error(`\n  Installing failed (the output above says why). Check your internet connection, then run "npm install --omit=dev --ignore-scripts" in ${ROOT} and try again.`);
      return 1;
    }
    // Start over in a fresh process so nothing resolved before the install is remembered.
    const child = spawn(process.execPath, [SELF, ...argv], { stdio: 'inherit', env: { ...process.env, CAREER_OPS_DISCOVERY_REEXEC: '1' } });
    return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  }

  const lib = await import('./lib/discovery-node.mjs');
  const daemon = await import('./discovery-node.mjs');
  const yaml = await import('js-yaml');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const hasConfig = existsSync(PATHS.config);
  if (!hasConfig && !existsSync(PATHS.example)) {
    console.error('  config/discovery-node.user.example.yml is missing from this folder. Download CareerAutopilot again and run this from there.');
    return 1;
  }

  if (args.reconfigure || !hasConfig) {
    if (hasConfig) {
      const current = lib.loadNodeConfig();
      if (lib.hubMode(current) !== 'companion') {
        console.error('  This folder is set up as a self-hosted node, which --reconfigure does not change. Edit config/discovery-node.yml directly.');
        return 2;
      }
    }
    // Before writing a single file: is this somebody's real career-ops folder?
    const problems = lib.detectUserLayer(ROOT);
    if (problems.length) { console.error(lib.userLayerRefusalMessage(problems)); return 2; }
    let result;
    try {
      result = await runSetup({ args, lib, yaml, interactive, existing: hasConfig });
    } catch (err) {
      if (err?.code === 'CANCELLED') { say('\n  Cancelled. Nothing was saved.'); return 130; }
      console.error(`  Setup could not finish: ${String(err?.message || err)}`);
      return 1;
    }
    if (!result.ok) { console.error('\n  Setup did not finish, so nothing was started. Run this again when ready.'); return 1; }
  }

  let cfg;
  try { cfg = lib.loadNodeConfig(); } catch (err) {
    console.error(`  Could not read config/discovery-node.yml: ${String(err?.message || err)}`);
    return 1;
  }

  let handle = null;
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    say('\n  Stopping the node...');
    // Not process.exit() once stop() is done: on Windows, exiting while the last of
    // the shutdown is still completing aborts Node ("Assertion failed:
    // !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c", exit code 0xC0000409)
    // in roughly one stop in four, which the launcher reports as an error. With
    // everything closed the loop drains and the process ends on its own; the
    // unref'd timer is the backstop for anything that never closes.
    Promise.resolve(handle?.stop()).then(
      () => { process.exitCode = 0; },
      (err) => { console.error(`  The node did not stop cleanly: ${String(err?.message || err)}`); process.exitCode = 1; },
    );
    setTimeout(() => process.exit(0), 4000).unref();
  };
  try {
    handle = await daemon.runDaemon(cfg, {
      dashboard: cfg.dashboard?.enabled !== false,
      dashboardPort: args.port ?? undefined,
      onStopRequested: leave,
    });
  } catch (err) {
    if (err instanceof daemon.DaemonRefusal) { console.error(err.message); return err.exitCode; }
    console.error(`  The node could not start: ${String(err?.message || err)}`);
    return 1;
  }
  // Closing the window is the documented way to stop, and a closed console or
  // terminal delivers SIGHUP (Node maps Windows' console-close event to it, and
  // kills the process about ten seconds later); SIGBREAK is Ctrl+Break on Windows.
  // Unhandled, the node dies without stop(), and the finds validated since the
  // last state save are lost.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(signal, leave);

  const launcher = process.platform === 'win32' ? 'discovery-node.cmd' : './discovery-node.sh';
  if (handle.dashboard) {
    say(directionsText({ url: handle.dashboard.url, launcher, opened: !args.noOpen }));
    // The bare address: the access key stays in this window (see dashboardOpenUrl).
    if (!args.noOpen) openBrowser(dashboardOpenUrl(handle.dashboard.url));
  } else {
    say(`\n  The node is running without a dashboard (turned off in config/discovery-node.yml, or its port was unavailable).`);
    say('  Press Ctrl+C in this window to stop it. Nothing keeps running after you close this window.\n');
  }
  return -1;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => { if (code >= 0) process.exitCode = code; }).catch((err) => {
    console.error(`  discovery-node: ${String(err?.message || err)}`);
    process.exitCode = 1;
  });
}

