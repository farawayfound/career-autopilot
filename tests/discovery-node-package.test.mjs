// tests/discovery-node-package.test.mjs — the discovery node, as a stranger gets it.
//
// This file exists only in the public mirror (it is not part of the private
// career-ops test suite). The suites that live next to it prove the node's logic
// piece by piece; this one proves the PACKAGE: that what the mirror ships is
// complete (every provider the registry loads by name is really there), that
// the one run script starts the real daemon and its dashboard from a bare
// folder, that it can be stopped, that the token goes where it should and
// nowhere else, and that nothing in the node's code can install something that
// outlives its window.
//
// Hermetic: the daemon runs from a throwaway copy of its import closure, against
// a fake site on 127.0.0.1, with every job switched off. Nothing here touches
// the network beyond loopback or this folder's own files.
import { pass, fail, ROOT, stageScript } from './helpers.mjs';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { loadProviders } from '../providers/_registry.mjs';
import { START_USAGE } from '../autopilot/discovery-node-start.mjs';
import { SCANNER_JOB_ORDER } from '../autopilot/lib/discovery-node.mjs';

console.log('\ndiscovery node package — what a stranger downloads');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The folder holds what the instructions point at ──────────────────────
{
  const needed = [
    'discovery-node.cmd', 'discovery-node.command', 'discovery-node.sh',
    'autopilot/discovery-node-start.mjs', 'autopilot/discovery-node.mjs',
    'config/discovery-node.user.example.yml', 'docs/DISCOVERY_NODE.md', 'package.json', 'package-lock.json',
  ];
  for (const rel of needed) ok(existsSync(join(ROOT, rel)), `${rel} is in the package`);
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts?.discovery === 'node autopilot/discovery-node-start.mjs', '`npm run discovery` starts the run script');
  ok(JSON.stringify(Object.keys(pkg.dependencies || {})) === '["js-yaml"]', 'the one runtime dependency is js-yaml');
  ok(!pkg.devDependencies && !['preinstall', 'install', 'postinstall', 'prepare'].some((h) => pkg.scripts?.[h]), 'and npm runs no script of its own on install');
  const lock = JSON.parse(read('package-lock.json'));
  ok(lock.packages?.['']?.dependencies?.['js-yaml'] === pkg.dependencies['js-yaml'], 'package-lock.json was generated for exactly that dependency');
  ok(Object.entries(lock.packages).filter(([k]) => k).every(([, v]) => String(v.resolved).startsWith('https://registry.npmjs.org/') && /^sha512-/.test(v.integrity)), 'every locked package comes from the npm registry with an integrity hash');
  // The launchers are what the 3-step directions tell people to run.
  ok(read('discovery-node.sh').startsWith('#!/usr/bin/env bash') && read('discovery-node.command').startsWith('#!/usr/bin/env bash'), 'the shell launchers start with a shebang');
  ok(!read('discovery-node.sh').includes('\r') && !read('discovery-node.command').includes('\r'), 'and use LF line endings (CRLF would be a "bad interpreter" error)');
}

// ── .gitignore keeps one computer's files out of a commit ────────────────
{
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['config/discovery-node.yml', 'config/discovery-node.local.yml', 'data/', '*.local.yml', 'node_modules/', '/portals.yml', 'config/profile.yml']) {
    ok(lines.includes(entry), `.gitignore ignores ${entry}`);
  }
}

// ── Every provider the registry loads by name is really here ────────────
{
  const dir = join(ROOT, 'providers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'));
  const origError = console.error;
  const complaints = [];
  console.error = (...a) => { complaints.push(a.join(' ')); };
  let loaded;
  try { loaded = await loadProviders(dir); } finally { console.error = origError; }
  ok(files.length >= 40, `providers/ holds the providers (${files.length})`);
  ok(complaints.length === 0, complaints.length === 0
    ? 'the registry loaded every provider without a complaint (no missing import)'
    : `the registry complained: ${complaints.slice(0, 3).join(' | ')}`);
  ok(loaded.size === files.length, `and every file registered a provider (${loaded.size} of ${files.length})`);
  ok(!loaded.has('local-parser'), 'the provider that runs a configured script is not part of the package');

  // The user template names only providers that exist, and only zero-auth ones.
  const cfg = yaml.load(read('config/discovery-node.user.example.yml'));
  const unknown = (cfg.boards || []).filter((b) => !loaded.has(b.provider)).map((b) => b.provider);
  ok(unknown.length === 0, unknown.length === 0 ? `all ${cfg.boards.length} boards in the template name a provider that ships` : `the template names providers that do not ship: ${unknown.join(', ')}`);
  for (const job of [...SCANNER_JOB_ORDER, 'validate']) ok(cfg.jobs?.[job] && typeof cfg.jobs[job] === 'object', `the template has a block for the ${job} job`);
  ok(cfg.hub?.mode === 'companion' && !cfg.hub.token, 'the template is hosted mode and holds no token');
}

