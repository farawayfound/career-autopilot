#!/usr/bin/env node
// autopilot/discovery-node.mjs — the discovery node CLI/daemon.
//
// Runs on an always-on, GPU-less machine (a small Windows or Linux box). It never
// calls a model (AGENTS.md "Hard constraints") — it scans more sources than
// the autopilot host does today, validates/pre-ranks them with pure logic
// (autopilot/lib/discovery-node.mjs), and pushes the winners into the
// autopilot's EXISTING pipeline over the authenticated
// POST /api/discovery/node/ingest route. Nothing here writes to the
// autopilot's data — the node's OWN checkout is its DATA_ROOT (see the header
// comments on every file this daemon renders under data/discovery-node/ and
// its own portals.yml/config/profile.yml/data/blacklist.md).
//
// Usage:
//   node autopilot/discovery-node.mjs --daemon
//   node autopilot/discovery-node.mjs --once <job>   (tracked|ats_full|seeds|boards|
//                                                      local_employers|aggregators|
//                                                      criteria|validate|ship|heartbeat)
//   node autopilot/discovery-node.mjs --status [--json]
//   node autopilot/discovery-node.mjs --dry-run --once <job>   (no pipeline writes, no ship)
//   node autopilot/discovery-node.mjs --help
//
// Two audiences, one daemon (hub.mode in config/discovery-node.yml):
//   node       a self-hosted box with a per-node token, run by --daemon
//              under a supervisor. Its hub can pause it and queue jobs, and its
//              /health listens wherever the config says.
//   companion  the public package, started BY HAND on an end user's own computer
//              by autopilot/discovery-node-start.mjs (which calls runDaemon()
//              below). It talks to the user's own hosted CareerAutopilot account
//              with their own token, ignores any control the hub sends, serves a
//              loopback-only dashboard, and installs nothing that outlives it.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { spawn } from 'child_process';
import * as yaml from 'js-yaml';
import { p, ROOT, readJsonSafe, writeJson, gitSha, loadCv } from './lib/util.mjs';
import { withPipelineLock } from '../lib/pipeline-lock.mjs';
import { normalizeCompany } from '../lib/tracker-utils.mjs';
import { canonicalLeadKey, canonicalUrlForRef } from './lib/lead-keys.mjs';
import { checkHostedUrl } from './lib/hosted-url-policy.mjs';
import { parseAtsUrl, fetchJobDetail } from './lib/jd.mjs';
import { checkLivenessViaApi } from '../lib/liveness-api.mjs';
import { hostThrottle } from './lib/host-throttle.mjs';
import { runAggregators } from './lib/aggregators.mjs';
import { runSources, summarizeSources } from './lib/discovery-sources.mjs';
import { readFrontier, writeFrontier, dueCandidates, recordResolution, resolvedEntries, frontierStats } from './lib/discovery-frontier.mjs';
import { parseLocationPolicy } from './lib/discovery-preferences.mjs';
import { configStaleness } from '../lib/config-staleness.mjs';
import { NODE_JOB_NAMES, SLOT_JOB_NAMES, patchControl, sanitizeControl, effectiveJobs, isPaused } from './lib/discovery-node-control.mjs';
import { startDashboard, isLoopbackHost } from './lib/discovery-node-dashboard.mjs';
import { lastSlotAtOrBefore, normalizeHHMM } from '../lib/slot-schedule.mjs';
import { parseScanOutput, summarizeScan } from './lib/discovery.mjs';
import { validateFlags, flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import {
  loadNodeConfig, MissingNodeConfigError, parsePipelineRows, scoreFind, decideFind, SCANNER_JOB_ORDER,
  planNextJob, buildScannerCommand, renderPortalsYml,
  renderBoardsPortalsYml, renderProfileYml, foldIngestResponse, markPipelineRow,
  buildHeartbeatStatus, pruneState, hubFetch, archetypeRoleNames,
  hubMode, NODE_NAME_RE, slotSpec, detectUserLayer, userLayerRefusalMessage, checkHubUrl, resolveCvSkills, sanitizeCriteriaPortals,
  applyHubControl, enqueueRunNow, takeRunNow, normalizeNodeState, foldLimits,
  hubBlockReason, hubErrorCode, rateLimitUntil, HUB_BLOCK_MS, shipBatchSize, SHIP_BATCH_FLOOR, atsCheckpointResumable,
  acquireInstanceLock, instanceRefusalMessage,
} from './lib/discovery-node.mjs';

const STARTED_AT = new Date();
const VERSION = gitSha();

// ── Paths (all under the node's own checkout — its own DATA_ROOT) ───────
const paths = {
  pipeline: p('data', 'pipeline.md'),
  portalsYml: p('portals.yml'),
  profileYml: p('config', 'profile.yml'),
  blacklistMd: p('data', 'blacklist.md'),
  boardsPortalsYml: p('data', 'discovery-node', 'portals-boards.yml'),
  state: p('data', 'discovery-node', 'state.json'),
  localEmployersCache: p('data', 'discovery-node', 'local-employers.json'),
  localEmployersInput: p('data', 'discovery-node', 'local-employers-input.yml'),
  nodeConfig: p('config', 'discovery-node.yml'),
  // Job overrides made on the node's own dashboard. The local Pause is NOT in
  // here: it lasts as long as the process does.
  localControl: p('data', 'discovery-node', 'local-control.json'),
  frontier: p('data', 'discovery-node', 'frontier.json'),
  discoveredCache: p('data', 'discovery-node', 'discovered.json'),
  resolveInput: p('data', 'discovery-node', 'resolve-input.yml'),
  atsCheckpoint: p('data', 'cache', 'ats-full-checkpoint.json'),
  logsDir: p('data', 'discovery-node', 'logs'),
  // One node per checkout: held by the process that runs the scheduler (runDaemon).
  daemonLock: p('data', 'discovery-node', 'daemon.lock'),
  daemonLog: p('data', 'discovery-node', 'logs', 'daemon.log'),
};

// ── State ─────────────────────────────────────────────────────────────
const STATE_VERSION = 1;
function loadState() {
  const s = readJsonSafe(paths.state, null);
  if (s && typeof s === 'object' && s.version === STATE_VERSION) return normalizeNodeState(s);
  return normalizeNodeState({
    version: STATE_VERSION,
    started_at: STARTED_AT.toISOString(),
    jobs: {},
    shipped: {},
    held: {},
    dropped: {},
    to_ship: [],
    criteria_hash: null,
    last_criteria_at: null,
    last_error: null,
    // What /health's `hub:` block and an external status probe's "hub:up|DOWN" column
    // read. Written by runHeartbeat() (the one call that runs on a fixed
    // cadence whether or not there is anything to ship) and by a failed ship.
    hub_reachable: null,
    last_heartbeat_ok_at: null,
    last_hub_error: null,
    counters: {},
  });
}
let state = loadState();
function saveState() {
  pruneState(state);
  writeJson(paths.state, state);
}
// A validate pass checks each row off in pipeline.md as it decides, but state.json
// used to be written only when the pass ended, so a kill part-way left rows marked
// done with no record that they were ever queued to ship — and nothing reads a
// checked-off row again. Saving soon after each decision (once per interval, not
// once per row) bounds that loss to a moment instead of a pass.
let saveStateTimer = null;
function saveStateSoon() {
  if (saveStateTimer) return;
  saveStateTimer = setTimeout(() => { saveStateTimer = null; saveState(); }, 1_500);
  saveStateTimer.unref?.();
}

// Criteria stays in memory, never in state.json (whose documented shape is
// only criteria_hash/last_criteria_at) — it's re-fetched at daemon start and
// on refresh, and is comfortably small (a portals.yml + a reduced profile).
let liveCriteria = null;
// The hub's portals_yml is shipped as raw TEXT (§3.2) — parsed once per
// refresh (not once per validate tick) so scoreFind's ctx.criteria.titleFilter
// and trackedCompanies stay cheap to build on every pass.
let parsedPortals = {};

// ── Logging (never the hub token — see discovery-node.mjs's own header) ──
function daemonLog(line) {
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    // Rotate at 5MB, keeping one prior generation — a long-running daemon's
    // log must not grow unbounded on a box nobody logs into for weeks.
    try {
      if (statSync(paths.daemonLog).size > 5 * 1024 * 1024) {
        renameSync(paths.daemonLog, `${paths.daemonLog}.1`);
      }
    } catch { /* no log yet */ }
    appendFileSync(paths.daemonLog, `${new Date().toISOString()} ${line}\n`, 'utf-8');
  } catch { /* logging must never crash the daemon */ }
}
// Console output mirrors the log line, same convention as util.mjs's own
// logEvent() — this daemon's log line NEVER includes cfg.hub.token; callers
// pass only cfg.hub.url when they need to say which hub they talked to.
function logInfo(msg) { console.log(`[discovery-node] ${msg}`); daemonLog(msg); }
function logWarn(msg) { console.warn(`[discovery-node] ${msg}`); daemonLog(`WARN ${msg}`); }

