// Discovery legibility: what the scan + aggregator stage of a cycle actually
// did, in numbers the log, /health and the dashboard can show.
//
// Why this exists: for a full day the autopilot logged `cycle_done triaged:0
// evaluated:0` while `scan_done` carried only the last two lines of the
// scanner's stdout — the manifesto footer, identical on a run that added 30
// offers and on one where every portal failed. Nothing said which. These
// helpers are pure (text in, numbers out) so the parsing is testable without a
// scan, and so an operator can read a cycle from the API instead of ssh.
import { existsSync, readFileSync, statSync } from 'fs';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../../lib/path-resolver.mjs';
import { ROOT, p } from './util.mjs';
import { parseAtsUrl } from './jd.mjs';
import { titleFilterCoverage } from '../../lib/title-keywords.mjs';

const MAX_SAMPLES = 5;

/** `Label:   123 removed` → 123. Tolerates any run of spaces after the colon. */
function countAfter(line, label) {
  const m = line.match(new RegExp(`^${label}:\\s+(\\d+)`));
  return m ? Number(m[1]) : null;
}

/**
 * Parse the scanner's stdout/stderr into counters.
 *
 * Reads the "Portal Scan" summary block scripts/scan/scan.mjs prints (labels
 * are the contract: `Companies scanned:`, `Total jobs found:`, `Filtered by
 * <what>: N removed`, `Duplicates: N skipped`, `New offers added: N`), every
 * `  ✗ company: error` line from the error sections, the `🚨 FIX NEEDED`
 * streak line, and `⚠️` warnings from either stream (provider modules that
 * failed to load print there). A field the output did not carry stays null,
 * never 0 — "the scanner did not say" and "the scanner said zero" are
 * different facts to whoever is debugging a silent cycle.
 *
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {{
 *   companies: number|null, boards: number|null, found: number|null,
 *   new_added: number|null, dupes: number|null, blacklisted: number|null,
 *   filtered: Record<string, number>,
 *   errors: number, error_samples: string[],
 *   unreachable_streak: number, warnings: number, warning_samples: string[],
 *   summary_seen: boolean,
 * }}
 */
export function parseScanOutput(stdout, stderr = '') {
  const out = {
    companies: null, boards: null, found: null, new_added: null, dupes: null,
    dupes_url: null, dupes_role: null, blacklisted: null,
    filtered: {},
    errors: 0, error_samples: [],
    unreachable_streak: 0,
    warnings: 0, warning_samples: [],
    summary_seen: false,
  };
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('Portal Scan')) out.summary_seen = true;
    let n;
    if ((n = countAfter(line, 'Companies scanned')) != null) out.companies = n;
    else if ((n = countAfter(line, 'Job boards scanned')) != null) out.boards = n;
    else if ((n = countAfter(line, 'Total jobs found')) != null) out.found = n;
    else if ((n = countAfter(line, 'New offers added')) != null) out.new_added = n;
    else if ((n = countAfter(line, 'Duplicates')) != null) {
      out.dupes = n;
      // `Duplicates: 2111 skipped (0 same URL, 2111 same company+role)`. The
      // split is the diagnosis: an all-role run means new postings were
      // suppressed by dedupe memory, not that the boards had nothing to give.
      // Older scanners print no parenthetical, and both stay null there.
      const m = line.match(/\((\d+) same URL, (\d+) same company\+role\)/);
      if (m) { out.dupes_url = Number(m[1]); out.dupes_role = Number(m[2]); }
    } else if ((n = countAfter(line, 'Blacklisted')) != null) out.blacklisted = n;
    else if (/^Filtered by /.test(line)) {
      const m = line.match(/^Filtered by ([^:]+):\s+(\d+)/);
      if (m) out.filtered[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = Number(m[2]);
    } else if (/^\s+✗ /.test(line)) {
      out.errors++;
      if (out.error_samples.length < MAX_SAMPLES) out.error_samples.push(line.trim().slice(2).trim().slice(0, 160));
    } else if (/^🚨 FIX NEEDED: (\d+) target/.test(line)) {
      out.unreachable_streak = Number(line.match(/^🚨 FIX NEEDED: (\d+) target/)[1]);
    } else if (/^⚠️/.test(line)) {
      out.warnings++;
      if (out.warning_samples.length < MAX_SAMPLES) out.warning_samples.push(line.replace(/^⚠️\s*/, '').slice(0, 160));
    }
  }
  for (const raw of String(stderr || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(⚠️|Warning:|Error:|Fatal:)/.test(line) || /failed to load|skipping/.test(line)) {
      out.warnings++;
      if (out.warning_samples.length < MAX_SAMPLES) out.warning_samples.push(line.replace(/^⚠️\s*/, '').slice(0, 160));
    }
  }
  return out;
}