// ── No code in the package installs anything that outlives its window ────
{
  const INSTALLERS = [
    [/\bschtasks\b/i, 'schtasks'], [/\b(?:Register|New)-ScheduledTask\b/i, 'a scheduled-task cmdlet'], [/\blaunchctl\b/i, 'launchctl'],
    [/\bsystemctl\b/i, 'systemctl'], [/\bcrontab\b/i, 'crontab'], [/\/etc\/systemd\b/, '/etc/systemd'], [/\bLaunchAgents\b|\bLaunchDaemons\b/, 'a LaunchAgents folder'],
    [/CurrentVersion[\\/]+Run\b/i, 'the Windows Run registry key'], [/\.config\/autostart\b/, 'an XDG autostart folder'], [/\bsc\s+create\b|\bnssm\b/i, 'a Windows service installer'],
  ];
  const roots = ['autopilot', 'lib', 'plugins', 'providers', 'scripts/scan', 'seeds'];
  const files = ['discovery-node.cmd', 'discovery-node.command', 'discovery-node.sh', 'config/discovery-node.user.example.yml'];
  const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(mjs|js)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  for (const r of roots) if (existsSync(join(ROOT, r))) files.push(...walk(r));
  const hits = [];
  for (const rel of files) {
    const text = read(rel);
    for (const [re, name] of INSTALLERS) if (re.test(text)) hits.push(`${rel} (${name})`);
  }
  ok(hits.length === 0, hits.length === 0 ? `none of the ${files.length} node files mentions a service, scheduled-task, startup or cron installer` : `a node file mentions an installer: ${hits.join('; ')}`);
}