function writeIfChanged(path, text) {
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  if (current === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
  return true;
}

// ── Config ────────────────────────────────────────────────────────────
function requireConfig() {
  try {
    return loadNodeConfig();
  } catch (err) {
    if (err instanceof MissingNodeConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

// ── Hub routes ────────────────────────────────────────────────────────
//
// The two audiences reach the same four operations on different paths. They are
// written out as literals (not built from a prefix) so that a search for a route
// finds its caller, and so tests/discovery-node.test.mjs can pin them.
const NODE_ROUTES = {
  criteria: '/api/discovery/node/criteria',
  seen: '/api/discovery/node/seen',
  ingest: '/api/discovery/node/ingest',
  heartbeat: '/api/discovery/node/heartbeat',
};
const COMPANION_ROUTES = {
  criteria: '/api/companion/discovery/criteria',
  seen: '/api/companion/discovery/seen',
  ingest: '/api/companion/discovery/ingest',
  heartbeat: '/api/companion/discovery/heartbeat',
};

/** Thrown by runDaemon() when it will not start; the caller prints the message and exits 2. */
export class DaemonRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'DaemonRefusal';
    this.exitCode = 2;
  }
}

// ── Runtime control ───────────────────────────────────────────────────
//
// The config file on disk is the BASE. Two layers sit on top of it, later wins:
//   hub    the admin dashboard's control for this node (self-hosted "node" mode
//          only; persisted in state.json so a restart applies it before the first
//          heartbeat)
//   local  what the person at this machine set on the local dashboard
//          (data/discovery-node/local-control.json)
// plus the local Pause button, which is session-only and lives in memory.
//
// `cfg.jobs` is rewritten IN PLACE from those layers (same object identity), so
// everything that holds `cfg` — the tick, the scanner dispatch — sees a change on
// its next read, and removing an override reverts to the file's value.
let companionMode = false;
let baseJobs = {};
let localControl = { jobs: {} };
let sessionPaused = false;
let effectiveSources = {};

function controlLayers() {
  return [
    // The hosted mode ignores the hub's control entirely: the user's own
    // computer takes orders from the user, not from a server.
    ...(companionMode ? [] : [{ name: 'hub', control: state.hub_control }]),
    { name: 'local', control: localControl },
  ];
}

function recomputeEffective(cfg) {
  const eff = effectiveJobs(baseJobs, controlLayers());
  for (const key of Object.keys(cfg.jobs)) delete cfg.jobs[key];
  Object.assign(cfg.jobs, eff.jobs);
  effectiveSources = eff.sources;
}

function initControl(cfg) {
  companionMode = hubMode(cfg) === 'companion';
  cfg.jobs ??= {};
  baseJobs = structuredClone(cfg.jobs);
  const stored = sanitizeControl(readJsonSafe(paths.localControl, null)).value;
  delete stored.paused; // a pause never outlives the process that was paused
  localControl = stored;
  recomputeEffective(cfg);
}

/** Paused by the local button, or by a pause in a control layer that applies. */
const isNodePaused = () => sessionPaused || isPaused(controlLayers());
/** Paused by something on THIS machine — what outranks a remote request. */
const isLocallyPaused = () => sessionPaused || isPaused([{ name: 'local', control: localControl }]);

// ── Calling the hub ────────────────────────────────────────────────────
//
// Every hub call goes through here so the rules for what a refusal MEANS live in
// one place:
//   - A 403 that says the account is stopped, discovery is off for it, access
//     lapsed or the token is the wrong kind blocks ALL hub calls for an hour
//     (persisted: a restart must not turn it back into a request a minute).
//   - A 429 blocks that ROUTE until its Retry-After (or the next local midnight).
//     It is a statement about the hub's allowance, never about the finds.
// A blocked call returns `{blocked: true}` without touching the network, and the
// callers treat that as "nothing to do", not as an error to log every tick.
const routeNotBefore = {};

function hubBlockedUntil() {
  const until = Date.parse(state.hub_block?.until || '');
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}

async function callHub(hub, route, opts = {}) {
  const now = Date.now();
  if (hubBlockedUntil()) return { ok: false, status: 0, json: null, retryAfter: null, blocked: true };
  if ((routeNotBefore[route] || 0) > now) return { ok: false, status: 429, json: null, retryAfter: null, blocked: true };
  const res = await hubFetch(hub, (companionMode ? COMPANION_ROUTES : NODE_ROUTES)[route], opts);
  const reason = hubBlockReason(res);
  if (reason) {
    const fresh = state.hub_block?.reason !== reason || !hubBlockedUntil();
    state.hub_block = { reason, until: new Date(now + HUB_BLOCK_MS).toISOString() };
    if (fresh) logWarn(`hub refused this node (${reason}) — not calling it again for an hour. ${HUB_BLOCK_HELP[reason] || ''}`.trim());
    saveState();
  } else if (res.status === 429) {
    const until = rateLimitUntil(res, now);
    if (!(routeNotBefore[route] > now)) logWarn(`hub rate limit on ${route} — backing off until ${new Date(until).toLocaleTimeString()}`);
    routeNotBefore[route] = until;
  }
  return res;
}

const HUB_BLOCK_HELP = {
  stopped_by_administrator: 'An administrator stopped this account.',
  discovery_node_disabled: 'Discovery is switched off for this account.',
  pipeline_disabled: 'The administrator turned off this account\'s pipeline.',
  careerops_access_required: 'This account does not have CareerAutopilot access.',
  token_scope: 'This token cannot be used for discovery: create a discovery token on the Targeting tab and run discovery-node --reconfigure.',
  use_node_mode: 'This is an administrator token: run the node in its self-hosted "node" mode, not the hosted one.',
};

// ── Scan-history source lookup (best-effort, for the ingest `source` field) ─
// data/scan-history.tsv's `portal` column is exactly what each scanner
// recorded as the origin of a hit — the ingest wire contract's `source` field
// exists for the same purpose on the hub side (per-source ledger counts), so
// reusing it here (rather than guessing from which job most recently ran) is
// both simpler and more accurate.
function loadScanHistorySources() {
  const map = new Map();
  const histPath = p('data', 'scan-history.tsv');
  if (!existsSync(histPath)) return map;
  const lines = readFileSync(histPath, 'utf-8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i];
    if (!line) continue;
    const cells = line.split('\t');
    const url = cells[0];
    const portal = cells[2];
    if (url && portal && !map.has(url)) map.set(url, portal);
  }
  return map;
}
const SOURCE_RE = /^[a-z0-9][a-z0-9:_.-]{0,39}$/;
function sanitizeSource(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9:_.-]/g, '').slice(0, 40);
  return SOURCE_RE.test(s) ? s : 'unknown';
}

// ── Child process runner (scanner jobs) ──────────────────────────────────
//
// cwd is ALWAYS the repo root (this checkout's own root, ROOT from util.mjs),
// never the daemon's own cwd at invocation time. scripts/scan/scan-ats-full.mjs
// resolves its pipeline/history/checkpoint paths relative to process.cwd()
// (CWD-relative, not DATA_ROOT-relative like scripts/scan/scan.mjs), so a
// mismatched cwd would write those files somewhere the rest of this daemon
// never looks — one of the two path conventions AGENTS.md's Agent B section
// calls out explicitly.
//
// The live child is tracked at module scope (not just inside the promise
// closure) so SIGINT/SIGTERM shutdown can kill it — §4.6 requires the daemon
// to kill a running child on shutdown, and a handle a caller never sees
// cannot be killed by that caller.
let liveChild = null;
function runChild(jobName, { file, args, env }, { maxMinutes = 60 } = {}) {
  return new Promise((resolve) => {
    // paths.logsDir is already absolute, so join(), never p(): p() roots its
    // arguments under ROOT again, and `ROOT/C:\…\logs\tracked.log` is not a
    // valid path on Windows (nor an existing directory on POSIX) — the first
    // deployed build swallowed that error and never wrote a per-job log.
    const logPath = join(paths.logsDir, `${jobName}.log`);
    let out = '';
    let err = '';
    const startedAt = Date.now();
    let child;
    try {
      mkdirSync(paths.logsDir, { recursive: true });
      child = spawn(process.execPath, [p(file), ...args], { cwd: ROOT, env });
      liveChild = child;
    } catch (spawnErr) {
      resolve({ ok: false, ms: 0, error: String(spawnErr.message || spawnErr), stdout: '', stderr: '' });
      return;
    }
    const killer = setTimeout(() => {
      logWarn(`${jobName}: killed after ${maxMinutes}m (still running)`);
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
    }, maxMinutes * 60_000);
    killer.unref?.();
    child.stdout?.on('data', (c) => { out += c; });
    child.stderr?.on('data', (c) => { err += c; });
    child.once('error', (spawnErr) => {
      clearTimeout(killer);
      if (liveChild === child) liveChild = null;
      resolve({ ok: false, ms: Date.now() - startedAt, error: String(spawnErr.message || spawnErr), stdout: out, stderr: err });
    });
    child.once('close', (code) => {
      clearTimeout(killer);
      if (liveChild === child) liveChild = null;
      try { writeFileSync(logPath, `${out}\n--- stderr ---\n${err}\n`, 'utf-8'); } catch { /* best effort */ }
      resolve({ ok: code === 0, ms: Date.now() - startedAt, code, stdout: out, stderr: err });
    });
  });
}

function recordJobResult(jobName, result, summary) {
  state.jobs[jobName] ??= { runs: 0, errors: 0 };
  const rec = state.jobs[jobName];
  rec.last_run_at = new Date().toISOString();
  rec.last_ok = Boolean(result.ok);
  rec.last_ms = result.ms ?? null;
  rec.last_summary = summary ? String(summary).slice(0, 200) : (result.error || null);
  rec.runs = (rec.runs || 0) + 1;
  if (!result.ok) {
    rec.errors = (rec.errors || 0) + 1;
    rec.last_error = String(result.error || `exit code ${result.code}`).slice(0, 300);
  }
  // One line per finished job in daemon.log. The first deployed build kept
  // results in state.json only, so a six-minute tracked scan and a 150-row
  // validate pass left no trace in the log at all.
  const secs = Number.isFinite(result.ms) ? (result.ms / 1000).toFixed(result.ms >= 10_000 ? 0 : 1) : '?';
  if (result.ok) logInfo(`${jobName}: ok in ${secs}s — ${rec.last_summary || 'done'}`);
  else logWarn(`${jobName}: failed in ${secs}s — ${rec.last_error}`);
  saveState();
}

