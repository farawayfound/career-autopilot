// autopilot/lib/discovery-node.mjs — the discovery node's pure logic, plus a
// handful of thin IO helpers with test seams (config load, the hub HTTP
// client). Everything with a filesystem/network side effect on the node's OWN
// box lives in autopilot/discovery-node.mjs (the CLI/daemon); this module is
// the pure island that file drives, so every scoring/parsing/rendering rule
// can be tested with no network, no child process, and no real disk.
//
// See DISCOVERY_NODE_SPEC.md §2/§4 for the contract this implements, and
// AGENTS.md's discovery-node section for the one-paragraph story.
// The node's own box has no LLM calls at all (AGENTS.md "Hard constraints") —
// everything below is deterministic string/number logic, on purpose.
import { existsSync, readFileSync, openSync, readSync, closeSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { uptime as osUptime } from 'os';
import * as yaml from 'js-yaml';
import { p } from './util.mjs';
import { normalizeCompany } from '../../lib/tracker-utils.mjs';
import { preferenceSignals } from './discovery-preferences.mjs';
import { compileKeyword, compilePositiveKeyword } from '../../lib/title-keywords.mjs';
import { parseAtsUrl } from './jd.mjs';
import { safeUrl } from './url-guard.mjs';
import { NODE_JOB_NAMES, sanitizeControl } from './discovery-node-control.mjs';
import { isLoopbackHost } from './discovery-node-dashboard.mjs';
import { lastSlotAtOrBefore, nextSlotAfter, normalizeHHMM, slotDue } from '../../lib/slot-schedule.mjs';
import classifyTier from '../../scripts/scan/classify-tier.mjs';

// ── Config load (§4.1) ──────────────────────────────────────────────────

/**
 * Deep-merge `over` onto `base`: plain objects merge key-by-key, arrays and
 * scalars replace. A private copy rather than an import — autopilot/lib/util.mjs's
 * own deepMerge() is module-private (loadConfig's own helper, never
 * exported), and this file's merge order (yml -> local.yml -> env) is its own
 * small contract, not autopilot's. Kept tiny on purpose.
 */
function deepMergeNode(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (isObj(v) && isObj(base[k])) deepMergeNode(base[k], v);
    else base[k] = v;
  }
  return base;
}

function readYamlIfExists(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  const doc = yaml.load(text);
  return doc && typeof doc === 'object' ? doc : {};
}

/** Thrown by loadNodeConfig when the required config file is missing. */
export class MissingNodeConfigError extends Error {
  constructor(configPath) {
    super(
      `discovery node config not found at ${configPath}. Copy the template first: `
      + `cp config/discovery-node.example.yml ${configPath}`,
    );
    this.name = 'MissingNodeConfigError';
    this.code = 'ENOCONFIG';
    this.configPath = configPath;
  }
}

/**
 * Load and merge the node's own config: `config/discovery-node.yml` (required)
 * deep-merged with `config/discovery-node.local.yml` (optional, holds
 * `hub.token`), then two env overrides (`CAREER_OPS_NODE_TOKEN` -> `hub.token`,
 * `CAREER_OPS_URL` -> `hub.url`).
 *
 * Never logs anything — the token can live in the merged result, in an env
 * var, or in the gitignored local overlay, and this function is the one place
 * all three converge, so it is also the one place a careless
 * `console.log(cfg)` would leak it. Callers must not stringify the whole
 * config into a log line either (see discovery-node.mjs's hub client, which
 * only ever logs `hub.url`, never `hub`).
 *
 * @param {{configPath?: string, localConfigPath?: string, env?: object}} [opts]
 *   Test seam: absolute paths and an env object, so a suite can point this at
 *   temp files without touching the real config/ directory or process.env.
 * @returns {object} The merged config. `node`/`hub`/`health`/`scheduler`/
 *   `jobs`/`boards`/`local_employers`/`rank` are always present as objects
 *   (possibly empty) so downstream reads never throw on an absent section.
 * @throws {MissingNodeConfigError} When configPath does not exist.
 */
export function loadNodeConfig(opts = {}) {
  const {
    configPath = p('config', 'discovery-node.yml'),
    localConfigPath = p('config', 'discovery-node.local.yml'),
    env = process.env,
  } = opts;
  if (!existsSync(configPath)) throw new MissingNodeConfigError(configPath);
  const cfg = yaml.load(readFileSync(configPath, 'utf-8')) || {};
  const local = readYamlIfExists(localConfigPath);
  if (local) deepMergeNode(cfg, local);

  for (const key of ['node', 'hub', 'health', 'scheduler', 'jobs', 'boards', 'local_employers', 'rank']) {
    if (cfg[key] === undefined) cfg[key] = key === 'boards' || key === 'local_employers' ? [] : {};
  }

  const nodeToken = env.CAREER_OPS_NODE_TOKEN?.trim?.() || (typeof env.CAREER_OPS_NODE_TOKEN === 'string' ? env.CAREER_OPS_NODE_TOKEN.trim() : '');
  if (nodeToken) cfg.hub.token = nodeToken;
  const hubUrl = typeof env.CAREER_OPS_URL === 'string' ? env.CAREER_OPS_URL.trim() : '';
  if (hubUrl) cfg.hub.url = hubUrl;

  return cfg;
}

// ── Hosted ("companion") mode ───────────────────────────────────────────
//
// The same node, two audiences. `node` is the self-hoster's mode: a
// per-node token, the autopilot's own /api/discovery/node/* routes, a hub the
// operator owns. `companion` is the public package's mode: the node runs on an
// end user's own computer and talks to THEIR hosted CareerAutopilot account
// with their own `cot_` token, over /api/companion/discovery/*. Everything below
// that differs between the two is decided by this one function so the daemon
// has a single place to ask.

/** @param {{hub?: {mode?: string}}} cfg @returns {'node'|'companion'} */
export function hubMode(cfg) {
  const mode = cfg?.hub?.mode;
  if (mode === undefined || mode === null || mode === 'node') return 'node';
  if (mode === 'companion') return 'companion';
  throw new Error(`hub.mode must be "node" or "companion" (got ${JSON.stringify(String(mode).slice(0, 40))})`);
}

export const isCompanionMode = (cfg) => hubMode(cfg) === 'companion';

// One node-name rule everywhere. autopilot/lib/discovery-node-ingest.mjs owns
// the hub's copy (DISCOVERY_NODE_NAME_RE); tests/discovery-node-companion.test.mjs
// pins the two equal, because a name the hub refuses is a node that can never
// report in.
export const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A node name from a machine's hostname: lowercase, anything outside
 * `[a-z0-9-]` folded to a hyphen, trimmed to 32 characters. Falls back to
 * `my-computer` when nothing usable is left, so a hostname made entirely of
 * punctuation still yields a name the hub accepts.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function slugifyNodeName(hostname) {
  const slug = String(hostname ?? '').toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return NODE_NAME_RE.test(slug) ? slug : 'my-computer';
}

/**
 * Whether a hub URL is acceptable for the hosted mode: https, or http only to a
 * loopback host (a developer pointing the node at a local server), no userinfo
 * (credentials in a URL end up in logs and process listings), and nothing but
 * an origin — a path, query or fragment on the hub URL would be silently
 * prepended to every route.
 *
 * @param {unknown} raw
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function checkHubUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'the site URL is empty' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, reason: 'that is not a valid URL' }; }
  if (u.username || u.password) return { ok: false, reason: 'the URL must not contain a user name or password' };
  const loopback = isLoopbackHost(u.hostname.replace(/^\[|\]$/g, ''));
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return { ok: false, reason: 'the site URL must start with https:// (http:// is only allowed for localhost)' };
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    return { ok: false, reason: 'use just the site address, with no path (for example https://davidchui.work)' };
  }
  return { ok: true, url: u.origin };
}

const MACHINE_HEADER_PREFIX = '# MACHINE-WRITTEN by autopilot/discovery-node.mjs';

function readHead(file, bytes = 200) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

/**
 * What in this checkout looks like somebody's career-ops USER LAYER — the files
 * the hosted node must never run next to.
 *
 * The node renders `portals.yml` and `config/profile.yml`, appends to
 * `data/pipeline.md` and `data/scan-history.tsv`, and its scanners resolve their
 * data root through `CAREER_OPS_ROOT` / `CAREER_OPS_DATA_DIR` / a
 * `.career-ops-data` marker. Run from a checkout that holds a real career-ops
 * setup, that would overwrite the candidate's own targeting and consume their
 * pipeline — a Data Contract violation, so the hosted mode refuses outright
 * rather than trusting the user to have used a fresh clone. A `portals.yml` or
 * `config/profile.yml` that carries the node's own machine-written header is
 * the node's, not the user's.
 *
 * @param {string} rootDir - The checkout root.
 * @param {{env?: object, exists?: (f: string) => boolean, head?: (f: string) => string}} [seams]
 * @returns {string[]} Offending paths/variables; empty when the checkout is clean.
 */
export function detectUserLayer(rootDir, { env = process.env, exists = existsSync, head = readHead } = {}) {
  const problems = [];
  for (const rel of ['cv.md', 'data/applications.md', 'applications.md', 'data/blacklist.md', '.career-ops-data']) {
    if (exists(join(rootDir, rel))) problems.push(rel);
  }
  for (const rel of ['portals.yml', 'config/profile.yml']) {
    const file = join(rootDir, rel);
    if (exists(file) && !head(file).startsWith(MACHINE_HEADER_PREFIX)) problems.push(rel);
  }
  for (const name of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER']) {
    if (typeof env?.[name] === 'string' && env[name].trim()) problems.push(`${name} (environment variable)`);
  }
  return problems;
}

/** The refusal printed when detectUserLayer() finds something. */
export function userLayerRefusalMessage(problems) {
  return [
    `Not starting: this folder already holds career-ops files of its own (${problems.join(', ')}).`,
    'The hosted discovery node writes its own portals.yml, config/profile.yml and data/pipeline.md here,',
    'which would overwrite or consume yours. Run it from a fresh download of the CareerAutopilot repository',
    '(https://github.com/farawayfound/career-autopilot), not from a folder you use for career-ops itself.',
  ].join('\n');
}

/**
 * The skills vocabulary scoreFind() matches JD text against.
 *
 * The hosted hub sends `skills` (keywords derived from the user's résumé, never
 * the résumé itself) in the criteria. A self-hoster's node falls back to its
 * own cv.md. In the hosted mode cv.md is NEVER read: a checkout that has one is
 * somebody's real CV, and the criteria's `skills` — present or absent — is the
 * only source the hub authorised.
 *
 * @param {{skills?: unknown}|null} criteria
 * @param {{companion?: boolean, cvExists?: () => boolean, readCv?: () => string}} [opts]
 * @returns {string[]}
 */
export function resolveCvSkills(criteria, { companion = false, cvExists = () => false, readCv = () => '' } = {}) {
  if (Array.isArray(criteria?.skills)) {
    // Untrusted hub data: strings only, bounded, lowercased like cvSkillsFromMarkdown.
    const out = [];
    for (const s of criteria.skills) {
      if (typeof s !== 'string') continue;
      const t = s.trim().toLowerCase();
      if (t && t.length <= 60 && !out.includes(t)) out.push(t);
      if (out.length >= 200) break;
    }
    return out;
  }
  if (companion) return [];
  return cvExists() ? cvSkillsFromMarkdown(readCv()) : [];
}

// Keys on a portals.yml entry that hold a URL the scanner will fetch.
const URL_KEY_RE = /(^|_)(url|api|feed|rss|website|endpoint|href)$/i;

/**
 * Drop every `tracked_companies` / `job_boards` entry whose URL is not a public
 * http(s) address. The hosted hub is a server the user does not control, and its
 * criteria tell THIS machine what to fetch — a loopback address, a LAN host or a
 * `file:` URL there would make the user's computer probe its own network. Same
 * literal-address guard (safeUrl) the autopilot applies to links in email. What
 * survives is then rebuilt from an allowlist (name, enabled, an https careers_url,
 * a vouched-for `api`; a board's provider slug) so no field that makes the
 * scanner run a command or read a file can come through. Hosted mode only.
 *
 * @param {string|null|undefined} portalsYmlText - `criteria.portals_yml`.
 * @returns {{text: string|null, dropped: number}}
 */
export function sanitizeCriteriaPortals(portalsYmlText) {
  if (!portalsYmlText) return { text: portalsYmlText ?? null, dropped: 0 };
  let doc;
  try { doc = yaml.load(portalsYmlText); } catch { return { text: null, dropped: 0 }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { text: null, dropped: 0 };
  let dropped = 0;
  const clean = (entry) => {
    if (!entry || typeof entry !== 'object') { dropped += 1; return false; }
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string' && URL_KEY_RE.test(key) && !safeUrl(value)) { dropped += 1; return false; }
    }
    return true;
  };
  // Surviving the address check is not enough: the scanner reads MORE than an
  // address off an entry (see "What a hub-supplied source may keep" below), so
  // what is kept is rebuilt from an allowlist rather than filtered down from
  // whatever the hub sent.
  for (const [key, build] of [['tracked_companies', companionCompany], ['job_boards', companionBoard]]) {
    if (!Array.isArray(doc[key])) continue;
    const rebuilt = doc[key].filter(clean).map(build);
    dropped += rebuilt.filter((entry) => !entry).length;
    doc[key] = rebuilt.filter(Boolean);
  }
  return { text: yaml.dump(doc, { lineWidth: 120 }), dropped };
}

// ── What a hub-supplied source may keep (hosted mode) ───────────────────
//
// A portals.yml entry is not only an address. scripts/scan/scan.mjs hands the
// WHOLE entry to providers/_registry.mjs's resolveProvider(), and
// providers/local-parser.mjs claims any entry carrying `parser.command` (or
// `provider: local-parser`) and execFile()s it on the machine running the scan.
// The in-repo-script and interpreter checks that provider makes are written for a
// portals.yml its own user wrote; the hosted hub's criteria are not that. So a
// hub-supplied entry is rebuilt here from fields that can only ever make the
// scanner fetch a public https page, and the executing fields cannot survive
// because nothing copies them.

