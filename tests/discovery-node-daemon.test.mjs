// tests/discovery-node-daemon.test.mjs — the discovery node daemon, RUN.
//
// The pure pieces (planNextJob, applyHubControl, the dashboard, ...) have their
// own suites; this one starts the real daemon in a child process and talks to it
// the way its two audiences do, because the failures that matter here live in the
// wiring: a control that is applied but never persisted, a pause that does not
// pause, a 429 that deletes the finds it was about to carry.
//
// Hermetic: the daemon's import closure is copied into a temp sandbox (its ROOT,
// so every file it writes lands there), the hub is a throwaway server on
// 127.0.0.1, and every scanner job is disabled or points at a script the sandbox
// does not have — nothing here reaches the real network or the real data/.
import { pass, fail, ROOT, stageScript } from './helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, readdirSync, statSync, utimesSync, copyFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

console.log('\ndiscovery-node daemon — end to end against a fake hub');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    // eslint-disable-next-line no-await-in-loop
    await sleep(step);
  }
}

// ── The sandbox: the daemon's closure, and a driver that starts it ──────────
const EXIT = 'process.' + 'exit'; // this file must not contain the call itself (test-all refuses it)
const DRIVER = `
// dynamic imports: a line that starts with "import" in this file would be read by tests/layout.test.mjs as an import of THIS file
const { loadNodeConfig } = await import('./autopilot/lib/discovery-node.mjs');
const { runDaemon, DaemonRefusal } = await import('./autopilot/discovery-node.mjs');
let handle = null;
const stop = () => (handle ? handle.stop() : Promise.resolve()).then(() => ${EXIT}(0));
try {
  handle = await runDaemon(loadNodeConfig(), { dashboard: process.env.DRIVER_DASHBOARD !== '0', onStopRequested: stop });
  console.log('READY ' + (handle.dashboard ? handle.dashboard.url : 'none'));
  process.stdin.on('data', (d) => { if (String(d).includes('stop')) stop(); });
  process.on('SIGTERM', stop);
} catch (err) {
  if (err instanceof DaemonRefusal) { console.error('REFUSED ' + err.message); ${EXIT}(err.exitCode); }
  console.error('CRASH ' + (err && err.stack || err));
  ${EXIT}(1);
}
`;

const sandbox = mkdtempSync(join(tmpdir(), 'careerops-daemon-e2e-'));
let sandboxReady = false;
try {
  stageScript(sandbox, 'autopilot/discovery-node.mjs');
  stageScript(sandbox, 'autopilot/lib/discovery-node.mjs');
  stageScript(sandbox, 'autopilot/lib/discovery-node-control.mjs');
  writeFileSync(join(sandbox, 'driver.mjs'), DRIVER);
  try { symlinkSync(join(ROOT, 'node_modules'), join(sandbox, 'node_modules'), 'junction'); sandboxReady = true; } catch (err) {
    console.log(`  SKIP: cannot link node_modules into the sandbox (${err.code || err.message})`);
  }
} catch (err) {
  fail('could not stage the daemon sandbox: ' + err.message);
}

// ── A fake hub ────────────────────────────────────────────────────────────
async function startHub(responses) {
  const hub = { requests: [], responses, port: 0 };
  hub.server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { body = null; }
      const route = req.url.split('?')[0];
      const entry = { method: req.method, route, auth: req.headers.authorization || null, body };
      hub.requests.push(entry);
      const handler = hub.responses[route];
      const r = typeof handler === 'function' ? handler(entry, hub.requests.filter((x) => x.route === route).length) : { status: 404, json: { error: 'not found' } };
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  hub.port = hub.server.address().port;
  hub.url = `http://127.0.0.1:${hub.port}`;
  hub.on = (route) => hub.requests.filter((x) => x.route === route);
  hub.close = () => new Promise((resolve) => { hub.server.close(() => resolve()); hub.server.closeAllConnections?.(); });
  return hub;
}

const PORTALS = 'title_filter:\n  positive: [platform engineer]\n  negative: [sales]\ntracked_companies:\n  - { name: Acme, careers_url: "https://boards.greenhouse.io/acme", enabled: true }\n  - { name: Internal, careers_url: "http://10.0.0.5/jobs", enabled: true }\n  - { name: Local, api: "http://127.0.0.1:9/x", enabled: true }\njob_boards:\n  - { name: Evil, provider: generic-careers, careers_url: "file:///etc/passwd" }\n';
const criteriaJson = (extra = {}) => ({
  ok: true, generated_at: new Date().toISOString(), criteria_hash: 'hash-1', portals_yml: PORTALS, blacklist_md: null,
  profile: { location: { country: 'United States', state: 'CO', city: 'Denver', timezone: 'America/Denver' }, compensation: null, target_roles: { primary: ['Platform Engineer'], archetypes: [] }, preferences: null },
  aggregators: {}, node_settings: {}, ...extra,
});

// ── Running the driver ────────────────────────────────────────────────────
const DISABLED_JOBS = ['tracked', 'aggregators', 'sources', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full']
  .map((j) => `  ${j}: { enabled: false, every_minutes: 60, max_minutes: 5 }`).join('\n');

function writeSandboxConfig({ mode, hubUrl, token, extraJobs = '', health = 'enabled: false', nodeName = 'e2e-node', dashboardCfg = '', criteriaRefresh = 30, validateCfg = 'enabled: false, every_minutes: 10' }) {
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  const text = [
    `node: { name: ${nodeName} }`,
    `hub: { ${mode === 'companion' ? 'mode: companion, ' : ''}url: "${hubUrl}", heartbeat_minutes: 5, criteria_refresh_minutes: ${criteriaRefresh}, ship_batch: 50, seen_check: false }`,
    `health: { ${health} }`,
    dashboardCfg ? `dashboard: { ${dashboardCfg} }` : '',
    'scheduler: { tick_seconds: 1 }',
    'jobs:',
    DISABLED_JOBS,
    `  validate: { ${validateCfg} }`,
    extraJobs,
    'boards: []',
    'local_employers: []',
    'rank: {}',
  ].join('\n');
  writeFileSync(join(sandbox, 'config', 'discovery-node.yml'), text);
  if (token) writeFileSync(join(sandbox, 'config', 'discovery-node.local.yml'), `hub:\n  token: ${token}\n`);
  else rmSync(join(sandbox, 'config', 'discovery-node.local.yml'), { force: true });
}

function resetSandbox() {
  rmSync(join(sandbox, 'data'), { recursive: true, force: true });
  rmSync(join(sandbox, 'config'), { recursive: true, force: true });
  for (const f of ['cv.md', 'portals.yml', 'applications.md']) rmSync(join(sandbox, f), { force: true });
}
const stateFile = () => join(sandbox, 'data', 'discovery-node', 'state.json');
const readState = () => { try { return JSON.parse(readFileSync(stateFile(), 'utf-8')); } catch { return null; } };
function seedState(partial) {
  mkdirSync(join(sandbox, 'data', 'discovery-node'), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ version: 1, jobs: {}, shipped: {}, held: {}, dropped: {}, to_ship: [], criteria_hash: null, ...partial }));
}