async function runScannerJob(jobName, cfg, dryRun) {
  const jobCfg = cfg.jobs?.[jobName] || {};
  const built = buildScannerCommand(jobName, jobCfg, {
    boardsPortals: paths.boardsPortalsYml,
    localEmployersInput: paths.localEmployersInput,
    resolveInput: paths.resolveInput,
    // Resumable, not merely present: a sweep saved under another undated policy
    // is refused by the scanner (exit 1) on every run until the file is deleted.
    atsCheckpointExists: atsCheckpointResumable(readJsonSafe(paths.atsCheckpoint, null), jobCfg),
  });
  if (!built) { logWarn(`${jobName}: no scanner command (not a child-process job)`); return; }
  if (dryRun) { logInfo(`${jobName}: dry-run, not spawning`); return; }
  if (jobName === 'resolve') {
    // The resolver is a pure CLI over a company list — same --in contract as
    // discover-ats.mjs. The frontier decides WHICH candidates it sees, so a
    // batch is bounded and a candidate that failed recently is not re-probed
    // until its backoff has elapsed.
    const batch = dueCandidates(readFrontier(paths.frontier), { limit: Number(jobCfg.max_per_run) || 25 });
    if (!batch.length) {
      logInfo('resolve: nothing due in the frontier');
      recordJobResult(jobName, { ok: true, ms: 0 }, 'nothing due');
      return;
    }
    mkdirSync(dirname(paths.resolveInput), { recursive: true });
    const lines = batch.map((c) => {
      const row = [`  - name: ${JSON.stringify(c.name)}`];
      // A website is what unlocks the site-fingerprint path; without one the
      // resolver falls through to discover-ats.mjs's slug probing, which is
      // still worth doing and is how a funding-feed name gets resolved at all.
      if (c.website) row.push(`    website: ${JSON.stringify(c.website)}`);
      return row.join('\n');
    });
    writeFileSync(paths.resolveInput, `companies:\n${lines.join('\n')}\n`, 'utf-8');
  }
  if (jobName === 'local_employers') {
    const names = (Array.isArray(cfg.local_employers) ? cfg.local_employers : [])
      .filter((n) => typeof n === 'string' && n.trim());
    mkdirSync(dirname(paths.localEmployersInput), { recursive: true });
    writeFileSync(paths.localEmployersInput, `companies:\n${names.map((n) => `  - name: ${JSON.stringify(n)}`).join('\n')}\n`, 'utf-8');
  }
  const result = await runChild(jobName, built, { maxMinutes: jobCfg.max_minutes || 60 });
  if (jobName === 'resolve' && result.ok) {
    // Same discipline as local_employers below: malformed-but-non-throwing
    // child stdout must never crash the tick, only warn and fall through to
    // the generic exit-code summary.
    try {
      const out = JSON.parse(result.stdout);
      const frontier = readFrontier(paths.frontier);
      let resolved = 0;
      let dead = 0;
      let unresolved = 0;
      for (const entry of Array.isArray(out.resolved) ? out.resolved : []) {
        if (!entry || typeof entry.name !== 'string' || !entry.careers_url) continue;
        const key = normalizeCompany(entry.name);
        if (recordResolution(frontier, key, { status: 'resolved', entry }, {})) resolved += 1;
      }
      for (const entry of Array.isArray(out.unresolved) ? out.unresolved : []) {
        if (!entry || typeof entry.name !== 'string') continue;
        const key = normalizeCompany(entry.name);
        // `definitive` means the vendor answered 404/410 — proof of absence,
        // not a bad day for one request (discover-ats.mjs's isDefinitiveAbsence,
        // and the #2883 comment above it). Everything else gets a backoff and
        // another go.
        const status = entry.definitive ? 'dead' : 'unresolved';
        if (recordResolution(frontier, key, { status, reason: entry.reason || null, website: entry.website }, {})) {
          if (status === 'dead') dead += 1; else unresolved += 1;
        }
      }
      writeFrontier(paths.frontier, frontier);
      await renderAndWritePortals(cfg);
      const stats = frontierStats(frontier);
      recordJobResult(jobName, result, `${resolved} resolved, ${unresolved} retrying, ${dead} dead — frontier ${stats.total} (${stats.resolved} resolved, ${stats.due} due)`);
      return;
    } catch (err) {
      logWarn(`resolve: could not fold resolve-careers.mjs output: ${String(err.message || err)}`);
    }
  }
  if (jobName === 'local_employers' && result.ok) {
    try {
      const out = JSON.parse(result.stdout);
      const resolved = (Array.isArray(out.resolved) ? out.resolved : [])
        .filter((e) => e && typeof e.name === 'string' && e.careers_url)
        .map((e) => ({ name: e.name, careers_url: e.careers_url, api: e.api, provider: e.provider, enabled: true }));
      writeJson(paths.localEmployersCache, { version: 1, resolved_at: new Date().toISOString(), entries: resolved });
      await renderAndWritePortals(cfg);
      recordJobResult(jobName, result, `${resolved.length} local employers resolved`);
      return;
    } catch (err) {
      logWarn(`local_employers: could not parse discover-ats.mjs output: ${String(err.message || err)}`);
    }
  }
  const summary = jobName === 'boards' || jobName === 'tracked'
    ? summarizeScan(parseScanOutput(result.stdout, result.stderr))
    : `exit ${result.code ?? 'n/a'}`;
  recordJobResult(jobName, result, summary);
}

// ── Aggregators (in-process — never a child) ─────────────────────────────
async function runAggregatorsJob(cfg) {
  if (!existsSync(paths.portalsYml)) {
    logInfo('aggregators: skipped — portals.yml not rendered yet');
    return;
  }
  const aggCfg = cfg.jobs?.aggregators || {};
  const criteriaAgg = liveCriteria?.aggregators || {};
  const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const started = Date.now();
  try {
    const result = await runAggregators({
      aggregators: {
        ...criteriaAgg,
        remotive_searches: union(criteriaAgg.remotive_searches, aggCfg.extra_remotive_searches),
        wwr_feeds: union(criteriaAgg.wwr_feeds, aggCfg.extra_wwr_feeds),
      },
    });
    recordJobResult('aggregators', { ok: true, ms: Date.now() - started }, `${result.added ?? 0} new`);
  } catch (err) {
    recordJobResult('aggregators', { ok: false, ms: Date.now() - started, error: String(err.message || err) });
  }
}

// ── Sources (in-process — the frontier's only writer of new names) ───────
//
// Deliberately in-process rather than a spawned child, for the same reason
// `aggregators` is: it makes a handful of bounded HTTP calls and folds the
// result into one small JSON file. It shares the one scanner slot, so it must
// stay bounded — the frontier batch caps exist for that.
async function runSourcesJob(cfg, dryRun = false) {
  const jobCfg = cfg.jobs?.sources || {};
  const started = Date.now();
  try {
    // `pipeline` costs no network at all: it re-reads names this node has
    // already seen go past and keeps the ones with no tracked board.
    let pipelineRows = [];
    try {
      pipelineRows = existsSync(paths.pipeline) ? parsePipelineRows(readFileSync(paths.pipeline, 'utf-8')) : [];
    } catch { pipelineRows = []; }
    const tracked = Array.isArray(parsedPortals?.tracked_companies) ? parsedPortals.tracked_companies : [];
    const trackedKeys = new Set(tracked.map((e) => normalizeCompany(e?.name || '')).filter(Boolean));

    const result = await runSources({
      frontierPath: paths.frontier,
      sources: Array.isArray(jobCfg.sources) && jobCfg.sources.length ? jobCfg.sources : null,
      months: Number(jobCfg.funding_months) || 3,
      limit: Number(jobCfg.max_per_run) || 40,
      pipelineRows,
      trackedKeys,
      keyFn: normalizeCompany,
      dryRun,
    });
    // A dry run persists NOTHING, state.jobs included — matching every other
    // dry-run path here (see runValidate's own comment on why).
    if (dryRun) { logInfo(`sources: dry-run — ${summarizeSources(result)}`); return; }
    recordJobResult('sources', { ok: true, ms: Date.now() - started }, summarizeSources(result));
  } catch (err) {
    if (dryRun) { logWarn(`sources: dry-run failed — ${String(err.message || err)}`); return; }
    recordJobResult('sources', { ok: false, ms: Date.now() - started, error: String(err.message || err) });
  }
}

// ── Criteria ──────────────────────────────────────────────────────────
async function renderAndWritePortals(cfg) {
  if (!liveCriteria) return;
  const cache = readJsonSafe(paths.localEmployersCache, null);
  const resolvedEmployers = Array.isArray(cache?.entries) ? cache.entries : [];
  // Everything the `resolve` job has confirmed, from the frontier itself —
  // companies go to tracked_companies, bespoke careers pages to job_boards.
  let discoveredCompanies = [];
  let discoveredBoards = [];
  try {
    const entries = resolvedEntries(readFrontier(paths.frontier));
    for (const entry of entries) {
      if (entry.provider === 'generic-careers') discoveredBoards.push(entry);
      else discoveredCompanies.push(entry);
    }
  } catch (err) {
    // A broken ledger costs the discovered half of the render, never the whole
    // render — the hub's own companies and this node's own boards still land.
    logWarn(`frontier unreadable while rendering portals.yml: ${String(err.message || err)}`);
    discoveredCompanies = [];
    discoveredBoards = [];
  }
  writeIfChanged(paths.portalsYml, renderPortalsYml(
    liveCriteria.portals_yml,
    cfg.boards,
    [...resolvedEmployers, ...discoveredCompanies],
    discoveredBoards,
  ));
  writeIfChanged(paths.boardsPortalsYml, renderBoardsPortalsYml(liveCriteria.portals_yml, cfg.boards, discoveredBoards));
  writeIfChanged(paths.profileYml, renderProfileYml(liveCriteria.profile));
  if (liveCriteria.blacklist_md) {
    writeIfChanged(paths.blacklistMd, liveCriteria.blacklist_md);
  } else if (existsSync(paths.blacklistMd)) {
    try { unlinkSync(paths.blacklistMd); } catch { /* best effort */ }
  }
}

// criteriaBackoffMs is the wait that applies to the NEXT retry (1 min -> caps at 30
// min, per §4.3); criteriaFailing says the last attempt failed. The scheduler needs
// the flag because a node that already holds a criteria set is otherwise only
// "due" on the refresh clock, and that clock (last_criteria_at) advances on success
// alone, so a hub that starts answering 5xx / 409 would be retried on every tick.
let criteriaBackoffMs = 60_000;
let criteriaFailing = false;
async function refreshCriteria(cfg) {
  const started = Date.now();
  try {
    const res = await callHub(cfg.hub, 'criteria');
    // Blocked: the hub already said stop (or rate-limited this route) and callHub
    // logged it once. Nothing happened, so there is nothing to record.
    if (res.blocked) return;
    if (!res.ok || !res.json?.ok) {
      // The hosted hub has no criteria for an account whose Profile tab is
      // unfinished. That is the user's next step, not a network fault.
      if (res.status === 409 && hubErrorCode(res.json) === 'profile_incomplete') {
        throw new Error('your CareerAutopilot profile is incomplete: finish the Profile tab and this node will start working');
      }
      throw new Error(`HTTP ${res.status}`);
    }
    liveCriteria = res.json;
    if (companionMode) {
      // The hosted hub is a server this machine does not control, and its criteria
      // say what to FETCH here. Only public https addresses survive, and only as
      // plain name/address entries.
      const clean = sanitizeCriteriaPortals(liveCriteria.portals_yml);
      liveCriteria.portals_yml = clean.text;
      if (clean.dropped) logWarn(`criteria: ignored ${clean.dropped} source(s) that are not a public https address or a plain name`);
    }
    foldLimits(state, liveCriteria);
    try { parsedPortals = liveCriteria.portals_yml ? (yaml.load(liveCriteria.portals_yml) || {}) : {}; }
    catch { parsedPortals = {}; }
    state.criteria_hash = liveCriteria.criteria_hash;
    state.last_criteria_at = new Date().toISOString();
    await renderAndWritePortals(cfg);
    criteriaBackoffMs = 60_000;
    criteriaFailing = false;
    recordJobResult('criteria', { ok: true, ms: Date.now() - started }, 'criteria refreshed');
  } catch (err) {
    recordJobResult('criteria', { ok: false, ms: Date.now() - started, error: String(err.message || err) });
    // The first failure waits a minute, each further one doubles. The line names
    // the wait the scheduler will really apply.
    criteriaBackoffMs = criteriaFailing ? Math.min(criteriaBackoffMs * 2, 30 * 60_000) : 60_000;
    criteriaFailing = true;
    logWarn(`criteria refresh failed (${String(err.message || err)}); retrying in ${Math.round(criteriaBackoffMs / 1000)}s`);
  }
}

