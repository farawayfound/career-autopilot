// autopilot/lib/discovery-node-dashboard.mjs — the discovery node's LOCAL
// dashboard: a tiny web page, on this machine only, for the person who started
// the node to see what it is doing and to pause, resume, stop or re-time it.
//
// Why it is built the way it is — this is a web server that can stop a process
// and change what it fetches, running next to a browser that opens arbitrary
// pages, so every layer assumes the others will fail:
//
//   - LOOPBACK ONLY. The listener binds 127.0.0.1 / ::1 and nothing else. The
//     configured host must be EXACTLY one of 127.0.0.1, ::1 or localhost; an
//     empty/null/other value is refused (a YAML `host:` with no value is null,
//     and Node treats a null host as "all interfaces"). After listen() the bound
//     address is asserted to be loopback again.
//   - A PER-RUN KEY, not a login. 32 random bytes, generated at start. The URL the
//     start script prints carries it in the FRAGMENT (`#k=…`): a fragment is never
//     sent to a server, so it is in no access log, no Referer and no proxy. The
//     page moves it into sessionStorage, strips it from the address bar and sends
//     it as `X-Node-Key` on every call. The key is never passed to a logger and
//     never written to a file; `startDashboard` returns it only to its caller.
//     It is not handed to the browser's launcher either: the start script opens
//     the plain address (a command line is readable by every other program on the
//     computer) and the page asks the person to paste the printed link.
//   - DNS-REBINDING / CSRF. A hostile page can make the browser send requests to
//     127.0.0.1 — or point its own DNS name at 127.0.0.1 and talk to us as
//     "same origin". So every request must carry a Host of 127.0.0.1:<port> /
//     localhost:<port> (403 otherwise), an Origin — when the browser sends one —
//     of exactly that origin (403), and the key (401). X-Node-Key is not a CORS
//     "simple" header, and we never answer a preflight, so a cross-origin page
//     cannot even try.
//   - NO DATA IN THE PAGE. GET / serves static HTML + one inline script and nothing
//     about the node; everything dynamic comes from the key-protected API.
//   - NOTHING SCRAPED IS EVER MARKUP. The recent-finds list shows titles, company
//     names and URLs taken from job postings — attacker-controlled strings. The
//     page builds its DOM with textContent only and links a URL only when its
//     parsed scheme is http: or https:. The CSP below is the backstop: scripts are
//     allowed only by the SHA-256 of our one inline script, so an injected
//     <script> or an event-handler attribute would not run even if one slipped by.
//   - SMALL, JSON-ONLY BODIES: at most 16 KB, application/json (415 otherwise).
//
// The module knows nothing about the daemon: the caller hands it an `api` object
// (status/pause/resume/stop/putJob/runJob), which is what lets the test suite
// drive every route against a fake. No dependency beyond node: built-ins and the
// shared job-name list, so it ships in the public package unchanged.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NODE_JOB_NAMES } from './discovery-node-control.mjs';

export const DEFAULT_DASHBOARD_PORT = 8390;
export const DASHBOARD_BODY_MAX_BYTES = 16 * 1024;
// "Try the next 10 ports, then an ephemeral one" when the preferred port is busy.
const PORT_FALLBACK_SPAN = 10;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * True only for the three spellings of "this machine". Everything else —
 * including an empty string, null, `0.0.0.0` and `127.0.0.2` — is not loopback
 * for our purposes. Exact match on purpose: a prefix test is how `127.evil.com`
 * and `localhost.evil.com` get through.
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  return typeof host === 'string' && LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** The Host header values a request to a listener on `port` may legitimately carry. */
function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── The page ─────────────────────────────────────────────────────────────
//
// One self-contained document: inline CSS, inline script, no external asset of
// any kind (the CSP has `default-src 'none'`). Written with String.raw so the
// script's backslashes mean what they say, and with no `${` or backtick inside
// it — it must be valid inside a template literal.