// Hosts whose own provider (providers/{greenhouse,lever,ashby,workable,
// smartrecruiters}.mjs) accepts an explicit `api:`. Each of those providers
// re-asserts its own host list; this one only decides what is worth keeping.
const KNOWN_ATS_API_HOSTS = new Set([
  'boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io', 'api.lever.co', 'api.eu.lever.co',
  'api.ashbyhq.com', 'apply.workable.com', 'api.smartrecruiters.com',
]);
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
const BOARD_PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `a.b.example.co.uk` -> `example.co.uk`. No public-suffix list: a heuristic is enough for "same site". */
function registrableHost(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, '').split('.');
  const tail = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL_LABELS.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-tail).join('.');
}

/** A public https URL with no credentials, in safeUrl's normalized form; else null. */
function publicHttpsUrl(value) {
  const safe = typeof value === 'string' ? safeUrl(value) : null;
  if (!safe) return null;
  const u = new URL(safe);
  return u.protocol === 'https:' && !u.username && !u.password ? safe : null;
}

/** @returns {{name: string, careers_url?: string, api?: string, enabled: boolean}|null} */
function companionCompany(entry) {
  const name = clip(entry.name, 120);
  if (!name) return null;
  const out = { name, enabled: entry.enabled !== false };
  if (entry.careers_url !== undefined) {
    out.careers_url = publicHttpsUrl(entry.careers_url);
    if (!out.careers_url) return null;
  }
  const api = publicHttpsUrl(entry.api);
  if (api) {
    const host = new URL(api).hostname;
    const sameSite = out.careers_url && registrableHost(host) === registrableHost(new URL(out.careers_url).hostname);
    if (KNOWN_ATS_API_HOSTS.has(host) || sameSite) out.api = api;
  }
  return out;
}

/** @returns {{name: string, provider?: string, careers_url?: string, enabled: boolean}|null} */
function companionBoard(entry) {
  const name = clip(entry.name, 120);
  if (!name) return null;
  const out = { name, enabled: entry.enabled !== false };
  if (entry.provider !== undefined) {
    if (typeof entry.provider !== 'string' || !BOARD_PROVIDER_RE.test(entry.provider) || entry.provider === 'local-parser') return null;
    out.provider = entry.provider;
  }
  if (entry.careers_url !== undefined) {
    out.careers_url = publicHttpsUrl(entry.careers_url);
    if (!out.careers_url) return null;
  }
  return out;
}

// ── Pipeline row parsing (§4.4.1) ───────────────────────────────────────

// Only PENDING rows (`- [ ] `) are read — a row already checked off
// (`- [x] `) was already shipped/held/dropped/known-to-hub in an earlier
// pass and markPipelineRow() is what checks a row off, so re-reading it here
// would be reprocessing already-decided work.
const PENDING_ROW_RE = /^- \[ \] (https?:\/\/\S+)(.*)$/;
const LABELED_CELL_RE = /^(posted|trust|note):\s*(.*)$/i;

function parseTrustCell(value) {
  const m = String(value).trim().match(/^(\d+)\s*(.*)$/);
  if (!m) return null;
  const score = Number(m[1]);
  const flags = m[2] ? m[2].split(',').map((f) => f.trim()).filter(Boolean) : [];
  return { score, flags };
}

/**
 * Parse the PENDING rows of a `data/pipeline.md` on the node's own box.
 *
 * Mirrors the grammar `formatPipelineOffer` in scripts/scan/scan.mjs writes (the same
 * writer scan.mjs/scan-ats-full.mjs use for the node's own scanner children):
 * `- [ ] {url} | {company} | {title}` then an optional `| {location}` and
 * `| {comp}` (positional, comp only present once location's cell is too, even
 * when location is blank), then optional labeled `| posted: ...`, `| trust:
 * ...`, `| note: ...` segments in that fixed order. Tolerates a bare-URL row
 * (no `|` at all) and 3/4/5-column rows — every reader downstream treats a
 * missing field as absent, never as a parse failure.
 *
 * The comp cell is parsed with parseCompensation() (below) rather than a
 * second number parser: `120000-160000 USD` / `150000 USD` /
 * `120000-160000` / `150000` are all a subset of the free-text grammar that
 * function already reads, so one function stays the single source of truth
 * for what a compensation string means.
 *
 * @param {string} text - `data/pipeline.md` contents.
 * @returns {Array<{url: string, company: string, title: string, location: string,
 *   comp: {min: number, max: number, currency: string}|null,
 *   posted: string|null, trust: {score: number, flags: string[]}|null,
 *   note: string|null, raw: string}>}
 */
export function parsePipelineRows(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(PENDING_ROW_RE);
    if (!m) continue;
    const url = m[1];
    // Leading cell before the first `|` is the empty pre-separator artifact
    // of splitting a string that STARTS with `|` (same convention
    // autopilot.mjs's parsePendingOffers() reads `cols[1]`/`cols[2]` under).
    const cells = m[2].split('|').map((c) => c.trim());
    const rest = cells.slice(1).filter((c, i) => !(i === 0 && cells.length === 1 && c === ''));
    // The first labeled cell (posted:/trust:/note:) marks the boundary
    // between positional cells (company, title, location?, comp?) and
    // labeled ones — positional cells never start with one of those prefixes
    // because sanitizeMarkdownField never emits a bare "posted:"/"trust:"/
    // "note:" as a company or title (`|`-escaping already keeps the writer's
    // own separators out of free text).
    let labelStart = rest.findIndex((c) => LABELED_CELL_RE.test(c));
    if (labelStart === -1) labelStart = rest.length;
    const positional = rest.slice(0, labelStart);
    const labeled = rest.slice(labelStart);

    const company = positional[0] || '';
    const title = positional[1] || '';
    const location = positional[2] || '';
    const comp = positional[3] ? parseCompensation(positional[3]) : null;

    let posted = null;
    let trust = null;
    let note = null;
    for (const cell of labeled) {
      const lm = cell.match(LABELED_CELL_RE);
      if (!lm) continue;
      const key = lm[1].toLowerCase();
      const value = lm[2].trim();
      if (key === 'posted') {
        posted = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
      } else if (key === 'trust') {
        trust = parseTrustCell(value);
      } else if (key === 'note') {
        note = value || null;
      }
    }

    out.push({ url, company, title, location, comp, posted, trust, note, raw: line });
  }
  return out;
}

// ── Compensation text parsing (§4.4.4) ──────────────────────────────────

// A currency code allowlist rather than a bare `[A-Z]{3}` scan: scoreFind()
// calls this over full, arbitrary JD text (not just a controlled comp cell),
// and an unrestricted 3-uppercase-letter match would false-positive on
// ordinary acronyms in prose ("API", "SLA", "SSO"). Short, deliberately —
// widen it if a real posting is ever missed.
const CURRENCY_CODE_RE = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY|INR|NZD|SGD|HKD|MXN|SEK|NOK|DKK|PLN|BRL|ZAR)\b/;
// One dash class covers hyphen, en dash and em dash — the same set of
// separators a comp range is written with across ATS free text and the
// scanner's own sanitized pipeline cell.
// A leading digit is REQUIRED: `[\\d,]+` alone matches a bare comma, and with
// a non-global .match() the first comma in a JD ("Denver, CO") was the whole
// result — parseCompensation() returned null on nearly every real posting and
// the $150K floor check silently never ran. The `(?<![\\d.])` guard keeps a
// match from starting mid-number ("2026-09-14" is not a 26–9 range).
const NUM = '(?<![\\d.])(\\$)?(\\d[\\d,]*(?:\\.\\d+)?)(?:\\s*([kK]))?(?![\\d])';
// An optional per-period unit RIGHT AFTER the first number, before the range
// separator — the LinkedIn shape "$140,000.00/yr - $250,000.00/yr" has "/yr "
// sitting exactly there, and without room for it the separator alternation
// below never matches, so the range collapses to the first (marked) number
// alone and $250,000 is silently dropped (#2951 bug 1). Deliberately narrow —
// a slash/word unit, nothing that could bridge unrelated prose.
const PERIOD_UNIT = '(?:yr|year|hr|hour|mo|month|wk|week)';
const PERIOD_SUFFIX = `(?:\\s*/\\s*${PERIOD_UNIT}|\\s+per\\s+${PERIOD_UNIT})?`;
// Three ways two numbers join into a range: a dash (with optional spaces), the
// word "to", or — new — bare whitespace ("USD 150000 200000 yearly", Workable/
// SmartRecruiters' `[currency,min,max,period].join(' ')`, #2951 bug 2). The
// whitespace alternative is captured (group below) so the code can tell it
// apart from a dash/"to" join and demand extra proof before trusting it: since
// it requires NUM to start immediately after the whitespace with nothing else
// between, prose like "$5,000 signing bonus 150,000 base" can never satisfy it
// (the words "signing bonus" aren't whitespace) — that case is safe by
// construction, not by the marked-check below. The marked-check exists for the
// narrower case a bare join CAN still match syntactically: "5000 150000 USD",
// where only the trailing currency code would otherwise vouch for the pair.
const RANGE_SEP = '(\\s*[-–—]\\s*|\\s+to\\s+|\\s+)';
// PERIOD_SUFFIX sits INSIDE the range group, not after NUM directly: a single
// (non-range) number like "$85/hr" must leave "/hr" outside the match so the
// existing after-the-match hourly detection below still sees it. Nested here,
// the suffix only ever gets consumed when it is actually followed by a
// separator and a second number — exactly the LinkedIn shape it exists for.
const COMP_RANGE_RE = new RegExp(`${NUM}(?:${PERIOD_SUFFIX}${RANGE_SEP}${NUM})?`, 'g');
// A separator is a genuine dash/"to" join; anything else matched by RANGE_SEP
// is the bare-whitespace alternative.
const DASH_OR_TO_SEP_RE = /[-–—]|to/i;
const MIN_PLAUSIBLE_ANNUAL = 20_000;
const MAX_PLAUSIBLE_ANNUAL = 1_000_000;
const MIN_PLAUSIBLE_HOURLY = 15;
const MAX_PLAUSIBLE_HOURLY = 500;
// Monthly/weekly bands are the annual band divided by its own multiplier, with
// a little headroom trimmed off each side so a number that would annualize to
// something implausible is caught before the multiply rather than after.
// Multiplier VALUES (12, 52) mirror providers/ashby.mjs's INTERVAL_MULTIPLIERS
// ('1 MONTH', '1 WEEK') — that file's constant isn't exported (it's scoped to
// Ashby's own structured `compensationTierSummary` shape), so this is the same
// number, not a shared import; hourly's 2080 (40h * 52wk) was already this
// module's own constant before this change and is unaffected.
const MONTHLY_MULTIPLIER = 12;
const WEEKLY_MULTIPLIER = 52;
const MIN_PLAUSIBLE_MONTHLY = 1_500;
const MAX_PLAUSIBLE_MONTHLY = 85_000;
const MIN_PLAUSIBLE_WEEKLY = 350;
const MAX_PLAUSIBLE_WEEKLY = 20_000;
// Hourly/monthly/weekly are judged ADJACENT to the number, not anywhere in the
// text: a JD that says "hourly standups" a sentence after a "$180,000" line is
// annual. Either the marker follows the range directly ("$85 - $95 per hour",
// "$85/hr", "$40 an hour", "$85 USD hourly") or a "<period> rate/pay/wage"
// label leads into it ("hourly rate: $85"). Monthly/weekly mirror hourly's
// shape exactly; kept as separate constants rather than a generated triple so
// each stays greppable on its own.
const HOURLY_AFTER_RE = /^[\s,)]*(?:usd\s*)?(?:\/\s*(?:hr|hour)(?![a-z])|per\s+hour(?![a-z])|an\s+hour(?![a-z])|hourly(?![a-z]))/i;
const HOURLY_BEFORE_RE = /hourly(?:\s+(?:rate|pay|wage|compensation))?\s*(?:of|:|is|-)?\s*$/i;
const MONTHLY_AFTER_RE = /^[\s,)]*(?:usd\s*)?(?:\/\s*(?:mo|month)(?![a-z])|per\s+month(?![a-z])|a\s+month(?![a-z])|monthly(?![a-z]))/i;
const MONTHLY_BEFORE_RE = /monthly(?:\s+(?:rate|pay|wage|compensation))?\s*(?:of|:|is|-)?\s*$/i;
const WEEKLY_AFTER_RE = /^[\s,)]*(?:usd\s*)?(?:\/\s*(?:wk|week)(?![a-z])|per\s+week(?![a-z])|a\s+week(?![a-z])|weekly(?![a-z]))/i;
const WEEKLY_BEFORE_RE = /weekly(?:\s+(?:rate|pay|wage|compensation))?\s*(?:of|:|is|-)?\s*$/i;
// The parenthetical shape ("(hour)", "(per-hour-salary)") that HOURLY_AFTER_RE
// never sees: its leading class `[\s,)]*` doesn't include `(`, so " (hour)"
// after a range is invisible to it and the value reads as annual, fails
// MIN_PLAUSIBLE_ANNUAL, and is discarded to null (#2951 bug 3). Live data
// already has "USD 160,000-220,000 (per-year-salary)", so `per-<unit>-salary`
// is real, not speculative. A dedicated regex rather than patching the leading
// class: "(hour)" has no "ly" for HOURLY_AFTER_RE's `hourly(?![a-z])` alt to
// land on, and widening that alt to bare "hour" would also fire on unrelated
// parenthetical asides — safer as its own small, explicit shape.
const PAREN_PERIOD_AFTER_RE = /^[\s,]*\(\s*(?:per-)?(hour|year|month|week)(?:ly)?(?:-salary)?\s*\)/i;
// What must lead into a bare comma-grouped number for it to count as pay.
const SALARY_LEAD_RE = /(?:salary|compensation|comp|pay|base|range|ote|earn(?:ing)?s?|remuneration|wage)\b[^.\n]{0,30}$/i;