// ── Validate ──────────────────────────────────────────────────────────
async function checkOneLiveness(url, validateCfg) {
  let host;
  try { host = new URL(url).hostname; } catch { host = url; }
  await hostThrottle(host, { baseMs: validateCfg.host_gap_ms || 3000 });
  let verdict = null;
  try { verdict = await checkLivenessViaApi(url); } catch { verdict = null; }
  if (verdict && verdict.result !== 'uncertain') return { liveness: verdict.result, jdText: null };
  if (!validateCfg.fetch_jd) return { liveness: verdict?.result || 'uncertain', jdText: null };
  try {
    const jd = await fetchJobDetail(url);
    if (jd?.live === false) return { liveness: 'expired', jdText: null };
    if (jd?.text) return { liveness: 'active', jdText: jd.text };
    return { liveness: 'uncertain', jdText: null }; // unsupported / no text
  } catch {
    return { liveness: 'uncertain', jdText: null }; // NEVER a drop — a fetch failure is a bad day, not a verdict
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, lane));
  return out;
}

// Every invocation records a 'validate' job result — including the early
// returns — because the tick's every_minutes gate reads
// state.jobs.validate.last_run_at, and an idle daemon (no pending rows, the
// normal steady state between scans) would otherwise re-read and re-parse
// pipeline.md on every 30 s tick forever. Same rule runScannerJob and
// refreshCriteria already follow. A dry run records nothing.
async function runValidate(cfg, dryRun) {
  const started = Date.now();
  try {
    const summary = await validatePass(cfg, dryRun);
    if (!dryRun) recordJobResult('validate', { ok: true, ms: Date.now() - started }, summary);
  } catch (err) {
    if (!dryRun) recordJobResult('validate', { ok: false, ms: Date.now() - started, error: String(err.message || err) });
    throw err;
  }
}

async function validatePass(cfg, dryRun) {
  if (!liveCriteria) { if (dryRun) logInfo('validate: skipped — no criteria yet'); return 'skipped: no criteria yet'; }
  if (!existsSync(paths.pipeline)) return 'no pipeline file yet';
  const validateCfg = cfg.jobs?.validate || {};
  const text = readFileSync(paths.pipeline, 'utf-8');
  // Every unchecked row, NOT capped yet. max_per_run rations the expensive
  // step (liveness + JD fetch + scoring) and is applied further down, only
  // after the hub's seen-check has removed what it already knows. The first
  // deployed build capped here, so the 2,950-row backlog of the first tracked
  // scan — 98% of it already in the hub's scan-history — drained 150 rows a
  // pass: three hours of passes to learn the hub knew nearly all of it.
  const rows = parsePipelineRows(text);
  if (!rows.length) return 'nothing pending';

  const decidedKeys = new Set([
    ...Object.keys(state.shipped || {}), ...Object.keys(state.held || {}), ...Object.keys(state.dropped || {}),
  ]);
  const canonOf = (row) => {
    let ref = null;
    try { ref = parseAtsUrl(row.url); } catch { ref = null; }
    return canonicalLeadKey(canonicalUrlForRef(ref) || row.url);
  };
  let pending = rows.filter((row) => !decidedKeys.has(canonOf(row)));
  if (!pending.length) return 'all pending rows already decided';
  let knownCount = 0;

  // Hosted: the server accepts only an ATS posting or a public listing page
  // (hosted-url-policy.mjs, the same module it applies). Some boards emit
  // neither: Hacker News job posts link to the poster's own careers site. Such a
  // find would be refused, and a refusal still spends a quarter of the day's
  // allowance, so it is dropped here, ahead of the seen-check and the fetches,
  // and counted like any other drop (the dashboard lists it separately).
  let refusedCount = 0;
  if (companionMode) {
    const refused = [];
    pending = pending.filter((row) => {
      const verdict = checkHostedUrl(row.url);
      if (verdict.ok) return true;
      refused.push([row, `hosted_${verdict.reason}`]);
      return false;
    });
    const at = new Date().toISOString();
    for (const [row, reason] of refused) state.dropped[canonOf(row)] = { at, reason };
    if (!dryRun && refused.length) { saveStateSoon(); await checkOffRows(refused.map(([row, reason]) => [row.url, `node: dropped (${reason})`])); }
    refusedCount = refused.length;
    if (!pending.length) return `checked ${refusedCount}: all ${refusedCount} refused by the hosted URL policy`;
  }

  // Ask the hub which of these it already knows, so a URL it has already
  // seen never pays a liveness/JD fetch — the biggest single cost this step
  // can avoid.
  if (cfg.hub?.seen_check !== false && pending.length) {
    // The hosted route takes at most 128 KB a call; 200 URLs is comfortably inside it.
    const chunkSize = companionMode ? Math.min(cfg.hub?.seen_check_max || 200, 200) : (cfg.hub?.seen_check_max || 500);
    const known = new Set();
    for (let i = 0; i < pending.length; i += chunkSize) {
      const chunk = pending.slice(i, i + chunkSize);
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await callHub(cfg.hub, 'seen', { method: 'POST', body: { node: cfg.node?.name, urls: chunk.map((r) => r.url) } });
        if (res.ok && Array.isArray(res.json?.seen)) for (const u of res.json.seen) known.add(u);
      } catch { /* best effort — a hub blip just means no shortcut this pass */ }
    }
    if (known.size) {
      const stillPending = [];
      const knownRows = [];
      for (const row of pending) {
        if (known.has(row.url)) {
          const key = canonOf(row);
          state.shipped[key] = { at: new Date().toISOString(), score: null, hub: 'duplicate' };
          knownRows.push(row);
        } else {
          stillPending.push(row);
        }
      }
      // One locked rewrite for the whole known set — thousands of rows would
      // otherwise mean thousands of lock/read/write rounds on the same file.
      if (!dryRun && knownRows.length) { saveStateSoon(); await checkOffRows(knownRows.map((row) => [row.url, 'node: known to hub'])); }
      knownCount = knownRows.length;
      pending = stillPending;
    }
  }
  const undecided = knownCount + pending.length;
  if (!pending.length) return `checked ${undecided}: all already known to the hub`;
  const cap = Math.max(1, Number(validateCfg.max_per_run) || 150);
  const deferred = Math.max(0, pending.length - cap);
  pending = pending.slice(0, cap);

  // Hosted: the hub's keyword list (derived from the user's résumé, never the
  // résumé). Self-hosted: criteria.skills when sent, else this box's own cv.md if
  // it has one. A node with neither scores without a stack signal rather than
  // failing every pass on a missing file.
  const cvSkills = new Set(resolveCvSkills(liveCriteria, {
    companion: companionMode,
    cvExists: () => existsSync(p('cv.md')),
    readCv: () => loadCv(),
  }));
  const trackedCompanies = new Set(
    (Array.isArray(parsedPortals.tracked_companies) ? parsedPortals.tracked_companies : [])
      .map((e) => normalizeCompany(e?.name || '')),
  );
  const floorUsd = liveCriteria.profile?.compensation?.minimum_usd ?? null;
  const criteria = {
    titleFilter: parsedPortals.title_filter || {},
    targetRoles: {
      primary: liveCriteria.profile?.target_roles?.primary || [],
      archetypeNames: archetypeRoleNames(liveCriteria.profile?.target_roles?.archetypes),
    },
    floorUsd,
    // The hub's own location_filter ranking tiers (primary / authorized /
    // sponsor_required). They already travelled here inside portals_yml —
    // the scanner read them to decide what entered the pipeline, and nothing
    // read them again to decide how to RANK it, so the node scored locations
    // against its own rank.local_terms and a hardcoded non-US penalty list
    // that contained cities the candidate had explicitly asked for.
    locationPolicy: parseLocationPolicy(parsedPortals),
    // The Profile tab's work-location and work-authorization answers.
    preferences: liveCriteria.profile?.preferences || null,
  };
  const sourceMap = loadScanHistorySources();
  const counts = { ship: 0, hold: 0, drop: 0 };

  await mapWithConcurrency(pending, validateCfg.concurrency || 3, async (row) => {
    const { liveness, jdText } = await checkOneLiveness(row.url, validateCfg);
    const scored = scoreFind(row, { criteria, rank: cfg.rank || {}, cvSkills, trackedCompanies, jdText, liveness });
    const { decision, drop_reason: dropReason, hold_reason: holdReason } = decideFind(scored, cfg.hub?.ship_min_score ?? 40);
    const key = canonOf(row);
    const now = new Date().toISOString();
    if (dryRun) logInfo(`dry-run: ${decision.padEnd(4)} ${String(scored.score).padStart(3)}/100 ${row.company} — ${row.title} [${scored.reasons.join(', ')}]${dropReason ? ` (${dropReason})` : ''}`);

    if (decision === 'drop') {
      counts.drop += 1;
      state.dropped[key] = { at: now, reason: dropReason };
      if (!dryRun) { saveStateSoon(); await checkOffRow(row.url, `node: dropped (${dropReason})`); }
      return;
    }
    if (decision === 'hold') {
      counts.hold += 1;
      state.held[key] = { at: now, score: scored.score, ...(holdReason ? { reason: holdReason } : {}) };
      if (!dryRun) { saveStateSoon(); await checkOffRow(row.url, `node: held (score ${scored.score}${holdReason ? `, ${holdReason}` : ''})`); }
      return;
    }
    // ship
    counts.ship += 1;
    let ref = null;
    try { ref = parseAtsUrl(row.url); } catch { ref = null; }
    const canonicalUrl = canonicalUrlForRef(ref) || row.url;
    state.to_ship.push({
      key, url: canonicalUrl, company: row.company, title: row.title, location: row.location,
      salary: row.comp ? { min: row.comp.min, max: row.comp.max, currency: row.comp.currency } : undefined,
      posted_at: row.posted || undefined,
      source: sanitizeSource(sourceMap.get(row.url) || row.note?.match(/node:[a-z0-9-]+:(\S+)/)?.[1] || 'unknown'),
      score: scored.score,
      reasons: scored.reasons.slice(0, 8),
      liveness: liveness === 'active' || liveness === 'uncertain' ? liveness : undefined,
      trust: row.trust || undefined,
    });
    if (!dryRun) { saveStateSoon(); await checkOffRow(row.url, 'node: shipped'); }
  });

  // A dry run computes and prints, and persists NOTHING — the in-memory
  // state it touched dies with the process (--dry-run only exists with --once).
  // The non-dry path is saved by runValidate's recordJobResult.
  return `checked ${undecided}: ${knownCount} known to hub, ${pending.length} validated (${counts.ship} to ship, ${counts.hold} held, ${counts.drop} dropped)${refusedCount ? `, ${refusedCount} refused by the hosted URL policy` : ''}${deferred ? `, ${deferred} deferred to the next pass` : ''}`;
}

