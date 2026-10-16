// tests/discovery-node-dashboard.test.mjs — the discovery node's LOCAL
// dashboard (autopilot/lib/discovery-node-dashboard.mjs): a loopback-only web
// page that can pause or stop a process and change what it fetches.
//
// Every route is driven over a REAL socket against a fake `api`, because the
// protections that matter here — the Host/Origin checks, the key, the body cap,
// the loopback bind — live in how the HTTP request is handled, not in any one
// function. Nothing here touches the daemon, its state or the network beyond
// 127.0.0.1.
import { pass, fail } from './helpers.mjs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

console.log('\ndiscovery-node dashboard — loopback-only control page');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const mod = await import('../autopilot/lib/discovery-node-dashboard.mjs');
const { startDashboard, isLoopbackHost, PAGE_HTML, PAGE_CSP, PAGE_SCRIPT_HASH } = mod;

const KEY = 'sentinel-key-9f3a1c7e5b2d4a60-DO-NOT-LOG';

// ── isLoopbackHost: exact spellings only ─────────────────────────────────
for (const h of ['127.0.0.1', '::1', 'localhost', ' LOCALHOST ']) ok(isLoopbackHost(h), `${JSON.stringify(h)} is loopback`);
for (const h of ['0.0.0.0', '', null, undefined, '127.0.0.2', '127.evil.com', 'localhost.evil.com', '203.0.113.5', '::', '[::1]', 0]) {
  ok(!isLoopbackHost(h), `${JSON.stringify(h)} is NOT loopback`);
}

// ── A fake daemon behind the dashboard ───────────────────────────────────
function makeApi() {
  const calls = [];
  const api = {
    calls,
    status: () => ({ node: 'test-node', mode: 'companion', paused: false, hub: { host: 'example.test', connected: true }, jobs: {}, queue: {} }),
    pause: () => { calls.push(['pause']); },
    resume: () => { calls.push(['resume']); },
    stop: () => { calls.push(['stop']); },
    putJob: (name, body) => {
      calls.push(['putJob', name, body]);
      return body.bad ? { ok: false, errors: ['tracked.every_minutes must be a whole number 5..10080'] } : { ok: true };
    },
    runJob: (name) => { calls.push(['runJob', name]); return name === 'ats_full' ? { ok: false, error: 'busy' } : { ok: true }; },
  };
  return api;
}