// ── The guide documents every option the run script has, and no other ───
{
  const doc = read('docs/DISCOVERY_NODE.md');
  const actual = [...new Set([...START_USAGE.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1]))];
  const table = doc.slice(doc.indexOf('## Options'), doc.indexOf('## Where things are kept'));
  const documented = [...new Set([...table.matchAll(/^\| `(--[a-z-]+)/gm)].map((m) => m[1]))];
  ok(actual.length >= 6, `the run script has ${actual.length} options (${actual.join(', ')})`);
  ok(actual.every((f) => documented.includes(f)), `the guide's options table lists every one of them${actual.filter((f) => !documented.includes(f)).length ? ` (missing ${actual.filter((f) => !documented.includes(f)).join(', ')})` : ''}`);
  ok(documented.every((f) => actual.includes(f)), 'and lists none the script lacks');
  ok(/no `--token` option/.test(doc), 'and says there is deliberately no --token option');
  for (const name of ['discovery-node.cmd', 'discovery-node.command', 'discovery-node.sh']) ok(doc.includes(name), `the guide names ${name}`);
}

// ── The run script starts the real node and its dashboard, and stop works ──
const TOKEN = ['cot', 'x'.repeat(8) + 'Pkg' + 'y'.repeat(14)].join('_'); // assembled: never a literal that looks like a credential
const sandbox = mkdtempSync(join(tmpdir(), 'careerautopilot-pkg-'));
let hub = null;
let child = null;
try {
  stageScript(sandbox, 'autopilot/discovery-node-start.mjs');
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  copyFileSync(join(ROOT, 'config', 'discovery-node.user.example.yml'), join(sandbox, 'config', 'discovery-node.user.example.yml'));
  // What is here now came from the package; whatever turns up later, the node (or its run script) wrote.
  const listFiles = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(join(dir, e.name), rel) : [rel];
  });
  const packaged = new Set(listFiles(sandbox));
  let linked = false;
  try { symlinkSync(join(ROOT, 'node_modules'), join(sandbox, 'node_modules'), 'junction'); linked = true; } catch (err) {
    console.log(`  SKIP: cannot link node_modules into the sandbox (${err.code || err.message})`);
  }

  if (linked) {
    // A fake site on loopback: it answers the four calls the node makes and remembers who asked.
    const seen = [];
    hub = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const route = req.url.split('?')[0];
        seen.push({ route, auth: req.headers.authorization || null });
        const body = route.endsWith('/criteria')
          ? { ok: true, generated_at: new Date().toISOString(), criteria_hash: 'pkg-1', token_scope: 'discovery', portals_yml: 'title_filter:\n  positive: [engineer]\n  negative: []\ntracked_companies: []\n', blacklist_md: null,
            profile: { location: { country: 'United States' }, compensation: null, target_roles: { primary: ['Engineer'], archetypes: [] }, preferences: null }, aggregators: {}, skills: ['javascript'], node_settings: {}, limits: { finds_per_day: 100, accepted_today: 0 } }
          : { ok: true, criteria_hash: 'pkg-1', accepted: 0, duplicates: 0, rejected: 0, seen: [] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const hubUrl = `http://127.0.0.1:${hub.address().port}`;
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const jobs = ['tracked', 'aggregators', 'sources', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full', 'validate']
      .map((j) => `  ${j}: { enabled: false, every_minutes: 60, max_minutes: 5 }`).join('\n');
    writeFileSync(join(sandbox, 'config', 'discovery-node.yml'), [
      'node: { name: package-test }',
      `hub: { mode: companion, url: "${hubUrl}", heartbeat_minutes: 5, criteria_refresh_minutes: 30, ship_batch: 50, seen_check: false }`,
      'health: { enabled: false }', `dashboard: { enabled: true, host: 127.0.0.1, port: ${port} }`,
      'scheduler: { tick_seconds: 1 }', 'jobs:', jobs, 'boards: []', 'local_employers: []', 'rank: {}', '',
    ].join('\n'));
    writeFileSync(join(sandbox, 'config', 'discovery-node.local.yml'), `hub:\n  token: ${TOKEN}\n`);

    let out = '';
    child = spawn(process.execPath, ['autopilot/discovery-node-start.mjs', '--no-open', '--port', String(port)], { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let exitCode = null;
    child.once('exit', (code) => { exitCode = code ?? -1; });

    let link = null;
    for (let i = 0; i < 150 && !link && exitCode === null; i++) {
      link = /http:\/\/127\.0\.0\.1:\d+\/#k=[A-Za-z0-9_-]+/.exec(out)?.[0] || null;
      if (!link) await sleep(100);
    }
    ok(link !== null, link ? 'the run script started the node and printed a dashboard link' : `the run script printed no dashboard link (exit ${exitCode}): ${out.slice(0, 400)}`);
    if (link) {
      const base = link.split('#')[0];
      const key = link.split('#k=')[1];
      ok(base === `http://127.0.0.1:${port}/`, 'on loopback, at the port that was asked for');
      const page = await fetch(base);
      const html = await page.text();
      ok(page.status === 200 && /CareerAutopilot discovery node/.test(html) && !html.includes(key), 'the page loads, and carries no access key');
      ok((await fetch(`${base}api/status`)).status === 401, 'its data is refused without the key');
      const status = await fetch(`${base}api/status`, { headers: { 'x-node-key': key } });
      const body = await status.json();
      ok(status.status === 200 && body.mode === 'companion' && body.node === 'package-test', 'and served with it (hosted mode, this computer\'s name)');
      ok(Object.keys(body.jobs || {}).length >= 9, 'the status lists the node\'s jobs');
      ok(seen.some((s) => s.route === '/api/companion/discovery/criteria' && s.auth === `Bearer ${TOKEN}`), 'the node asked the site for its targeting with the token as a bearer credential');
      ok(seen.every((s) => s.route.startsWith('/api/companion/discovery/')), 'and only ever called the site\'s discovery routes');
      ok(!out.includes(TOKEN), 'the token appears nowhere in the window');
      const stop = await fetch(`${base}api/stop`, { method: 'POST', headers: { 'x-node-key': key, 'content-type': 'application/json' }, body: '{}' });
      ok(stop.status === 200, 'Stop node is accepted');
      for (let i = 0; i < 100 && exitCode === null; i++) await sleep(100);
      ok(exitCode === 0, `and the node exits cleanly, leaving nothing running (exit ${exitCode})`);
    }
    const left = readdirSync(sandbox).filter((n) => !['autopilot', 'lib', 'config', 'data', 'node_modules', 'providers', 'plugins', 'scripts', 'seeds'].includes(n));
    ok(left.every((n) => /\.(yml|md)$/.test(n)), `only its own files were written beside the package (${left.join(', ') || 'none'})`);

    // The guide promises that nothing the node writes can end up in a commit or a fork. Ask git, in a repository
    // holding only the package's own .gitignore, which of the files this run just wrote it would NOT ignore.
    const git = (...a) => spawnSync('git', ['-C', sandbox, ...a], { encoding: 'utf8' });
    if (git('--version').status !== 0) console.log('  SKIP: git is not installed here, so the .gitignore was not exercised');
    else {
      git('init', '-q');
      copyFileSync(join(ROOT, '.gitignore'), join(sandbox, '.gitignore'));
      const written = listFiles(sandbox).filter((f) => !packaged.has(f) && f !== '.gitignore');
      const untracked = new Set(git('ls-files', '--others', '--exclude-standard').stdout.split('\n').filter(Boolean));
      const exposed = written.filter((f) => untracked.has(f));
      ok(written.includes('portals.yml') && written.includes('config/profile.yml'), `the node wrote its targeting files beside the package (${written.length} files in all)`);
      ok(exposed.length === 0, exposed.length === 0 ? 'and the package\'s .gitignore covers every one of them' : `git would commit what the node wrote: ${exposed.join(', ')}`);
    }
  }
} catch (err) {
  fail(`the end-to-end start failed: ${err.stack || err.message}`);
} finally {
  if (child && child.exitCode === null) child.kill();
  if (hub) await new Promise((resolve) => { hub.close(() => resolve()); hub.closeAllConnections?.(); });
  rmSync(sandbox, { recursive: true, force: true });
}