const PAGE_STYLE = String.raw`
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#1b1f24; --muted:#5b6571; --line:#d9dee5; --accent:#1f6feb; --accent-ink:#fff; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1318; --card:#171c23; --ink:#e6eaf0; --muted:#9aa5b1; --line:#2a323c; --accent:#4c9aff; --accent-ink:#0b1220; --ok:#3fb950; --warn:#d29922; --bad:#f85149; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.35rem; margin: 8px 0 2px; }
h2 { font-size: 1.05rem; margin: 0 0 10px; }
p { margin: 4px 0; }
.muted { color: var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.grow { flex:1 1 auto; }
.pill { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; font-size:.85rem; border:1px solid var(--line); }
.pill.ok { color:var(--ok); border-color:var(--ok); } .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.bad { color:var(--bad); border-color:var(--bad); }
button { font:inherit; padding:6px 12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
button.danger { color:var(--bad); border-color:var(--bad); }
button:disabled { opacity:.5; cursor:default; }
button:focus-visible, input:focus-visible, a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
input[type=number] { width:6.5em; } input[type=time] { width:7.5em; }
input { font:inherit; padding:4px 6px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--ink); }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.tag { font-size:.75rem; color:var(--muted); border:1px solid var(--line); border-radius:6px; padding:0 5px; margin-left:4px; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.stats { display:flex; flex-wrap:wrap; gap:6px 22px; margin-top:10px; }
.stats b { font-variant-numeric: tabular-nums; }
ul.finds { list-style:none; margin:0; padding:0; } ul.finds li { padding:6px 0; border-bottom:1px solid var(--line); }
#msg { min-height: 1.4em; }
@media (max-width: 760px) {
  table, thead, tbody, tr, td { display:block; width:100%; } thead { position:absolute; left:-9999px; }
  tr { border:1px solid var(--line); border-radius:8px; margin:8px 0; padding:6px 8px; }
  td { border:0; padding:3px 0; } td[data-l]::before { content: attr(data-l) ": "; color:var(--muted); }
}
`;

const PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  var STORE = 'cad-node-key';
  var key = null;
  var editing = false;
  var lastEdit = 0;
  var timer = null;
  var stopped = false;

  try {
    var m = /^#k=([A-Za-z0-9_-]{16,128})$/.exec(location.hash || '');
    if (m) { key = m[1]; try { sessionStorage.setItem(STORE, key); } catch (e) { /* private mode */ } }
    else { try { key = sessionStorage.getItem(STORE); } catch (e) { key = null; } }
    // The key is the only secret on this page: take it out of the address bar and history.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  } catch (e) { key = null; }

  function $(id) { return document.getElementById(id); }
  function node(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function say(text, bad) { var m = $('msg'); m.textContent = text || ''; m.className = bad ? 'bad' : 'muted'; }
  // The start script opens this page WITHOUT the key (it would sit in the browser's
  // command line, readable by other programs on the computer). The person pastes the
  // link printed in the terminal here instead; only its key part is used.
  function needKey(text) {
    key = null;
    try { sessionStorage.removeItem(STORE); } catch (e) { /* private mode */ }
    $('needkey').hidden = false;
    say(text, true);
  }
  function takeKey(text) {
    var typed = String(text || '').trim();
    var m = /(?:^|[#&?])k=([A-Za-z0-9_-]{16,128})$/.exec(typed) || /^([A-Za-z0-9_-]{16,128})$/.exec(typed);
    if (!m) { say('That is not the dashboard link. Copy the whole line that starts with http://127.0.0.1 from the terminal window.', true); return; }
    key = m[1];
    try { sessionStorage.setItem(STORE, key); } catch (e) { /* private mode */ }
    $('keyIn').value = '';
    $('needkey').hidden = true;
    say('');
    refresh();
  }
  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return 'never';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 0) { s = -s; return 'in ' + span(s); }
    return s < 5 ? 'just now' : span(s) + ' ago';
  }
  function span(s) {
    if (s < 90) return s + 's';
    if (s < 5400) return Math.round(s / 60) + ' min';
    if (s < 129600) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' d';
  }
  function safeHref(u) {
    try { var p = new URL(String(u)); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; }
    catch (e) { return null; }
  }
  function call(method, path, body) {
    var opts = { method: method, headers: { 'X-Node-Key': key || '' }, cache: 'no-store' };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, ok: r.ok, body: j }; },
        function () { return { status: r.status, ok: r.ok, body: {} }; });
    });
  }
  function failText(res) {
    if (res.status === 401) return 'This page lost its access key. Open the link printed in the terminal again.';
    var b = res.body || {};
    if (Array.isArray(b.errors) && b.errors.length) return b.errors.join('; ');
    return b.error ? String(b.error) : 'Request failed (' + res.status + ').';
  }

  function render(s) {
    var pill = $('pill');
    var state = s.paused ? ['Paused', 'warn'] : (s.current_job ? ['Working', 'ok'] : ['Running', 'ok']);
    pill.textContent = state[0]; pill.className = 'pill ' + state[1];
    $('sub').textContent = (s.mode === 'companion' ? 'Hosted: finds go to your CareerAutopilot account' : 'Self-hosted node')
      + ' · node ' + s.node + ' · ' + s.hub.host;
    $('pause').textContent = s.paused ? 'Resume' : 'Pause';
    $('pause').setAttribute('data-act', s.paused ? 'resume' : 'pause');
    // A pause set from the admin dashboard is not this page's to lift.
    var hubOnly = !!(s.paused_by && s.paused_by.hub && !s.paused_by.local);
    $('pause').disabled = hubOnly;
    $('pause').title = hubOnly ? 'Paused from the admin dashboard: resume it there' : '';
    var why = [];
    if (s.paused_by && s.paused_by.local) why.push('paused here');
    if (s.paused_by && s.paused_by.hub) why.push('paused from the admin dashboard');
    $('state').textContent = s.paused
      ? 'No new work starts while paused (' + why.join(', ') + '). A job already running finishes first.'
      : (s.current_job ? 'Running ' + s.current_job.name + ' since ' + ago(s.current_job.started_at) + '.' : 'Idle: waiting for the next scheduled job.');
    var hub = s.hub.connected === false ? 'cannot reach CareerAutopilot' : (s.hub.connected ? 'connected' : 'not contacted yet');
    var stats = clear($('stats'));
    [['Hub', hub + (s.hub.last_heartbeat_ok_at ? ' (' + ago(s.hub.last_heartbeat_ok_at) + ')' : '')],
     ['Waiting to check', s.queue.pending_local], ['Waiting to send', s.queue.to_ship],
     ['Sent', s.queue.shipped_total], ['Held back', s.queue.held_total], ['Dropped', s.queue.dropped_total]
    ].concat(s.queue.dropped_hosted ? [['Dropped, site not accepted by your account', s.queue.dropped_hosted]] : []).forEach(function (p) { var d = node('span'); d.appendChild(document.createTextNode(p[0] + ': ')); d.appendChild(node('b', p[1])); stats.appendChild(d); });
    if (s.limits) {
      // Accepted, not "used": the account also charges a little for each
      // posting it refuses, so the allowance can run out before N reaches M.
      var d = node('span'); d.appendChild(document.createTextNode('Accepted today: '));
      d.appendChild(node('b', s.limits.accepted_today + ' (daily allowance ' + s.limits.finds_per_day + ')')); stats.appendChild(d);
    }
    $('hubErr').textContent = s.hub.error ? 'Hub: ' + s.hub.error : '';
    if (s.hub_blocked) $('hubErr').textContent = 'The hub asked this node to stop calling (' + s.hub_blocked.reason + ') until ' + s.hub_blocked.until + '.';
    renderCriteria(s.criteria);
    renderFinds(s.recent_shipped);
    if (!editing) renderJobs(s);
  }

  function renderCriteria(c) {
    var box = clear($('criteria'));
    if (!c) { box.appendChild(node('p', 'No search criteria yet. They arrive from CareerAutopilot a few seconds after start.', 'muted')); return; }
    box.appendChild(node('p', 'Updated ' + ago(c.fetched_at) + '. ' + c.title_keywords + ' job-title keywords, '
      + c.target_roles + ' target roles; locations: ' + c.location.primary + ' home, ' + c.location.authorized + ' authorized, '
      + c.location.sponsor_required + ' needing sponsorship. Change these on the Targeting tab of your CareerAutopilot account.'));
  }

  function renderFinds(list) {
    var ul = clear($('finds'));
    if (!list || !list.length) { ul.appendChild(node('li', 'Nothing sent yet.', 'muted')); return; }
    list.forEach(function (f) {
      var li = node('li');
      var href = safeHref(f.url);
      var label = (f.title || 'Untitled') + (f.company ? ' — ' + f.company : '');
      if (href) { var a = node('a', label); a.href = href; a.rel = 'noopener noreferrer'; a.target = '_blank'; li.appendChild(a); }
      else li.appendChild(node('span', label));
      li.appendChild(node('span', ' ' + ago(f.at), 'muted'));
      ul.appendChild(li);
    });
  }

  var SRC = { config: 'config file', hub: 'admin dashboard', local: 'set here' };
  var KEYNAME = { enabled: 'on/off', every_minutes: 'interval', start_at: 'start time', max_minutes: 'time limit', ats: 'sources' };
  var LABEL = { tracked: 'Companies you track', boards: 'Job boards', aggregators: 'Remote job feeds', sources: 'New companies', resolve: 'Careers pages',
    local_employers: 'Local employers', seeds: 'Startup lists', ats_full: 'Full ATS sweep', validate: 'Checking results' };
  function renderJobs(s) {
    var body = clear($('jobs'));
    Object.keys(s.jobs).forEach(function (name) {
      var j = s.jobs[name];
      var tr = node('tr');
      var cell = function (label) { var td = node('td'); td.setAttribute('data-l', label); tr.appendChild(td); return td; };

      var label = LABEL[name] || name;
      var c1 = cell('Job'); c1.appendChild(node('strong', label));
      if (label !== name) c1.appendChild(node('span', name, 'tag'));
      if (s.current_job && s.current_job.name === name) c1.appendChild(node('span', 'running', 'tag'));

      var c2 = cell('On');
      var en = node('input'); en.type = 'checkbox'; en.checked = j.enabled; en.setAttribute('aria-label', label + ' enabled');
      c2.appendChild(en);

      var c3 = cell('Every (min)');
      var ev = node('input'); ev.type = 'number'; ev.min = '5'; ev.max = '10080'; ev.value = j.every_minutes === null ? '' : String(j.every_minutes);
      ev.setAttribute('aria-label', label + ' interval in minutes');
      c3.appendChild(ev);

      var c4 = cell('Start at');
      var st = null;
      if (j.can_start_at) {
        st = node('input'); st.type = 'time'; st.value = j.start_at || ''; st.setAttribute('aria-label', label + ' start time (empty for none)');
        c4.appendChild(st);
      } else c4.appendChild(node('span', 'interval only', 'muted'));

      var c5 = cell('Last run');
      c5.appendChild(node('div', j.last_run_at ? ago(j.last_run_at) + (j.last_ok === false ? ' (failed)' : '') : 'never'));
      if (j.last_summary) c5.appendChild(node('div', j.last_summary, 'muted'));
      c5.appendChild(node('div', 'next ' + (j.enabled ? (j.next_run_at ? ago(j.next_run_at) : 'when due') : 'disabled'), 'muted'));
      var from = Object.keys(j.source || {}).filter(function (k) { return j.source[k] !== 'config'; });
      if (from.length) c5.appendChild(node('div', from.map(function (k) { return (KEYNAME[k] || k) + ': ' + (SRC[j.source[k]] || j.source[k]); }).join(', '), 'muted'));

      var c6 = cell('Actions');
      var save = node('button', 'Save'); save.disabled = true;
      var run = node('button', 'Run now');
      var reset = node('button', 'Reset');
      reset.title = 'Forget what was set here and use the config file again';
      [save, run, reset].forEach(function (b) { b.type = 'button'; c6.appendChild(b); c6.appendChild(document.createTextNode(' ')); });

      var dirty = function () { editing = true; lastEdit = Date.now(); save.disabled = false; };
      en.addEventListener('change', dirty); ev.addEventListener('input', dirty);
      if (st) st.addEventListener('input', dirty);
      save.addEventListener('click', function () {
        // Only what was changed: a field left alone keeps following the config file.
        var patch = {};
        if (en.checked !== j.enabled) patch.enabled = en.checked;
        if (ev.value !== '' && Number(ev.value) !== j.every_minutes) patch.every_minutes = Number(ev.value);
        if (st && st.value !== (j.start_at || '')) patch.start_at = st.value;
        if (!Object.keys(patch).length) { editing = false; say('Nothing changed.'); return; }
        call('PUT', '/api/jobs/' + encodeURIComponent(name), patch).then(function (r) {
          if (r.ok) { editing = false; say('Saved ' + name + '.'); render(r.body.status); }
          else say(failText(r), true);
        });
      });
      reset.addEventListener('click', function () {
        call('PUT', '/api/jobs/' + encodeURIComponent(name), { reset: true }).then(function (r) {
          if (r.ok) { editing = false; say('Reset ' + name + ' to the config file.'); render(r.body.status); }
          else say(failText(r), true);
        });
      });
      run.addEventListener('click', function () {
        call('POST', '/api/jobs/' + encodeURIComponent(name) + '/run', {}).then(function (r) {
          say(r.ok ? 'Queued ' + name + '. It starts within a minute.' : failText(r), !r.ok);
        });
      });
      body.appendChild(tr);
    });
  }

  function refresh() {
    if (stopped) return;
    // An abandoned edit must not freeze the table for good.
    if (editing && Date.now() - lastEdit > 60000) editing = false;
    if (!key) { needKey('Paste the link printed in the terminal window: it carries this page’s access key.'); return; }
    call('GET', '/api/status').then(function (r) {
      if (r.ok) { $('needkey').hidden = true; say(''); render(r.body); }
      else if (r.status === 401) needKey('That access key was not accepted (the node may have been restarted). Paste the link printed in the terminal window.');
      else say(failText(r), true);
    }, function () { say('Cannot reach the node. It may have stopped.', true); });
  }

  function act(path, okText) {
    call('POST', path, {}).then(function (r) {
      if (r.ok) { say(okText); if (r.body.status) render(r.body.status); } else say(failText(r), true);
    });
  }

  $('keyGo').addEventListener('click', function () { takeKey($('keyIn').value); });
  $('keyIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') takeKey($('keyIn').value); });
  $('pause').addEventListener('click', function () { act('/api/' + $('pause').getAttribute('data-act'), 'Done.'); });
  $('stop').addEventListener('click', function () {
    if (!confirm('Stop the node? Nothing runs after this until you start it again from the terminal.')) return;
    call('POST', '/api/stop', {}).then(function (r) {
      if (r.ok) {
        stopped = true; clearInterval(timer);
        $('pill').textContent = 'Stopped'; $('pill').className = 'pill bad';
        $('state').textContent = 'The node has stopped. You can close this tab.';
        say('');
      } else say(failText(r), true);
    });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  refresh();
  timer = setInterval(function () { if (!document.hidden) refresh(); }, 5000);
})();
`;

const PAGE_BODY = `<main>
  <header>
    <h1>CareerAutopilot discovery node</h1>
    <p id="sub" class="muted">Loading…</p>
  </header>
  <section class="card" id="needkey" aria-labelledby="h-key" hidden>
    <h2 id="h-key">Paste your dashboard link</h2>
    <p>This page was opened without its access key on purpose: a key on a command line can be read by other programs on this computer. Copy the dashboard link printed in the terminal window the node started in (a long line that starts with <code>http://127.0.0.1</code> and contains <code>#k=</code>) and paste it here.</p>
    <div class="row">
      <label for="keyIn" class="sr">Dashboard link from the terminal</label>
      <input id="keyIn" class="grow" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8390/#k=…">
      <button id="keyGo" type="button" class="primary">Use this link</button>
    </div>
  </section>
  <section class="card" aria-labelledby="h-now">
    <h2 id="h-now">Status</h2>
    <div class="row">
      <span id="pill" class="pill" role="status" aria-live="polite">…</span>
      <span id="state" class="grow muted"></span>
      <button id="pause" type="button" class="primary">Pause</button>
      <button id="stop" type="button" class="danger">Stop node</button>
    </div>
    <p id="stats" class="stats"></p>
    <p id="hubErr" class="muted"></p>
    <p id="msg" class="muted" role="status" aria-live="polite"></p>
  </section>
  <section class="card" aria-labelledby="h-jobs">
    <h2 id="h-jobs">Jobs</h2>
    <p class="muted">Changes here apply to this node only and survive a restart. Reset returns a job to the config file. A start time repeats every interval from that time each day.</p>
    <table>
      <caption class="sr">Scheduled jobs</caption>
      <thead><tr><th scope="col">Job</th><th scope="col">On</th><th scope="col">Every (min)</th><th scope="col">Start at</th><th scope="col">Last run</th><th scope="col">Actions</th></tr></thead>
      <tbody id="jobs"></tbody>
    </table>
  </section>
  <section class="card" aria-labelledby="h-finds">
    <h2 id="h-finds">Recent finds sent to your account</h2>
    <ul id="finds" class="finds"></ul>
  </section>
  <section class="card" aria-labelledby="h-crit">
    <h2 id="h-crit">What it searches for</h2>
    <div id="criteria"></div>
  </section>
  <p class="muted">Nothing keeps running after you close the terminal window this node started in. To start it again, run the discovery-node launcher.</p>
</main>`;

/** `'sha256-<base64>'` of the inline script, for the CSP. */
export const PAGE_SCRIPT_HASH = `sha256-${createHash('sha256').update(PAGE_SCRIPT, 'utf8').digest('base64')}`;

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>CareerAutopilot discovery node</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${PAGE_BODY}
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;

export const PAGE_CSP = [
  "default-src 'none'",
  `script-src '${PAGE_SCRIPT_HASH}'`,
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// ── The server ───────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function sendJson(res, status, obj, extra = {}) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    ...BASE_HEADERS, ...extra,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Read a JSON object body, refusing anything that is not application/json, is
 * larger than the cap, or is not valid JSON. An empty body is `{}`.
 *
 * @returns {Promise<{ok: true, value: object} | {ok: false, status: number, error: string}>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return resolve({ ok: false, status: 415, error: 'content-type must be application/json' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > DASHBOARD_BODY_MAX_BYTES) {
      return resolve({ ok: false, status: 413, error: 'request body too large' });
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > DASHBOARD_BODY_MAX_BYTES) {
        finish({ ok: false, status: 413, error: 'request body too large' });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => finish({ ok: false, status: 400, error: 'could not read the request body' }));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      if (!text) return finish({ ok: true, value: {} });
      let value;
      try { value = JSON.parse(text); } catch { return finish({ ok: false, status: 400, error: 'body is not valid JSON' }); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return finish({ ok: false, status: 400, error: 'body must be a JSON object' });
      }
      return finish({ ok: true, value });
    });
  });
}

/**
 * Route table. Each entry: method, a matcher on the path, and the handler. Job
 * names are matched against NODE_JOB_NAMES, never used as lookup keys directly.
 */
function matchRoute(pathname) {
  if (pathname === '/api/status') return { allow: ['GET'], name: 'status' };
  if (pathname === '/api/pause') return { allow: ['POST'], name: 'pause' };
  if (pathname === '/api/resume') return { allow: ['POST'], name: 'resume' };
  if (pathname === '/api/stop') return { allow: ['POST'], name: 'stop' };
  let m = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (m) return { allow: ['PUT'], name: 'putJob', job: safeDecode(m[1]) };
  m = /^\/api\/jobs\/([^/]+)\/run$/.exec(pathname);
  if (m) return { allow: ['POST'], name: 'runJob', job: safeDecode(m[1]) };
  return null;
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return ''; } }

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start the dashboard.
 *
 * @param {object} opts
 * @param {string|undefined} [opts.host] - undefined = 127.0.0.1. Anything that is not exactly 127.0.0.1, ::1 or localhost (including '' and null) refuses to start.
 * @param {number} [opts.port] - preferred port (default 8390); a busy port falls through to the next 10, then an ephemeral one.
 * @param {string} [opts.key] - the per-run key. Test seam: the real caller omits it and gets 32 random bytes.
 * @param {object} opts.api - status(), pause(), resume(), stop(), putJob(name, body), runJob(name).
 * @param {(line: string) => void} [opts.log] - receives lines that mention the PORT, never the key.
 * @returns {Promise<{port: number, host: string, key: string, url: string, close: () => Promise<void>} | null>}
 *   null when it refused to start (the reason has been logged).
 */
export async function startDashboard({ host, port = DEFAULT_DASHBOARD_PORT, key, api, log = () => {} } = {}) {
  const wanted = host === undefined ? '127.0.0.1' : host;
  if (!isLoopbackHost(wanted)) {
    log('dashboard: not started — dashboard.host must be 127.0.0.1, ::1 or localhost (it is never exposed beyond this computer)');
    return null;
  }
  const bindHost = String(wanted).trim().toLowerCase() === 'localhost' ? '127.0.0.1' : String(wanted).trim().toLowerCase();
  const nodeKey = key || randomBytes(32).toString('base64url');
  let boundPort = 0;
  let hostsOk = new Set();
  let originsOk = new Set();

  const handle = async (req, res) => {
    if (!hostsOk.has(String(req.headers.host || '').toLowerCase())) {
      return sendJson(res, 403, { error: 'forbidden host' });
    }
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad request' }); }
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PAGE_CSP,
        'Content-Length': Buffer.byteLength(PAGE_HTML),
      });
      return res.end(req.method === 'HEAD' ? undefined : PAGE_HTML);
    }
    if (!pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    // An Origin header is sent by browsers on cross-origin requests and on any
    // POST/PUT; when present it must be us.
    if (req.headers.origin !== undefined && !originsOk.has(String(req.headers.origin).toLowerCase())) {
      return sendJson(res, 403, { error: 'forbidden origin' });
    }
    const given = req.headers['x-node-key'];
    if (typeof given !== 'string' || !safeEqual(given, nodeKey)) return sendJson(res, 401, { error: 'missing or wrong access key' });

    const route = matchRoute(pathname);
    if (!route) return sendJson(res, 404, { error: 'not found' });
    if (!route.allow.includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' }, { Allow: route.allow.join(', ') });

    if (route.job !== undefined && !NODE_JOB_NAMES.includes(route.job)) return sendJson(res, 404, { error: 'unknown job' });

    let body = {};
    if (req.method !== 'GET') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        // An oversized body is still arriving: close the connection once the 413 is out rather than drain it.
        if (parsed.status === 413) res.once('finish', () => req.socket?.destroy());
        return sendJson(res, parsed.status, { error: parsed.error }, parsed.status === 413 ? { Connection: 'close' } : {});
      }
      body = parsed.value;
    }

    switch (route.name) {
      case 'status':
        return sendJson(res, 200, await api.status());
      case 'pause':
        await api.pause();
        return sendJson(res, 200, { ok: true, status: await api.status() });
      case 'resume':
        await api.resume();
        return sendJson(res, 200, { ok: true, status: await api.status() });
      case 'putJob': {
        const r = await api.putJob(route.job, body);
        if (!r || r.ok !== true) return sendJson(res, 400, { error: 'invalid job settings', errors: r?.errors || [] });
        return sendJson(res, 200, { ok: true, status: await api.status() });
      }
      case 'runJob': {
        const r = await api.runJob(route.job);
        if (!r || r.ok !== true) return sendJson(res, 409, { error: r?.error || 'could not queue that job' });
        return sendJson(res, 200, { ok: true, status: await api.status() });
      }
      case 'stop':
        // Answer first, stop after the response has been flushed.
        res.once('finish', () => { setImmediate(() => { Promise.resolve(api.stop()).catch(() => {}); }); });
        return sendJson(res, 200, { ok: true });
      default:
        return sendJson(res, 404, { error: 'not found' });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // The message can carry request-derived text; log the shape, not the content.
      log(`dashboard: handler error (${err?.name || 'Error'})`);
      try { if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); else res.end(); } catch { /* socket gone */ }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (err, socket) => {
    void err;
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* already closed */ }
  });

  const candidates = port === 0 ? [0] : [...Array.from({ length: PORT_FALLBACK_SPAN + 1 }, (_, i) => port + i), 0];
  let listening = false;
  for (const candidate of candidates) {
    if (candidate > 65535) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await listen(server, bindHost, candidate);
      listening = true;
      break;
    } catch (err) {
      if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') {
        log(`dashboard: not started — ${err?.code || err?.message || 'listen failed'}`);
        return null;
      }
    }
  }
  if (!listening) { log('dashboard: not started — no free port'); return null; }

  const addr = server.address();
  if (!addr || typeof addr === 'string' || (addr.address !== '127.0.0.1' && addr.address !== '::1')) {
    log('dashboard: not started — the listener was not bound to loopback');
    await new Promise((resolve) => server.close(resolve));
    return null;
  }
  boundPort = addr.port;
  hostsOk = allowedHosts(boundPort);
  originsOk = new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`]);
  log(`dashboard: listening on port ${boundPort} (this computer only)`);

  const origin = addr.address === '::1' ? `http://[::1]:${boundPort}` : `http://127.0.0.1:${boundPort}`;
  return {
    port: boundPort,
    host: addr.address,
    key: nodeKey,
    url: `${origin}/#k=${nodeKey}`,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