async function checkOffRow(url, note) {
  await checkOffRows([[url, note]]);
}

// Marks every [url, note] pair under ONE lock acquisition and one
// read/write of the file — the critical section is synchronous, so a
// concurrent in-process writer can never interleave with it either.
async function checkOffRows(items) {
  if (!items.length) return;
  await withPipelineLock(paths.pipeline, () => {
    if (!existsSync(paths.pipeline)) return;
    let current = readFileSync(paths.pipeline, 'utf-8');
    for (const [url, note] of items) current = markPipelineRow(current, url, note);
    writeFileSync(paths.pipeline, current, 'utf-8');
  });
}

// ── Ship ──────────────────────────────────────────────────────────────
function omitKey({ key, ...rest }) { void key; return rest; }

let shipBackoffMs = 60_000; // 1 min -> caps at 30 min, per §4.4.7
// The backoff is only real if something consults it: the tick skips runShip
// until this instant. (The first version doubled the number, logged it, and
// retried on the very next tick regardless.)
let nextShipAttemptAt = 0;
// The last hosted refusal that was logged: asking again in an hour must not
// write the same line every hour, so a repeat is silent until something changes.
let lastShipNotice = null;
const SHIP_409_HELP = {
  profile_incomplete: 'finish the Profile tab on your CareerAutopilot account and this node will start sending',
  too_many_nodes: 'this account already has the most nodes it may have',
};
async function runShip(cfg, dryRun) {
  if (dryRun || !state.to_ship.length) return;
  const batchSize = shipBatchSize(cfg.hub?.ship_batch, state);
  const batch = state.to_ship.slice(0, batchSize);
  const runId = `${cfg.node?.name || 'node'}-${new Date().toISOString().slice(0, 16)}`;
  const body = {
    node: cfg.node?.name,
    run_id: runId,
    // `key` is this daemon's own dedup key (state.to_ship/shipped/dropped are
    // keyed by it) — never part of the wire body.
    finds: batch.map(omitKey),
  };

  // The hosted mode talks to ONE site; fallback URLs are a self-hosted router/primary pair.
  const urls = companionMode
    ? [cfg.hub?.url].filter(Boolean)
    : [cfg.hub?.url, ...(Array.isArray(cfg.hub?.fallback_urls) ? cfg.hub.fallback_urls : [])].filter(Boolean);
  let response = { ok: false, status: null, networkError: true };
  for (const url of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await callHub({ url, token: cfg.hub?.token }, 'ingest', { method: 'POST', body });
      response = res;
      if (res.blocked || res.ok || (res.status && res.status < 500 && res.status !== 401 && res.status !== 403)) break;
      // 401/403/5xx: try the next fallback URL at the connection level.
    } catch {
      response = { ok: false, status: null, networkError: true };
    }
  }

  // The hub told this node to stop calling (or rate-limited ingest) and callHub
  // already said so once. Leave the queue exactly as it is and look again later.
  if (response.blocked) {
    nextShipAttemptAt = Math.max(hubBlockedUntil(), routeNotBefore.ingest || 0, Date.now() + 60_000);
    return;
  }

  if (response.ok && response.status === 202) {
    shipBackoffMs = 60_000;
    nextShipAttemptAt = 0;
    lastShipNotice = null;
    foldIngestResponse(state, batch, response);
    foldLimits(state, response.json);
    logInfo(`ship: submitted ${batch.length}, accepted ${(response.json?.accepted_urls || []).length}, duplicate ${(response.json?.duplicate_urls || []).length}`);
    if (response.json?.capped === true) {
      // Part of the batch did not fit (the daily allowance, or a full inbox) and
      // stays queued. Come back in an hour, by which time it may.
      nextShipAttemptAt = Date.now() + 60 * 60_000;
      logInfo(`ship: the hub took only part of the batch; ${state.to_ship.length} find(s) wait for room`);
    }
  } else if (response.status === 429) {
    // A rate limit or the daily allowance: the queue is untouched and callHub has
    // set the time to try again.
    nextShipAttemptAt = routeNotBefore.ingest || Date.now() + 30 * 60_000;
  } else if (companionMode && (response.status === 409 || response.status === 413)) {
    // Neither says the FINDS are bad, so the batch stays queued (the self-hosted
    // node keeps dropping on any other 4xx). A 409 is about the account
    // (profile_incomplete, too_many_nodes): ask again in an hour. A 413 is about
    // the request's size: the next batch is half this one, down to a floor; a
    // batch already at the floor that is still refused backs off like a 5xx.
    foldIngestResponse(state, batch, response, { hosted: true });
    const tooLarge = response.status === 413;
    const atFloor = tooLarge && batch.length <= SHIP_BATCH_FLOOR;
    const code = tooLarge ? 'too_large' : (hubErrorCode(response.json) || 'conflict');
    if (!tooLarge) {
      nextShipAttemptAt = Date.now() + HUB_BLOCK_MS;
    } else if (atFloor) {
      nextShipAttemptAt = Date.now() + shipBackoffMs;
      shipBackoffMs = Math.min(shipBackoffMs * 2, 30 * 60_000);
    } else {
      nextShipAttemptAt = 0;
    }
    const notice = `${code}:${state.ship_batch_limit ?? ''}`;
    if (notice !== lastShipNotice) {
      lastShipNotice = notice;
      const what = !tooLarge
        ? `${SHIP_409_HELP[code] || 'the hub is not ready for finds'} (${code}); asking again in an hour`
        : atFloor
          ? `the hub still refuses requests of ${batch.length} as too large; backing off`
          : `the hub refused a request of ${batch.length} as too large; sending ${state.ship_batch_limit} at a time from now on`;
      state.last_hub_error = { at: new Date().toISOString(), job: 'ship', message: what.slice(0, 300) };
      logWarn(`ship: ${what} — ${state.to_ship.length} find(s) kept`);
    }
  } else if (companionMode && hubBlockReason(response)) {
    // The account itself was refused (stopped, discovery off, pipeline off, wrong
    // token kind...). callHub has said why, once, and blocked every hub call for an
    // hour; the generic "enter a new token" advice below would be wrong for it.
    nextShipAttemptAt = Math.max(hubBlockedUntil(), Date.now() + 60_000);
  } else if (response.status === 401 || response.status === 403) {
    state.last_hub_error = { at: new Date().toISOString(), job: 'ship', message: `HTTP ${response.status} (auth refused)` };
    logWarn(`ship: hub refused auth (HTTP ${response.status}) — ${companionMode ? 'run discovery-node --reconfigure to enter a new token' : "check config/discovery-node.local.yml's hub.token"} — retrying in ${Math.round(shipBackoffMs / 1000)}s`);
    nextShipAttemptAt = Date.now() + shipBackoffMs;
    shipBackoffMs = Math.min(shipBackoffMs * 2, 30 * 60_000);
  } else if (response.networkError || (typeof response.status === 'number' && response.status >= 500)) {
    if (response.networkError) state.hub_reachable = false;
    state.last_hub_error = { at: new Date().toISOString(), job: 'ship', message: response.networkError ? 'network error on every hub URL' : `HTTP ${response.status}` };
    logWarn(`ship: hub unreachable/5xx — backing off ${Math.round(shipBackoffMs / 1000)}s`);
    nextShipAttemptAt = Date.now() + shipBackoffMs;
    shipBackoffMs = Math.min(shipBackoffMs * 2, 30 * 60_000);
  } else {
    logWarn(`ship: hub rejected batch (HTTP ${response.status ?? 'n/a'}) — dropping ${batch.length} finds`);
    foldIngestResponse(state, batch, response);
  }
  saveState();
}

// ── Heartbeat ─────────────────────────────────────────────────────────
let currentJob = null;
// Set while the local dashboard is listening: { enabled, port }.
let dashboardInfo = { enabled: false, port: null };

/** The status the heartbeat sends and /health serves: one builder, so they cannot disagree. */
function nodeStatus(cfg) {
  return buildHeartbeatStatus(state, cfg.jobs || {}, {
    version: VERSION,
    started_at: STARTED_AT.toISOString(),
    uptime_s: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
    current_job: currentJob,
    pending_local: existsSync(paths.pipeline) ? parsePipelineRows(readFileSync(paths.pipeline, 'utf-8')).length : 0,
    criteria_hash: state.criteria_hash,
    last_error: state.last_error,
    paused: isNodePaused(),
    // The hosted mode has no hub-side control, so it reports none.
    control_revision: companionMode ? null : state.control_revision,
    command_acks: companionMode ? [] : state.command_acks,
    dashboard: dashboardInfo,
    sources: effectiveSources,
  });
}

function applyControlFromHub(cfg, control) {
  const result = applyHubControl(state, control, { locallyPaused: isLocallyPaused() });
  if (result.control_changed) {
    recomputeEffective(cfg);
    logInfo(`control: revision ${state.control_revision} applied${isNodePaused() ? ' (node is paused)' : ''}`);
  }
  for (const job of result.queued) logInfo(`control: run-now ${job} requested from the dashboard`);
  for (const refused of result.refused) logInfo(`control: command ${refused.id} not run (${refused.reason})`);
}