/** Header-aware TSV reader: the last `n` rows as objects keyed by the header. */
export function readTsvTail(absPath, n = 10) {
  if (!existsSync(absPath)) return { exists: false, rows: [], total: 0, mtime: null };
  const text = readFileSync(absPath, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { exists: true, rows: [], total: 0, mtime: statSync(absPath).mtime.toISOString() };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).slice(-n).map((l) => {
    const cells = l.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
  return { exists: true, rows, total: lines.length - 1, mtime: statSync(absPath).mtime.toISOString() };
}

/**
 * The most recent portal-health run: `data/portal-health.tsv` carries one
 * `timestamp\tcompany\tstatus` row per target per scan. Group the latest
 * timestamp's rows by status and name the non-reachable ones, so "every
 * portal failed with the same error" is one line instead of a file read.
 */
export function latestPortalHealth(absPath, maxNames = 25) {
  const { exists, rows } = readTsvTail(absPath, 2000);
  if (!exists || rows.length === 0) return { exists, at: null, counts: {}, not_reachable: [] };
  const last = rows[rows.length - 1].timestamp;
  const latest = rows.filter((r) => r.timestamp === last);
  const counts = {};
  const notReachable = [];
  for (const r of latest) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status !== 'reachable' && r.status !== 'empty' && notReachable.length < maxNames) notReachable.push(`${r.company}: ${r.status}`);
  }
  return { exists, at: last, targets: latest.length, counts, not_reachable: notReachable };
}