/**
 * Parse a free-text compensation mention into an annualized range.
 *
 * Handles the shapes named in the spec: `$150,000 - $200,000`, `$150k–$200k`,
 * `150K-200K USD`, `USD 150,000`, `$85/hr`, `$85 - $95 per hour` (hourly is
 * annualized at 2080 hours/year, the standard full-time convention), monthly
 * and weekly figures (×12 / ×52), a per-period unit sitting between the first
 * number and a dash range (`$140,000.00/yr - $250,000.00/yr`), a whitespace-
 * joined range with no dash at all (`USD 150000 200000 yearly`), a
 * parenthetical period marker (`USD $85-$95 (hour)`, `160,000-220,000
 * (per-year-salary)`), plus the bare-number forms `parsePipelineRows`'s comp
 * cell writes (`120000-160000`, `150000`). A single bound (no dash) is
 * returned as `min === max`.
 *
 * Best-effort, not a full salary NLP pass: it takes the FIRST number pattern
 * it finds in `text`, so a JD whose comp mention isn't the first digit run
 * (a phone number, a year, "5 years experience") can occasionally pick the
 * wrong one. The plausibility floor/ceiling (20K-1M/year, and each period's
 * own pre-multiply band) is what catches most of that — a phone number or a
 * headcount is far outside it and the whole match is discarded rather than
 * reported as a wrong salary. Mirrors the same "best-effort, filtered by
 * plausibility" trade the scanner's own title/location filters make
 * elsewhere in this codebase.
 *
 * @param {string} text
 * @returns {{min: number, max: number, currency: string, period: 'annual'|'hourly'|'monthly'|'weekly'}|null}
 */
export function parseCompensation(text) {
  const s = String(text ?? '');
  const trimmed = s.trim();
  if (!trimmed) return null;
  // The scanner's own comp cell ("120000-160000 USD", "150000") is a bare
  // number by construction — the ONE shape where a number with no "$", no
  // "k" and no thousands separator is still a salary. Anywhere else (JD
  // prose) a bare 5-6 digit run is a zip code, a req id or a headcount far
  // more often than a wage, so it needs one of those salary markers.
  const bareCell = /^\d[\d,]*(?:\.\d+)?\s*[kK]?(?:\s*[-–—]\s*\d[\d,]*(?:\.\d+)?\s*[kK]?)?(?:\s+[A-Z]{3})?$/.test(trimmed);

  const toNum = (digits, kSuffix) => {
    const n = Number(String(digits).replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    return kSuffix ? n * 1000 : n;
  };
  const curM = s.match(CURRENCY_CODE_RE);
  const currency = curM ? curM[1] : 'USD';

  // Every candidate in document order; the first one that is salary-shaped
  // AND plausible wins. Returning null on the first implausible number (the
  // previous behaviour) meant "401(k)" or "$5,000 signing bonus" ahead of the
  // real range hid the range entirely.
  // Two tiers. A MARKED candidate ("$", "k", a currency code right after it,
  // or the whole text being a comp cell) wins outright, first one in document
  // order. A bare comma-grouped number ("50,000") is only a salary when a
  // salary word leads into it ("Salary: 150,000 to 180,000") — otherwise it
  // is office square footage, a headcount or revenue, and an earlier one of
  // those must never shadow the real "$150,000 - $200,000" further down.
  let fallback = null;
  for (const m of s.matchAll(COMP_RANGE_RE)) {
    const [, dollar1, digits1, k1, sep, dollar2, digits2, k2] = m;
    let isRange = digits2 !== undefined;
    const end = m.index + m[0].length;
    const after = s.slice(end, end + 12);
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    // A currency code right before the FIRST number marks it on its own —
    // this is what "USD 150000 200000 yearly" needs, since neither number
    // carries a "$" or a "k". Kept as ITS OWN flag (not folded into the
    // broader `leadMarked` below) because it is the ONLY lead-mark strong
    // enough to trust a bare-whitespace join by itself — see the guard below.
    const currencyLeadMarked = bareCell || /(?:USD|EUR|GBP|CAD|AUD|CHF)\s*$/i.test(before);
    const leadMarked = currencyLeadMarked || Boolean(dollar1) || Boolean(k1);
    const marked = leadMarked || Boolean(dollar2 || k2)
      || /^\s*(?:USD|EUR|GBP|CAD|AUD|CHF)\b/.test(after);
    const commaGrouped = /,\d{3}/.test(digits1) || (isRange && /,\d{3}/.test(digits2 || ''));
    if (!marked && !commaGrouped) continue;
    // A bare-whitespace join ("150000 200000", no dash, no "to") is the
    // riskiest shape RANGE_SEP admits. Gating it on the broad `leadMarked`
    // (#2951) still let an unrelated adjacent number ride in on the FIRST
    // number's own "$"/"k" mark — "$150,000 401k match available" (a 401(k)
    // mention), "...750k equity grant...", "$150,000 30000 sq ft...", and
    // "$150,000 50000 employees..." all read a benefits/headcount/footage
    // figure as the salary's other bound, and "$150,000 $10,000 relocation
    // bonus" (both sides individually "$"-marked) joined into an implausible
    // range and lost the $150,000 salary entirely (#2971, confirmed against
    // the live queue). A deliberate "CURRENCY MIN MAX PERIOD" cell
    // (Workable/SmartRecruiters, `currencyLeadMarked`) is a real, rare,
    // structured shape; an ordinary "$"-prefixed number followed by
    // whitespace and whatever comes next in JD prose is not. So only
    // `currencyLeadMarked` (or the whole text being the scanner's own comp
    // cell, folded into it above) is trusted to join a bare-whitespace pair
    // — not a mere "$"/"k" on the first number. When it isn't trusted, don't
    // drop the candidate outright: the FIRST number can still be a genuine
    // marked salary on its own, so fall back to treating this match as a
    // single value rather than losing it to the failed range.
    if (isRange && sep && !DASH_OR_TO_SEP_RE.test(sep) && !currencyLeadMarked) isRange = false;
    let lo = toNum(digits1, k1);
    let hi = isRange ? toNum(digits2, k2) : null;
    if (lo === null) continue;
    if (hi === null) hi = lo;
    if (lo > hi) [lo, hi] = [hi, lo];

    // Period detection: an inline marker adjacent to the range ("/hr", "per
    // hour", "an hour", "hourly", the monthly/weekly equivalents) or a
    // parenthetical one after it ("(hour)", "(per-year-salary)"). Checked in
    // this fixed order (hourly, monthly, weekly) since only one can apply;
    // annual is the default when none match, including when the parenthetical
    // names "year" explicitly.
    const periodSlice = s.slice(end, end + 24);
    const beforeSlice = s.slice(Math.max(0, m.index - 32), m.index);
    const parenUnit = PAREN_PERIOD_AFTER_RE.exec(periodSlice)?.[1]?.toLowerCase() || null;
    const hourly = HOURLY_AFTER_RE.test(periodSlice) || HOURLY_BEFORE_RE.test(beforeSlice) || parenUnit === 'hour';
    const monthly = !hourly && (MONTHLY_AFTER_RE.test(periodSlice) || MONTHLY_BEFORE_RE.test(beforeSlice) || parenUnit === 'month');
    const weekly = !hourly && !monthly && (WEEKLY_AFTER_RE.test(periodSlice) || WEEKLY_BEFORE_RE.test(beforeSlice) || parenUnit === 'week');

    let period = 'annual';
    if (hourly) {
      if (lo < MIN_PLAUSIBLE_HOURLY || hi > MAX_PLAUSIBLE_HOURLY) continue;
      lo *= 2080; hi *= 2080; period = 'hourly';
    } else if (monthly) {
      if (lo < MIN_PLAUSIBLE_MONTHLY || hi > MAX_PLAUSIBLE_MONTHLY) continue;
      lo *= MONTHLY_MULTIPLIER; hi *= MONTHLY_MULTIPLIER; period = 'monthly';
    } else if (weekly) {
      if (lo < MIN_PLAUSIBLE_WEEKLY || hi > MAX_PLAUSIBLE_WEEKLY) continue;
      lo *= WEEKLY_MULTIPLIER; hi *= WEEKLY_MULTIPLIER; period = 'weekly';
    }
    if (lo < MIN_PLAUSIBLE_ANNUAL || hi > MAX_PLAUSIBLE_ANNUAL) continue;
    const candidate = { min: lo, max: hi, currency, period };
    if (marked) return candidate;
    if (!fallback && SALARY_LEAD_RE.test(s.slice(Math.max(0, m.index - 40), m.index))) fallback = candidate;
  }
  return fallback;
}

// ── Scoring (§4.4.5) ─────────────────────────────────────────────────────

function normText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Level words are not part of a role's name: "Senior Software Engineer" and
// "Lead AI Engineer" are the roles "software engineer" and "ai engineer" at a
// level, and "Software Engineer II" is the first at a grade. Whole words only,
// so the "i" in "ai" and the "lead" in "leader" are never touched. A name the
// strip would leave as one word ("Senior Engineer" → "engineer") keeps its
// level: one generic word would match nearly every title on the board.
const LEVEL_WORDS_RE = /(?<![\p{L}\p{N}])(?:senior|sr|staff|principal|lead|junior|jr|mid-level|mid|associate|distinguished|i{1,3}|iv|v)\.?(?![\p{L}\p{N}])/gu;
export function stripLevelWords(name) {
  const stripped = String(name ?? '').replace(LEVEL_WORDS_RE, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s,/&-]+|[\s,/&-]+$/g, '').trim();
  return stripped.split(' ').length >= 2 ? stripped : String(name ?? '').trim();
}