async function runHeartbeat(cfg) {
  const status = nodeStatus(cfg);
  try {
    const res = await callHub(cfg.hub, 'heartbeat', { method: 'POST', body: { node: cfg.node?.name, status } });
    if (res.blocked) return;
    if (res.ok) {
      state.hub_reachable = true;
      state.last_heartbeat_ok_at = new Date().toISOString();
      state.last_hub_error = null;
    } else {
      // The hub answered but refused: reachable for the status column (the
      // network is fine), but the error is what an operator needs to see —
      // a 401/403 here is a token mismatch, nothing a retry fixes.
      state.hub_reachable = true;
      state.last_hub_error = { at: new Date().toISOString(), job: 'heartbeat', message: `HTTP ${res.status}${res.json?.error ? ` ${String(res.json.error).slice(0, 120)}` : ''}` };
      logWarn(`heartbeat: hub answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? (companionMode ? ' — the token may have been revoked: run discovery-node --reconfigure' : " — check config/discovery-node.local.yml's hub.token") : ''}`);
    }
    if (res.ok) {
      foldLimits(state, res.json);
      // Self-hosted only. The hosted hub is a server this machine does not
      // control: nothing it puts in a response can pause, re-time or start a job.
      if (!companionMode) applyControlFromHub(cfg, res.json?.control);
    }
    if (res.ok && res.json?.criteria_hash && res.json.criteria_hash !== state.criteria_hash) {
      logInfo('heartbeat: hub criteria_hash differs — refreshing');
      await refreshCriteria(cfg);
    }
  } catch (err) {
    state.hub_reachable = false;
    state.last_hub_error = { at: new Date().toISOString(), job: 'heartbeat', message: String(err.message || err).slice(0, 300) };
    logWarn(`heartbeat failed: ${String(err.message || err)}`);
  }
  saveState();
}

// ── Health server (§4.5, unauthenticated) ────────────────────────────────
//
// Two shapes, decided by where it listens:
//   - Bound to a non-loopback address (a self-hosted box's 0.0.0.0, so a status
//     probe on its private network can reach it): exactly the document it has
//     always served.
//   - Bound to loopback (a hosted node's only option, or a self-hoster who chose
//     127.0.0.1): the request's Host header must name this listener (a DNS-
//     rebinding page can aim a hostile name at 127.0.0.1 and read a response
//     cross-origin), and the response omits the error strings, which can carry
//     local file paths and a user name.
// `health.enabled: false` turns it off. In the hosted mode the host defaults to
// 127.0.0.1 and a non-loopback value is refused rather than honoured.
function startHealthServer(cfg) {
  if (cfg.health?.enabled === false) {
    logInfo('health server disabled (health.enabled: false)');
    return null;
  }
  const configured = cfg.health?.host;
  // Self-hosted: byte-identical to before — an unset/empty host means all interfaces.
  const host = companionMode ? (configured === undefined ? '127.0.0.1' : configured) : (configured || '0.0.0.0');
  const loopback = isLoopbackHost(host);
  if (companionMode && !loopback) {
    logWarn('health server not started: health.host must be 127.0.0.1, ::1 or localhost on a hosted node');
    return null;
  }
  const bindHost = loopback && String(host).trim().toLowerCase() === 'localhost' ? '127.0.0.1' : host;
  const port = cfg.health?.port || 8380;
  const server = createServer((req, res) => {
    // Whole handler guarded: this port is unauthenticated and, on a self-hosted
    // box, reachable from its private network, and an uncaught exception here (a request
    // line `new URL` refuses, an unreadable pipeline file mid-write) would take
    // the daemon — and every scanner it supervises — down with it.
    try {
      handleHealth(req, res);
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'health handler failed' }));
      } catch { /* socket already gone */ }
      logWarn(`health handler error: ${String(err?.message || err).slice(0, 200)}`);
    }
  });
  // A malformed request that never reaches the handler (bad request line,
  // header overflow) surfaces here; without a listener Node destroys the
  // socket itself, but be explicit so the intent is visible.
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* already closed */ }
  });
  // A port that is already taken costs the health route, never the node.
  server.on('error', (err) => logWarn(`health server error: ${err?.code || String(err?.message || err).slice(0, 120)}`));
  function handleHealth(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }
    if (loopback) {
      const bound = server.address()?.port;
      const allowed = [`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`];
      if (!allowed.includes(String(req.headers.host || '').toLowerCase())) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden host' }));
        return;
      }
    }
    if (req.method !== 'GET' || url.pathname !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const status = nodeStatus(cfg);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'career-ops-discovery-node',
      node: cfg.node?.name || null,
      version: VERSION,
      started_at: STARTED_AT.toISOString(),
      uptime_s: status.uptime_s,
      // Never cfg.hub itself (carries the token) — url + a boolean only.
      hub: { url: cfg.hub?.url || null, reachable: state.hub_reachable ?? null, last_heartbeat_ok_at: state.last_heartbeat_ok_at || null, last_error: loopback ? undefined : (state.last_hub_error || null) },
      jobs: status.jobs,
      queue: { pending_local: status.pending_local, to_ship: status.to_ship, shipped_total: status.shipped_total, held_total: status.held_total, dropped_total: status.dropped_total },
      current_job: currentJob,
      last_error: loopback ? undefined : state.last_error,
    }));
  }
  server.listen(port, bindHost, () => {
    if (loopback) {
      const addr = server.address();
      if (!addr || typeof addr === 'string' || (addr.address !== '127.0.0.1' && addr.address !== '::1')) {
        logWarn('health server closed: it was not bound to loopback');
        server.close();
        return;
      }
    }
    logInfo(`health server listening on http://${bindHost}:${server.address()?.port ?? port}`);
  });
  return server;
}

// ── Hosted-mode guard ─────────────────────────────────────────────────

/**
 * Everything the hosted mode needs to be true before it touches a file or the
 * network. There is deliberately no flag that skips the first check: the files
 * it protects are the user's own targeting and pipeline.
 */
function assertCompanionReady(cfg) {
  const problems = detectUserLayer(ROOT);
  if (problems.length) throw new DaemonRefusal(userLayerRefusalMessage(problems));
  const url = checkHubUrl(cfg.hub?.url);
  if (!url.ok) throw new DaemonRefusal(`Not starting: hub.url in config/discovery-node.yml — ${url.reason}. Fix it, or run discovery-node --reconfigure.`);
  cfg.hub.url = url.url;
  if (!/^cot_[A-Za-z0-9_-]{8,}$/.test(String(cfg.hub?.token || ''))) {
    throw new DaemonRefusal('Not starting: no CareerAutopilot token is configured. Run discovery-node --reconfigure to enter one.');
  }
  if (!NODE_NAME_RE.test(String(cfg.node?.name || ''))) {
    throw new DaemonRefusal('Not starting: node.name must be 1-32 characters of a-z, 0-9 and "-". Run discovery-node --reconfigure.');
  }
}

// ── Local dashboard (autopilot/lib/discovery-node-dashboard.mjs) ───────

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const COMBO_MESSAGE = (name) => `${name}: with a start time, an interval over a day must be whole days (a multiple of 1440 minutes)`;

function buildDashboardStatus(cfg) {
  const hb = nodeStatus(cfg);
  const jobs = {};
  for (const [name, job] of Object.entries(hb.jobs)) {
    // The dashboard always gets the full source map; only the heartbeat sheds it for size.
    jobs[name] = { ...job, can_start_at: SLOT_JOB_NAMES.includes(name), source: { ...(effectiveSources[name] || {}) } };
  }
  const tier = parseLocationPolicy(parsedPortals);
  const roles = liveCriteria?.profile?.target_roles;
  return {
    node: cfg.node?.name || '',
    mode: companionMode ? 'companion' : 'node',
    version: VERSION,
    started_at: STARTED_AT.toISOString(),
    uptime_s: hb.uptime_s,
    hub: {
      url: cfg.hub?.url || '',
      host: hostOf(cfg.hub?.url),
      connected: state.hub_reachable ?? null,
      last_heartbeat_ok_at: state.last_heartbeat_ok_at || null,
      error: state.last_hub_error?.message || null,
    },
    hub_blocked: hubBlockedUntil() ? { reason: state.hub_block.reason, until: state.hub_block.until } : null,
    paused: isNodePaused(),
    paused_by: {
      local: isLocallyPaused(),
      hub: !companionMode && isPaused([{ name: 'hub', control: state.hub_control }]),
    },
    current_job: currentJob,
    jobs,
    queue: {
      pending_local: hb.pending_local,
      to_ship: hb.to_ship,
      shipped_total: hb.shipped_total,
      held_total: hb.held_total,
      dropped_total: hb.dropped_total,
      // Of those, the finds the hosted URL policy ruled out before shipping (a
      // company's own careers page, say): the account would have refused them.
      dropped_hosted: Object.values(state.dropped || {}).filter((d) => String(d?.reason || '').startsWith('hosted_')).length,
      run_now: [...(state.run_now || [])],
    },
    recent_shipped: state.recent_shipped || [],
    criteria: liveCriteria ? {
      fetched_at: state.last_criteria_at,
      title_keywords: Array.isArray(parsedPortals?.title_filter?.positive) ? parsedPortals.title_filter.positive.length : 0,
      target_roles: (roles?.primary?.length || 0) + (roles?.archetypes?.length || 0),
      location: { primary: tier.primary.length, authorized: tier.authorized.length, sponsor_required: tier.sponsorRequired.length },
    } : null,
    limits: state.limits ? { finds_per_day: state.limits.finds_per_day, accepted_today: state.limits.accepted_today } : null,
  };
}

// One extra heartbeat shortly after a local change, so the admin's view of a
// self-hosted node (or the user's own account page) catches up without waiting
// out the five-minute cadence. Debounced; the hosted hub rate-limits heartbeats,
// so there it waits a minute between extras.
let heartbeatSoonTimer = null;
let lastExtraHeartbeatAt = 0;
function requestHeartbeatSoon(cfg) {
  if (heartbeatSoonTimer) return;
  const wait = companionMode ? Math.max(5_000, 60_000 - (Date.now() - lastExtraHeartbeatAt)) : 5_000;
  heartbeatSoonTimer = setTimeout(() => {
    heartbeatSoonTimer = null;
    lastExtraHeartbeatAt = Date.now();
    runHeartbeat(cfg).catch(() => {});
  }, wait);
  heartbeatSoonTimer.unref?.();
}