/** Collapse a skip reason to its class: `failed x3: HTTP 500 …` → `failed`. */
export function skipReasonClass(reason) {
  const r = String(reasonText(reason) || '').trim();
  if (!r) return 'unknown';
  const head = r.split(':')[0].trim();
  return head.replace(/\s+x\d+$/, '').replace(/\s+\(.*$/, '').replace(/\s+/g, '_').toLowerCase() || 'unknown';
}

// A skip entry is either the historical bare string or `{reason, at, retries}`.
// Both shapes must keep working: state files on live boxes carry the old one.
export const reasonText = (entry) => (entry && typeof entry === 'object' ? entry.reason : entry);

/**
 * Is this skip a verdict about the posting, or about the day we had?
 *
 * `unsupported_ats` / `unfetchable` / `triaged out` / `closed` are properties
 * of the posting: re-running changes nothing, so they are permanent. A
 * `failed xN: …` skip is not — it is three consecutive *attempts* that threw,
 * and the thing that made them throw is usually ours (an endpoint down, a
 * model unloaded, a hub that was not answering). Between 07-30 and 08-31, 35
 * URLs were retired that way; when the pool was misrouted, every offer in
 * flight became permanently skipped after three cycles, so an inference
 * outage silently converted itself into a drained pipeline that no fix to
 * inference could refill.
 */
export function isTransientSkip(entry) {
  return /^failed x\d+/i.test(String(reasonText(entry) || '').trim());
}

/** Seconds → ms, but as days, for readability at the call sites. */
const DAY_MS = 86_400_000;

/**
 * Should a transiently-skipped offer be given another chance this cycle?
 *
 * Bounded on both axes: not before `cooldownDays` have passed, and never more
 * than `maxRetries` times, so a URL that is genuinely dead in a way that
 * *looks* transient (a 500 that never stops) costs a handful of attempts over
 * weeks instead of one per cycle forever — the #749-class churn the three-strike
 * rule was added to stop.
 *
 * An entry with no timestamp (the historical string shape) is eligible once:
 * it was written before this policy existed, so there is no clock to wait on,
 * and leaving those permanently skipped would mean the fix never reaches the
 * offers the bug actually stranded.
 *
 * @param {string|{reason: string, at?: string, retries?: number}} entry
 * @param {{cooldownDays?: number, maxRetries?: number, now?: number}} [opts]
 */
export function shouldRetrySkip(entry, { cooldownDays = 3, maxRetries = 2, now = Date.now() } = {}) {
  if (!isTransientSkip(entry)) return false;
  if (typeof entry !== 'object' || entry === null) return true; // legacy string: one chance
  if ((entry.retries || 0) >= maxRetries) return false;
  const at = Date.parse(entry.at || '');
  if (!Number.isFinite(at)) return true;
  return now - at >= cooldownDays * DAY_MS;
}

/**
 * The offers a cycle should look at, and why the others were left out.
 *
 * Split out of runCycle so the selection rule is testable without a pipeline
 * file, a config, or a model.
 *
 * @param {{url: string}[]} pending
 * @param {{skipped?: Record<string, any>}} state
 * @param {{cooldownDays?: number, maxRetries?: number, now?: number}} [opts]
 */
export function selectPending(pending, state = {}, opts = {}) {
  const skipped = state.skipped || {};
  const offers = [];
  const retried = [];
  for (const o of pending) {
    const entry = skipped[o.url];
    if (entry == null) { offers.push(o); continue; }
    if (shouldRetrySkip(entry, opts)) { offers.push(o); retried.push(o.url); }
  }
  return { offers, retried };
}

/**
 * Drop skip entries that are no longer gating anything, so the ledger tracks
 * the live working set instead of growing forever.
 *
 * `state.skipped` had no eviction of any kind. On the autopilot host 2026-09-18 it held
 * 1048 entries / 184,190 bytes — 75% of a 246KB state file — and it is
 * REWRITTEN WHOLE on every debounced checkpoint touch (up to once per 1.5s;
 * lib/cycle-state.mjs replaces CYCLE_OWNED_KEYS wholesale, never merging one
 * level deeper), so its size is a per-touch write cost, not just disk. It grew
 * 619 → 1044 in the thirty minutes it took to measure it, and the triaged-out
 * durability fix adds roughly 2,000 more entries from the current backlog.
 *
 * Age alone is the wrong axis: nothing in that ledger was older than 19 days,
 * so a 30-day TTL would have freed exactly nothing. What makes an entry dead
 * is STRUCTURAL — its pipeline.md row is checked off, so no selection pass can
 * ever consult it again.
 *
 * The two conditions are sequential guards, deliberately, and the order is
 * load-bearing: a url still in `pending` returns before the age test is even
 * reached, so the "no timestamp" carve-out can never become an independent
 * reason to prune. Written as one `if` with an `||` inside, a refactor could
 * short-circuit past the pending check and evict a transient skip that still
 * has retries owed to it (sweepSkippedPending leaves exactly those rows
 * unchecked, which is what keeps them in `pending` here).
 *
 * Why this cannot cause re-work, in the three places it could:
 *   - selectPending() only ever looks up urls that ARE pending; a pruned entry
 *     is by construction not one of those.
 *   - pipelineBreakdown() likewise reads `skipped[o.url]` per pending row.
 *     `skipped_total` does shrink — it reported the whole ledger, not the part
 *     that gates anything, which is the more honest number anyway.
 *   - reconcileLeads() (lib/leads.mjs) walks the whole map, but reads a
 *     checked-off pipeline.md row as its own fourth signal for exactly this
 *     case, and its final pass never regresses an entry to 'queued' when no
 *     signal matches. A pruned lead resolves identically.
 *
 * The one thing it depends on is `scan_history.recheck_after_days` staying
 * unset (URL-tier dedup permanent), which is what stops the scanner re-adding
 * a pruned url as a fresh row. `role_recheck_after_days` (30d default) is a
 * different tier — it only ever admits a NEW url for a repost, never replays
 * this key. If the URL tier is ever enabled, this needs a floor derived from
 * it rather than `graceDays`.
 *
 * @param {{skipped?: Record<string, any>}} state - mutated in place
 * @param {Iterable<string>|Set<string>} pendingUrls - urls still unchecked in pipeline.md
 * @param {{graceDays?: number, now?: number}} [opts]
 * @returns {{pruned: number, kept: number}}
 */
export function pruneResolvedSkips(state, pendingUrls, { graceDays = 3, now = Date.now() } = {}) {
  const skipped = state?.skipped;
  if (!skipped || typeof skipped !== 'object') return { pruned: 0, kept: 0 };
  const pending = pendingUrls instanceof Set ? pendingUrls : new Set(pendingUrls || []);
  const graceMs = Math.max(0, Number(graceDays) || 0) * DAY_MS;
  let pruned = 0;
  for (const url of Object.keys(skipped)) {
    // (a) still gating a row the next selection pass will look at. Returns
    // FIRST, so nothing below can override it.
    if (pending.has(url)) continue;
    // (b) and past the grace window. An entry with no parseable `at` is the
    // pre-2026-08-30 bare-string shape — there is no clock to wait on, and it
    // already passed (a), so it goes now.
    const entry = skipped[url];
    const at = entry && typeof entry === 'object' ? Date.parse(entry.at || '') : NaN;
    if (Number.isFinite(at) && now - at < graceMs) continue;
    delete skipped[url];
    pruned++;
  }
  return { pruned, kept: Object.keys(skipped).length };
}

/**
 * What the pending inbox really holds: rows the next cycle will look at vs
 * rows a previous cycle already gave up on (`state.skipped`) but never
 * checked off. Before this, `pending_left` counted both and read as "28 offers
 * waiting" for weeks while the cycle correctly ignored all 28.
 *
 * @param {{url: string}[]} pending - parsePendingOffers() of data/pipeline.md
 * @param {{skipped?: Record<string,string>, triage_pass?: Record<string,number>, fail_counts?: Record<string,number>}} state
 */
export function pipelineBreakdown(pending, state = {}) {
  const skipped = state.skipped || {};
  const triagePass = state.triage_pass || {};
  const failCounts = state.fail_counts || {};
  const reasons = {};
  // (ats, HTTP status) tally for transient `failed xN: HTTP ###` skips only —
  // diagnosed live 2026-09-17: 20 stuck rows, all `failed x3: HTTP 403 from
  // <workday cxs url>`, and the plain "already skipped (failed:20)" message
  // gave the operator no way to tell that apart from an inference outage or a
  // dead endpoint. Cheap: it reads the same skip entries the loop above
  // already visits, no extra file reads.
  const httpFailures = {};
  let skippedRows = 0;
  let actionable = 0;
  let triagePassed = 0;
  for (const o of pending) {
    if (skipped[o.url] != null) {
      skippedRows++;
      const entry = skipped[o.url];
      const cls = skipReasonClass(entry);
      reasons[cls] = (reasons[cls] || 0) + 1;
      if (isTransientSkip(entry)) {
        const m = String(reasonText(entry) || '').match(/HTTP (\d{3})/);
        if (m) {
          const ats = parseAtsUrl(o.url)?.ats || 'other';
          const key = `${ats}:${m[1]}`;
          httpFailures[key] = (httpFailures[key] || 0) + 1;
        }
      }
      continue;
    }
    actionable++;
    if (triagePass[o.url] != null) triagePassed++;
  }
  // Name it only when it actually dominates — a mixed bag of statuses/ATSs
  // is more honestly left as the plain "failed:N" total.
  let dominantFailure = null;
  const failureEntries = Object.entries(httpFailures);
  if (failureEntries.length) {
    failureEntries.sort((a, b) => b[1] - a[1]);
    const [key, count] = failureEntries[0];
    if (count >= 2 && count / skippedRows >= 0.6) {
      const [ats, status] = key.split(':');
      dominantFailure = { ats, status: Number(status), count, of: skippedRows };
    }
  }
  return {
    pending_rows: pending.length,
    actionable,
    dominant_failure: dominantFailure,
    skipped_rows: skippedRows,
    skipped_reasons: reasons,
    triage_passed: triagePassed,
    skipped_total: Object.keys(skipped).length,
    failing: Object.keys(failCounts).length,
  };
}

/**
 * Where the two halves of discovery read and write. The autopilot resolves
 * `data/` from its own module location (`util.mjs` ROOT); the scanner, since
 * v1.30.0, from `lib/path-resolver.mjs` (env override → `.career-ops-data`
 * marker → repo root). They agree unless an env var or marker says otherwise —
 * and if they disagree, the scanner fills an inbox the cycle never reads.
 */
export function discoveryPaths(env = process.env) {
  let scanRoot = null;
  try { scanRoot = getCareerOpsRoot(); } catch { scanRoot = null; }
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const envNames = ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_TRACKER', 'CAREER_OPS_PORTALS', 'CAREER_OPS_PROFILE'];
  const envSet = {};
  for (const n of envNames) envSet[n] = Boolean(String(env[n] || '').trim());
  return {
    autopilot_root: ROOT,
    scan_data_root: scanRoot,
    same_root: scanRoot != null && norm(scanRoot) === norm(ROOT),
    marker_file: existsSync(`${ROOT}/.career-ops-data`),
    env: envSet,
    node: process.version,
    platform: process.platform,
  };
}

/**
 * Whether the candidate's own `config/profile.yml` `target_roles.primary`
 * titles can ever reach the pipeline through `portals.yml`'s `title_filter` —
 * the coverage block both `GET /api/discovery` and the discovery doctor serve
 * (`title_filter_rejects_targets`). The autopilot host ran 24 straight cycles at
 * `new_added: 0` with a `title_filter.positive` narrowed to 12 phrases that
 * covered 3 of the profile's 7 target roles, and nothing said so until this.
 *
 * Never throws: a missing or unreadable portals.yml/profile.yml reads as
 * `configured:false`, zeroed counts and empty arrays — the same "don't guess"
 * default the rest of this module uses (discoveryPaths(), readTsvTail()...).
 *
 * Returns role TITLES only — never any other profile field. config/profile.yml
 * also carries the candidate's name, email and comp target, and none of that
 * may leave this function; the shape below is the whole contract.
 *
 * @param {{portalsPath?: string, profilePath?: string}} [opts]
 * @returns {{
 *   configured: boolean, positive: number, negative: number,
 *   primary_roles: number, admitted: string[], rejected: string[],
 *   vetoed: {title: string, by: string}[],
 * }}
 */
export function titleFilterProfileCoverage({ portalsPath = p('portals.yml'), profilePath = p('config', 'profile.yml') } = {}) {
  const countUsable = (arr) => (Array.isArray(arr) ? arr.filter((k) => typeof k === 'string' && k.trim().length > 0).length : 0);
  let titleFilter;
  try {
    titleFilter = existsSync(portalsPath) ? yaml.load(readFileSync(portalsPath, 'utf-8'))?.title_filter : undefined;
  } catch {
    titleFilter = undefined;
  }
  let roles = [];
  try {
    const primary = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf-8'))?.target_roles?.primary : undefined;
    roles = Array.isArray(primary) ? primary.filter((r) => typeof r === 'string' && r.trim().length > 0) : [];
  } catch {
    roles = [];
  }
  const positive = countUsable(titleFilter?.positive);
  const negative = countUsable(titleFilter?.negative);
  const coverage = titleFilterCoverage(titleFilter, roles);
  return {
    configured: positive > 0 || negative > 0,
    positive,
    negative,
    primary_roles: roles.length,
    admitted: coverage.admitted,
    rejected: coverage.rejected,
    vetoed: coverage.vetoed,
  };
}

/** One line for the log / dashboard: "91 portals, 812 found, 0 new, 91 errors". */
export function summarizeScan(scan) {
  if (!scan) return 'no scan';
  if (scan.failed) return `scan failed: ${scan.error || 'unknown error'}`;
  if (!scan.summary_seen) return 'scan printed no summary';
  const parts = [];
  if (scan.companies != null) parts.push(`${scan.companies} portals`);
  if (scan.found != null) parts.push(`${scan.found} found`);
  if (scan.new_added != null) parts.push(`${scan.new_added} new`);
  if (scan.errors) parts.push(`${scan.errors} errors`);
  if (scan.warnings) parts.push(`${scan.warnings} warnings`);
  return parts.join(', ') || 'scan ran';
}