function startDriver(env = {}) {
  const child = spawn(process.execPath, ['driver.mjs'], { cwd: sandbox, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const run = { child, stdout: '', stderr: '', exit: null };
  child.stdout.on('data', (c) => { run.stdout += c; });
  child.stderr.on('data', (c) => { run.stderr += c; });
  run.done = new Promise((resolve) => child.once('exit', (code) => { run.exit = code; resolve(code); }));
  run.url = async () => {
    const line = await until(() => /READY (\S+)/.exec(run.stdout), 20000);
    return line ? line[1] : null;
  };
  run.stop = async () => {
    if (run.exit !== null) return;
    try { child.stdin.write('stop\n'); } catch { /* already gone */ }
    const stopped = await Promise.race([run.done.then(() => true), sleep(8000).then(() => false)]);
    if (!stopped) child.kill();
    await run.done;
  };
  return run;
}

/** One request to the dashboard URL the driver printed. */
function dashCall(dashUrl, { method = 'GET', path, body } = {}) {
  const u = new URL(dashUrl);
  const key = u.hash.replace(/^#k=/, '');
  return new Promise((resolve, reject) => {
    const headers = { 'X-Node-Key': key, Host: u.host };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function filesUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, out); else out.push(full);
  }
  return out;
}
const dashKey = (url) => new URL(url).hash.replace(/^#k=/, '');

if (sandboxReady) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  // ═════════════════════════════════════════════════════════════════════════
  // A. Self-hosted ("node") mode: the hub's control and commands
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n  node mode: hub control, commands, pause');
  {
    resetSandbox();
    const control = {
      revision: 7, paused: true, jobs: { tracked: { every_minutes: 45 } },
      commands: [
        { id: 'cmd-1', type: 'run_job', job: 'boards', issued_at: iso(now), expires_at: iso(now + 3600e3) },
        { id: 'cmd-old', type: 'run_job', job: 'tracked', issued_at: iso(now - 7200e3), expires_at: iso(now - 3600e3) },
        { id: 'cmd-bad', type: 'format_disk', job: 'tracked', issued_at: iso(now), expires_at: iso(now + 3600e3) },
      ],
    };
    let hbControl = control;
    const hub = await startHub({
      '/api/discovery/node/criteria': () => ({ status: 200, json: criteriaJson() }),
      '/api/discovery/node/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1', node_settings: {}, control: hbControl } }),
    });
    writeSandboxConfig({ mode: 'node', hubUrl: hub.url, token: 'a'.repeat(48) });
    let run = startDriver();
    const url = await run.url();
    ok(url && /^http:\/\/127\.0\.0\.1:\d+\/#k=/.test(url), 'the daemon starts and reports its dashboard link');
    if (url) {
      ok(await until(() => hub.on('/api/discovery/node/heartbeat').length >= 1, 15000), 'it heartbeats the hub at start');
      const hb1 = hub.on('/api/discovery/node/heartbeat')[0]?.body;
      ok(hb1 && hb1.node === 'e2e-node' && hb1.status.paused === false && hb1.status.control_revision === null, 'the first heartbeat reports no control yet and not paused');
      ok(hb1 && hb1.status.dashboard && Number.isInteger(hb1.status.dashboard.port) && hb1.status.dashboard.enabled === true, 'and says its dashboard is on');
      ok(hb1 && hb1.status.jobs.tracked.every_minutes === 60 && hb1.status.jobs.tracked.start_at === null && hb1.status.jobs.tracked.max_minutes === 5, 'and each job carries every_minutes / start_at / max_minutes');
      ok(hub.requests.every((r) => r.auth === `Bearer ${'a'.repeat(48)}`), 'every call carries the per-node bearer token');

      // The control is applied and shown.
      const st = await until(async () => { const r = await dashCall(url, { path: '/api/status' }); return r.json?.paused ? r.json : null; }, 10000);
      ok(st && st.paused === true && st.paused_by.hub === true && st.paused_by.local === false, 'the hub pause is applied, and attributed to the hub');
      ok(st && st.jobs.tracked.every_minutes === 45 && st.jobs.tracked.source.every_minutes === 'hub', 'a hub job override is applied and its source is "hub"');
      ok(st && st.jobs.boards.source.enabled === 'config', 'a value nobody overrode is from the config file');

      // The run-now command ran although the node is paused (an explicit request);
      // the expired and the unknown command did not.
      const ran = await until(() => (readState()?.jobs?.boards?.runs || 0) >= 1, 20000);
      ok(ran, 'a valid run_job command ran its job, even while paused');
      const s1 = readState();
      ok(!s1.jobs.tracked?.runs, 'an expired command and an unknown command type did not run');
      ok(Array.isArray(s1.command_acks) && ['cmd-1', 'cmd-old', 'cmd-bad'].every((id) => s1.command_acks.includes(id)), 'all three command ids are queued for acknowledgement');
      ok(s1.control_revision === 7 && s1.hub_control.paused === true && s1.hub_control.jobs.tracked.every_minutes === 45, 'the hub control is persisted in state.json');

      // `--status`, from another process, reports the EFFECTIVE config and does not cry "stale" for
      // a config the running daemon read at start (state.started_at used to be the day state.json
      // was first created, so every later edit read as unread for ever).
      const statusJson = () => {
        const r = spawnSync(process.execPath, ['autopilot/discovery-node.mjs', '--status', '--json'], { cwd: sandbox, encoding: 'utf-8' });
        try { return JSON.parse(r.stdout); } catch { return { parse_error: r.stderr || r.stdout }; }
      };
      const cs = statusJson();
      ok(cs.config && cs.config.stale === false, `--status: the config is not stale against a daemon that started after it was written (${JSON.stringify(cs.config || cs.parse_error).slice(0, 120)})`);
      ok(cs.paused === true && cs.jobs?.tracked?.every_minutes === 45, '--status reports the effective jobs and the hub pause');
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(sandbox, 'config', 'discovery-node.yml'), later, later);
      ok(statusJson().config?.stale === true, '--status DOES say stale once the config file is newer than the running daemon');
      const back = new Date(Date.now() - 60_000);
      utimesSync(join(sandbox, 'config', 'discovery-node.yml'), back, back);

      // A local change triggers an extra heartbeat that carries the acknowledgements.
      const before = hub.on('/api/discovery/node/heartbeat').length;
      const put = await dashCall(url, { method: 'PUT', path: '/api/jobs/validate', body: { every_minutes: 30 } });
      ok(put.status === 200 && put.json.status.jobs.validate.every_minutes === 30 && put.json.status.jobs.validate.source.every_minutes === 'local', 'a local job override is applied through the dashboard');
      ok(await until(() => hub.on('/api/discovery/node/heartbeat').length > before, 15000), 'and an extra heartbeat follows within seconds');
      const hb2 = hub.on('/api/discovery/node/heartbeat').at(-1).body.status;
      ok(['cmd-1', 'cmd-old', 'cmd-bad'].every((id) => hb2.command_acks.includes(id)), 'the extra heartbeat acknowledges every command');
      ok(hb2.control_revision === 7 && hb2.paused === true && hb2.jobs.validate.every_minutes === 30 && hb2.jobs.validate.source.every_minutes === 'local', 'and reports the revision, the pause and the new effective value');
      ok(JSON.stringify(hb2).length < 7 * 1024, 'and stays under the heartbeat size cap');
      ok(JSON.parse(readFileSync(join(sandbox, 'data', 'discovery-node', 'local-control.json'), 'utf-8')).jobs.validate.every_minutes === 30, 'the local override is persisted in local-control.json');

      // Local pause outranks a remote command; the hub un-pausing does not lift it.
      await dashCall(url, { method: 'POST', path: '/api/pause', body: {} });
      hbControl = { revision: 8, paused: false, jobs: { tracked: { every_minutes: 45 } },
        commands: [{ id: 'cmd-2', type: 'run_job', job: 'boards', issued_at: iso(Date.now()), expires_at: iso(Date.now() + 3600e3) }] };
      const runsBefore = readState().jobs.boards.runs;
      const before2 = hub.on('/api/discovery/node/heartbeat').length;
      await dashCall(url, { method: 'POST', path: '/api/pause', body: {} }); // another click: schedules a heartbeat
      await until(() => hub.on('/api/discovery/node/heartbeat').length > before2, 15000);
      await sleep(2500);
      const st2 = (await dashCall(url, { path: '/api/status' })).json;
      ok(st2.paused === true && st2.paused_by.local === true && st2.paused_by.hub === false, 'with the hub resumed, the local pause still holds');
      ok(readState().jobs.boards.runs === runsBefore, 'a hub command is refused while the node is locally paused');
      ok(readState().command_acks.includes('cmd-2'), 'but it is still acknowledged, so the hub can drop it');

      // Leave the hub pause ON in the persisted state for the restart check.
      hbControl = { revision: 9, paused: true, jobs: { tracked: { every_minutes: 45 } }, commands: [] };
      const before3 = hub.on('/api/discovery/node/heartbeat').length;
      await dashCall(url, { method: 'POST', path: '/api/resume', body: {} });
      await until(() => hub.on('/api/discovery/node/heartbeat').length > before3, 15000);
      await until(() => readState()?.control_revision === 9, 10000);
    }
    await run.stop();
    ok(run.exit === 0, 'it stops cleanly when asked');
    const logsText = filesUnder(join(sandbox, 'data')).map((f) => readFileSync(f, 'utf-8')).join('\n') + run.stderr;
    if (url) ok(!logsText.includes(dashKey(url)), 'the dashboard key is in no log, state file or stderr');
    ok(!logsText.includes('a'.repeat(48)), 'and neither is the hub token');

    // Restart: the hub is down; the persisted control must apply BEFORE any heartbeat succeeds.
    console.log('\n  node mode: a restart');
    hub.responses['/api/discovery/node/heartbeat'] = () => ({ status: 500, json: { error: 'down' } });
    hub.responses['/api/discovery/node/criteria'] = () => ({ status: 500, json: { error: 'down' } });
    run = startDriver();
    const url2 = await run.url();
    ok(Boolean(url2), 'the daemon restarts with the hub failing');
    if (url2) {
      const st3 = (await dashCall(url2, { path: '/api/status' })).json;
      ok(st3.paused === true && st3.paused_by.hub === true, 'the hub pause survived the restart');
      ok(st3.paused_by.local === false, 'and the local pause did not (it is session-only)');
      ok(st3.jobs.tracked.every_minutes === 45 && st3.jobs.validate.every_minutes === 30 && st3.jobs.validate.source.every_minutes === 'local', 'hub and local job overrides both survived');
      const reset = await dashCall(url2, { method: 'PUT', path: '/api/jobs/validate', body: { reset: true } });
      ok(reset.status === 200 && reset.json.status.jobs.validate.every_minutes === 10 && reset.json.status.jobs.validate.source.every_minutes === 'config', 'Reset returns a job to the config file');
      const bad = await dashCall(url2, { method: 'PUT', path: '/api/jobs/tracked', body: { start_at: '06:00', every_minutes: 1800 } });
      ok(bad.status === 400, 'a start time with a non-whole-day interval over 24h is refused');
      const stopped = await dashCall(url2, { method: 'POST', path: '/api/stop', body: {} });
      ok(stopped.status === 200, 'POST /api/stop is accepted');
      ok(await Promise.race([run.done.then(() => true), sleep(10000).then(() => false)]), 'and the daemon exits by itself, gracefully');
    }
    await run.stop();
    await hub.close();
  }

  const TOKEN_H = 'cot_' + 'H'.repeat(24);
  console.log('\n  health route and dashboard host');
  {
    const getHealth = (port, host) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/health', headers: host ? { Host: host } : {} }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
      });
      req.on('error', reject); req.end();
    });
    const freePort = async () => { const t = createServer(); await new Promise((r) => t.listen(0, '127.0.0.1', r)); const p = t.address().port; await new Promise((r) => t.close(r)); return p; };
    const failing = { '/api/discovery/node/criteria': () => ({ status: 500, json: { error: 'down' } }), '/api/discovery/node/heartbeat': () => ({ status: 500, json: { error: 'down' } }) };

    // Self-hosted, loopback: the Host check applies and the error text is left out.
    resetSandbox();
    let hub = await startHub(failing);
    let port = await freePort();
    writeSandboxConfig({ mode: 'node', hubUrl: hub.url, token: 'b'.repeat(48), health: `enabled: true, host: 127.0.0.1, port: ${port}`, dashboardCfg: 'enabled: true, host: 0.0.0.0' });
    let run = startDriver();
    await until(() => /READY/.test(run.stdout), 20000);
    ok(/READY none/.test(run.stdout), 'a dashboard.host of 0.0.0.0 is refused: there is no dashboard and so no link');
    ok(await until(() => hub.on('/api/discovery/node/heartbeat').length >= 1, 15000), 'the node itself starts regardless');
    ok(/dashboard: not started/.test(readFileSync(join(sandbox, 'data', 'discovery-node', 'logs', 'daemon.log'), 'utf-8')), 'and the refusal is logged');
    await until(() => readState()?.last_hub_error, 10000);
    const h1 = await until(async () => { try { return await getHealth(port, `127.0.0.1:${port}`); } catch { return null; } }, 10000);
    ok(h1 && h1.status === 200 && h1.json.service === 'career-ops-discovery-node' && h1.json.hub.reachable === true, '/health on a loopback address answers');
    ok(h1 && !('last_error' in h1.json) && !('last_error' in h1.json.hub), 'without the error strings');
    ok((await getHealth(port, 'evil.example')).status === 403 && (await getHealth(port, `127.0.0.1:${port + 1}`)).status === 403, 'and refuses a foreign Host header');
    await run.stop(); await hub.close();

    // Self-hosted, all interfaces (a box on a private network): unchanged — no Host check, errors included.
    resetSandbox();
    hub = await startHub(failing);
    port = await freePort();
    writeSandboxConfig({ mode: 'node', hubUrl: hub.url, token: 'b'.repeat(48), health: `enabled: true, host: 0.0.0.0, port: ${port}` });
    run = startDriver({ DRIVER_DASHBOARD: '0' });
    await until(() => /READY/.test(run.stdout), 20000);
    await until(() => readState()?.last_hub_error, 15000);
    const h2 = await until(async () => { try { return await getHealth(port, 'node-box.example:8380'); } catch { return null; } }, 10000);
    ok(h2 && h2.status === 200 && 'last_error' in h2.json && h2.json.hub.last_error, 'a node-mode /health on 0.0.0.0 is what an external status probe has always read: any Host, errors included');
    await run.stop(); await hub.close();

    // Hosted: a non-loopback health host is refused (the node still runs), and the default is loopback.
    resetSandbox();
    hub = await startHub({ '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson() }), '/api/companion/discovery/heartbeat': () => ({ status: 200, json: { ok: true } }) });
    port = await freePort();
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN_H, health: `enabled: true, host: 0.0.0.0, port: ${port}` });
    run = startDriver();
    ok(Boolean(await run.url()), 'a hosted node with a non-loopback health host still starts');
    await sleep(1500);
    ok(await getHealth(port).then(() => false, () => true), 'but opens no health listener');
    ok(/health server not started/.test(readFileSync(join(sandbox, 'data', 'discovery-node', 'logs', 'daemon.log'), 'utf-8')), 'and says so');
    await run.stop();
    port = await freePort();
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN_H, health: `enabled: true, port: ${port}` });
    run = startDriver();
    await run.url();
    const h3 = await until(async () => { try { return await getHealth(port, `localhost:${port}`); } catch { return null; } }, 10000);
    ok(h3 && h3.status === 200 && !('last_error' in h3.json), 'with no host set, a hosted node health route is on loopback and redacted');
    await run.stop(); await hub.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // B. Hosted ("companion") mode
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n  companion mode: routes, ignored control, refusals');
  const TOKEN = 'cot_' + 'T'.repeat(24);
  const find = (n) => ({ key: `k${n}`, url: `https://boards.greenhouse.io/acme/jobs/${n}`, company: 'Acme', title: `Platform Engineer ${n}`, location: 'Remote', source: 'test', score: 80, reasons: ['ats_direct'] });
  {
    resetSandbox();
    seedState({ to_ship: [find(1), find(2), find(3)] });
    const hub = await startHub({
      '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson({ skills: ['kubernetes', 'Terraform'], limits: { finds_per_day: 100, accepted_today: 3 }, token_scope: 'discovery' }) }),
      // A hostile hub: pause, re-time and command the node.
      '/api/companion/discovery/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1', limits: { finds_per_day: 100, accepted_today: 3 },
        control: { revision: 1, paused: true, jobs: { tracked: { enabled: true, every_minutes: 5 } }, commands: [{ id: 'evil', type: 'run_job', job: 'tracked', issued_at: iso(Date.now()), expires_at: iso(Date.now() + 3600e3) }] } } }),
      '/api/companion/discovery/ingest': () => ({ status: 202, json: { ok: true, accepted: 1, duplicates: 0, rejected: 0, capped: true,
        accepted_urls: [find(1).url], duplicate_urls: [], deferred_urls: [find(2).url, find(3).url], accepted_today: 4, finds_per_day: 100 } }),
    });
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN, nodeName: 'my-laptop' });
    const run = startDriver();
    const url = await run.url();
    ok(Boolean(url), `a hosted node starts in a fresh folder (${(run.stderr || '').split('\n')[0]})`);
    if (url) {
      ok(await until(() => hub.on('/api/companion/discovery/ingest').length >= 1, 20000), 'it ships to the hosted ingest route');
      ok(hub.requests.length > 0 && hub.requests.every((r) => r.route.startsWith('/api/companion/discovery/')), 'every call goes to /api/companion/discovery/*, none to the self-hosted routes');
      ok(hub.requests.every((r) => r.auth === `Bearer ${TOKEN}`), 'each carries the user\'s token as a bearer');
      const ingest = hub.on('/api/companion/discovery/ingest')[0].body;
      ok(ingest.node === 'my-laptop' && Array.isArray(ingest.finds) && ingest.finds.length === 3 && ingest.finds.every((f) => !('key' in f)), 'the ingest body is {node, run_id, finds[]} without the daemon\'s private dedup key');
      await sleep(1500);
      const s = readState();
      ok(s.to_ship.map((f) => f.key).sort().join() === 'k2,k3', 'a capped 202 keeps the deferred finds queued (not dropped as rejected)');
      ok(s.shipped.k1?.hub === 'accepted' && !s.dropped.k2 && !s.dropped.k3, 'and records only the accepted one as shipped');
      ok(s.recent_shipped.length === 1 && s.recent_shipped[0].url === find(1).url && s.recent_shipped[0].title === 'Platform Engineer 1', 'recent finds records the accepted one for the dashboard');
      ok(s.limits && s.limits.accepted_today === 4 && s.limits.finds_per_day === 100, 'the hub\'s allowance is kept');
      ok(hub.on('/api/companion/discovery/ingest').length === 1, 'and the node does not hammer the hub: one ingest, then it waits');

      // The hub's control is ignored outright.
      const st = (await dashCall(url, { path: '/api/status' })).json;
      ok(st.mode === 'companion' && st.paused === false && st.paused_by.hub === false, 'a hosted hub cannot pause the node');
      ok(st.jobs.tracked.enabled === false && st.jobs.tracked.every_minutes === 60 && st.jobs.tracked.source.every_minutes === 'config', 'or re-time a job');
      ok((readState().jobs.tracked?.runs || 0) === 0 && !(readState().run_now || []).length, 'or queue one');
      ok(st.limits && st.limits.accepted_today === 4, 'the dashboard shows the daily allowance');
      const hb = hub.on('/api/companion/discovery/heartbeat')[0].body.status;
      ok(hb.control_revision === null && hb.command_acks.length === 0, 'and the node reports no control state');
      // Untrusted criteria: a non-public address never reaches portals.yml.
      const portals = readFileSync(join(sandbox, 'portals.yml'), 'utf-8');
      ok(portals.startsWith('# MACHINE-WRITTEN by autopilot/discovery-node.mjs'), 'portals.yml is rendered with the machine-written header');
      ok(portals.includes('boards.greenhouse.io/acme') && !portals.includes('10.0.0.5') && !portals.includes('127.0.0.1') && !portals.includes('file:'), 'sources at private, loopback or file: addresses are dropped from the criteria');
      ok(st.criteria && st.criteria.title_keywords === 1, 'the criteria summary reaches the dashboard');
    }
    await run.stop();
    await hub.close();
  }

  console.log('\n  companion mode: 429 and 403');
  {
    resetSandbox();
    seedState({ to_ship: [find(1), find(2)] });
    const hub = await startHub({
      '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson({ skills: [] }) }),
      '/api/companion/discovery/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1' } }),
      '/api/companion/discovery/ingest': () => ({ status: 429, headers: { 'Retry-After': '3600' }, json: { error: 'daily_cap', resets_at: new Date(Date.now() + 3600e3).toISOString() } }),
    });
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    const run = startDriver();
    const url = await run.url();
    if (url) {
      ok(await until(() => hub.on('/api/companion/discovery/ingest').length >= 1, 20000), 'the node tries to ship');
      await sleep(3000);
      ok(hub.on('/api/companion/discovery/ingest').length === 1, 'a 429 with Retry-After stops further attempts until then');
      ok(readState().to_ship.length === 2 && Object.keys(readState().dropped || {}).length === 0, 'and the queued finds are untouched (a 429 never deletes them)');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }
  {
    resetSandbox();
    seedState({ to_ship: [find(1)] });
    const hub = await startHub({
      '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson() }),
      '/api/companion/discovery/heartbeat': () => ({ status: 403, json: { error: 'stopped_by_administrator' } }),
      // 5xx: whatever races the block at start, the queue must come out untouched.
      '/api/companion/discovery/ingest': () => ({ status: 500, json: { error: 'down' } }),
    });
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    const run = startDriver();
    const url = await run.url();
    if (url) {
      ok(await until(() => readState()?.hub_block?.reason === 'stopped_by_administrator', 20000), 'a 403 stopped_by_administrator is remembered as a block');
      const count = hub.requests.length;
      await sleep(3500);
      ok(hub.requests.length === count, 'and the node then makes no further hub calls of any kind');
      ok(Date.parse(readState().hub_block.until) - Date.now() > 50 * 60e3, 'for about an hour');
      ok(readState().to_ship.length === 1, 'with the queue untouched');
      const st = (await dashCall(url, { path: '/api/status' })).json;
      ok(st.hub_blocked && st.hub_blocked.reason === 'stopped_by_administrator', 'the dashboard says why');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }

  console.log('\n  companion mode: ingest 409 and 413, hostile sources');
  const okHubRoutes = (ingest, portals = PORTALS) => ({
    '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson({ skills: [], portals_yml: portals }) }),
    '/api/companion/discovery/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1' } }),
    '/api/companion/discovery/ingest': ingest,
  });
  {
    // 409 is the ACCOUNT (the Profile tab is unfinished), not the finds: keep them, ask again in an hour, say so once.
    resetSandbox();
    seedState({ to_ship: [find(1), find(2)] });
    const hub = await startHub(okHubRoutes(() => ({ status: 409, json: { detail: { error: 'profile_incomplete' } } })));
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    const run = startDriver();
    if (await run.url()) {
      ok(await until(() => hub.on('/api/companion/discovery/ingest').length >= 1, 20000), 'the node tries to ship');
      await sleep(3500);
      ok(hub.on('/api/companion/discovery/ingest').length === 1, 'a 409 profile_incomplete is backed off (one call, not one per tick)');
      const s = readState();
      ok(s.to_ship.length === 2 && Object.keys(s.dropped || {}).length === 0, 'and the batch is kept, not dropped as rejected');
      const said = (run.stdout + run.stderr).split('\n').filter((l) => l.includes('profile_incomplete'));
      ok(said.length === 1 && /Profile tab/.test(said[0]), `and the user is told once what to do (${said.length} line(s))`);
      ok(/Profile tab/.test(s.last_hub_error?.message || ''), 'and the dashboard/heartbeat error says it too');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }
  {
    // 413 is the request's SIZE: keep the finds, halve the batch (floor 10) until the hub takes it.
    resetSandbox();
    seedState({ to_ship: Array.from({ length: 40 }, (_, i) => find(i + 1)) });
    const hub = await startHub(okHubRoutes((entry) => {
      const finds = entry.body?.finds || [];
      if (finds.length > 12) return { status: 413, json: { detail: 'too large' } };
      return { status: 202, json: { ok: true, accepted: finds.length, duplicates: 0, rejected: 0, accepted_urls: finds.map((f) => f.url), duplicate_urls: [] } };
    }));
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    const run = startDriver();
    if (await run.url()) {
      ok(await until(() => (readState()?.to_ship || [1]).length === 0, 40000), 'every find is eventually accepted');
      const sizes = hub.on('/api/companion/discovery/ingest').map((r) => r.body.finds.length);
      ok(sizes.slice(0, 3).join() === '40,20,10', `each 413 halves the next batch (${sizes.slice(0, 4).join()})`);
      ok(sizes.slice(2).every((n) => n === 10) && sizes.length === 6, 'and it stays at the floor of 10 afterwards');
      const s = readState();
      ok(Object.keys(s.dropped || {}).length === 0 && Object.keys(s.shipped || {}).length === 40, 'with nothing dropped');
      ok(s.ship_batch_limit === 10, 'and the smaller size is remembered in the state');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }
  {
    // A 403 that says the ACCOUNT is refused, in the shape the site's FastAPI uses (`detail`), on the
    // ingest route: blocked for an hour, the finds kept, and no "enter a new token" advice for it.
    resetSandbox();
    seedState({ to_ship: [find(1), find(2)] });
    const hub = await startHub(okHubRoutes(() => ({ status: 403, json: { detail: 'pipeline_disabled' } })));
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    const run = startDriver();
    if (await run.url()) {
      ok(await until(() => readState()?.hub_block?.reason === 'pipeline_disabled', 20000), 'a 403 carrying `detail: pipeline_disabled` is remembered as a block');
      await sleep(3000);
      ok(hub.on('/api/companion/discovery/ingest').length === 1, 'the node asks ingest once, then stops calling the hub');
      ok(readState().to_ship.length === 2 && Object.keys(readState().dropped || {}).length === 0, 'the finds are kept');
      ok(Date.parse(readState().hub_block.until) - Date.now() > 50 * 60e3, 'blocked for about an hour');
      const said = (run.stdout + run.stderr).split('\n').filter((l) => l.includes('pipeline_disabled'));
      ok(said.length === 1 && !/new token/.test(run.stdout + run.stderr), `and the log names the real reason once, with no token advice (${said.length} line(s))`);
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }
  {
    // Whatever the hub sends, the rendered portals.yml holds only plain name/address entries.
    resetSandbox();
    const hostile = [
      'title_filter:', '  positive: [platform engineer]', 'tracked_companies:',
      '  - { name: Acme, careers_url: "https://boards.greenhouse.io/acme", provider: local-parser, notes: SECRET-NOTE, parser: { command: node, script: scripts/evil.mjs } }',
      '  - { name: Runner, parser: { command: node, args: [scripts/evil.mjs] } }',
      '  - { name: PlainHttp, careers_url: "http://jobs.example.com/careers" }',
      'job_boards:', '  - { name: Parse, provider: local-parser }',
      '  - { name: Good, provider: jobicy, searches: [{ q: SEARCH-TERM }] }',
    ].join('\n');
    const hub = await startHub(okHubRoutes(() => ({ status: 202, json: { ok: true, accepted_urls: [], duplicate_urls: [] } }), hostile));
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    const run = startDriver();
    if (await run.url()) {
      ok(await until(() => existsSync(join(sandbox, 'portals.yml')), 20000), 'the node renders portals.yml from the criteria');
      const portals = readFileSync(join(sandbox, 'portals.yml'), 'utf-8');
      ok(portals.includes('boards.greenhouse.io/acme') && portals.includes('name: Good') && portals.includes('provider: jobicy'), 'a plain https company and a named board survive');
      ok(!/local-parser|parser|command|scripts\/|SECRET-NOTE|SEARCH-TERM|PlainHttp|name: Parse/.test(portals), 'nothing that makes the scanner run a command, an extra field, an http source or a local-parser board does');
      ok(portals.includes('name: Runner') && !/Runner[^]*?(parser|command)/.test(portals), 'and a name-only entry that carried a parser is left as a bare, harmless name');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }
  {
    // The self-hosted node trusts ITS hub (its own autopilot): the same bodies change nothing there.
    resetSandbox();
    seedState({ to_ship: [find(1), find(2)] });
    const hub = await startHub({
      '/api/discovery/node/criteria': () => ({ status: 200, json: criteriaJson({ portals_yml: 'title_filter: { positive: [x] }\ntracked_companies:\n  - { name: Acme, careers_url: "https://boards.greenhouse.io/acme", notes: KEPT-NOTE }\n' }) }),
      '/api/discovery/node/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1', node_settings: {} } }),
      '/api/discovery/node/ingest': () => ({ status: 409, json: { error: 'profile_incomplete' } }),
    });
    writeSandboxConfig({ mode: 'node', hubUrl: hub.url, token: 'a'.repeat(48) });
    const run = startDriver();
    if (await run.url()) {
      ok(await until(() => Object.keys(readState()?.dropped || {}).length === 2, 20000), 'node mode still drops a batch the hub answers 409 to (unchanged)');
      ok(readState().to_ship.length === 0 && readState().ship_batch_limit === undefined, 'and never grows a hosted-only batch limit');
      ok(readFileSync(join(sandbox, 'portals.yml'), 'utf-8').includes('KEPT-NOTE'), 'and renders its hub\'s portals.yml entries as they came');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }

  console.log('\n  companion mode: finds the account would refuse are dropped on this machine, not shipped');
  {
    // Hacker News job posts (the hackernews and hn-jobs boards) link the poster's OWN careers site; the account accepts
    // only an ATS posting or a public listing page, and a refused submission still spends a quarter of the day's allowance.
    resetSandbox();
    const POSTER = 'https://careers.acme-startup.example/jobs/platform-engineer';
    const PLAIN_HTTP = 'http://boards.greenhouse.io/acme/jobs/1234567';
    const WITH_PORT = 'https://jobs.lever.co:8443/acme/123e4567-e89b-12d3-a456-426614174000';
    mkdirSync(join(sandbox, 'data'), { recursive: true });
    writeFileSync(join(sandbox, 'data', 'pipeline.md'), [POSTER, PLAIN_HTTP, WITH_PORT].map((u, i) => `- [ ] ${u} | Acme ${i} | Platform Engineer`).join('\n') + '\n');
    const hub = await startHub({
      '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson() }),
      '/api/companion/discovery/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1' } }),
      '/api/companion/discovery/seen': () => ({ status: 200, json: { ok: true, seen: [] } }),
      '/api/companion/discovery/ingest': () => ({ status: 202, json: { ok: true, accepted: 0, duplicates: 0, rejected: 0, accepted_urls: [], duplicate_urls: [] } }),
    });
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN, validateCfg: 'enabled: true, every_minutes: 1, concurrency: 1' });
    const run = startDriver();
    const url = await run.url();
    if (url) {
      ok(await until(() => Object.keys(readState()?.dropped || {}).length === 3, 20000), 'a find on a site the account does not take is dropped as soon as it is read, with all three of these refused');
      const s = readState();
      const reasons = Object.values(s.dropped).map((d) => d.reason).sort();
      ok(reasons.join() === 'hosted_bad_url,hosted_bad_url,hosted_unsupported_host', `each is dropped with the reason the account would have given (${reasons.join()})`);
      ok(s.to_ship.length === 0 && Object.keys(s.shipped || {}).length === 0, 'and none of them is queued to ship');
      const pipeline = readFileSync(join(sandbox, 'data', 'pipeline.md'), 'utf-8');
      ok(!pipeline.includes('- [ ]') && /careers\.acme-startup\.example\S* \| Acme 0 \| Platform Engineer — node: dropped \(hosted_unsupported_host\)/.test(pipeline), 'the pipeline rows are checked off with the reason, so they are not read again');
      await sleep(2500);
      ok(hub.on('/api/companion/discovery/ingest').length === 0, 'nothing reached the account: no ingest call at all');
      const st = (await dashCall(url, { path: '/api/status' })).json;
      ok(st.queue.dropped_total === 3 && st.queue.dropped_hosted === 3, 'the local dashboard counts them as dropped, and says how many were for this reason');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }

  console.log('\n  criteria refresh: a hub that starts failing after one good fetch is backed off, not retried every tick');
  for (const [label, mode, token, prefix, failure] of [
    ['a self-hosted hub answering 500', 'node', 'a'.repeat(48), '/api/discovery/node', { status: 500, json: { error: 'down' } }],
    ['a hosted hub answering 409 profile_incomplete', 'companion', TOKEN, '/api/companion/discovery', { status: 409, json: { error: 'profile_incomplete' } }],
  ]) {
    resetSandbox();
    const hub = await startHub({
      // Succeeds once; every later call fails. The scheduler ticks every second and the refresh is due every
      // 1.2 s, so a node without a backoff asks again on every tick (seven or eight calls in the window below).
      [`${prefix}/criteria`]: (_entry, n) => (n === 1 ? { status: 200, json: criteriaJson() } : failure),
      [`${prefix}/heartbeat`]: () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1', node_settings: {} } }),
    });
    writeSandboxConfig({ mode, hubUrl: hub.url, token, criteriaRefresh: 0.02 });
    const run = startDriver();
    if (await run.url()) {
      ok(await until(() => hub.on(`${prefix}/criteria`).length >= 2, 20000), `${label}: the node refreshes its criteria once they are due`);
      await sleep(7000);
      const calls = hub.on(`${prefix}/criteria`).length;
      ok(calls === 2, `${label}: and then waits out its backoff instead of asking again on every tick (${calls} criteria calls)`);
      const log = readFileSync(join(sandbox, 'data', 'discovery-node', 'logs', 'daemon.log'), 'utf-8');
      const said = log.split('\n').filter((l) => l.includes('criteria refresh failed'));
      ok(said.length === 1 && /retrying in 60s/.test(said[0]), `${label}: the log says so once, with the wait it really applies (${said.length} line(s))`);
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
  }

  console.log('\n  one node per folder: a second launch is refused, a stale lock is taken over');
  {
    resetSandbox();
    const hub = await startHub({
      '/api/discovery/node/criteria': () => ({ status: 200, json: criteriaJson() }),
      '/api/discovery/node/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1', node_settings: {} } }),
    });
    writeSandboxConfig({ mode: 'node', hubUrl: hub.url, token: 'a'.repeat(48) });
    const lockFile = join(sandbox, 'data', 'discovery-node', 'daemon.lock');
    const first = startDriver();
    const firstUrl = await first.url();
    if (firstUrl) {
      ok(existsSync(lockFile), 'a running node holds data/discovery-node/daemon.lock');
      const held = JSON.parse(readFileSync(lockFile, 'utf-8'));
      ok(held.pid === first.child.pid && held.dashboard_port === Number(new URL(firstUrl).port), 'naming its process and its dashboard port');
      ok(!readFileSync(lockFile, 'utf-8').includes(dashKey(firstUrl)), 'and never the dashboard\'s access key');
      const startedBefore = readState().started_at;
      const second = startDriver();
      await second.done;
      ok(second.exit === 2 && /already running from this folder \(process \d+/.test(second.stderr) && /delete data\/discovery-node\/daemon\.lock/.test(second.stderr), `a second launch in the same folder is refused with the way out (${second.stderr.split('\n')[0].slice(0, 110)})`);
      ok(!/READY/.test(second.stdout) && second.stderr.includes(`http://127.0.0.1:${new URL(firstUrl).port}/`) && !second.stderr.includes(dashKey(firstUrl)), 'it starts no second dashboard, and names the first one\'s address without its key');
      // (The first node writes its own state all the time, so compare what only a SECOND start would change.)
      ok(startedBefore && readState().started_at === startedBefore, 'and did not stamp its own start over the first node\'s state (an unguarded second copy rewrites state.json at once)');
      ok((await dashCall(firstUrl, { path: '/api/status' })).status === 200 && JSON.parse(readFileSync(lockFile, 'utf-8')).pid === first.child.pid, 'while the first node is untouched and still holds the lock');
    } else ok(false, 'the node starts');
    await first.stop();
    ok(!existsSync(lockFile), 'an orderly stop removes the lock');

    // A lock left by a process that is gone is stale, and so is one a crash left half-written.
    mkdirSync(join(sandbox, 'data', 'discovery-node'), { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(lockFile, JSON.stringify({ pid: gone, started_at: iso(now), dashboard_port: 8390 }));
    const third = startDriver();
    ok(Boolean(await third.url()), 'a lock whose process is gone is taken over');
    ok(JSON.parse(readFileSync(lockFile, 'utf-8')).pid === third.child.pid, 'and then names the new process');
    await third.stop();
    writeFileSync(lockFile, '{"pid": ');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    const fourth = startDriver();
    ok(Boolean(await fourth.url()), 'an unreadable lock a crash left behind is taken over too');
    await fourth.stop();
    await hub.close();
  }

  console.log('\n  closing the window: SIGHUP stops the node in order');
  {
    // The documented way to stop the packaged node is "close the window", which delivers SIGHUP; unhandled, the
    // process died without saving what it had validated since its last state save. Windows cannot deliver a signal
    // to a child (kill() ends it outright), so there the wiring is pinned in the source and the behaviour is run elsewhere.
    const daemonSrc = readFileSync(join(ROOT, 'autopilot', 'discovery-node.mjs'), 'utf-8');
    const startSrc = readFileSync(join(ROOT, 'autopilot', 'discovery-node-start.mjs'), 'utf-8');
    const SIGNALS = /for \(const signal of \['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'\]\) process\.once\(signal, (shutdown|leave)\);/;
    ok(SIGNALS.test(daemonSrc) && SIGNALS.test(startSrc), 'both ways of running the node stop it on SIGINT, SIGTERM, SIGHUP and SIGBREAK');
    // …and neither forces an exit straight after stop(): on Windows that races the last of the teardown and
    // aborts Node (libuv assertion, exit code 0xC0000409, about one stop in four). They let the loop drain, with an unref'd backstop.
    const daemonCode = daemonSrc.replace(/^\s*\/\/.*$/gm, ''); // comments may say what the code avoids
    const shutdownStart = daemonCode.indexOf('const shutdown = () => {');
    const shutdownBody = daemonCode.slice(shutdownStart, daemonCode.indexOf('try {', shutdownStart));
    const backstop = /setTimeout\(\(\) => process\.exit\(0\), 3000\)\.unref\(\);/;
    ok(shutdownStart > 0 && backstop.test(shutdownBody) && /process\.exitCode = 0/.test(shutdownBody) && !/process\.exit\(/.test(shutdownBody.replace(backstop, '')),
      '--daemon ends by draining its loop after stop(), with an unref\'d timer as the backstop');
    if (process.platform === 'win32') {
      console.log('  SKIP: a signal cannot be delivered to a child process on Windows');
    } else {
      resetSandbox();
      seedState({ to_ship: [] });
      const hub = await startHub({
        '/api/discovery/node/criteria': () => ({ status: 200, json: criteriaJson() }),
        '/api/discovery/node/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1', node_settings: {} } }),
      });
      writeSandboxConfig({ mode: 'node', hubUrl: hub.url, token: 'a'.repeat(48) });
      const child = spawn(process.execPath, ['autopilot/discovery-node.mjs', '--daemon'], { cwd: sandbox, stdio: 'ignore' });
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      const logFile = join(sandbox, 'data', 'discovery-node', 'logs', 'daemon.log');
      ok(await until(() => existsSync(logFile) && readFileSync(logFile, 'utf-8').includes('daemon started'), 20000), 'the daemon starts');
      child.kill('SIGHUP');
      const end = await Promise.race([exited, sleep(10000).then(() => null)]);
      if (!end) child.kill();
      ok(end && end.code === 0 && end.signal === null, `SIGHUP makes it exit normally rather than die (${JSON.stringify(end)})`);
      ok(readFileSync(logFile, 'utf-8').includes('shutting down') && !existsSync(join(sandbox, 'data', 'discovery-node', 'daemon.lock')), 'having gone through its shutdown (state saved, lock removed)');
      await hub.close();
    }
  }

  console.log('\n  a config with a job block missing: the advice names files that are in this checkout');
  {
    // The same source runs in the full repository and in the public package, which ships neither
    // fleet/sync-node-jobs.mjs nor config/discovery-node.example.yml (only the user example). The sandbox is a
    // checkout with neither, so the user example is staged here as the package would have it.
    resetSandbox();
    const hub = await startHub({
      '/api/companion/discovery/criteria': () => ({ status: 200, json: criteriaJson() }),
      '/api/companion/discovery/heartbeat': () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1' } }),
    });
    writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN });
    writeFileSync(join(sandbox, 'config', 'discovery-node.yml'), readFileSync(join(sandbox, 'config', 'discovery-node.yml'), 'utf-8').replace('  resolve: { enabled: false, every_minutes: 60, max_minutes: 5 }\n', ''));
    copyFileSync(join(ROOT, 'config', 'discovery-node.user.example.yml'), join(sandbox, 'config', 'discovery-node.user.example.yml'));
    const run = startDriver();
    if (await run.url()) {
      const log = readFileSync(join(sandbox, 'data', 'discovery-node', 'logs', 'daemon.log'), 'utf-8');
      const warned = log.split('\n').find((l) => l.includes('config has no jobs.resolve block')) || '';
      ok(/copy the block\(s\) from config\/discovery-node\.user\.example\.yml into config\/discovery-node\.yml, then stop the node and start it again/.test(warned), `the startup warning names the example config that ships with the package (${warned.slice(0, 160)})`);
      ok(!/fleet\/|scheduled task|config\/discovery-node\.example\.yml/.test(warned), 'and nothing that is not there');
      const status = spawnSync(process.execPath, ['autopilot/discovery-node.mjs', '--status'], { cwd: sandbox, encoding: 'utf-8' }).stdout;
      ok(/can schedule resolve/.test(status) && /copy the block\(s\) from config\/discovery-node\.user\.example\.yml/.test(status) && !/fleet\/|scheduled task/.test(status), '--status says the same');
    } else ok(false, 'the node starts');
    await run.stop();
    await hub.close();
    // …and in a checkout that has the maintainer's script, --status names it.
    resetSandbox();
    writeSandboxConfig({ mode: 'node', hubUrl: 'http://127.0.0.1:9', token: 'a'.repeat(48) });
    writeFileSync(join(sandbox, 'config', 'discovery-node.yml'), readFileSync(join(sandbox, 'config', 'discovery-node.yml'), 'utf-8').replace('  resolve: { enabled: false, every_minutes: 60, max_minutes: 5 }\n', ''));
    mkdirSync(join(sandbox, 'fleet'), { recursive: true });
    writeFileSync(join(sandbox, 'fleet', 'sync-node-jobs.mjs'), '// stand-in\n');
    const status = spawnSync(process.execPath, ['autopilot/discovery-node.mjs', '--status'], { cwd: sandbox, encoding: 'utf-8' }).stdout;
    ok(/run: node fleet\/sync-node-jobs\.mjs, then restart the node/.test(status), 'where fleet/sync-node-jobs.mjs exists, a self-hosted node is pointed at it');
    rmSync(join(sandbox, 'fleet'), { recursive: true, force: true });
  }

  console.log('\n  companion mode: refusing to start');
  {
    const hub = await startHub({});
    const refusal = async (label, setup, expect) => {
      resetSandbox();
      setup();
      const run = startDriver();
      await run.done;
      ok(run.exit === 2 && expect.test(run.stderr), `${label}: exit 2 with a clear message (exit ${run.exit}: ${run.stderr.split('\n')[0].slice(0, 120)})`);
    };
    const cfg = (extra = {}) => writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: TOKEN, ...extra });
    await refusal('a folder with a cv.md', () => { cfg(); writeFileSync(join(sandbox, 'cv.md'), '# Somebody\n'); }, /cv\.md/);
    await refusal('a folder with a tracker', () => { cfg(); mkdirSync(join(sandbox, 'data'), { recursive: true }); writeFileSync(join(sandbox, 'data', 'applications.md'), '| # |\n'); }, /data\/applications\.md/);
    await refusal('a hand-written portals.yml', () => { cfg(); writeFileSync(join(sandbox, 'portals.yml'), 'title_filter: {}\n'); }, /portals\.yml/);
    await refusal('a hub URL that is not https', () => { writeSandboxConfig({ mode: 'companion', hubUrl: 'http://example.com', token: TOKEN }); }, /https/);
    await refusal('no token', () => { writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: null }); }, /token/);
    await refusal('a token of the wrong kind', () => { writeSandboxConfig({ mode: 'companion', hubUrl: hub.url, token: 'a'.repeat(48) }); }, /token/);
    await refusal('an unusable node name', () => { cfg({ nodeName: '"Bad Name!"' }); }, /node\.name/);
    // The node's own machine-written files are fine to find again.
    resetSandbox();
    cfg();
    writeFileSync(join(sandbox, 'portals.yml'), '# MACHINE-WRITTEN by autopilot/discovery-node.mjs from the hub\'s criteria — edit portals.yml on the autopilot host instead.\ntitle_filter: {}\n');
    hub.responses['/api/companion/discovery/criteria'] = () => ({ status: 200, json: criteriaJson() });
    hub.responses['/api/companion/discovery/heartbeat'] = () => ({ status: 200, json: { ok: true, criteria_hash: 'hash-1' } });
    const run = startDriver();
    ok(Boolean(await run.url()), 'a portals.yml carrying the node\'s own header is the node\'s, so it starts');
    await run.stop();
    await hub.close();
  }
}

rmSync(sandbox, { recursive: true, force: true });
console.log('\ndiscovery-node daemon checks complete.');