/** PUT /api/jobs/:name — merge-patch the LOCAL control (null removes a field; { reset: true } removes the job's overrides). */
function putLocalJob(cfg, name, body) {
  if (!NODE_JOB_NAMES.includes(name)) return { ok: false, errors: ['unknown job'] };
  const reset = body?.reset === true;
  if (reset && Object.keys(body).length > 1) return { ok: false, errors: ['reset cannot be combined with other fields'] };
  const result = patchControl(localControl, { jobs: { [name]: reset ? null : body } });
  if (result.errors.length) return { ok: false, errors: result.errors };
  const next = result.value;
  delete next.paused;
  // patchControl checks each field; whether the COMBINATION still makes sense
  // depends on the layers beneath it too.
  const layers = [...(companionMode ? [] : [{ name: 'hub', control: state.hub_control }]), { name: 'local', control: next }];
  const eff = effectiveJobs(baseJobs, layers).jobs[name];
  if (eff && normalizeHHMM(eff.start_at) && Number(eff.every_minutes) > 1440 && Number(eff.every_minutes) % 1440 !== 0) {
    return { ok: false, errors: [COMBO_MESSAGE(name)] };
  }
  localControl = next;
  writeJson(paths.localControl, localControl);
  recomputeEffective(cfg);
  logInfo(`dashboard: settings for ${name} changed`);
  requestHeartbeatSoon(cfg);
  return { ok: true };
}

/** POST /api/jobs/:name/run — an explicit request, so it ignores enabled/paused. */
function queueRunNow(cfg, name) {
  if (!enqueueRunNow(state, name)) return { ok: false, error: 'unknown job' };
  saveState();
  logInfo(`dashboard: ${name} queued to run now`);
  requestHeartbeatSoon(cfg);
  return { ok: true };
}

let stopDaemon = null;
function dashboardApi(cfg, onStopRequested) {
  return {
    status: () => buildDashboardStatus(cfg),
    pause: () => { sessionPaused = true; logInfo('paused from the local dashboard'); requestHeartbeatSoon(cfg); },
    resume: () => { sessionPaused = false; logInfo('resumed from the local dashboard'); requestHeartbeatSoon(cfg); },
    stop: () => {
      logInfo('stop requested from the local dashboard');
      return onStopRequested ? onStopRequested() : stopDaemon?.();
    },
    putJob: (name, body) => putLocalJob(cfg, name, body),
    runJob: (name) => queueRunNow(cfg, name),
  };
}

async function startLocalDashboard(cfg, { port, onStopRequested } = {}) {
  const handle = await startDashboard({
    host: cfg.dashboard?.host,
    port: port ?? (Number(cfg.dashboard?.port) || undefined),
    api: dashboardApi(cfg, onStopRequested),
    log: logInfo, // port numbers only: the access key never reaches a log line
  });
  dashboardInfo = handle ? { enabled: true, port: handle.port } : { enabled: false, port: null };
  return handle;
}

// ── Scheduler (§4.3) ──────────────────────────────────────────────────
/**
 * Name every job this build knows how to schedule that this box's config has no
 * block for.
 *
 * planNextJob skips a job whose `jobs.<name>` block is missing — silently, with
 * no log line, forever — and buildHeartbeatStatus iterates the config's own
 * keys, so such a job never appears in /health or --status either. That is
 * invisible by construction, and it is exactly what happens on a box whose
 * config/discovery-node.yml was copied before the job existed: the deploy lands
 * the code, the operator sees a clean start, and the feature does nothing at
 * all. Defaulting the job on instead would be worse — a job that runs because
 * nobody wrote it down is not a job anyone chose.
 *
 * Reported once at startup rather than every tick, with the copy instruction,
 * since the fix is a two-line paste from the shipped example.
 *
 * @param {object} cfg - The loaded node config.
 * @returns {string[]} Job names present in code and absent from the config.
 */
function unconfiguredJobs(cfg) {
  const configured = cfg?.jobs || {};
  return SCANNER_JOB_ORDER.filter((name) => !Object.prototype.hasOwnProperty.call(configured, name));
}

/**
 * How to fix a config that lacks job blocks, worded for the checkout it is
 * printed in. The same source runs in this repository (where
 * fleet/sync-node-jobs.mjs and config/discovery-node.example.yml exist) and in
 * the public package (which ships neither, only
 * config/discovery-node.user.example.yml), so the files it names are the ones
 * that are really here.
 */
function missingJobsFix() {
  if (!companionMode && existsSync(p('fleet', 'sync-node-jobs.mjs'))) return 'run: node fleet/sync-node-jobs.mjs, then restart the node';
  const candidates = ['config/discovery-node.user.example.yml', 'config/discovery-node.example.yml'];
  if (!companionMode) candidates.reverse();
  const example = candidates.find((rel) => existsSync(p(...rel.split('/'))));
  return `copy the block(s) from ${example || 'the example config that came with this node'} into config/discovery-node.yml, then stop the node and start it again`;
}

function startScheduler(cfg) {
  const missing = unconfiguredJobs(cfg);
  if (missing.length) {
    logWarn(
      `config has no jobs.${missing.join('/jobs.')} block — ${missing.length === 1 ? 'that job' : 'those jobs'} will never run. `
      + `To fix it, ${missingJobsFix()}.`,
    );
  }
  let stopped = false;
  let running = false;
  let criteriaTimer = null;
  let lastCriteriaAttempt = 0;

  // One tick at a time. setInterval keeps firing while a slow validate pass
  // (dozens of JD fetches at 3 s host gaps) is still awaiting, and without
  // this a second pass would score and check off the same rows concurrently
  // — two writers on state.json and pipeline.md from one process.
  let tickBusy = false;
  const tick = async () => {
    if (stopped || tickBusy) return;
    tickBusy = true;
    try { await tickBody(); } finally { tickBusy = false; }
  };
  const tickBody = async () => {
    const now = Date.now();
    // A paused node starts no new work: no scanner job, no validate pass, no
    // ship. It still fetches criteria it has never had (a run-now needs them) and
    // it still heartbeats, which is how the hub learns it is paused.
    const paused = isNodePaused();
    // criteria: on start, then every criteria_refresh_minutes, with its own
    // backoff on failure (never blocks the scanner-job slot below).
    const refreshMs = (cfg.hub?.criteria_refresh_minutes || 30) * 60_000;
    const dueForRefresh = !liveCriteria || criteriaFailing
      ? now - lastCriteriaAttempt >= criteriaBackoffMs
      : now - Date.parse(state.last_criteria_at || 0) >= refreshMs;
    if (dueForRefresh && (!paused || !liveCriteria)) {
      lastCriteriaAttempt = now;
      await refreshCriteria(cfg);
    }

    if (!running) {
      // An explicit request goes first, whatever the schedule: it ignores
      // `enabled` and a pause because somebody asked for exactly this job. It
      // still needs criteria, so without them it stays queued.
      const queued = liveCriteria ? takeRunNow(state, (name) => name !== 'validate') : null;
      const next = queued || (paused ? null : planNextJob(cfg.jobs || {}, state, now));
      if (queued) { logInfo(`${queued}: run-now requested`); saveState(); }
      if (next && liveCriteria) {
        // A job starting on its start-time schedule is serving a SLOT; remember
        // which one, so the next tick does not start it again for the same slot.
        const spec = queued ? null : slotSpec(cfg.jobs?.[next]);
        if (spec) {
          state.jobs[next] ??= { runs: 0, errors: 0 };
          state.jobs[next].last_slot_at = lastSlotAtOrBefore(spec, now)?.toISOString() ?? null;
          saveState();
        }
        running = true;
        currentJob = { name: next, started_at: new Date().toISOString() };
        logInfo(`${next}: started`);
        // Deliberately NOT awaited. A scanner child can run for hours (the
        // ats_full sweep is capped at 6 h) and the tick has to keep coming
        // round for validate, ship and the criteria refresh while it does;
        // `running` is the one-child-at-a-time guard. The first deployed
        // build awaited here, and validate/ship froze for the whole length
        // of every long scan — finds only shipped once the sweep ended.
        // A lookup rather than a chained ternary: the in-process jobs share
        // this one scanner slot with the spawning ones, and a name that falls
        // through to runScannerJob without a SCANNER_SCRIPTS entry silently
        // no-ops (buildScannerCommand returns null and nothing is recorded).
        const inProcess = { aggregators: runAggregatorsJob, sources: runSourcesJob };
        const job = inProcess[next] ? inProcess[next](cfg) : runScannerJob(next, cfg, false);
        Promise.resolve(job)
          .catch((err) => logWarn(`${next} failed: ${String(err.message || err)}`))
          .finally(() => { currentJob = null; running = false; });
      } else if (next && !liveCriteria) {
        logInfo(`scanner jobs idle — criteria not fetched yet (job "${next}" is due)`);
      }
    }

    // validate/ship run independently of the scanner-child slot — validate on
    // its own cadence (jobs.validate.enabled / every_minutes, the same knobs
    // every scanner job honours), ship whenever its backoff allows.
    const validateCfg = cfg.jobs?.validate || {};
    // validate is not a scanner slot, so a run-now for it is taken here.
    const validateNow = liveCriteria ? takeRunNow(state, (name) => name === 'validate') : null;
    if (validateNow) { logInfo('validate: run-now requested'); saveState(); }
    if (validateNow || (!paused && validateCfg.enabled !== false)) {
      const everyMs = Math.max(1, Number(validateCfg.every_minutes) || 10) * 60_000;
      const last = Date.parse(state.jobs?.validate?.last_run_at || '');
      if (validateNow || !Number.isFinite(last) || Date.now() - last >= everyMs) {
        try { await runValidate(cfg, false); } catch (err) { logWarn(`validate failed: ${String(err.message || err)}`); }
      }
    }
    if (!paused && Date.now() >= nextShipAttemptAt) {
      try { await runShip(cfg, false); } catch (err) { logWarn(`ship failed: ${String(err.message || err)}`); }
    }
  };

  const tickTimer = setInterval(() => { tick().catch((err) => logWarn(`tick error: ${String(err.message || err)}`)); }, (cfg.scheduler?.tick_seconds || 30) * 1000);
  const heartbeatTimer = setInterval(() => {
    runHeartbeat(cfg).catch((err) => logWarn(`heartbeat error: ${String(err.message || err)}`));
  }, (cfg.hub?.heartbeat_minutes || 5) * 60_000);
  tick().catch((err) => logWarn(`initial tick error: ${String(err.message || err)}`));
  runHeartbeat(cfg).catch(() => {});

  return {
    stop() { stopped = true; clearInterval(tickTimer); clearInterval(heartbeatTimer); if (criteriaTimer) clearTimeout(criteriaTimer); },
  };
}

// ── runDaemon: the daemon, as a function ──────────────────────────────

