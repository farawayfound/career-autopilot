// Shared helpers for the autopilot layer.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const p = (...parts) => join(ROOT, ...parts);

// Repo-relative, forward slashes — the shape queue items and the tracker store
// for a file the cycle wrote (output/cv-….pdf). `relative()` rather than a
// string strip: autopilot.mjs used to strip `p() + '\\'`, which never matched
// once the autopilot host became a Linux box on 2026-09-08, so every package from then on
// stored an absolute path and every reader below failed to find it.
export const repoRelative = (abs) => relative(ROOT, abs).split(sep).join('/');

// A file path stored on a queue item, resolved for reading. Repo-relative is
// the contract, but an absolute path is honoured as-is rather than joined
// onto ROOT — join() turns /srv/career-ops/output/x.pdf into
// /srv/career-ops/srv/career-ops/output/x.pdf, which is how the
// dashboard's PDF link said "not found" and the companion served the generic
// resume for every package written between 2026-09-08 and this helper.
export const itemPath = (stored) => (isAbsolute(stored) ? stored : p(stored));

// The commit this process is running from. /health and /api/companion/health
// report it so a deploy can be VERIFIED over HTTP instead of inferred: for
// three deploys in a row on 2026-09-10 the only evidence that a merge had
// reached the autopilot host was the dashboard tunnel's pid changing, which proves a
// restart and says nothing about what restarted. `git rev-parse` first (git is
// on every box the deploy touches); then a file walk for a checkout with no
// git on PATH — a normal repo (.git/HEAD → refs/heads/x, or packed-refs) or a
// worktree (.git is a file naming the gitdir; refs live under its commondir);
// 'unknown' only when both fail. Computed once — the answer cannot change
// while the process lives.
let cachedSha;
export function gitSha() {
  if (cachedSha !== undefined) return cachedSha;
  cachedSha = 'unknown';
  try {
    const out = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim();
    if (/^[0-9a-f]{7,40}$/.test(out)) { cachedSha = out; return cachedSha; }
  } catch { /* no git on PATH, or not a checkout — try the files */ }
  try {
    let gitDir = p('.git');
    if (!statSync(gitDir).isDirectory()) {
      const m = readFileSync(gitDir, 'utf-8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return cachedSha;
      gitDir = resolve(ROOT, m[1].trim());
    }
    const commonFile = join(gitDir, 'commondir');
    const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf-8').trim()) : gitDir;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
    let sha = ref ? null : head;
    if (ref) {
      const loose = join(common, ref);
      if (existsSync(loose)) sha = readFileSync(loose, 'utf-8').trim();
      else if (existsSync(join(common, 'packed-refs'))) {
        sha = readFileSync(join(common, 'packed-refs'), 'utf-8').split(/\r?\n/)
          .find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] || null;
      }
    }
    if (sha && /^[0-9a-f]{40}$/.test(sha)) cachedSha = sha.slice(0, 9);
  } catch { /* stays 'unknown' */ }
  return cachedSha;
}

/** The release in the VERSION file, or 'unknown'. */
export function appVersion() {
  try { return readFileSync(p('VERSION'), 'utf-8').trim() || 'unknown'; } catch { return 'unknown'; }
}

export function loadYamlFile(relPath) {
  return yaml.load(readFileSync(p(relPath), 'utf-8'));
}