/** One raw HTTP request, with full control of the Host header. */
function call(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve({ status: 0, headers: {}, text: '', json: null }) : reject(err)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const withKey = (extra = {}) => ({ 'X-Node-Key': KEY, ...extra });
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ── Refusal to bind anywhere but loopback ────────────────────────────────
{
  for (const host of ['0.0.0.0', '', null, '127.0.0.2', '203.0.113.5', 'example.com']) {
    const lines = [];
    const dash = await startDashboard({ host, port: 0, key: KEY, api: makeApi(), log: (l) => lines.push(l) });
    ok(dash === null, `host ${JSON.stringify(host)}: no listener is started`);
    ok(lines.some((l) => /not started/.test(l)), `host ${JSON.stringify(host)}: the refusal is logged`);
    if (dash) await dash.close();
  }
}

// ── The running dashboard ────────────────────────────────────────────────
const logs = [];
const api = makeApi();
const dash = await startDashboard({ port: 0, key: KEY, api, log: (l) => logs.push(l) });
ok(dash && dash.port > 0, `starts on an ephemeral port when asked for 0 (got ${dash?.port})`);
ok(dash.host === '127.0.0.1' || dash.host === '::1', `bound address is loopback (${dash.host})`);
ok(dash.url === `http://127.0.0.1:${dash.port}/#k=${KEY}`, 'the URL carries the key in the FRAGMENT (never sent to a server)');
const port = dash.port;

try {
  // ── GET / ──────────────────────────────────────────────────────────────
  {
    const r = await call(port);
    ok(r.status === 200 && /^text\/html/.test(r.headers['content-type']), 'GET / serves HTML');
    ok(r.text === PAGE_HTML, 'and it is the static page, nothing computed per request');
    ok(!r.text.includes(KEY), 'the page does not contain the access key');
    ok(r.headers['content-security-policy'] === PAGE_CSP, 'CSP header is set');
    ok(r.headers['cache-control'] === 'no-store', 'Cache-Control: no-store');
    ok(r.headers['referrer-policy'] === 'no-referrer', 'Referrer-Policy: no-referrer');
    ok(r.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');

    // The CSP allows exactly the hash of the one inline script.
    const scripts = [...r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    ok(scripts.length === 1, 'the page has exactly one inline script');
    const hash = `sha256-${createHash('sha256').update(scripts[0][1], 'utf8').digest('base64')}`;
    ok(PAGE_CSP.includes(`script-src '${hash}'`) && hash === PAGE_SCRIPT_HASH, 'script-src is the sha256 of the inline script text, byte for byte');
    for (const directive of ["default-src 'none'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      ok(PAGE_CSP.includes(directive), `CSP carries ${directive}`);
    }
    ok(!/script-src[^;]*unsafe-inline/.test(PAGE_CSP) && !/unsafe-eval/.test(PAGE_CSP), 'and scripts are NOT allowed by unsafe-inline or unsafe-eval');
    // The one <link> is an empty data: icon, there so the browser does not ask the server for /favicon.ico.
    ok(!/<script[^>]+src=|<link[^>]+href=["'](?!data:)|<img[^>]+src=|<iframe/i.test(r.text), 'no external asset of any kind');

    // Scraped strings reach the DOM through textContent only.
    const script = scripts[0][1];
    ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function|\bon[a-z]+\s*=\s*['"]/.test(script),
      'the script never uses innerHTML/outerHTML/document.write/eval/inline handlers');
    ok(/textContent/.test(script) && /safeHref/.test(script) && /p\.protocol === 'https:' \|\| p\.protocol === 'http:'/.test(script),
      'finds are linked only for http(s) URLs');
    ok(/rel = 'noopener noreferrer'/.test(script), 'and with rel="noopener noreferrer"');
    ok(/replaceState/.test(script) && /sessionStorage/.test(script), 'the key is moved to sessionStorage and stripped from the address bar');
    ok(/Nothing keeps running after you close/.test(r.text), 'the page says nothing keeps running once the terminal closes');
    ok(!/CareerOps|Career Ops|Career-Ops/.test(r.text), 'the product name is CareerAutopilot');
    ok(r.text.includes('<meta name="viewport"') && r.text.includes('prefers-color-scheme: dark'), 'responsive and dark-mode aware');

    // The start script opens the browser on the bare address (the key must not sit on a command line), so a page with
    // no key has to ask for it. Run the real script against a stub DOM.
    {
      const { runInNewContext } = await import('node:vm');
      const KEY64 = 'AbCdEf0123456789_-AbCdEf0123456789_-AbCdEf0123456789_-AbCdEf01';
      const boot = (hash = '', stored = null) => {
        const els = new Map();
        const stub = (id) => ({
          id, hidden: id === 'needkey', value: '', textContent: '', className: '', disabled: false, listeners: {}, attrs: {}, children: [],
          addEventListener(type, fn) { this.listeners[type] = fn; },
          setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
          appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); },
          get firstChild() { return this.children[0] ?? null; },
        });
        const el = (id) => { if (!els.has(id)) els.set(id, stub(id)); return els.get(id); };
        const store = new Map(stored ? [['cad-node-key', stored]] : []);
        const fetches = [];
        const ctx = {
          document: { getElementById: el, createElement: () => stub(null), createTextNode: (text) => ({ text }), addEventListener() {}, hidden: false },
          location: { hash, pathname: '/', search: '' }, history: { replaceState() {} },
          sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
          fetch: (path, opts) => { fetches.push({ path, key: opts.headers['X-Node-Key'] }); return Promise.resolve({ status: 401, ok: false, json: () => Promise.resolve({ error: 'unauthorized' }) }); },
          setInterval: () => 1, clearInterval() {}, confirm: () => false, URL, Date, JSON, Math, isFinite, encodeURIComponent, Promise,
        };
        runInNewContext(script, ctx);
        return { el, fetches, store };
      };
      const tick = () => new Promise((resolve) => setImmediate(resolve));

      let page = boot();
      ok(page.el('needkey').hidden === false && page.fetches.length === 0 && /Paste the link/.test(page.el('msg').textContent), 'opened with no key, the page asks for the link and calls nothing');
      page.el('keyIn').value = 'garbage';
      page.el('keyGo').listeners.click();
      await tick();
      ok(page.fetches.length === 0 && /not the dashboard link/.test(page.el('msg').textContent), 'something that is not the link is turned away without a request');
      page.el('keyIn').value = `  http://127.0.0.1:8390/#k=${KEY64}  `;
      page.el('keyGo').listeners.click();
      await tick();
      ok(page.fetches.length === 1 && page.fetches[0].key === KEY64 && page.fetches[0].path === '/api/status', 'the pasted link\'s key (and only that) is sent as X-Node-Key');
      ok(page.store.get('cad-node-key') === undefined && page.el('needkey').hidden === false && /not accepted/.test(page.el('msg').textContent), 'a key the node refuses (401) is forgotten and the page asks again, saying why');
      page.el('keyIn').value = KEY64;
      page.el('keyIn').listeners.keydown({ key: 'Enter' });
      await tick();
      ok(page.fetches.length === 2 && page.fetches[1].key === KEY64, 'Enter in the box does the same, and so does the bare key');

      page = boot(`#k=${KEY64}`);
      await tick();
      ok(page.fetches.length === 1 && page.fetches[0].key === KEY64, 'a link opened with its key in the address bar still works as before');
      page = boot('', KEY64);
      await tick();
      ok(page.fetches.length === 1 && page.fetches[0].key === KEY64, 'and so does a reload of a tab that already has its key');
      ok(/id="needkey"[^>]*\bhidden\b/.test(PAGE_HTML) && /<label for="keyIn"/.test(PAGE_HTML) && !/<form/.test(PAGE_HTML), 'the box is hidden until needed, labelled, and not a form (the CSP forbids form submission)');
    }

    const post = await call(port, { method: 'POST', path: '/' });
    ok(post.status === 405, 'POST / is 405');
    ok((await call(port, { path: '/nope' })).status === 404, 'an unknown path is 404');
  }

  // ── Host header: DNS-rebinding defence ────────────────────────────────
  {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `127.0.0.1.evil.example:${port}`]) {
      const r = await call(port, { path: '/api/status', headers: withKey(), host });
      ok(r.status === 403 || r.status === 400, `Host ${JSON.stringify(host)} is refused (${r.status})`);
    }
    ok((await call(port, { path: '/', host: 'evil.example' })).status === 403, 'even the static page refuses a foreign Host');
    ok((await call(port, { path: '/api/status', headers: withKey(), host: `localhost:${port}` })).status === 200, 'Host localhost:<port> is accepted');
    ok((await call(port, { path: '/api/status', headers: withKey(), host: `127.0.0.1:${port}` })).status === 200, 'Host 127.0.0.1:<port> is accepted');
  }

  // ── Origin ─────────────────────────────────────────────────────────────
  {
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://localhost.evil.example:${port}`]) {
      const r = await call(port, { path: '/api/status', headers: withKey({ Origin: origin }) });
      ok(r.status === 403, `Origin ${origin} is refused`);
    }
    ok((await call(port, { path: '/api/status', headers: withKey({ Origin: `http://127.0.0.1:${port}` }) })).status === 200, 'Origin http://127.0.0.1:<port> is accepted');
    ok((await call(port, { path: '/api/status', headers: withKey({ Origin: `http://localhost:${port}` }) })).status === 200, 'Origin http://localhost:<port> is accepted');
    ok((await call(port, { path: '/api/status', headers: withKey() })).status === 200, 'no Origin header at all (a plain fetch from the same page) is fine');
  }

  // ── The key ────────────────────────────────────────────────────────────
  {
    ok((await call(port, { path: '/api/status' })).status === 401, 'no key: 401');
    ok((await call(port, { path: '/api/status', headers: { 'X-Node-Key': 'x'.repeat(KEY.length) } })).status === 401, 'a wrong key of the right length: 401');
    ok((await call(port, { path: '/api/status', headers: { 'X-Node-Key': KEY.slice(1) } })).status === 401, 'a wrong key of the wrong length: 401');
    ok((await call(port, { path: `/api/status?key=${KEY}` })).status === 401, 'the key in the query string does not count');
    const r = await call(port, { path: '/api/status', headers: withKey() });
    ok(r.status === 200 && r.json.node === 'test-node', 'the right key: 200 and the status');
    ok(r.headers['cache-control'] === 'no-store' && /^application\/json/.test(r.headers['content-type']), 'API responses are JSON and uncacheable');
    ok((await call(port, { method: 'OPTIONS', path: '/api/status', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } })).status === 403,
      'a CORS preflight is never answered (Origin refused before anything else)');
    ok(!('access-control-allow-origin' in r.headers), 'and no CORS header is ever sent');
  }

  // ── Methods, content type, body ────────────────────────────────────────
  {
    ok((await call(port, { method: 'GET', path: '/api/pause', headers: withKey() })).status === 405, 'GET on a POST route: 405');
    ok((await call(port, { method: 'POST', path: '/api/status', headers: withKey(JSON_HEADERS), body: '{}' })).status === 405, 'POST on a GET route: 405');
    ok((await call(port, { method: 'POST', path: '/api/pause', headers: withKey(), body: '{}' })).status === 415, 'POST without a content type: 415');
    ok((await call(port, { method: 'POST', path: '/api/pause', headers: withKey({ 'Content-Type': 'text/plain' }), body: '{}' })).status === 415, 'POST as text/plain: 415');
    ok((await call(port, { method: 'POST', path: '/api/pause', headers: withKey({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: 'a=1' })).status === 415, 'POST as a form: 415 (a cross-site <form> cannot reach it)');
    ok((await call(port, { method: 'PUT', path: '/api/jobs/tracked', headers: withKey(JSON_HEADERS), body: '{not json' })).status === 400, 'invalid JSON: 400');
    ok((await call(port, { method: 'PUT', path: '/api/jobs/tracked', headers: withKey(JSON_HEADERS), body: '[1,2]' })).status === 400, 'a JSON array body: 400');
    const big = JSON.stringify({ pad: 'x'.repeat(20 * 1024) });
    const r413 = await call(port, { method: 'PUT', path: '/api/jobs/tracked', headers: withKey(JSON_HEADERS), body: big });
    ok(r413.status === 413 || r413.status === 0, `a body over 16 KB is refused (${r413.status})`);
    const calls0 = api.calls.length;
    ok(api.calls.slice(0, calls0).every((c) => c[0] !== 'putJob' || !String(JSON.stringify(c[2])).includes('xxxxxxxxxx')), 'and never reached the handler');
  }

  // ── Routes ─────────────────────────────────────────────────────────────
  {
    api.calls.length = 0;
    ok((await call(port, { method: 'POST', path: '/api/pause', headers: withKey(JSON_HEADERS), body: '{}' })).json?.ok === true && api.calls.at(-1)[0] === 'pause', 'POST /api/pause pauses');
    ok((await call(port, { method: 'POST', path: '/api/resume', headers: withKey(JSON_HEADERS), body: '{}' })).json?.ok === true && api.calls.at(-1)[0] === 'resume', 'POST /api/resume resumes');
    const put = await call(port, { method: 'PUT', path: '/api/jobs/tracked', headers: withKey(JSON_HEADERS), body: JSON.stringify({ every_minutes: 90, enabled: true }) });
    ok(put.status === 200 && api.calls.at(-1)[0] === 'putJob' && api.calls.at(-1)[1] === 'tracked' && api.calls.at(-1)[2].every_minutes === 90, 'PUT /api/jobs/:name hands the body to putJob');
    const bad = await call(port, { method: 'PUT', path: '/api/jobs/tracked', headers: withKey(JSON_HEADERS), body: JSON.stringify({ bad: true }) });
    ok(bad.status === 400 && Array.isArray(bad.json.errors) && bad.json.errors.length === 1, 'a rejected patch is 400 with the validation errors');
    ok((await call(port, { method: 'PUT', path: '/api/jobs/not-a-job', headers: withKey(JSON_HEADERS), body: '{}' })).status === 404, 'an unknown job is 404');
    ok((await call(port, { method: 'PUT', path: '/api/jobs/..%2F..%2Fetc', headers: withKey(JSON_HEADERS), body: '{}' })).status === 404, 'a traversal-shaped job name is 404');
    ok((await call(port, { method: 'PUT', path: '/api/jobs/%E0%A4%A', headers: withKey(JSON_HEADERS), body: '{}' })).status === 404, 'a malformed escape in the job name is 404, not a crash');
    ok(!api.calls.some((c) => c[0] === 'putJob' && !['tracked'].includes(c[1])), 'and none of those reached putJob');
    ok((await call(port, { method: 'POST', path: '/api/jobs/boards/run', headers: withKey(JSON_HEADERS), body: '{}' })).status === 200 && api.calls.at(-1)[0] === 'runJob', 'POST /api/jobs/:name/run queues a run');
    ok((await call(port, { method: 'POST', path: '/api/jobs/ats_full/run', headers: withKey(JSON_HEADERS), body: '{}' })).status === 409, 'a run the daemon cannot queue is 409');
    ok((await call(port, { method: 'POST', path: '/api/jobs/validate/run', headers: withKey(JSON_HEADERS), body: '{}' })).status === 200, 'validate is a runnable job too');
  }

  // ── Stop: answered first, stopped after ───────────────────────────────
  {
    api.calls.length = 0;
    const r = await call(port, { method: 'POST', path: '/api/stop', headers: withKey(JSON_HEADERS), body: '{}' });
    ok(r.status === 200 && r.json.ok === true, 'POST /api/stop answers 200');
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok(api.calls.some((c) => c[0] === 'stop'), 'and then stops the node');
  }

  // ── The key never reaches the logger ──────────────────────────────────
  ok(logs.length > 0 && logs.every((l) => !l.includes(KEY)), 'the access key is absent from every line the dashboard logged');
  ok(logs.some((l) => l.includes(String(port))), 'the log names the port');
} finally {
  await dash.close();
}
{
  const r = await call(port, { path: '/api/status', headers: withKey() }).catch((e) => ({ status: -1, err: e.code }));
  ok(r.status === -1 || r.status === 0, 'after close() the port no longer answers');
}

// ── The page's script, actually run ──────────────────────────────────────
//
// The CSP hash and the textContent-only rule are checks on the TEXT of the
// script; neither proves it runs. This executes the real script in a vm context
// against a minimal fake DOM and a fake fetch, feeds it a status document whose
// scraped fields are hostile, and looks at what ended up in the tree.
{
  const { Script, createContext, runInContext } = await import('node:vm');
  const scriptText = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  let compiled = null;
  try { compiled = new Script(scriptText); } catch (err) { fail('the page script compiles: ' + err.message); }
  ok(compiled !== null, 'the page script compiles');

  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.className = ''; this.disabled = false; this.checked = false; this.value = ''; this.title = ''; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    walk(fn) { fn(this); for (const c of this.children) if (c.walk) c.walk(fn); }
  }
  const byId = new Map();
  for (const m of PAGE_HTML.matchAll(/id="([A-Za-z]+)"/g)) byId.set(m[1], new El('div'));
  const created = [];
  const stored = {};
  const fetches = [];
  const status = {
    node: 'my-laptop', mode: 'companion', version: 'abc', uptime_s: 5,
    hub: { host: 'example.test', connected: true, last_heartbeat_ok_at: new Date().toISOString(), error: null },
    hub_blocked: null, paused: false, paused_by: { local: false, hub: false }, current_job: { name: 'boards', started_at: new Date().toISOString() },
    jobs: {
      tracked: { enabled: true, every_minutes: 120, start_at: null, max_minutes: 45, last_run_at: new Date().toISOString(), last_ok: true, last_summary: '<b>done</b>', next_run_at: null, runs: 2, errors: 0, can_start_at: true, source: { enabled: 'config', every_minutes: 'local' } },
      validate: { enabled: true, every_minutes: 10, start_at: null, max_minutes: null, last_run_at: null, last_ok: null, last_summary: null, next_run_at: null, runs: 0, errors: 0, can_start_at: false, source: {} },
    },
    queue: { pending_local: 3, to_ship: 1, shipped_total: 9, held_total: 2, dropped_total: 1, run_now: [] },
    recent_shipped: [
      { url: 'javascript:alert(1)', company: '<img src=x onerror=alert(2)>', title: '"><script>alert(3)</script>', at: new Date().toISOString() },
      { url: 'https://jobs.example.test/1', company: 'Acme', title: 'Platform Engineer', at: new Date().toISOString() },
      { url: 'data:text/html,<script>alert(4)</script>', company: 'X', title: 'Y', at: new Date().toISOString() },
    ],
    criteria: { fetched_at: new Date().toISOString(), title_keywords: 12, target_roles: 3, location: { primary: 1, authorized: 0, sponsor_required: 2 } },
    limits: { finds_per_day: 100, accepted_today: 7 },
  };
  const sandbox = {
    document: {
      hidden: false,
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => { const e = new El(tag); created.push(e); return e; },
      createTextNode: (t) => ({ textContent: String(t) }),
      addEventListener() {},
    },
    location: { hash: '#k=' + KEY, pathname: '/', search: '' },
    history: { replaceState: (...a) => { sandbox.__replaced = a; } },
    sessionStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => stored[k] ?? null },
    fetch: (path, opts) => { fetches.push([path, opts]); return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(status) }); },
    confirm: () => true, setInterval: () => 1, clearInterval() {}, Date, Math, JSON, Object, Array, String, Number, isFinite, encodeURIComponent, URL, Promise,
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  let threw = null;
  try { runInContext(scriptText, sandbox); await new Promise((r) => setTimeout(r, 30)); } catch (err) { threw = err; }
  ok(threw === null, 'the page script runs without throwing' + (threw ? ': ' + threw.message : ''));
  ok(fetches[0] && fetches[0][0] === '/api/status' && fetches[0][1].headers['X-Node-Key'] === KEY, 'it asks for /api/status with the key from the URL fragment');
  ok(Array.isArray(sandbox.__replaced) && !String(sandbox.__replaced[2]).includes('k='), 'it strips the key from the address bar');
  ok(Object.values(stored).includes(KEY), 'and keeps it in sessionStorage');
  ok(byId.get('pill').textContent === 'Working', 'the status pill says what the node is doing');
  ok(byId.get('sub').textContent.includes('my-laptop') && byId.get('sub').textContent.includes('example.test'), 'the header names the node and the site');
  ok(byId.get('stats').textContent.includes('Accepted today: 7 (daily allowance 100)'), 'the daily allowance is shown, labelled as accepted finds (refusals also use some of it)');
  ok(byId.get('jobs').children.length === 2 && byId.get('jobs').textContent.includes('tracked') && byId.get('jobs').textContent.includes('validate'), 'the jobs table lists every job');
  ok(byId.get('jobs').textContent.includes('<b>done</b>'), 'a job summary is shown as text, tags and all');
  const anchors = []; byId.get('finds').walk((n) => { if (n.tagName === 'A') anchors.push(n); });
  ok(anchors.length === 1 && anchors[0].href === 'https://jobs.example.test/1' && anchors[0].rel === 'noopener noreferrer', 'only the https find becomes a link (javascript: and data: URLs do not)');
  ok(byId.get('finds').textContent.includes('<img src=x onerror=alert(2)>') && byId.get('finds').textContent.includes('"><script>alert(3)</script>'), 'hostile titles and company names appear as literal text');
  ok(!created.some((n) => ['IMG', 'SCRIPT', 'IFRAME'].includes(n.tagName)), 'and no element was ever created from them');
  ok(created.every((n) => !('innerHTML' in n)), 'nothing set innerHTML');
}

// ── Port fallback ────────────────────────────────────────────────────────
{
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  const lines = [];
  const d2 = await startDashboard({ port: busy, api: makeApi(), log: (l) => lines.push(l) });
  ok(d2 && d2.port !== busy, `a busy port falls through to another (asked ${busy}, got ${d2?.port})`);
  ok(d2 && typeof d2.key === 'string' && d2.key.length >= 40, 'without a key option a random 32-byte key is generated');
  ok(lines.every((l) => !l.includes(d2.key)), 'and it is not logged');
  await d2?.close();
  await new Promise((resolve) => blocker.close(resolve));
}

console.log('\ndiscovery-node dashboard checks complete.');