/**
 * Start the scheduler, the health route and (optionally) the local dashboard in
 * THIS process, from an already-loaded config. `--daemon` calls it, and so does
 * autopilot/discovery-node-start.mjs, which is how the public package starts a
 * node in the foreground with a dashboard.
 *
 * It never reads the config itself, never calls the process-exit function and
 * never installs a signal handler: the caller owns all three, and `stop()` tells
 * it when the node has finished shutting down. It throws DaemonRefusal when it
 * will not start (a hosted node run from a folder that holds somebody's own
 * career-ops files, for one).
 *
 * @param {object} cfg - loadNodeConfig()'s result.
 * @param {{dashboard?: boolean, dashboardPort?: number, onStopRequested?: () => void}} [opts]
 *   `dashboard`: true/false forces it; omitted, it follows `dashboard.enabled`
 *   (off unless the config says true). `onStopRequested` is called when the
 *   dashboard's Stop button is pressed; by default the node just stops.
 * @returns {Promise<{stop: () => Promise<void>, dashboard: {port: number, url: string}|null}>}
 *   `dashboard.url` carries the access key in its fragment: show it to the person
 *   at the terminal and nowhere else.
 */
export async function runDaemon(cfg, opts = {}) {
  initControl(cfg); // throws on a bad hub.mode
  if (companionMode) assertCompanionReady(cfg);
  // One node per checkout, taken before anything is written: a second copy would
  // overwrite state.json from its own memory and validate and ship the same rows.
  const lock = acquireInstanceLock(paths.daemonLock);
  if (!lock.ok) throw new DaemonRefusal(instanceRefusalMessage(lock.holder));
  // Gone with the process on any orderly exit; after a crash the dead pid marks it stale.
  process.once('exit', lock.release);
  // --status compares the config file's mtime with this to tell whether the
  // running process has read the file as it is now. It used to be set only when
  // state.json was first created, so on a long-lived box every config edit
  // after that read as "the daemon has not seen it" for ever.
  state.started_at = STARTED_AT.toISOString();
  saveState();

  const wantDashboard = opts.dashboard === undefined ? cfg.dashboard?.enabled === true : opts.dashboard === true;
  let dash = null;
  let health = null;
  let scheduler = null;
  try {
    if (wantDashboard) dash = await startLocalDashboard(cfg, { port: opts.dashboardPort, onStopRequested: opts.onStopRequested });
    if (dash) lock.update({ dashboard_port: dash.port }); // the port only: a second launch can name it, never the access key
    health = startHealthServer(cfg);
    scheduler = startScheduler(cfg);
  } catch (err) {
    lock.release();
    throw err;
  }
  logInfo(`daemon started (mode=${companionMode ? 'companion' : 'node'}, node=${cfg.node?.name || '(unnamed)'}, hub=${cfg.hub?.url || '(unset)'})`);

  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      logInfo('shutting down');
      scheduler.stop();
      clearTimeout(heartbeatSoonTimer);
      heartbeatSoonTimer = null;
      if (liveChild) { try { liveChild.kill('SIGTERM'); } catch { /* best effort */ } }
      saveState();
      await Promise.all([
        health ? new Promise((resolve) => { health.close(() => resolve()); health.closeAllConnections?.(); }) : null,
        dash ? dash.close() : null,
      ]);
      lock.release();
    })();
    return stopping;
  };
  stopDaemon = stop;
  return { stop, dashboard: dash ? { port: dash.port, url: dash.url } : null };
}

// ── CLI ───────────────────────────────────────────────────────────────
const KNOWN_FLAGS = ['--daemon', '--once', '--status', '--json', '--dry-run', '--help', '-h'];
const VALUE_FLAGS = ['--once'];
const USAGE = `Usage:
  node autopilot/discovery-node.mjs --daemon                 # run the scheduler forever
  node autopilot/discovery-node.mjs --once <job>              # run one job to completion
  node autopilot/discovery-node.mjs --status [--json]         # print current status
  node autopilot/discovery-node.mjs --dry-run --once <job>    # preview: no pipeline writes, no ship
  node autopilot/discovery-node.mjs --help`;

const ONCE_JOBS = ['tracked', 'ats_full', 'seeds', 'boards', 'local_employers', 'aggregators', 'sources', 'resolve', 'criteria', 'validate', 'ship', 'heartbeat'];

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (hasFlag(args, '--status')) {
    const cfg = requireConfig();
    initControl(cfg); // report the EFFECTIVE jobs: file + hub control + local overrides
    const status = buildHeartbeatStatus(state, cfg.jobs || {}, {
      version: VERSION, started_at: state.started_at, criteria_hash: state.criteria_hash, last_error: state.last_error,
      paused: isNodePaused(), sources: effectiveSources,
    });
    // Two things --status could not tell you before, and both look identical
    // to "fine" when they are wrong.
    //
    // A job this build can schedule but the config has no block for is skipped
    // by planNextJob forever, and does not even appear in the loop below —
    // buildHeartbeatStatus iterates the CONFIG's keys, so an absent job is
    // absent from its own status line.
    const missingJobs = unconfiguredJobs(cfg);
    // And a config the daemon has not re-read is indistinguishable from one it
    // has: /health, this output and the log all look completely normal. On
    // 2026-09-18 a self-hosted node's config sat correct on disk for 73 minutes while the
    // daemon ran the previous one, because the restart had silently no-op'd
    // (`Restart-ScheduledTask` is not a real cmdlet, and `Stop-ScheduledTask`
    // reports Ready while the process is still alive). The only reliable proof
    // is that the process started AFTER the file was last written.
    const staleness = configStaleness(paths.nodeConfig, state.started_at);

    if (hasFlag(args, '--json')) {
      console.log(JSON.stringify({ ...status, unconfigured_jobs: missingJobs, config: staleness }, null, 2));
    } else {
      console.log(`node: ${cfg.node?.name || '(unnamed)'}  version: ${VERSION}`);
      console.log(`to_ship: ${status.to_ship}  shipped: ${status.shipped_total}  held: ${status.held_total}  dropped: ${status.dropped_total}`);
      if (status.paused) console.log('  PAUSED by the hub (no new work starts; a local pause lasts only while the process runs)');
      for (const [name, job] of Object.entries(status.jobs)) {
        console.log(`  ${name}: ${job.enabled ? 'enabled' : 'disabled'}  last_run_at=${job.last_run_at || 'never'}  last_ok=${job.last_ok}  runs=${job.runs} errors=${job.errors}`);
      }
      if (missingJobs.length) {
        console.log('');
        console.log(`  !! this build can schedule ${missingJobs.join(', ')}, and the config has no block for ${missingJobs.length === 1 ? 'it' : 'them'}.`);
        console.log(`     They will never run. To fix it, ${missingJobsFix()}.`);
      }
      if (staleness.stale) {
        console.log('');
        console.log(`  !! config/discovery-node.yml was written at ${staleness.configMtime}, AFTER this daemon started`);
        console.log(`     at ${staleness.startedAt}. The running process has NOT read it. Stop the node, start it`);
        console.log('     again and check this line again — nothing else here will look wrong meanwhile.');
      }
    }
    return;
  }

  if (hasFlag(args, '--once')) {
    const job = flagValue(args, '--once');
    if (!ONCE_JOBS.includes(job)) {
      console.error(`Error: --once requires one of: ${ONCE_JOBS.join(', ')}`);
      process.exit(1);
    }
    const cfg = requireConfig();
    try {
      initControl(cfg);
      if (companionMode) assertCompanionReady(cfg); // --once writes into this checkout too
    } catch (err) {
      if (err instanceof DaemonRefusal) { console.error(err.message); process.exit(err.exitCode); }
      throw err;
    }
    const dryRun = hasFlag(args, '--dry-run');
    // Every job but ship/heartbeat needs criteria in memory first — the
    // scanner jobs to render portals.yml/boards.yml, validate to score
    // against title_filter/target_roles/floor. criteria fetches itself below.
    if (!['criteria', 'ship', 'heartbeat'].includes(job)) await refreshCriteria(cfg);
    if (job === 'criteria') await refreshCriteria(cfg);
    else if (job === 'aggregators') await runAggregatorsJob(cfg);
    else if (job === 'sources') await runSourcesJob(cfg, dryRun);
    else if (job === 'validate') await runValidate(cfg, dryRun);
    else if (job === 'ship') await runShip(cfg, dryRun);
    else if (job === 'heartbeat') await runHeartbeat(cfg);
    else await runScannerJob(job, cfg, dryRun);
    const rec = state.jobs?.[job];
    console.log(rec ? `${job}: ${rec.last_ok ? 'ok' : 'FAILED'} — ${rec.last_summary || ''}` : `${job}: done`);
    process.exit(rec && rec.last_ok === false ? 1 : 0);
  }

  if (hasFlag(args, '--daemon')) {
    const cfg = requireConfig();
    let handle = null;
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Not process.exit() once stop() is done: on Windows, exiting while the last of
      // the shutdown is still completing aborts Node (an assertion in libuv's
      // win/async.c, exit code 0xC0000409). Everything is closed by now, so the loop
      // drains and the process ends on its own; the unref'd timer is the backstop.
      (handle ? handle.stop() : Promise.resolve()).then(
        () => { process.exitCode = 0; },
        (err) => { console.error(`The node did not stop cleanly: ${String(err?.message || err)}`); process.exitCode = 1; },
      );
      setTimeout(() => process.exit(0), 3000).unref();
    };
    try {
      // Under --daemon the dashboard is OFF unless the config turns it on: this
      // is the unattended mode (a supervisor, a log file), where nobody is at a
      // terminal to be shown the dashboard's access key.
      handle = await runDaemon(cfg, { onStopRequested: shutdown });
    } catch (err) {
      if (err instanceof DaemonRefusal) { console.error(err.message); process.exit(err.exitCode); }
      throw err;
    }
    // The key is printed to a terminal and nowhere else: not to the log, and not
    // to a stdout that a supervisor redirects into a file.
    if (handle.dashboard) {
      if (process.stdout.isTTY) console.log(`Dashboard: ${handle.dashboard.url}`);
      else logInfo(`dashboard is on port ${handle.dashboard.port}; its link is shown only when started from a terminal`);
    }
    // SIGHUP: a closed terminal or console window (Windows maps its close event to
    // it); SIGBREAK: Ctrl+Break on Windows. Either one, unhandled, kills the process
    // without stop(), so the ledgers since the last state save are lost.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(signal, shutdown);
    return;
  }

  console.log(USAGE);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[discovery-node] fatal: ${String(err.message || err)}`);
    process.exit(1);
  });
}