// Recursively merge `over` onto `base`: plain objects merge key-by-key, while
// arrays and scalars replace. A deep merge (not the old one-level Object.assign)
// lets the local overlay carry a single nested leaf — e.g. inference.roles.
// evaluate.num_ctx — without clobbering its siblings (the model, temperature,
// or the other roles). Backward-compatible: every pre-existing overlay key is a
// ≤2-level scalar/array, where deep and shallow merge behave identically.
function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (isObj(v) && isObj(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function loadConfig() {
  const cfg = loadYamlFile('config/autopilot.yml');
  // Optional local overrides (gitignored) — e.g. server.token, dashboard edits
  if (existsSync(p('config/autopilot.local.yml'))) {
    const local = loadYamlFile('config/autopilot.local.yml') || {};
    deepMerge(cfg, local);
  }
  if (process.env.CAREER_OPS_TOKEN) {
    cfg.server ??= {};
    cfg.server.token = process.env.CAREER_OPS_TOKEN;
  }
  // The fleet hub (mints demo keys; see lib/fleet-demo.mjs). File-only
  // otherwise: fleet_hub.url / fleet_hub.admin_token in the overlay.
  if (process.env.FLEET_HUB_URL) {
    cfg.fleet_hub ??= {};
    cfg.fleet_hub.url = process.env.FLEET_HUB_URL;
  }
  if (process.env.FLEET_HUB_ADMIN_TOKEN) {
    cfg.fleet_hub ??= {};
    cfg.fleet_hub.admin_token = process.env.FLEET_HUB_ADMIN_TOKEN;
  }
  cfg.autopilot ??= {};
  cfg.autopilot.min_score_to_package ??= 3.8;
  cfg.autopilot.max_new_offers_per_cycle ??= 8;
  cfg.autopilot.offer_concurrency ??= 2;
  cfg.autopilot.cycle_interval_hours ??= 6;
  cfg.autopilot.jd_max_chars ??= 14000;
  // Writing-quality knobs (cover letter + CV tailoring). `retry_on_issues`
  // re-asks once with the deterministic gate's violations listed
  // (lib/writing-guards.mjs); `review_pass` adds an editor call that rewrites
  // the draft against the rubric (prompts/cover-letter-review.md). Defaults
  // come from the writing benchmark (evals/writing/README.md).
  cfg.writing ??= {};
  cfg.writing.retry_on_issues ??= true;
  cfg.writing.review_pass ??= false;
  cfg.writing.min_words ??= 170;
  cfg.writing.max_words ??= 330;
  // The humanizer pass (lib/humanize.mjs): on by default for the cover letter
  // only — the piece it was measured and tuned for. Screening answers and the
  // tailored CV's summary are opt-in (Admin -> Models -> Writing).
  cfg.writing.humanizer ??= {};
  cfg.writing.humanizer.enabled ??= true;
  cfg.writing.humanizer.cover_letter ??= true;
  cfg.writing.humanizer.resume ??= false;
  cfg.writing.humanizer.answers ??= false;
  // How much longer than the draft a rewrite may come back, in percent.
  cfg.writing.humanizer.max_longer_pct ??= 10;
  // The hub's own coordinates, copied onto the inference block. `new
  // LlmPool(cfg.inference)` is the constructor every consumer in this repo
  // calls, and the lane planner needs the hub's URL and admin token — which
  // live under `fleet_hub`, one level up and out of the pool's reach. Copying
  // them here keeps that constructor signature intact rather than threading a
  // second argument through server.mjs, the email agent, autopilot.mjs, the apply
  // worker and every test that builds a pool.
  cfg.inference ??= {};
  cfg.inference.hub = {
    url: cfg.fleet_hub?.url || '',
    admin_token: cfg.fleet_hub?.admin_token || '',
  };
  resolveEndpointKeys(cfg);
  return cfg;
}

// What a lane endpoint says when it has no key of its own. A lane IS its key:
// the three lanes exist to be metered, budgeted and expirable separately on the
// hub, so borrowing another feature's key defeats the split — and the two keys
// it could plausibly borrow are both wrong in ways that fail late rather than
// loudly (OLLAMA_API_KEY_SCAN_EVALUATE is model-bound to the 9B and would 403
// on the 27B; the shared AMA key carries an agent profile and would answer in
// the wrong persona). Better to disable the lane and say why.
export const UNKEYED_LANE_REASON = 'unkeyed lane — mint it on Admin → Inference lanes';

// An inference endpoint may name its bearer key instead of inlining it:
// `api_key_env: OLLAMA_API_KEY_SCAN_EVALUATE` is looked up in the process
// environment, then in the overlay's `secrets:` block — the same two places
// lib/fleet-demo.mjs's hubConfig() reads the message generator's key from.
// That is what lets a key rotated from the dashboard (lib/hub-keys.mjs writes
// `secrets.<ENV>`) reach the pool without anyone editing config/autopilot.yml
// by hand on the box. A literal `api_key` stays the fallback, so an endpoint
// written before this existed keeps working, and one whose named secret has
// not been minted yet still sends the key it always did.
//
// Mutates in place and is idempotent (a second call finds `api_key` already
// resolved and the env name unchanged). Nothing here ever logs a value.
export function resolveEndpointKeys(cfg, env = process.env) {
  const secrets = cfg?.secrets && typeof cfg.secrets === 'object' ? cfg.secrets : {};
  for (const ep of cfg?.inference?.endpoints || []) {
    const name = String(ep?.api_key_env || '').trim();
    if (name) {
      const key = String(env[name] || secrets[name] || '').trim();
      if (key) ep.api_key = key;
    }
    if (!ep?.lane) continue;
    // A lane whose key has not been minted yet must not sit in the pool
    // ENABLED. It would be priority 0, it would win every call in its lane, and
    // the hub would refuse each one — turning "you have not minted this key
    // yet" into a cycle-long failover storm whose logs blame the hub. Disabled
    // with a reason instead, so the dashboard's lane card can say what to do
    // and the pool simply goes to the direct boxes, as it did before lanes.
    if (!String(ep.api_key || '').trim()) {
      ep.enabled = false;
      ep.disabled_reason = UNKEYED_LANE_REASON;
    } else if (ep.disabled_reason === UNKEYED_LANE_REASON) {
      // The key arrived (minted since the last load). Clear OUR note only —
      // `enabled` is left as the config states it, because an operator who
      // disabled a lane on purpose must not be overruled by a rotation.
      delete ep.disabled_reason;
    }
  }
  return cfg;
}

export const loadProfile = () => loadYamlFile('config/profile.yml');
export const loadCv = () => readFileSync(p('cv.md'), 'utf-8');
export const loadTone = () => (existsSync(p('config/tone.md')) ? readFileSync(p('config/tone.md'), 'utf-8') : '');

// The candidate's own voice, for the writing prompts' {{TONE}} slot: their
// tone samples (config/tone.md) plus the `## Writing Style` block the
// interactive modes extract into modes/_profile.md (modes/_writing.md). Both
// are user-layer and optional; the system floor (autopilot/prompts/_voice.md,
// {{VOICE}}) applies whether or not either exists, so an install with neither
// no longer asks a model to "follow the voice guide exactly" above an empty
// heading, which is what the cover-letter prompt did until 2026-09-10.
export function loadWritingStyle() {
  const parts = [];
  const tone = loadTone().trim();
  if (tone) parts.push(`## The candidate's own tone samples and preferences (layer these over the voice rules)\n\n${tone}`);
  const profilePath = p('modes', '_profile.md');
  if (existsSync(profilePath)) {
    const m = readFileSync(profilePath, 'utf-8').match(/^## Writing Style\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
    const block = m?.[1]?.trim();
    // The shipped template carries no such block; a user's extracted style
    // does. Placeholders left from the template are not a style.
    if (block && !/\{[a-z_ ]+\}/i.test(block)) parts.push(`## The candidate's writing style (extracted from their own samples)\n\n${block}`);
  }
  return parts.join('\n\n');
}

/** The system-layer voice floor every writing prompt carries as {{VOICE}}. */
export const loadVoice = () => readFileSync(p('autopilot', 'prompts', '_voice.md'), 'utf-8').trim();
export const loadApplyAnswers = () =>
  existsSync(p('config/apply-answers.yml')) ? loadYamlFile('config/apply-answers.yml').answers || [] : [];

export function loadPrompt(name, vars = {}) {
  let text = readFileSync(p('autopilot', 'prompts', `${name}.md`), 'utf-8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{{${k}}}`).join(String(v ?? ''));
  }
  return text;
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';

export function ensureDir(relPath) {
  mkdirSync(p(relPath), { recursive: true });
}

export function logEvent(event, data = {}) {
  ensureDir('data');
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  appendFileSync(p('data', 'autopilot-log.jsonl'), line + '\n', 'utf-8');
  console.log(`[autopilot] ${event}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '-');
}

export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Extract the first JSON object from model output (tolerates <think> blocks and fences).
export function extractJson(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in model output');
  return JSON.parse(t.slice(start, end + 1));
}

export function readJsonSafe(absPath, fallback = null) {
  try { return JSON.parse(readFileSync(absPath, 'utf-8')); } catch { return fallback; }
}

let tmpCounter = 0;

/**
 * Write JSON atomically: full content to a temp file in the SAME directory,
 * then rename over the target. rename is atomic within a filesystem, so a
 * reader sees either the old file or the new one — never a half-written one.
 *
 * This used to be a bare writeFileSync, which truncates first and then fills.
 * A crash, a kill, or a power loss inside that window leaves a truncated file,
 * and readJsonSafe answers a parse error with the fallback — SILENTLY. For
 * autopilot-state.json the fallback is an empty state: the dedup and skip
 * ledgers vanish and the next cycle re-evaluates everything it already did.
 * Nothing logs, because from readJsonSafe's point of view nothing went wrong.
 * That window is now closed, which is what makes it safe for a watchdog to
 * kill a wedged autopilot.
 */
export function writeJson(absPath, obj) {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  // Same directory (rename cannot cross filesystems) and unique per writer:
  // the server and detached apply-worker processes write concurrently.
  const tmp = join(dir, `.${process.pid}.${++tmpCounter}.tmp`);
  try {
    const body = JSON.stringify(obj, null, 2);
    writeFileSync(tmp, body, 'utf-8');
    // Windows refuses to rename over a file while another process holds a read
    // handle (EPERM). readFileSync's handle is open for microseconds, so a short
    // backoff clears the realistic collision.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, absPath); return; } catch (err) {
        if (!/EPERM|EACCES|EBUSY/.test(String(err.code))) throw err;
        if (attempt >= 4) {
          // A reader is holding it open for longer than we can wait. Writing in
          // place is exactly what this function used to do unconditionally, so
          // this is the old risk in a rare case rather than a new failure mode:
          // refusing the write would strand queue or tracker state that the
          // caller has already committed to in memory.
          writeFileSync(absPath, body, 'utf-8');
          try { unlinkSync(tmp); } catch { /* best effort */ }
          return;
        }
        sleepSync(20 * (attempt + 1));
      }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// writeJson is synchronous and called from synchronous paths throughout the
// autopilot, so the rename backoff cannot await.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB — skip the wait */ }
}

export function normalizeQ(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