function compileKeywordList(list, compileFn) {
  return (Array.isArray(list) ? list : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map(compileFn);
}

// Boundary-aware matcher for the rank config's term lists (local_terms /
// remote_us_terms / NON_US_HINTS). A term must start and end at a word
// boundary of the normalized haystack — "us" never matches the pronoun in
// "about us", "co" never matches "Colombia" or "co-founder", "india" never
// matches "Indiana". A term that itself begins or ends with punctuation
// ("US-", "U.S.", "CO,") keeps that side open, so "US-based" and "Denver, CO,"
// still match. The first version was a plain .includes() that trimmed the
// authored delimiters away; measured on real JD text it flagged nearly every
// posting as remote_us via the word "us".
function boundaryMatcher(list) {
  const res = (Array.isArray(list) ? list : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => {
      const lead = /^[a-z0-9]/.test(t) ? '(?<![a-z0-9])' : '';
      const tail = /[a-z0-9]$/.test(t) ? '(?![a-z0-9])' : '';
      return new RegExp(`${lead}${escapeRegExp(t)}${tail}`);
    });
  return (haystack) => res.some((re) => re.test(haystack));
}
// Two built-in signals the config lists cannot express with plain terms:
// "<city>, CO" for a Front Range town not in local_terms (never "co-founder"
// or "Co."), and "US based" / "US remote" / "US time zones" phrasing for a
// posting that names no state or city at all.
const LOCAL_STATE_RE = /,\s*co(?![a-z0-9-])/;
const US_CONTEXT_RE = /(?<![a-z0-9])u\.?s\.?[- ](?:based|only|remote|residents?|citizens?|time ?zones?|hours|nationwide)(?![a-z0-9])/;

// A structured location field that names ONLY the country, nothing else, is
// how Workday/iCIMS/Greenhouse boards tag a nationwide requisition -- not an
// unknown location. Evidence (a self-hosted node's held pile, 2026-09-17): Peraton "Cloud
// Engineer - GRC | United States" and Elastic "Principal Software Engineer -
// Vector Search | United States" both scored 20-25 and held below
// ship_min_score 40, because neither the literal word "remote" nor the
// US_CONTEXT_RE phrasing ("US based" / "US remote" / etc) appears in a bare
// "United States" -- only the boundaryMatcher(remote_us_terms) hit fires, and
// only once `remoteWord` is also true. Anchored on the whole (already
// normText'd) field so it never matches a country name alongside a city/state
// ("Boston, MA, United States") or a multi-location rollup ("2 Locations") --
// those carry real information the country-only case doesn't.
const BARE_US_COUNTRY_RE = /^(?:united states(?: of america)?|u\.?s\.?a?\.?)$/;
export function isBareUsCountry(locationText) {
  return BARE_US_COUNTRY_RE.test(normText(locationText));
}

// A small, best-effort list of non-US country/region/city hints for the
// `non_us_only` PENALTY only (never a drop — the scanner's own
// location_filter, rendered from the hub's portals.yml, already decided what
// reaches the pipeline at all; this is a softer secondary signal scoreFind
// applies on top). Deliberately not exhaustive: a miss here just means no
// penalty is applied, which is the safe direction for a signal that only
// ever subtracts points.
const NON_US_HINTS = [
  'india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'delhi', 'chennai',
  'pakistan', 'philippines', 'manila', 'bangladesh', 'nigeria', 'lagos',
  'united kingdom', 'uk', 'london', 'ireland', 'dublin',
  'canada', 'toronto', 'vancouver', 'montreal',
  'germany', 'berlin', 'munich', 'france', 'paris', 'spain', 'madrid', 'poland', 'warsaw',
  'mexico', 'brazil', 'sao paulo', 'argentina', 'colombia', 'bogota',
  'emea', 'apac', 'latam',
];

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score one pending find against the node's criteria.
 *
 * Deterministic, zero network/LLM — the whole point of the node per
 * AGENTS.md. Reasons and weights are additive; drop conditions are checked
 * in a fixed order (title -> comp -> liveness) and the FIRST one found wins
 * as `drop_reason` — a row rarely trips more than one, and callers that only
 * need "why was this dropped" get one clear answer rather than a list.
 *
 * @param {{url: string, company: string, title: string, location: string,
 *   comp: {min:number,max:number,currency:string}|null, posted: string|null,
 *   trust: {score:number, flags:string[]}|null}} row - from parsePipelineRows().
 * @param {{
 *   criteria: {
 *     titleFilter?: {positive?: string[], negative?: string[], seniority_boost?: string[]},
 *     targetRoles?: {primary?: string[], archetypeNames?: string[]},
 *     floorUsd?: number|null,
 *   },
 *   rank?: {local_terms?: string[], remote_us_terms?: string[], floor_usd?: number|null,
 *     weights?: Record<string,number>, penalties?: Record<string,number>},
 *   cvSkills?: string[]|Set<string>,
 *   trackedCompanies?: Set<string>,
 *   jdText?: string|null,
 *   liveness?: 'active'|'uncertain'|'expired'|null,
 *   now?: number,
 * }} ctx
 * @returns {{score: number, reasons: string[], drop_reason: string|null}}
 */
export function scoreFind(row, ctx = {}) {
  const rank = ctx.rank || {};
  const weights = rank.weights || {};
  const penalties = rank.penalties || {};
  const w = (key) => Number(weights[key]) || 0;
  const pen = (key) => Number(penalties[key]) || 0;

  const reasons = [];
  let score = 0;
  let dropReason = null;

  // -- title --
  const title = row.title || '';
  const lowerTitle = normText(title);
  const targetRoleNames = [
    ...(ctx.criteria?.targetRoles?.primary || []),
    ...(ctx.criteria?.targetRoles?.archetypeNames || []),
  ].map((n) => stripLevelWords(normText(n))).filter(Boolean);
  // The posting title must contain the target ROLE, its level words removed:
  // "Senior Software Engineer" in the profile is the role "software engineer"
  // at a level, and "Software Engineer II - Builder Experience" names that
  // role. Until 2026-10-31 the level word had to appear too, so that title —
  // a mid-to-senior posting the candidate reached interviews for — earned 12
  // where "Senior Software Engineer, anything" earned 40. Titles inflate and
  // deflate from one company to the next ("II" at one is "Senior" at
  // another), so the level is the triage model's call, read from the duties;
  // the `seniority` weight below is a tie-break. Still ONE direction: a title
  // that merely shares words with a role ("Platform Engineer" for "Senior
  // Software Engineer") is not a primary match.
  const matchesTargetRole = Boolean(lowerTitle) && targetRoleNames.some((n) => lowerTitle.includes(n));
  const titlePositive = compileKeywordList(ctx.criteria?.titleFilter?.positive, compilePositiveKeyword);
  const titleNegative = compileKeywordList(ctx.criteria?.titleFilter?.negative, compileKeyword);
  const seniorityBoost = compileKeywordList(ctx.criteria?.titleFilter?.seniority_boost, compileKeyword);

  if (matchesTargetRole) {
    reasons.push('title_primary');
    score += w('title_primary');
  } else if (titlePositive.some((match) => match(lowerTitle))) {
    reasons.push('title_secondary');
    score += w('title_secondary');
  }
  // Safety net: checked regardless of the branch above, so a title that
  // happens to also carry a target-role phrase but is unambiguously
  // unwanted ("Senior Platform Sales Engineer" if "sales" is negative-listed)
  // still drops.
  if (titleNegative.some((match) => match(lowerTitle))) {
    reasons.push('title_negative');
    dropReason = dropReason || 'title_negative';
  }

  const tier = classifyTier(title);
  if (seniorityBoost.some((match) => match(lowerTitle)) || tier === 'senior') {
    reasons.push('seniority');
    score += w('seniority');
  } else if (tier === 'entry' || tier === 'intern') {
    reasons.push('entry_or_intern');
    score += pen('entry_or_intern');
  }

  // -- location --
  const jdSnippet = ctx.jdText ? String(ctx.jdText).slice(0, 400) : '';
  const haystack = normText(`${row.location || ''} ${title} ${jdSnippet}`);
  const locationOnly = normText(row.location || '');
  // `location_filter.primary` is the hub-wide answer to "where do I most want
  // to work"; `rank.local_terms` is this node's own override of the same idea
  // (a second node targeting a different metro keeps its own list). Unioned,
  // so setting the Targeting card on the dashboard reaches the node's ranking
  // without anyone editing config/discovery-node.yml on the box.
  const policy = ctx.criteria?.locationPolicy || { primary: [], authorized: [], sponsorRequired: [] };
  const localMatch = boundaryMatcher([...(rank.local_terms || []), ...(policy.primary || [])])(haystack)
    || LOCAL_STATE_RE.test(locationOnly);
  const usTermMatch = boundaryMatcher(rank.remote_us_terms)(haystack) || US_CONTEXT_RE.test(haystack);
  const remoteWord = /(?<![a-z0-9])remote(?![a-z0-9])/.test(haystack);
  const nonUsHint = boundaryMatcher(NON_US_HINTS)(haystack);
  const bareUsCountry = isBareUsCountry(locationOnly);
  // Somewhere the candidate may work with no sponsor, and somewhere they want
  // but would need one for. Both are wanted; they rank differently.
  //
  // `location_filter.authorized` is the targeting CHOICE ("these are places I
  // want to look"); `profile.yml`'s `location.authorized_in` is the legal FACT
  // ("these are places I may already work"). They answer the same scoring
  // question from opposite directions, so they are unioned — a candidate
  // authorized in the UK gets `authorized_location` on a London posting even
  // when nobody remembered to add the UK to the Targeting card.
  const authorizedMatch = boundaryMatcher([
    ...(policy.authorized || []),
    ...(ctx.criteria?.preferences?.authorized_in || []),
  ])(haystack);
  const sponsorMatch = boundaryMatcher(policy.sponsorRequired)(haystack);

  // AN EXPLICIT INTERNATIONAL SIGNAL BEATS AN ACCIDENTAL LOCAL ONE, and this
  // ordering is load-bearing rather than cosmetic.
  //
  // `local_terms` are city names, and nine of the sixteen shipped ones are a
  // whole word somewhere else: Lakewood NJ/CA/OH, Littleton MA/NH, Englewood NJ,
  // Aurora IL/ON, Louisville KY, Golden Valley MN, Boulder City NV, Centennial
  // Campus NC. Word-boundary matching does not help — they genuinely ARE whole
  // words there. Most of those are harmless mis-rankings of a US posting.
  //
  // One is not. "Westminster, London, UK" matched `Westminster` and took this
  // branch, so a role that needs a visa scored as the candidate's home metro
  // (+20, the highest location tier) AND never reached the sponsor_required
  // branch below — silently skipping the sponsorship question entirely, which
  // is the worst thing this scorer can do. Deleting the ambiguous terms is not
  // the fix: the candidate really does want Lakewood and Littleton, and the
  // next such collision is one config edit away.
  //
  // So a genuine local posting is one with no international signal on it. A
  // Denver job's location string never contains "London" or "United Kingdom";
  // when both appear, the international reading is the correct one, and being
  // wrong in this direction costs a mis-rank rather than a hidden visa
  // requirement.
  const internationalSignal = sponsorMatch || (nonUsHint && !usTermMatch && !remoteWord);
  if (localMatch && !internationalSignal) {
    reasons.push('local');
    score += w('local');
  } else if (bareUsCountry || (remoteWord && (usTermMatch || !nonUsHint))) {
    reasons.push('remote_us');
    score += w('remote_us');
  } else if (authorizedMatch) {
    reasons.push('authorized_location');
    score += w('authorized_location');
  } else if (sponsorMatch) {
    reasons.push('sponsor_required_location');
    score += w('sponsor_required_location');
  } else if (nonUsHint && !usTermMatch && !remoteWord) {
    // Penalty only — the scanner's own location_filter already decided this
    // posting was worth surfacing at all.
    //
    // The two branches above are what keep this honest. NON_US_HINTS lists
    // `london`, `dublin`, `ireland` and `united kingdom` among others, so
    // before `location_filter`'s tiers reached the scorer this docked 25
    // points — against a ship threshold of 40 — from every posting in a city
    // the candidate had explicitly asked for. The penalty now means "outside
    // every authorized-or-sponsorable location", not "not US". With none of the
    // three tiers configured both matchers are inert and this behaves exactly
    // as it did.
    reasons.push('non_us_only');
    score += pen('non_us_only');
  }

  // -- the candidate's own stated preferences --
  // Additive, with exactly one gate (an explicit refusal to sponsor someone who
  // needs it). See autopilot/lib/discovery-preferences.mjs for why silence is
  // never a drop.
  const prefSignals = preferenceSignals({
    haystack,
    fullText: ctx.jdText ? normText(ctx.jdText) : '',
    prefs: ctx.criteria?.preferences || null,
    local: localMatch,
    remote: remoteWord || bareUsCountry,
    elsewhere: authorizedMatch || sponsorMatch || nonUsHint,
    sponsorLocation: sponsorMatch,
  });
  for (const sig of prefSignals.signals) {
    reasons.push(sig.reason);
    score += sig.kind === 'penalty' ? pen(sig.key) : w(sig.key);
  }
  if (prefSignals.drop) dropReason = dropReason || prefSignals.drop;

  // -- compensation --
  // A posted band that tops out under the candidate's floor is a PENALTY
  // (`penalties.comp_below_floor`), never a drop (2026-10-29): a strong local
  // senior role with a low posted band is still worth a look, and the
  // evaluation step weighs the whole package. A posting that states no pay
  // at all scores nothing either way — `comp-unknown` is a visible reason,
  // not a deduction. Only `comp_at_or_above_floor` adds points.
  const floor = Number.isFinite(rank.floor_usd) ? rank.floor_usd : ctx.criteria?.floorUsd;
  const comp = row.comp || (ctx.jdText ? parseCompensation(ctx.jdText) : null);
  if (comp && Number.isFinite(floor)) {
    const hasMin = Number.isFinite(comp.min) && comp.min > 0;
    const hasMax = Number.isFinite(comp.max) && comp.max > 0;
    if (hasMin && hasMax) {
      if (comp.max < floor) {
        reasons.push('comp_below_floor');
        score += pen('comp_below_floor');
      } else if (comp.min >= floor) {
        reasons.push('comp_at_or_above_floor');
        score += w('comp_at_or_above_floor');
      } else {
        reasons.push('comp-straddles-floor');
      }
    } else if (hasMin || hasMax) {
      // Only one bound known — a lower bar (floor x 0.9) before penalising,
      // since a lone number might be a stated minimum on a range whose real
      // ceiling is comfortably above the floor.
      const only = hasMax ? comp.max : comp.min;
      if (only < floor * 0.9) {
        reasons.push('comp_below_floor');
        score += pen('comp_below_floor');
      } else if (only >= floor) {
        reasons.push('comp_at_or_above_floor');
        score += w('comp_at_or_above_floor');
      } else {
        reasons.push('comp-straddles-floor');
      }
    } else {
      reasons.push('comp-unknown');
    }
  } else {
    reasons.push('comp-unknown');
  }

  // -- freshness --
  const now = ctx.now ?? Date.now();
  if (row.posted) {
    const postedMs = Date.parse(row.posted);
    if (Number.isFinite(postedMs)) {
      const days = (now - postedMs) / 86_400_000;
      if (days <= 3) { reasons.push('fresh_3d'); score += w('fresh_3d'); }
      else if (days <= 14) { reasons.push('fresh_14d'); score += w('fresh_14d'); }
      else if (days > 45) { reasons.push('stale_45d'); score += pen('stale_45d'); }
    }
  }

  // -- ats / tracked-company / trust --
  let atsRef = null;
  try { atsRef = parseAtsUrl(row.url); } catch { atsRef = null; }
  if (atsRef) { reasons.push('ats_direct'); score += w('ats_direct'); }

  if (ctx.trackedCompanies instanceof Set && ctx.trackedCompanies.has(normalizeCompany(row.company))) {
    reasons.push('tracked_company');
    score += w('tracked_company');
  }

  if (row.trust && Number.isFinite(row.trust.score) && row.trust.score < 100) {
    reasons.push('trust_flagged');
    score += pen('trust_flagged');
  }

  // -- stack overlap --
  if (ctx.jdText && ctx.cvSkills) {
    const skills = ctx.cvSkills instanceof Set ? [...ctx.cvSkills] : Array.from(ctx.cvSkills);
    const jdLower = String(ctx.jdText).toLowerCase();
    let distinct = 0;
    for (const skill of skills) {
      if (!skill) continue;
      // Not \b: ".net" and "c#" start/end on a non-word char, so \b never
      // fires for them and two of this candidate's core skills never matched.
      if (new RegExp(`(?<![a-z0-9])${escapeRegExp(skill)}(?![a-z0-9])`, 'i').test(jdLower)) distinct++;
    }
    const cap = Number(weights.stack_match_max) || 0;
    const stackScore = Math.min(cap, 3 * distinct);
    if (stackScore > 0) { reasons.push('stack_match'); score += stackScore; }
  }

  // -- liveness --
  if (ctx.liveness === 'expired') {
    reasons.push('expired');
    dropReason = dropReason || 'expired';
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, drop_reason: dropReason };
}

/**
 * Turn a scoreFind() result into ship/hold/drop.
 *
 * Split out from scoreFind() so the threshold decision — the one knob an
 * operator actually tunes (`hub.ship_min_score`) — is testable on its own,
 * without recomputing a score for every threshold value.
 *
 * @param {{score: number, drop_reason: string|null}} scored
 * @param {number} shipMinScore - `hub.ship_min_score` from the node's config.
 * @returns {{decision: 'ship'|'hold'|'drop', drop_reason: string|null}}
 */
// The signals that say something about the posting BEYOND its title. A title
// alone — even a primary target role with a seniority word — is not enough to
// ship: title_primary (25) + seniority (15) reach the default ship_min_score
// of 40 by themselves, and a row with no location hint, no comp, no posting
// date, no ATS/tracked-company provenance and no stack overlap is exactly the
// row the node knows least about. Every ATS-API-sourced row carries
// ats_direct, and every LinkedIn/aggregator row a posting date, so in practice
// this only holds back a bare title from an unknown source.
export const CORROBORATING_REASONS = new Set([
  'local', 'remote_us', 'comp_at_or_above_floor', 'fresh_3d', 'fresh_14d', 'ats_direct', 'tracked_company', 'stack_match',
]);

export function decideFind(scored, shipMinScore = 40) {
  if (scored?.drop_reason) return { decision: 'drop', drop_reason: scored.drop_reason };
  const score = Number(scored?.score) || 0;
  if (score < shipMinScore) return { decision: 'hold', drop_reason: null };
  const reasons = Array.isArray(scored?.reasons) ? scored.reasons : [];
  const corroborated = reasons.some((r) => CORROBORATING_REASONS.has(r));
  return { decision: corroborated ? 'ship' : 'hold', drop_reason: null, ...(corroborated ? {} : { hold_reason: 'title-only' }) };
}

// ── Target-role names from the profile's archetypes ─────────────────────

/**
 * The strings a posting title must CONTAIN to count as a primary match, from
 * the profile's `target_roles.archetypes`. Only `fit: primary` archetypes,
 * and each one prefixed with its level ("Senior/Staff" fans out to "Senior …"
 * and "Staff …"). scoreFind compares them with the level words removed since
 * 2026-10-31 (stripLevelWords), so the prefix no longer decides a match; it
 * is kept because these strings travel in the hub's criteria payload, and a
 * node still running the older scoreFind reads them as before.
 * The name itself stays as written; an archetype phrased "AI Platform / LLMOps
 * Engineer" will rarely appear verbatim in a title, which is the safe
 * direction (title_secondary through the positive keywords still applies).
 *
 * @param {Array<{name?: string, level?: string, fit?: string}>|undefined} archetypes
 * @returns {string[]}
 */
export function archetypeRoleNames(archetypes) {
  const out = [];
  for (const a of Array.isArray(archetypes) ? archetypes : []) {
    if (!a || typeof a.name !== 'string' || !a.name.trim()) continue;
    if (String(a.fit || '').toLowerCase() !== 'primary') continue;
    const levels = String(a.level || '').split('/').map((l) => l.trim()).filter(Boolean);
    if (!levels.length) continue; // no level = no seniority word = not a primary-match string
    for (const level of levels) out.push(`${level} ${a.name.trim()}`);
  }
  return [...new Set(out)];
}

// ── CV skills (§4.4.5 stack overlap) ────────────────────────────────────

/**
 * Lowercase skill tokens (>=3 chars) out of cv.md's `## Technical Skills`
 * section, split on `,;/·|` and newlines — the vocabulary scoreFind() checks
 * a JD for whole-word overlap against. Mirrors the same
 * `(?=^## |(?![\s\S]))` "next heading or end of file" idiom
 * autopilot/lib/util.mjs's loadWritingStyle() uses to bound a markdown section.
 *
 * @param {string} cvText - cv.md contents.
 * @returns {string[]} Deduplicated lowercase tokens.
 */
// Category labels and filler that the real cv.md section format
// ("- **Cloud/DevOps:** AWS, Azure, ...") would otherwise leak in as "skills"
// — a JD mentioning "code" or "tools" is not a stack match.
const SKILL_STOPLIST = new Set(['and', 'the', 'with', 'other', 'tools', 'platforms', 'languages', 'frameworks',
  'cloud', 'code', 'studio', 'etc', 'misc', 'various', 'more', 'skills', 'technical']);
// Short tokens worth keeping despite the >= 3 rule.
const SHORT_SKILLS = new Set(['c#', 'c++', '.net', 'go', 'r']);
export function cvSkillsFromMarkdown(cvText) {
  const text = String(cvText ?? '');
  const m = text.match(/^##\s+Technical Skills\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return [];
  const tokens = m[1]
    .split(/\r?\n/)
    // Drop the bullet + bold category label first ("- **Cloud/DevOps:** " and
    // "**Languages/Frameworks:**"), so the label never survives a later "/"
    // split as "devops:** aws" — which is what happened against the real
    // cv.md before this.
    .map((line) => line.replace(/^\s*[-*+]?\s*\*\*[^*]*\*\*\s*:?\s*/, '').replace(/^\s*[-*+]\s+/, ''))
    .flatMap((line) => line.split(/[,;/·|]+/))
    // Trim surrounding markup/punctuation but KEEP a leading "." or a
    // trailing "#"/"+" — ".NET", "C#" and "C++" are the tokens, not "net"/"c".
    .map((t) => t.replace(/^[\s*"'():]+|[\s*"'():]+$/g, '').trim().toLowerCase())
    .filter((t) => t && !SKILL_STOPLIST.has(t) && (t.length >= 3 || SHORT_SKILLS.has(t)))
    // "go" and "r" survive the short-token rule only when written as such in
    // the CV; still too noisy as whole words in prose to count elsewhere.
    .filter((t) => t !== 'go' && t !== 'r');
  return [...new Set(tokens)];
}

// ── Scheduler (§4.3) ─────────────────────────────────────────────────────

// Fixed priority order the scheduler picks from — never-run jobs are chosen
// in THIS order, and it is also the tie-break when two jobs are equally
// overdue.
// Quick sources first, the multi-hour reverse-ATS sweep LAST: on a fresh node
// (or after a criteria change) every never-run job is started in this order,
// one at a time, so the first hour covers the tracked boards, the aggregators,
// the board-wide providers and the local employers before ats_full occupies
// the scanner slot for up to six hours. Once every job has run at least once,
// the MOST overdue due job wins regardless of this order (planNextJob).
// `sources` before `resolve` is load-bearing on a fresh node, not cosmetic:
// never-run jobs are started in exactly this array order, and `resolve` drains
// the frontier `sources` fills. Reversed, the node's first `resolve` pass would
// find an empty ledger, record a run, and not come back round for its own
// every_minutes.
export const SCANNER_JOB_ORDER = ['tracked', 'aggregators', 'sources', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full'];

/**
 * The "start at HH:MM, then every N" spec of a job, or null for a plain
 * interval job (no `start_at`, or an unreadable one).
 *
 * @param {{start_at?: string, every_minutes?: number}|undefined} jobCfg
 * @returns {{start_at: string, every_ms: number}|null}
 */
export function slotSpec(jobCfg) {
  const startAt = normalizeHHMM(jobCfg?.start_at);
  if (!startAt) return null;
  return { start_at: startAt, every_ms: Math.max(1, Number(jobCfg.every_minutes) || 0) * 60_000 };
}

// Whether a slot job is waiting to run. `last_slot_at` is the SLOT the job last
// ran for. A job that predates the slot (it has a last_run_at but never a
// last_slot_at — the start time was just added) counts as having served the slot
// its last run fell in, so adding a start time never re-runs a job that ran
// minutes ago, while one whose last run was before the latest slot still catches
// up. A job that has never run at all is due at once, like any never-run job.
function slotState(spec, rec, now) {
  const lastRun = Date.parse(rec?.last_run_at || '');
  const served = rec?.last_slot_at ?? (Number.isFinite(lastRun) ? lastSlotAtOrBefore(spec, lastRun) : null);
  return slotDue(spec, { now, last_slot_at: served, max_late_ms: spec.every_ms });
}

/**
 * Pick the single most-overdue enabled scanner job, or null when nothing is
 * due. Pure: given the same `jobsConfig`/`state`/`now`, always the same
 * answer — the daemon's tick loop just asks this and acts.
 *
 * Two kinds of job. An INTERVAL job (the default) is due `every_minutes` after
 * it last finished; a never-run one is picked first, in SCANNER_JOB_ORDER. A
 * SLOT job (`start_at` set) is due when the latest "HH:MM, then every N" slot
 * has not been served yet, and is a candidate ONLY then — never-run precedence
 * does not apply to it, so a start time the user chose is not jumped by a job
 * that has simply never run. Among everything due, the most overdue wins and a
 * tie goes to SCANNER_JOB_ORDER.
 *
 * @param {Record<string, {enabled?: boolean, every_minutes?: number, start_at?: string}>} jobsConfig - `cfg.jobs`.
 * @param {{jobs?: Record<string, {last_run_at?: string|null, last_slot_at?: string|null}>}} state - the node's state.json shape.
 * @param {number} [now]
 * @returns {string|null}
 */
export function planNextJob(jobsConfig = {}, state = {}, now = Date.now()) {
  const jobs = state.jobs || {};
  let neverRun = null;
  let best = null;
  let bestOverdueMs = -Infinity;
  for (const name of SCANNER_JOB_ORDER) {
    const cfg = jobsConfig?.[name];
    if (!cfg || cfg.enabled === false) continue;
    const spec = slotSpec(cfg);
    if (spec) {
      const due = slotState(spec, jobs[name], now);
      if (due.due) {
        const overdueMs = now - due.slot.getTime();
        if (overdueMs > bestOverdueMs) { bestOverdueMs = overdueMs; best = name; }
      }
      continue;
    }
    const everyMs = Math.max(1, Number(cfg.every_minutes) || 0) * 60_000;
    const lastRunAtRaw = jobs[name]?.last_run_at;
    const lastRunAt = lastRunAtRaw ? Date.parse(lastRunAtRaw) : NaN;
    if (!Number.isFinite(lastRunAt)) {
      if (!neverRun) neverRun = name;
      continue;
    }
    const overdueMs = (now - lastRunAt) - everyMs;
    if (overdueMs >= 0 && overdueMs > bestOverdueMs) {
      bestOverdueMs = overdueMs;
      best = name;
    }
  }
  return neverRun || best;
}

/**
 * When a job will next be picked: an interval job `every_minutes` after it last
 * ran, a slot job at the slot it has waiting (already past: it is due) or else
 * the next one. Null when it has no basis yet (an interval job that never ran).
 *
 * @param {{every_minutes?: number, start_at?: string}|undefined} jobCfg
 * @param {{last_run_at?: string|null, last_slot_at?: string|null}} [rec]
 * @param {number} [now]
 * @returns {string|null} ISO timestamp.
 */
export function jobNextRunAt(jobCfg, rec = {}, now = Date.now()) {
  const spec = slotSpec(jobCfg);
  if (spec) {
    const due = slotState(spec, rec, now);
    if (due.due) return due.slot.toISOString();
    return nextSlotAfter(spec, now)?.toISOString() ?? null;
  }
  const everyMinutes = Number(jobCfg?.every_minutes) || null;
  const lastRunAt = rec?.last_run_at || null;
  return lastRunAt && everyMinutes ? new Date(Date.parse(lastRunAt) + everyMinutes * 60_000).toISOString() : null;
}

// Which script each scanner job spawns. 'aggregators' and 'sources' run
// in-process (runAggregators() from autopilot/lib/aggregators.mjs and
// runSources() from autopilot/lib/discovery-sources.mjs, called directly by the
// daemon) and 'validate'/'ship'/'heartbeat'/'criteria' are not scanner
// children at all — buildScannerCommand() returns null for all of those, and
// the daemon special-cases them instead of shelling out.
//
// Exported since the crawler landed: tests/discovery-node-jobs.test.mjs asserts
// every job name is present in ALL the hand-maintained lists that have to agree
// (this map, SCANNER_JOB_ORDER, the daemon's ONCE_JOBS and its --once dispatch,
// and the shipped example config). Each of those was previously edited by hand
// with no cross-check, and the failure when one is missed is silent — a job
// that runs under --once but is never scheduled, or vice versa.
export const SCANNER_SCRIPTS = {
  tracked: 'scripts/scan/scan.mjs',
  ats_full: 'scripts/scan/scan-ats-full.mjs',
  seeds: 'scripts/scan/scan-ats-full.mjs',
  boards: 'scripts/scan/scan.mjs',
  local_employers: 'scripts/scan/discover-ats.mjs',
  resolve: 'scripts/scan/resolve-careers.mjs',
};

// The jobs the daemon runs inside its own process rather than spawning. Kept
// beside SCANNER_SCRIPTS (and asserted disjoint from it) so the two can never
// both claim a name — a job in both would be spawned AND run in-process.
export const IN_PROCESS_JOBS = ['aggregators', 'sources'];

// What `--ats` means when ats_full names none: scripts/scan/scan-ats-full.mjs's
// DEFAULT_ATS (tests/discovery-node.test.mjs pins the two equal). One copy here so
// the command line and the checkpoint check below cannot disagree about it.
const ATS_FULL_DEFAULT = 'greenhouse,lever,ashby,workday,icims';
/** The list the scanner will parse out of `--ats <value>` (its parseArgs, verbatim). */
const atsList = (value) => String(value || ATS_FULL_DEFAULT).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Build the argv/env for one scanner job's child process, WITHOUT spawning
 * it — spawning is the daemon's job (it owns cwd, stdio piping and the
 * max_minutes kill timer). `file` is repo-relative; the daemon spawns with
 * `cwd` set to the repo root, which is what lets a relative
 * `CAREER_OPS_PORTALS` value (as written here for `boards`, matching the
 * literal spec example) resolve correctly — see autopilot/discovery-node.mjs's
 * spawn comment for why cwd must be the repo root (scan.mjs/scan-ats-full.mjs
 * resolve their DATA_ROOT and default portals path relative to it).
 *
 * @param {'tracked'|'ats_full'|'seeds'|'boards'|'local_employers'} jobName
 * @param {object} cfg - `cfg.jobs[jobName]` from the node's config.
 * @param {{env?: NodeJS.ProcessEnv, boardsPortals?: string,
 *   localEmployersInput?: string, resolveInput?: string,
 *   atsCheckpointExists?: boolean}} [paths] - test seam.
 * @returns {{file: string, args: string[], env: object}|null}
 */
export function buildScannerCommand(jobName, cfg = {}, paths = {}) {
  if (!Object.prototype.hasOwnProperty.call(SCANNER_SCRIPTS, jobName)) return null;
  const file = SCANNER_SCRIPTS[jobName];
  const env = { ...(paths.env || process.env) };
  // "env = inherited minus CAREER_OPS_PORTALS" for every job except `boards`,
  // which sets it explicitly below — an ambient value (left over from a
  // previous `boards` run's environment, or set on the box for some other
  // reason) must never leak into `tracked`/`ats_full`/`seeds`/`local_employers`.
  delete env.CAREER_OPS_PORTALS;
  const args = [];

  if (jobName === 'ats_full') {
    args.push('--since', String(cfg.since_days ?? 3));
    args.push('--ats', String(cfg.ats || ATS_FULL_DEFAULT));
    // Opt-in: six of the stapply ATS sources emit no posting date at all, so
    // without this they return nothing (see scan-ats-full.mjs's header).
    if (cfg.include_undated === true) args.push('--include-undated');
    if (cfg.resume && paths.atsCheckpointExists) args.push('--resume');
  } else if (jobName === 'seeds') {
    args.push('--seeds', String(cfg.seeds || ''));
    args.push('--since', String(cfg.since_days ?? 7));
  } else if (jobName === 'boards') {
    env.CAREER_OPS_PORTALS = paths.boardsPortals || 'data/discovery-node/portals-boards.yml';
  } else if (jobName === 'resolve') {
    // Same preview-only contract as local_employers below: the resolver has no
    // --write flag at all, and the node's portals.yml is only ever produced by
    // the render-from-criteria path in autopilot/discovery-node.mjs.
    args.push('--in', paths.resolveInput || 'data/discovery-node/resolve-input.yml');
    if (Number.isFinite(Number(cfg.concurrency))) args.push('--concurrency', String(cfg.concurrency));
    if (Number.isFinite(Number(cfg.host_gap_ms))) args.push('--host-gap-ms', String(cfg.host_gap_ms));
  } else if (jobName === 'local_employers') {
    // Preview mode only — NEVER --write (see AGENTS.md's Data Contract: the
    // node's own portals.yml is a machine-written CACHE, never edited by
    // hand, but discover-ats.mjs's --write would append straight into it
    // outside the render-from-criteria path this file owns).
    args.push('--in', paths.localEmployersInput || 'data/discovery-node/local-employers-input.yml');
  }

  return { file, args, env };
}

/**
 * Is the saved ats_full checkpoint one `--resume` will accept under this job's
 * config? scan-ats-full.mjs's checkpointCompatible exits 1 on a checkpoint
 * written with a different `--ats` list, `--limit` or undated policy, and a
 * refused resume repeats every interval until somebody deletes the file. Not
 * passing --resume starts a fresh sweep instead. The node never passes --limit,
 * so a checkpoint that carries one (a hand run) is not ours to resume either.
 */
export function atsCheckpointResumable(checkpoint, jobCfg = {}) {
  return checkpoint?.version === 1
    && checkpoint.includeUndated === (jobCfg?.include_undated === true)
    && (checkpoint.limit ?? null) === null
    && JSON.stringify(checkpoint.ats) === JSON.stringify(atsList(jobCfg?.ats));
}

// ── One node per checkout ───────────────────────────────────────────────
//
// A node is started by hand now (a double-click on the launcher), so a second
// launch in the same folder is an everyday slip, not an operator error. Without
// a guard the second process starts normally, picks the next dashboard port, and
// two schedulers then validate and ship the same pending rows against one
// state.json that each overwrites from its own memory.

/** Is a process with this id running? EPERM means it is, and is not ours to signal. */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

const lockAgeMs = (file) => { try { return Date.now() - statSync(file).mtimeMs; } catch { return Infinity; } };

function readLockHolder(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    const pid = Number(doc?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const port = Number(doc.dashboard_port);
    return {
      pid,
      started_at: typeof doc.started_at === 'string' ? doc.started_at.slice(0, 40) : null,
      dashboard_port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    };
  } catch { return null; }
}

// When this computer last booted, less a minute of slack for clock adjustment.
const bootedAtMs = () => Date.now() - osUptime() * 1000 - 60_000;

/**
 * Take the single-instance lock for this checkout: an exclusively created file
 * holding the owner's pid. A lock whose owner is gone (the computer crashed, the
 * process was killed) or whose content is unreadable (a crash mid-write) is
 * stale and is taken over; one held by a live process is not.
 *
 * A lock written before the computer last booted is stale too, whatever process
 * holds its pid now: pids are handed out again soon after a reboot, and a
 * supervised node (Task Scheduler) restarted after a power cut would otherwise
 * refuse to start for as long as an unrelated process kept that number. Within
 * one boot it still cannot tell a live node from an unrelated process handed the
 * same pid, so the refusal message says how to clear the file by hand.
 *
 * @param {string} file
 * @param {{pid?: number, isAlive?: (pid: number) => boolean, now?: () => string, bootedAt?: () => number}} [opts] - test seams.
 * @returns {{ok: true, update: (extra: object) => void, release: () => void}
 *   | {ok: false, holder: {pid: number, started_at: string|null, dashboard_port: number|null}|null}}
 */
export function acquireInstanceLock(file, { pid = process.pid, isAlive = pidIsAlive, now = () => new Date().toISOString(), bootedAt = bootedAtMs } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const record = { pid, started_at: now(), dashboard_port: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(record), { flag: 'wx' });
      const ours = () => readLockHolder(file)?.pid === pid;
      return {
        ok: true,
        // Never rewrite or remove a lock somebody else holds now.
        update(extra) { if (ours()) writeFileSync(file, JSON.stringify({ ...record, ...extra })); },
        release() { if (ours()) { try { unlinkSync(file); } catch { /* already gone */ } } },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const holder = readLockHolder(file);
    const beforeBoot = holder && Date.parse(holder.started_at) < bootedAt();
    if (holder && holder.pid !== pid && !beforeBoot && isAlive(holder.pid)) return { ok: false, holder };
    // An unreadable lock this young is another launcher between creating the file
    // and writing its pid into it, not a crash: leave it.
    if (!holder && lockAgeMs(file) < 5_000) return { ok: false, holder: null };
    try { unlinkSync(file); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  }
  return { ok: false, holder: readLockHolder(file) };
}

/** What a refused second launch tells the person. Never mentions the dashboard's access key (it is not in the lock). */
export function instanceRefusalMessage(holder, lockPath = 'data/discovery-node/daemon.lock') {
  const where = holder
    ? `process ${holder.pid}${holder.started_at ? `, started ${holder.started_at}` : ''}${holder.dashboard_port ? `; its dashboard is on http://127.0.0.1:${holder.dashboard_port}/` : ''}`
    : 'another copy is starting right now';
  return `This node is already running from this folder (${where}). Use that window, or close it first: two copies would check and send the same finds twice. `
    + `If nothing is running (the computer crashed, say), delete ${lockPath} and start again.`;
}

// ── Rendered files (§4.2) ───────────────────────────────────────────────

const MACHINE_HEADER =
  '# MACHINE-WRITTEN by autopilot/discovery-node.mjs from the hub\'s criteria — '
  + 'edit portals.yml on the autopilot host instead.\n';

function loadYamlDocOrEmpty(text) {
  if (!text) return {};
  let doc;
  try { doc = yaml.load(text); } catch { return {}; }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

/**
 * Dedup key for a `job_boards` entry.
 *
 * `tracked_companies` dedups on the company name, but a board entry has no
 * company — two entries are the same board when they point at the same place.
 * A URL is the identity when one exists (normalized: lowercased host, path
 * without a trailing slash). Otherwise the identity is the provider plus
 * whatever provider-specific fields distinguish this entry from its siblings,
 * and `name` is deliberately excluded from that: two entries for the same
 * board under different labels ("RemoteOK" / "Remote OK") are one board and
 * must collapse, while seven `getro` entries for seven different VC portfolio
 * collections, or five `torre` entries for five queries, each carry their own
 * distinguishing field and must NOT.
 *
 * `enabled` is excluded for the same reason `name` is — it is bookkeeping, not
 * identity; an entry disabled on one side is still the same board.
 *
 * @param {object} entry - A `job_boards`-shaped entry.
 * @returns {string} A stable key, or '' when the entry is unusable.
 */
export function boardKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.api || entry.careers_url || '';
  if (raw) {
    try {
      const u = new URL(String(raw));
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      // Not a URL — fall through to the provider key rather than silently
      // returning '' and letting every malformed entry dedup against every
      // other malformed entry.
    }
  }
  const provider = String(entry.provider || '').trim().toLowerCase();
  const rest = Object.keys(entry)
    .filter((k) => k !== 'name' && k !== 'provider' && k !== 'enabled')
    .sort()
    .map((k) => `${k}=${JSON.stringify(entry[k])}`)
    .join('&');
  if (provider) return rest ? `${provider}?${rest}` : provider;
  const name = normalizeCompany(entry.name || '');
  return name ? `name:${name}` : '';
}

/**
 * Merge the three sources of `job_boards` entries a node's portals.yml draws
 * on, in descending precedence: the node's own `boards:` config, then the
 * hub's own `job_boards:`, then boards the `resolve` job fingerprinted.
 *
 * THE HUB'S OWN BOARDS USED TO BE DISCARDED HERE. Both renderers did a flat
 * `doc.job_boards = boards`, replacing the hub's list with the node's, while
 * config/discovery-node.example.yml described its `boards:` block as entries
 * "this node adds ON TOP OF the hub's own portals.yml". Nobody could notice,
 * because the admin's own portals.yml carried no `job_boards:` key at all —
 * until 2026-09-18, when 34 were added to it and the node would have silently
 * dropped every one.
 *
 * PRECEDENCE IS BY PROVIDER, NOT BY ENTRY, and that matters for one provider in
 * particular. If the node's config names a provider at all, the hub's entries
 * for that provider are dropped rather than merged: a self-hosted node's `linkedin-guest`
 * entry carries its own 20-search matrix tuned for this box, and unioning it
 * with the hub's differently-named entry for the same provider would produce
 * two LinkedIn guest scans in one pass — the provider paces >= 12s between
 * requests precisely because LinkedIn answers 429/999 to a faster client, so a
 * silent doubling is the one merge outcome that actively breaks a source. A
 * provider the node does NOT name passes through with all its entries intact,
 * which is what keeps the hub's seven `getro` collections and five `torre`
 * queries whole.
 *
 * @param {Array<object>} nodeBoards - The node's own `cfg.boards`.
 * @param {Array<object>} hubBoards - `job_boards` from the hub's portals.yml.
 * @param {Array<object>} discoveredBoards - What the `resolve` job fingerprinted.
 * @returns {Array<object>} Merged, deduped, node-first.
 */
export function mergeBoards(nodeBoards, hubBoards, discoveredBoards = []) {
  const node = (Array.isArray(nodeBoards) ? nodeBoards : []).filter((e) => e && typeof e === 'object');
  const nodeProviders = new Set(
    node.map((e) => String(e.provider || '').trim().toLowerCase()).filter(Boolean),
  );
  const keys = new Set(node.map((e) => boardKey(e)).filter(Boolean));
  const out = [...node];

  for (const list of [hubBoards, discoveredBoards]) {
    const fromHub = list === hubBoards;
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== 'object') continue;
      const provider = String(entry.provider || '').trim().toLowerCase();
      if (fromHub && provider && nodeProviders.has(provider)) continue;
      const key = boardKey(entry);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Render the node's own `portals.yml`: the hub's portals_yml text with
 * `job_boards:` replaced by the node's own `boards` config, and the resolved
 * local employers appended to `tracked_companies` (skipped when already
 * present, compared case-insensitively via normalizeCompany).
 *
 * Deterministic — the same inputs always produce the same text — which is
 * what lets the daemon's "written only when the rendered text changes" rule
 * (§4.2) work: it just string-compares this output against what is on disk.
 *
 * `job_boards` was a WHOLESALE replacement before the crawler landed, which was
 * fine while the node's only board list was the static `boards:` block in its
 * own config. The `resolve` job changed that: a bespoke careers page it
 * fingerprints has no company slug to track, it is a board, and it has to
 * survive the next render. So discovered boards are UNIONED on top of the
 * configured ones, deduped by `boardKey` — the config's own entry always wins
 * a collision, because that one a human wrote on purpose.
 *
 * @param {string|null} hubPortalsYmlText - `criteria.portals_yml` from the hub.
 * @param {Array<object>} boards - the node's own `cfg.boards` (job_boards entries).
 * @param {Array<{name: string}>} localEmployers - resolved tracked_companies-shaped
 *   entries (discover-ats.mjs's preview `pendingEntries`), each carrying at
 *   least a `name`.
 * @param {Array<object>} discoveredBoards - `job_boards`-shaped entries the
 *   `resolve` job fingerprinted (typically `provider: 'generic-careers'`).
 * @returns {string} Full YAML text, header included.
 */
export function renderPortalsYml(hubPortalsYmlText, boards, localEmployers = [], discoveredBoards = []) {
  const doc = loadYamlDocOrEmpty(hubPortalsYmlText);
  doc.job_boards = mergeBoards(boards, doc.job_boards, discoveredBoards);

  const existing = Array.isArray(doc.tracked_companies) ? doc.tracked_companies : [];
  const existingKeys = new Set(existing.map((e) => normalizeCompany(e?.name || '')));
  const seen = new Set();
  const toAdd = [];
  for (const entry of Array.isArray(localEmployers) ? localEmployers : []) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const key = normalizeCompany(entry.name);
    if (!key || existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    toAdd.push(entry);
  }
  doc.tracked_companies = [...existing, ...toAdd];

  return MACHINE_HEADER + yaml.dump(doc, { lineWidth: 120 });
}

// The filter keys a boards-only portals view carries over from the hub's
// portals.yml verbatim — everything that governs WHICH postings pass, never
// `tracked_companies` (the boards job scans job_boards only) and never
// anything else the hub's file might carry.
const BOARD_PORTALS_ALLOWED_KEYS = [
  'title_filter', 'location_filter', 'salary_filter', 'scan_history',
  'skip_tiers', 'max_posting_age_days', 'content_filter', 'trust_filter',
  'country_eligibility_filter', 'visa_filter',
];

/**
 * Render `data/discovery-node/portals-boards.yml` — the same filters as the
 * hub's portals.yml, `tracked_companies: []`, `job_boards: <boards>`. Used
 * only by the `boards` scanner job (via `CAREER_OPS_PORTALS`), kept separate
 * from the node's main portals.yml so a `boards`-only scan never re-walks the
 * 95 tracked companies too.
 *
 * @param {string|null} hubPortalsYmlText
 * @param {Array<object>} boards - the node's own `cfg.boards`.
 * @param {Array<object>} [discoveredBoards] - bespoke careers pages the
 *   `resolve` job fingerprinted. They belong in the boards-only view too: a
 *   discovered generic-careers page IS a board, and leaving it out of this file
 *   would mean the `boards` job never scans anything the crawler found.
 * @returns {string}
 */
export function renderBoardsPortalsYml(hubPortalsYmlText, boards, discoveredBoards = []) {
  const hub = loadYamlDocOrEmpty(hubPortalsYmlText);
  const doc = {};
  for (const key of BOARD_PORTALS_ALLOWED_KEYS) {
    if (hub[key] !== undefined) doc[key] = hub[key];
  }
  doc.tracked_companies = [];
  doc.job_boards = mergeBoards(boards, hub.job_boards, discoveredBoards);
  const header =
    '# MACHINE-WRITTEN by autopilot/discovery-node.mjs — a boards-only view of the '
    + 'hub\'s filters for the `boards` scanner job. Never hand-edit.\n';
  return header + yaml.dump(doc, { lineWidth: 120 });
}

/**
 * Render the node's own minimal `config/profile.yml` subset from the hub
 * criteria route's already-reduced `profile` object — `candidate.location`
 * (a display string), `location.*`, `compensation.*`, `target_roles.*`. No
 * contact fields ever reach this function (the criteria route never sends
 * them — see §3.2), so there is nothing here that could leak one.
 *
 * @param {{location?: {country?:string,state?:string,city?:string,timezone?:string},
 *   compensation?: object, target_roles?: object}|null} profile
 * @returns {string}
 */
export function renderProfileYml(profile) {
  const loc = profile?.location || {};
  const candidateLocation = [loc.city, loc.state].filter(Boolean).join(', ') || loc.country || '';
  const doc = {
    candidate: { location: candidateLocation },
    location: {
      country: loc.country ?? null,
      state: loc.state ?? null,
      city: loc.city ?? null,
      timezone: loc.timezone ?? null,
    },
    compensation: profile?.compensation ? { ...profile.compensation } : {},
    target_roles: profile?.target_roles ? { ...profile.target_roles } : {},
  };
  const header =
    '# MACHINE-WRITTEN by autopilot/discovery-node.mjs from the hub\'s criteria — edit '
    + 'config/profile.yml on the autopilot host instead. No contact fields are included.\n';
  return header + yaml.dump(doc, { lineWidth: 120 });
}

// ── Ship-queue state folding (§4.4.7) ───────────────────────────────────

/**
 * Fold the hub's response to one ingest POST into the node's state.
 *
 * Mutates `state` in place and returns it — the daemon owns one long-lived
 * state object for its whole run and persists it via autopilot/lib/util.mjs's
 * writeJson() after each fold, the same "mutate the ledger, then persist"
 * convention autopilot/lib/leads.mjs and the email agent's nudge module use. Only ever
 * removes a `to_ship` entry once the hub has given a DEFINITIVE answer about
 * it (202, or an unrecoverable 4xx) — a 401/403/5xx/network failure leaves
 * the queue untouched so the daemon's own backoff/fallback-URL loop (which
 * this function does not implement; see discovery-node.mjs) can retry it.
 *
 * @param {{shipped?: object, held?: object, dropped?: object, to_ship?: Array<{key:string,url:string,score?:number}>}} state
 * @param {Array<{key: string, url: string, score?: number}>} batch - the finds
 *   that were just POSTed (a slice of `state.to_ship`).
 * @param {{ok: boolean, status: number|null, json?: {accepted_urls?: string[], duplicate_urls?: string[]}, networkError?: boolean}} response
 * @param {{hosted?: boolean}} [opts] - `hosted` (the user's own computer talking to
 *   the public site) reads a 409 and a 413 as statements about the account or the
 *   request size, not the finds; the self-hosted node keeps its old reading.
 * @returns {object} `state`, mutated.
 */
export function foldIngestResponse(state, batch, response, opts = {}) {
  state.shipped ??= {};
  state.dropped ??= {};
  state.held ??= {};
  state.to_ship ??= [];
  const now = new Date().toISOString();
  const items = Array.isArray(batch) ? batch : [];
  const batchKeys = new Set(items.map((f) => f.key));

  if (response?.ok && response.status === 202) {
    const accepted = new Set(response.json?.accepted_urls || []);
    const duplicate = new Set(response.json?.duplicate_urls || []);
    // A hosted hub answers 202 with `capped: true` when only part of the batch
    // fitted (the guest's daily allowance, or a full inbox). What it did not take
    // is not rejected, just not served yet: `deferred_urls` names it, and it
    // stays queued. Without a `deferred_urls` list every URL the hub did not
    // account for is treated as deferred — the safe reading, since dropping them
    // would lose finds the user never got a chance to receive.
    const capped = response.json?.capped === true;
    const deferred = Array.isArray(response.json?.deferred_urls) ? new Set(response.json.deferred_urls) : null;
    const stay = new Set();
    for (const find of items) {
      if (accepted.has(find.url)) {
        state.shipped[find.key] = { at: now, score: find.score ?? null, hub: 'accepted' };
        recordRecentShipped(state, find, now);
      } else if (duplicate.has(find.url)) {
        state.shipped[find.key] = { at: now, score: find.score ?? null, hub: 'duplicate' };
      } else if (capped && (!deferred || deferred.has(find.url))) {
        stay.add(find.key);
      } else {
        // Answered 202 but named this URL in neither list — rejected for a
        // per-item reason folded only into the response's aggregate
        // rejected_reasons counts, never surfaced per URL. Dropped so it is
        // never retried forever.
        state.dropped[find.key] = { at: now, reason: 'hub_rejected' };
      }
    }
    state.to_ship = state.to_ship.filter((f) => !batchKeys.has(f.key) || stay.has(f.key));
    return state;
  }

  const status = response?.status;
  // 429 is the hub saying "not now" (a rate limit or the daily allowance), which
  // is a statement about the hub's mood, not about these finds.
  const transient = response?.networkError || status === 401 || status === 403 || status === 429
    || (typeof status === 'number' && status >= 500);
  if (transient) return state; // queue untouched — the caller retries later

  if (opts.hosted) {
    // 409: the account is not ready for finds (profile_incomplete, too_many_nodes)
    // — the finds are fine, and dropping a batch because the user has not finished
    // a form would lose them for good. 413: the request was too big, so the next
    // one is smaller; the finds stay queued.
    if (status === 409) return state;
    if (status === 413) {
      state.ship_batch_limit = Math.min(state.ship_batch_limit || Infinity, Math.max(SHIP_BATCH_FLOOR, Math.floor(items.length / 2)));
      return state;
    }
  }

  // Any other 4xx: the hub rejected the whole batch outright.
  for (const find of items) {
    state.dropped[find.key] = { at: now, reason: `hub_rejected_${status ?? 'unknown'}` };
  }
  state.to_ship = state.to_ship.filter((f) => !batchKeys.has(f.key));
  return state;
}

// ── Recent finds and the hub's allowance ───────────────────────────────

export const RECENT_SHIPPED_MAX = 20;

// A hosted 413 halves the next ingest batch, down to this many finds.
export const SHIP_BATCH_FLOOR = 10;

/** Finds per ingest request: the config's size, or less once the hub said a request was too large. */
export function shipBatchSize(configured, state) {
  return Math.min(configured || 100, state?.ship_batch_limit || Infinity);
}

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Remember a find the hub accepted, for the local dashboard's "recent finds".
 * `state.shipped` keeps only `{at, score, hub}` under a dedup key, so without
 * this ring the dashboard would have nothing to show but a count. The strings
 * are scraped from a posting — bounded here, and rendered with textContent only.
 */
export function recordRecentShipped(state, find, at = new Date().toISOString()) {
  const entry = { url: clip(find?.url, 2048), company: clip(find?.company, 120), title: clip(find?.title, 200), at };
  if (!entry.url) return state;
  state.recent_shipped = [entry, ...(Array.isArray(state.recent_shipped) ? state.recent_shipped : [])
    .filter((e) => e?.url !== entry.url)].slice(0, RECENT_SHIPPED_MAX);
  return state;
}

/**
 * Keep the hub's statement of the user's daily allowance (hosted mode) for the
 * dashboard: `limits: {finds_per_day, accepted_today}` on the criteria and the
 * heartbeat response, the same two numbers at the top level of an ingest 202.
 */
export function foldLimits(state, json) {
  const src = json && typeof json === 'object' ? (json.limits && typeof json.limits === 'object' ? json.limits : json) : null;
  if (!src) return state;
  const perDay = Number(src.finds_per_day);
  const today = Number(src.accepted_today);
  if (Number.isFinite(perDay) && Number.isFinite(today)) {
    state.limits = { finds_per_day: perDay, accepted_today: today, at: new Date().toISOString() };
  }
  return state;
}

// ── Runtime control: hub commands, the run-now queue, state hygiene ────────

export const MAX_COMMANDS_PER_RESPONSE = 10;
export const MAX_COMMAND_ACKS = 20;
const MAX_SEEN_COMMANDS = 100;
// A command is an hour-old request at most, whatever expiry it claims.
const COMMAND_MAX_AGE_MS = 60 * 60_000;
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Put a job on the run-now queue. Names are checked against NODE_JOB_NAMES, a
 * job already queued is not queued twice, and the queue can never hold more
 * entries than there are jobs.
 *
 * @returns {boolean} true when the job is (now) queued.
 */
export function enqueueRunNow(state, job) {
  if (!NODE_JOB_NAMES.includes(job)) return false;
  state.run_now = Array.isArray(state.run_now) ? state.run_now : [];
  if (!state.run_now.includes(job)) state.run_now.push(job);
  return true;
}

/**
 * Remove and return the first queued job `accept` allows, or null.
 * @param {(job: string) => boolean} [accept]
 */
export function takeRunNow(state, accept = () => true) {
  if (!Array.isArray(state?.run_now)) return null;
  const i = state.run_now.findIndex((job) => accept(job));
  if (i === -1) return null;
  return state.run_now.splice(i, 1)[0];
}

function remember(list, id, cap) {
  const at = list.indexOf(id);
  if (at !== -1) list.splice(at, 1);
  list.push(id);
  while (list.length > cap) list.shift();
}

/**
 * Apply the `control` block a hub puts in a heartbeat response (self-hosted
 * "node" mode only — the hosted mode ignores it entirely, see the daemon).
 *
 * - Absent or malformed `control`: nothing changes. A failed or old-hub
 *   heartbeat must never un-pause a node, so the stored control is only ever
 *   REPLACED by a well-formed one.
 * - A different `revision` replaces the stored control (compared with `!==`, not
 *   `>`: a hub whose store was reset starts counting again from a low number and
 *   must not lock the node out). The stored control is re-sanitized; junk the hub
 *   sent is dropped, never trusted.
 * - Each `run_job` command runs once: ids are remembered (persisted, capped), an
 *   expired or over-age command is acknowledged without running, and while the
 *   node is locally paused a command is acknowledged and REFUSED — the user's
 *   own Pause outranks a remote request. Every handled id goes into
 *   `state.command_acks`, which the next heartbeat reports so the hub can drop it.
 *
 * Mutates `state`.
 *
 * @param {object} state
 * @param {unknown} control
 * @param {{now?: number, locallyPaused?: boolean}} [opts]
 * @returns {{control_changed: boolean, queued: string[], refused: Array<{id: string, reason: string}>}}
 */
export function applyHubControl(state, control, { now = Date.now(), locallyPaused = false } = {}) {
  const result = { control_changed: false, queued: [], refused: [] };
  if (!control || typeof control !== 'object' || Array.isArray(control)) return result;
  if (!Number.isInteger(control.revision) || control.revision < 0) return result;

  if (control.revision !== state.control_revision) {
    state.hub_control = sanitizeControl({ paused: control.paused, jobs: control.jobs }).value;
    state.control_revision = control.revision;
    result.control_changed = true;
  }

  state.seen_commands = Array.isArray(state.seen_commands) ? state.seen_commands : [];
  state.command_acks = Array.isArray(state.command_acks) ? state.command_acks : [];
  const commands = Array.isArray(control.commands) ? control.commands.slice(0, MAX_COMMANDS_PER_RESPONSE) : [];
  for (const cmd of commands) {
    const id = typeof cmd?.id === 'string' && COMMAND_ID_RE.test(cmd.id) ? cmd.id : null;
    if (!id) continue;
    const alreadyHandled = state.seen_commands.includes(id);
    remember(state.seen_commands, id, MAX_SEEN_COMMANDS);
    remember(state.command_acks, id, MAX_COMMAND_ACKS);
    if (alreadyHandled) continue; // re-listed because our ack has not landed yet

    const expires = Date.parse(cmd.expires_at);
    const issued = Date.parse(cmd.issued_at);
    if (!Number.isFinite(expires) || expires <= now || (Number.isFinite(issued) && now - issued > COMMAND_MAX_AGE_MS)) {
      result.refused.push({ id, reason: 'expired' });
    } else if (cmd.type !== 'run_job' || !NODE_JOB_NAMES.includes(cmd.job)) {
      result.refused.push({ id, reason: 'unsupported' });
    } else if (locallyPaused) {
      result.refused.push({ id, reason: 'paused' });
    } else if (enqueueRunNow(state, cmd.job)) {
      result.queued.push(cmd.job);
    }
  }
  return result;
}

/**
 * Make a state object read from disk safe to use: right types, known job names,
 * bounded lists. state.json is this node's own file, but a hand edit or an older
 * build must not be able to crash a tick or smuggle in a command id.
 */
export function normalizeNodeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const strings = (v, cap, re) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === 'string' && (!re || re.test(x))).slice(-cap);
  s.run_now = [...new Set((Array.isArray(s.run_now) ? s.run_now : []).filter((j) => NODE_JOB_NAMES.includes(j)))];
  s.seen_commands = strings(s.seen_commands, MAX_SEEN_COMMANDS, COMMAND_ID_RE);
  s.command_acks = strings(s.command_acks, MAX_COMMAND_ACKS, COMMAND_ID_RE);
  s.recent_shipped = (Array.isArray(s.recent_shipped) ? s.recent_shipped : [])
    .filter((e) => e && typeof e.url === 'string').slice(0, RECENT_SHIPPED_MAX)
    .map((e) => ({ url: clip(e.url, 2048), company: clip(e.company, 120), title: clip(e.title, 200), at: clip(e.at, 40) }));
  s.hub_control = sanitizeControl(s.hub_control).value;
  s.control_revision = Number.isInteger(s.control_revision) && s.control_revision >= 0 ? s.control_revision : null;
  if (!(Number.isInteger(s.ship_batch_limit) && s.ship_batch_limit >= SHIP_BATCH_FLOOR)) delete s.ship_batch_limit;
  return s;
}

// ── Pipeline row marking (§4.4.6) ───────────────────────────────────────

/**
 * Check off one pending pipeline row and append a note — the pure text
 * transform behind autopilot.mjs's own markPipeline(), returning the new text
 * instead of writing a file (the daemon calls this under withPipelineLock()
 * and writes the result).
 *
 * @param {string} text - `data/pipeline.md` contents.
 * @param {string} url - The row's URL (matched as a literal prefix, exactly
 *   like autopilot.mjs's markPipeline).
 * @param {string} note - Appended after ` — ` (e.g. `node: shipped`,
 *   `node: held (score 55)`, `node: dropped (comp_below_floor)`,
 *   `node: known to hub`).
 * @returns {string} The updated text.
 */
export function markPipelineRow(text, url, note) {
  return String(text ?? '').split('\n').map((line) => (
    line.startsWith(`- [ ] ${url}`) ? line.replace('- [ ]', '- [x]') + ` — ${note}` : line
  )).join('\n');
}

// ── Heartbeat status (§3.5 / §4.5) ──────────────────────────────────────

/**
 * Build the `status` object the daemon POSTs to `/api/discovery/node/heartbeat`
 * (and the basis for the local `/health` route's `jobs`/`queue` fields).
 *
 * Pure: everything about "what happened" comes from `state`/`jobsConfig`;
 * everything about "what is happening right now" (version, uptime, the
 * currently running job, the live pending-local count) is live daemon state
 * the caller supplies via `extra`, because reading data/pipeline.md or the
 * process clock is IO/impure and does not belong in this function.
 *
 * @param {{jobs?: object, shipped?: object, held?: object, dropped?: object,
 *   to_ship?: Array, started_at?: string, last_error?: object, criteria_hash?: string}} state
 * @param {Record<string, {enabled?: boolean, every_minutes?: number}>} [jobsConfig] - `cfg.jobs`.
 * @param {{version?: string, started_at?: string, uptime_s?: number,
 *   current_job?: object|null, pending_local?: number, criteria_hash?: string,
 *   last_error?: object|null, now?: number, paused?: boolean,
 *   control_revision?: number|null, command_acks?: string[],
 *   dashboard?: {enabled: boolean, port: number|null}|null,
 *   sources?: Record<string, Record<string, string>>}} [extra] - `sources` is
 *   effectiveJobs()'s map of where each controllable value came from.
 * @returns {object}
 */
export function buildHeartbeatStatus(state = {}, jobsConfig = {}, extra = {}) {
  const now = extra.now ?? Date.now();
  const jobs = {};
  for (const name of Object.keys(jobsConfig || {})) {
    const rec = state.jobs?.[name] || {};
    const jobCfg = jobsConfig[name] || {};
    const lastRunAt = rec.last_run_at || null;
    jobs[name] = {
      enabled: jobCfg.enabled !== false,
      // What the node is actually running on, after the config file, the hub's
      // control and the local dashboard have all had their say.
      every_minutes: Number(jobCfg.every_minutes) || null,
      start_at: normalizeHHMM(jobCfg.start_at) || null,
      max_minutes: Number(jobCfg.max_minutes) || null,
      last_run_at: lastRunAt,
      last_ok: rec.last_ok ?? null,
      last_ms: rec.last_ms ?? null,
      last_summary: rec.last_summary ? String(rec.last_summary).slice(0, 200) : null,
      next_run_at: jobNextRunAt(jobCfg, rec, now),
      runs: rec.runs || 0,
      errors: rec.errors || 0,
    };
    // Where each controllable value came from: 'config' | 'hub' | 'local'.
    if (extra.sources?.[name] && Object.keys(extra.sources[name]).length) jobs[name].source = { ...extra.sources[name] };
  }

  const shipped = state.shipped || {};
  const held = state.held || {};
  const dropped = state.dropped || {};
  let lastShipAt = null;
  for (const entry of Object.values(shipped)) {
    if (entry?.at && (!lastShipAt || entry.at > lastShipAt)) lastShipAt = entry.at;
  }

  return fitHeartbeat({
    version: extra.version ?? null,
    started_at: extra.started_at ?? state.started_at ?? null,
    uptime_s: extra.uptime_s ?? null,
    current_job: extra.current_job ?? null,
    paused: extra.paused === true,
    control_revision: extra.control_revision ?? state.control_revision ?? null,
    command_acks: (Array.isArray(extra.command_acks) ? extra.command_acks : (state.command_acks || [])).slice(-MAX_COMMAND_ACKS),
    dashboard: extra.dashboard ?? null,
    jobs,
    pending_local: extra.pending_local ?? 0,
    to_ship: Array.isArray(state.to_ship) ? state.to_ship.length : 0,
    shipped_total: Object.keys(shipped).length,
    held_total: Object.keys(held).length,
    dropped_total: Object.keys(dropped).length,
    last_ship_at: lastShipAt,
    last_error: extra.last_error ?? state.last_error ?? null,
    criteria_hash: extra.criteria_hash ?? state.criteria_hash ?? null,
  });
}

// The hub refuses a heartbeat body over 8 KB (HEARTBEAT_MAX_BYTES, 413) and a
// node that gets a 413 simply reads as offline. Nine jobs with 200-character
// summaries and the per-job control fields are ~6 KB; non-ASCII summaries cost up
// to four bytes a character. Stay under 7 KB — the body also carries the node
// name — by shedding the least useful detail first: the per-job `source` maps,
// then the summaries, then the error text.
export const HEARTBEAT_STATUS_MAX_BYTES = 7 * 1024;

function fitHeartbeat(status) {
  const size = () => Buffer.byteLength(JSON.stringify(status));
  if (size() <= HEARTBEAT_STATUS_MAX_BYTES) return status;
  for (const job of Object.values(status.jobs)) delete job.source;
  if (size() <= HEARTBEAT_STATUS_MAX_BYTES) return status;
  for (const job of Object.values(status.jobs)) if (job.last_summary) job.last_summary = job.last_summary.slice(0, 60);
  if (size() <= HEARTBEAT_STATUS_MAX_BYTES) return status;
  for (const job of Object.values(status.jobs)) job.last_summary = null;
  if (size() <= HEARTBEAT_STATUS_MAX_BYTES) return status;
  if (status.last_error) status.last_error = clip(JSON.stringify(status.last_error), 200);
  return status;
}

// ── State pruning (§4.2) ────────────────────────────────────────────────

const STATE_MAX_ENTRIES = 20_000;

/**
 * Cap `shipped`/`held`/`dropped` to the newest N entries by `.at`, oldest
 * first out. Mutates and returns `state`, same convention as
 * foldIngestResponse() above.
 *
 * @param {{shipped?: object, held?: object, dropped?: object}} state
 * @param {{maxEntries?: number}} [opts] - test seam; the real cap is 20000.
 * @returns {object} `state`, mutated.
 */
export function pruneState(state, opts = {}) {
  const maxEntries = opts.maxEntries ?? STATE_MAX_ENTRIES;
  for (const key of ['shipped', 'held', 'dropped']) {
    const map = state?.[key];
    if (!map || typeof map !== 'object') continue;
    const entries = Object.entries(map);
    if (entries.length <= maxEntries) continue;
    entries.sort((a, b) => String(a[1]?.at || '').localeCompare(String(b[1]?.at || '')));
    const toDrop = entries.length - maxEntries;
    for (let i = 0; i < toDrop; i++) delete map[entries[i][0]];
  }
  return state;
}

// ── Hub HTTP client (thin IO helper, §3 wire contract) ──────────────────

/**
 * One attempt at one hub URL. No retry, no fallback, no logging — those are
 * the daemon's job (it owns the backoff timer and the fallback_urls list; see
 * autopilot/discovery-node.mjs). Never logs `hub` or the request itself, so
 * the token cannot reach a log line through this function; a caller that logs
 * a failure must log `hub.url` alone, never the `hub` object.
 *
 * A redirect is an ERROR, never followed: the request carries a bearer token,
 * and a hub that answers 3xx (a misconfigured URL, a hijacked one) would
 * otherwise hand that token to wherever it points.
 *
 * @param {{url: string, token?: string}} hub
 * @param {string} path - e.g. `/api/discovery/node/criteria`.
 * @param {{method?: string, body?: object, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, status: number, json: object|null, retryAfter: number|null}>}
 *   `retryAfter` is the response's Retry-After in seconds, when it sent one.
 */
export async function hubFetch(hub, path, opts = {}) {
  const { method = 'GET', body = null, timeoutMs = 15_000 } = opts;
  const base = String(hub?.url || '').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (hub?.token) headers.authorization = `Bearer ${hub.token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  // Number(null) is 0, which would read a missing header as "retry at once".
  const rawRetry = res.headers.get('retry-after');
  const retryAfter = rawRetry !== null && rawRetry.trim() !== '' ? Number(rawRetry) : NaN;
  return { ok: res.ok, status: res.status, json, retryAfter: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null };
}

// ── What the hub's refusals mean (hosted mode) ───────────────────────────

// A 403 carrying one of these says the ACCOUNT, not the request, is the
// problem: an administrator stopped it, discovery is switched off for it, its
// pipeline is disabled, its CareerAutopilot access lapsed, the token is the wrong
// kind, or it is an admin token (which belongs in the self-hosted node mode).
// Retrying cannot help and only adds noise to a hub that already said no.
export const HUB_BLOCK_CODES = Object.freeze([
  'stopped_by_administrator', 'discovery_node_disabled', 'pipeline_disabled',
  'careerops_access_required', 'token_scope', 'use_node_mode',
]);
export const HUB_BLOCK_MS = 60 * 60_000;
const RATE_LIMIT_MIN_MS = 30_000;
const RATE_LIMIT_MAX_MS = 24 * 60 * 60_000;

/**
 * The machine-readable error code in a hub error body, or null. The hub speaks
 * three shapes: `{error: 'x'}` (the autopilot), `{detail: {error: 'x'}}` and
 * `{detail: 'x'}` (FastAPI's HTTPException on the site). The first STRING wins,
 * so an `error` that is not one (an object, a number) never hides a `detail` that is.
 */
export function hubErrorCode(json) {
  const raw = [json?.error, json?.detail?.error, json?.detail].find((v) => typeof v === 'string');
  return raw === undefined ? null : raw.slice(0, 60);
}

/** @returns {string|null} the block code when this response says "stop calling", else null. */
export function hubBlockReason(response) {
  if (response?.status !== 403) return null;
  const code = hubErrorCode(response.json);
  return HUB_BLOCK_CODES.includes(code) ? code : null;
}

/**
 * When to try a route again after a 429: its Retry-After, else the `resets_at`
 * the daily-cap answer carries, else the next local midnight (the allowance is
 * per day). Clamped to 30 s .. 24 h so neither a 0 nor a huge value from the hub
 * can make the node hammer it or go silent for good.
 *
 * @returns {number} epoch ms.
 */
export function rateLimitUntil(response, now = Date.now()) {
  let until;
  if (Number.isFinite(response?.retryAfter)) until = now + response.retryAfter * 1000;
  else if (Number.isFinite(Date.parse(response?.json?.resets_at))) until = Date.parse(response.json.resets_at);
  else { const d = new Date(now); d.setHours(24, 0, 0, 0); until = d.getTime(); }
  return Math.min(now + RATE_LIMIT_MAX_MS, Math.max(now + RATE_LIMIT_MIN_MS, until));
}
