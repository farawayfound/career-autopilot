/**
 * autopilot/lib/discovery-frontier.mjs — the discovery node's self-feeding
 * candidate ledger: employers it has HEARD OF (a funding feed, a VC
 * portfolio page) but not yet resolved to a scannable job board.
 *
 * Today the node only scans companies a human enumerated in portals.yml. That
 * caps discovery at the size of a hand-maintained list. The frontier is what
 * lets it grow that list itself: a candidate is seeded once (by name, maybe a
 * website), sits in `data/discovery-node/frontier.json` until a resolver job
 * (out of scope here) tries to turn it into a real `{careers_url, provider}`
 * board entry, and only then becomes eligible for `resolvedEntries()` — which
 * a human still promotes into portals.yml BY HAND (AGENTS.md's Data Contract:
 * a discovery node may never write that file itself).
 *
 * The one failure mode this module exists to prevent is re-probing a domain
 * forever. A naive "seed it, try it, drop it on failure" design either (a)
 * retries a dead site every single cycle, wasting the node's own HTTP budget
 * and drawing exactly the kind of hammering AGENTS.md's crawl-hygiene rules
 * (robots.txt, per-host pacing) exist to avoid, or (b) drops a candidate after
 * one failed attempt, even though "the resolver's HTTP call timed out" and
 * "this company has no careers page" are completely different facts. Backoff
 * (RESOLVE_BACKOFF_DAYS) buys time between retries without ever forgetting a
 * candidate; the resolved/unresolved/dead state split keeps "couldn't tell
 * yet" (retry later, cheaply) distinct from "definitively not a job board"
 * (scripts/scan/discover-ats.mjs's isDefinitiveAbsence — a 404/410, never a
 * timeout or 5xx) so a transient outage can never permanently blacklist a
 * real employer the way a strike-based skip ledger has, elsewhere in this
 * repo, more than once.
 *
 * PURE LOGIC PLUS TWO THIN IO SEAMS — same split as autopilot/lib/discovery-node.mjs:
 * every decision here is a pure function over a plain `frontier` object
 * (constructed, inspected and mutated with no filesystem or network access at
 * all), and only readFrontier()/writeFrontier() touch disk, each taking an
 * explicit path so a test can point them at a temp file instead of the real
 * `data/discovery-node/frontier.json`.
 *
 * Company keys go through normalizeCompany() — the SAME fold
 * autopilot/lib/discovery-node.mjs's renderPortalsYml() uses to dedupe
 * `tracked_companies` — so a frontier candidate and a portals.yml entry for
 * the same company always collide on the same key, rather than each module
 * growing its own notion of "the same company" and silently drifting apart.
 *
 * Zero LLM calls, zero auth (AGENTS.md's Discovery node section): everything
 * below is deterministic string/number/date logic.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, basename, join } from 'path';
import { normalizeCompany, renameSyncWithRetry } from '../../lib/tracker-utils.mjs';

/** Current on-disk schema version. Bump alongside a migration if the shape ever changes. */
export const FRONTIER_VERSION = 1;

/**
 * One frontier candidate: an employer name the node has heard of, plus what
 * it has learned trying to turn that into a scannable job board.
 *
 * @typedef {object} FrontierEntry
 * @property {string} name - Display name as first seeded (not the normalized key).
 * @property {string|null} website - Best-known domain/URL for this company, if any.
 * @property {string[]} sources - Where this candidate came from (capped at 6), e.g. 'techcrunch', 'vc:accel'.
 * @property {string} first_seen - ISO timestamp of the first time this key was added.
 * @property {string} last_seen - ISO timestamp of the most recent time this key was added/re-seeded.
 * @property {number} hits - How many times a seed has reported this candidate.
 * @property {'new'|'resolved'|'unresolved'|'dead'} state - Resolution lifecycle state.
 * @property {number} attempts - Count of 'unresolved' resolution attempts since the last reset.
 * @property {string|null} last_attempt_at - ISO timestamp of the most recent recordResolution() call.
 * @property {string|null} next_attempt_at - ISO timestamp before which dueCandidates() will not offer this entry.
 * @property {string|null} reason - Free-text reason from the most recent resolution attempt.
 * @property {object|null} resolved - Portals-shaped details once state is 'resolved'; null otherwise.
 */

/**
 * A fresh, empty frontier ledger.
 *
 * @returns {{version: number, updated_at: string|null, companies: Object<string, FrontierEntry>}}
 */
export function emptyFrontier() {
  return { version: FRONTIER_VERSION, updated_at: null, companies: {} };
}

/**
 * Derive the frontier's storage key for a company name.
 *
 * Delegates entirely to normalizeCompany() (lib/tracker-utils.mjs) rather than
 * a local fold, so a frontier candidate and a `tracked_companies` entry for
 * the same employer always land on the same key — see the module header.
 *
 * @param {*} name - Candidate company name (any input; non-strings coerce like normalizeCompany does).
 * @returns {string} Normalized key, or '' when the name has no usable content.
 */
export function frontierKey(name) {
  return normalizeCompany(name);
}

/** Cap on how many distinct `source` tags one entry keeps (addCandidates' sources union). */
const MAX_SOURCES = 6;

/**
 * Seed or refresh candidates in the frontier.
 *
 * A brand-new key is inserted in state 'new'. An EXISTING key is never
 * downgraded by a re-seed: its `hits` counter bumps, `last_seen` advances to
 * `now`, and `website` is filled in ONLY when the entry had none — a later,
 * lower-quality seed (a bare company-name mention) must never clobber a
 * website an earlier, more specific seed (or a resolver, via
 * recordResolution's own website field) already confirmed.
 *
 * @param {{version: number, updated_at: string|null, companies: Object<string, FrontierEntry>}} frontier - Mutated in place.
 * @param {Array<{name: *, website?: string, source?: string, discovered_at?: string}>} candidates - Raw seed candidates.
 * @param {{now?: number}} [options] - `now` as epoch ms; defaults to Date.now() (test seam).
 * @returns {{added: number, updated: number, skipped: number, revived: number}} Counts for this call.
 */
export function addCandidates(frontier, candidates, { now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let revived = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const key = frontierKey(candidate?.name);
    if (!key) { skipped++; continue; }
    const website = candidate?.website ? String(candidate.website) : null;
    const source = candidate?.source ? String(candidate.source) : null;
    const existing = frontier.companies[key];
    if (!existing) {
      const seenAt = candidate?.discovered_at ? String(candidate.discovered_at) : nowIso;
      frontier.companies[key] = {
        name: String(candidate.name).trim(),
        website,
        sources: source ? [source] : [],
        first_seen: seenAt,
        last_seen: seenAt,
        hits: 1,
        state: 'new',
        attempts: 0,
        last_attempt_at: null,
        next_attempt_at: null,
        reason: null,
        resolved: null,
      };
      added++;
    } else {
      existing.hits += 1;
      existing.last_seen = nowIso;
      // A DEAD entry that has just been handed a website it did not have is
      // the one case worth reopening, and this is the only place it can be
      // noticed. `dead` means "every vendor we could derive from the name said
      // no" (or a definitive 404); a domain is new evidence that was never
      // tried, and the site-fingerprint path it unlocks resolves exactly the
      // cases slug-guessing cannot. Without this the website would be stored,
      // the state would stay `dead`, dueCandidates would never return it, and
      // the new evidence would sit in the ledger unused forever.
      //
      // Deliberately BEFORE the website assignment below: reviveCandidate
      // refuses when the incoming website equals the stored one, and assigning
      // first would make every revival look like a no-op.
      if (existing.state === 'dead' && website) {
        if (reviveCandidate(frontier, key, { now, website })) revived++;
      }
      if (!existing.website && website) existing.website = website;
      if (source && !existing.sources.includes(source) && existing.sources.length < MAX_SOURCES) {
        existing.sources.push(source);
      }
      updated++;
    }
  }
  return { added, updated, skipped, revived };
}

/**
 * Candidates eligible for a resolve attempt right now.
 *
 * Eligible means: state is one of `states`, AND either the entry has never
 * been attempted (`next_attempt_at` is null) or its backoff window has
 * elapsed (`next_attempt_at <= now`).
 *
 * Ordering is fully deterministic (no Math.random, ever — this feeds a
 * resolver job's HTTP budget, and a resolver's own tests need a stable plan
 * to assert against): entries WITH a website first (cheap to probe, likely to
 * resolve), then by `hits` descending (a candidate several sources agree on
 * is worth resolving before one seen once), then by `first_seen` ascending,
 * then by key — the last tiebreak exists purely so two entries that are
 * otherwise identical never depend on object key iteration order.
 *
 * @param {{companies: Object<string, FrontierEntry>}} frontier
 * @param {{now?: number, limit?: number, states?: string[]}} [options]
 * @returns {Array<FrontierEntry & {key: string}>} Up to `limit` entries, most eligible first.
 */
export function dueCandidates(frontier, { now = Date.now(), limit = 25, states = ['new', 'unresolved'] } = {}) {
  const stateSet = new Set(states);
  const nowIso = new Date(now).toISOString();
  const eligible = [];
  for (const [key, entry] of Object.entries(frontier?.companies || {})) {
    if (!entry || !stateSet.has(entry.state)) continue;
    if (entry.next_attempt_at && entry.next_attempt_at > nowIso) continue;
    eligible.push({ key, ...entry });
  }
  eligible.sort((a, b) => {
    const aHasSite = a.website ? 0 : 1;
    const bHasSite = b.website ? 0 : 1;
    if (aHasSite !== bHasSite) return aHasSite - bHasSite;
    if ((b.hits || 0) !== (a.hits || 0)) return (b.hits || 0) - (a.hits || 0);
    const bySeen = String(a.first_seen).localeCompare(String(b.first_seen));
    if (bySeen !== 0) return bySeen;
    return a.key.localeCompare(b.key);
  });
  return eligible.slice(0, limit);
}

/**
 * Backoff schedule (days) between resolve attempts while an entry stays
 * 'unresolved'. Index 0 is the wait after the FIRST unresolved attempt.
 * Exported so a test asserts the real schedule instead of a second hardcoded
 * copy of it drifting from this one.
 */
export const RESOLVE_BACKOFF_DAYS = [1, 3, 7, 21, 60];

/**
 * Record the outcome of one resolve attempt against a frontier candidate.
 *
 * `result.status`:
 *   - 'resolved' — a scannable board was found. State becomes 'resolved',
 *     `resolved` is stamped `{...result.entry, at: <now, ISO>}`, and the
 *     backoff clock is cleared (next_attempt_at: null, attempts: 0).
 *   - 'unresolved' — the resolver could not tell either way (a timeout, a 5xx,
 *     an ambiguous page). `attempts` increments and `next_attempt_at` is set
 *     from RESOLVE_BACKOFF_DAYS[attempts - 1]. Once `attempts` exceeds the
 *     schedule's length, the entry gives up: state becomes 'dead' with reason
 *     `exhausted: <reason>` — NOT because absence was proven, only because
 *     retrying further is no longer worth the node's HTTP budget.
 *   - 'dead' — DEFINITIVE absence (an HTTP 404/410; see
 *     scripts/scan/discover-ats.mjs's isDefinitiveAbsence and the #2883
 *     comment above it explaining why a 5xx/timeout must never be treated as
 *     proof of absence). State becomes 'dead' immediately, no backoff.
 *
 * `result.website`, when given, is recorded onto the entry regardless of
 * status — this is the path a resolver that turned up a domain along the way
 * feeds it back, even on an 'unresolved' attempt.
 *
 * @param {{companies: Object<string, FrontierEntry>}} frontier - Mutated in place.
 * @param {string} key - frontierKey() of the candidate to update.
 * @param {{status: 'resolved'|'unresolved'|'dead', entry?: object, reason?: string, website?: string}} result
 * @param {{now?: number}} [options]
 * @returns {FrontierEntry|null} The mutated entry, or null when `key` is unknown.
 */
export function recordResolution(frontier, key, result, { now = Date.now() } = {}) {
  const entry = frontier?.companies?.[key];
  if (!entry) return null;
  const nowIso = new Date(now).toISOString();
  entry.last_attempt_at = nowIso;
  if (result?.website) entry.website = String(result.website);

  const status = result?.status;
  if (status === 'resolved') {
    entry.state = 'resolved';
    entry.resolved = { ...(result.entry || {}), at: nowIso };
    entry.next_attempt_at = null;
    entry.attempts = 0;
    entry.reason = null;
  } else if (status === 'unresolved') {
    const reason = result?.reason ? String(result.reason) : null;
    entry.attempts += 1;
    entry.reason = reason;
    const scheduleIndex = entry.attempts - 1;
    if (scheduleIndex < RESOLVE_BACKOFF_DAYS.length) {
      entry.state = 'unresolved';
      const days = RESOLVE_BACKOFF_DAYS[scheduleIndex];
      entry.next_attempt_at = new Date(now + days * 86_400_000).toISOString();
    } else {
      entry.state = 'dead';
      entry.next_attempt_at = null;
      entry.reason = `exhausted: ${reason || ''}`;
    }
  } else if (status === 'dead') {
    entry.state = 'dead';
    entry.next_attempt_at = null;
    entry.reason = result?.reason ? String(result.reason) : null;
  } else {
    // FAIL LOUD (AGENTS.md house rule): an unrecognized status is a caller
    // bug, not a case to guess a default lifecycle transition for — silently
    // leaving the entry's state untouched would hide exactly that bug.
    throw new Error(`recordResolution: unknown result.status ${JSON.stringify(status)}`);
  }
  return entry;
}

/**
 * Give a 'dead' candidate one more chance, but ONLY when armed with a website
 * it did not have before.
 *
 * Both ways an entry reaches 'dead' — a definitive 404/410 at its known
 * website, or the backoff schedule running out on repeated 'unresolved'
 * attempts against that same website — are, from this module's point of
 * view, the same fact: probing THAT website again predicts the same outcome
 * again. Neither is a reason to believe the company itself doesn't exist. A
 * new website (a rebrand, a corrected domain, a second seed disagreeing with
 * the first) is a genuinely different probe, so — and only so — it earns a
 * fresh attempt budget. Reviving on the SAME website would just re-spend that
 * budget re-discovering what is already known.
 *
 * @param {{companies: Object<string, FrontierEntry>}} frontier - Mutated in place.
 * @param {string} key - frontierKey() of the candidate to revive.
 * @param {{now?: number, website?: string}} [options] - `website` is the new domain; required to revive.
 * @returns {boolean} True when the entry was revived.
 */
export function reviveCandidate(frontier, key, { now = Date.now(), website } = {}) {
  const entry = frontier?.companies?.[key];
  if (!entry || entry.state !== 'dead') return false;
  const newWebsite = website ? String(website) : null;
  if (!newWebsite || newWebsite === entry.website) return false;
  entry.website = newWebsite;
  entry.state = 'unresolved';
  entry.attempts = 0;
  entry.reason = null;
  entry.next_attempt_at = null;
  void now; // accepted for API symmetry with the other options objects; nothing here is timestamped by it
  return true;
}

/**
 * Every 'resolved' candidate, shaped for `renderPortalsYml`'s `localEmployers`
 * parameter (autopilot/lib/discovery-node.mjs).
 *
 * Optional keys absent from the resolved details are OMITTED rather than
 * emitted as `api: undefined` — renderPortalsYml/yaml.dump would otherwise
 * write a literal `api: undefined` line into the node's portals.yml.
 *
 * @param {{companies: Object<string, FrontierEntry>}} frontier
 * @returns {Array<{name: string, careers_url: *, api?: *, provider?: *, enabled: true}>}
 */
export function resolvedEntries(frontier) {
  const out = [];
  for (const entry of Object.values(frontier?.companies || {})) {
    if (!entry || entry.state !== 'resolved' || !entry.resolved) continue;
    const r = entry.resolved;
    const shaped = { name: r.name || entry.name, careers_url: r.careers_url, enabled: true };
    if (r.api !== undefined) shaped.api = r.api;
    if (r.provider !== undefined) shaped.provider = r.provider;
    out.push(shaped);
  }
  return out;
}

/**
 * Roll-up counters over the whole frontier, for the node's heartbeat/status
 * reporting (see AGENTS.md's "Report discovered employers in the heartbeat").
 *
 * @param {{companies: Object<string, FrontierEntry>}} frontier
 * @param {{now?: number}} [options]
 * @returns {{total: number, new: number, resolved: number, unresolved: number, dead: number, due: number, with_website: number}}
 */
export function frontierStats(frontier, { now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  let total = 0;
  let newCount = 0;
  let resolved = 0;
  let unresolved = 0;
  let dead = 0;
  let due = 0;
  let withWebsite = 0;
  for (const entry of Object.values(frontier?.companies || {})) {
    if (!entry) continue;
    total++;
    if (entry.website) withWebsite++;
    if (entry.state === 'new') newCount++;
    else if (entry.state === 'resolved') resolved++;
    else if (entry.state === 'unresolved') unresolved++;
    else if (entry.state === 'dead') dead++;
    if ((entry.state === 'new' || entry.state === 'unresolved')
      && (!entry.next_attempt_at || entry.next_attempt_at <= nowIso)) {
      due++;
    }
  }
  return { total, new: newCount, resolved, unresolved, dead, due, with_website: withWebsite };
}

/**
 * Bound the frontier's size, without ever discarding a 'resolved' candidate —
 * it is the thing feeding portals.yml, and a candidate can take a very long
 * time to resolve, so pruning it is the one outcome worse than an oversized
 * file.
 *
 * Note this is a SEPARATE prune from autopilot/lib/discovery-node.mjs's own
 * `pruneState`, which only trims the node's shipped/held/dropped ledger (a
 * different file, `data/discovery-node/state.json`, via the daemon's own
 * state); it never touches this frontier, and this function never touches
 * that state — the two ledgers age out independently.
 *
 * Two passes:
 *   1. Drop 'dead' entries whose most recent resolve attempt (`last_attempt_at`,
 *      falling back to `last_seen` for a malformed record with none) is older
 *      than `deadTtlDays`. `last_attempt_at` freezes the moment an entry is
 *      marked dead (dueCandidates never offers a 'dead' entry again, so it is
 *      never re-attempted), so it measures "how long has this been a known
 *      dead end" — `last_seen` alone would keep resetting the clock every time
 *      a funding feed happens to re-mention an already-dead company.
 *   2. If still over `maxEntries`, drop the lowest-value REMAINING (never
 *      'resolved') entries: 'dead' first, then 'unresolved' ranked by most
 *      attempts (the ones that have cost the most and gotten nowhere), then —
 *      within any remaining tie, across every state — fewest `hits`, then
 *      oldest `first_seen`.
 *
 * @param {{companies: Object<string, FrontierEntry>}} frontier - Mutated in place.
 * @param {{maxEntries?: number, deadTtlDays?: number, now?: number}} [options]
 * @returns {{removed: number}}
 */
export function pruneFrontier(frontier, { maxEntries = 20_000, deadTtlDays = 180, now = Date.now() } = {}) {
  const companies = frontier?.companies || {};
  let removed = 0;

  const cutoffIso = new Date(now - deadTtlDays * 86_400_000).toISOString();
  for (const [key, entry] of Object.entries(companies)) {
    if (!entry || entry.state !== 'dead') continue;
    const deadSince = String(entry.last_attempt_at || entry.last_seen || '');
    if (deadSince && deadSince < cutoffIso) {
      delete companies[key];
      removed++;
    }
  }

  const remaining = Object.keys(companies).length;
  if (remaining > maxEntries) {
    const rank = (entry) => (entry.state === 'dead' ? 0 : entry.state === 'unresolved' ? 1 : 2);
    const candidates = Object.entries(companies).filter(([, entry]) => entry && entry.state !== 'resolved');
    candidates.sort(([, a], [, b]) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1 && (b.attempts || 0) !== (a.attempts || 0)) return (b.attempts || 0) - (a.attempts || 0);
      if ((a.hits || 0) !== (b.hits || 0)) return (a.hits || 0) - (b.hits || 0);
      return String(a.first_seen).localeCompare(String(b.first_seen));
    });
    const toDrop = remaining - maxEntries;
    for (let i = 0; i < toDrop && i < candidates.length; i++) {
      delete companies[candidates[i][0]];
      removed++;
    }
  }

  return { removed };
}

/**
 * Load the frontier ledger from disk.
 *
 * NEVER throws: a missing file, a permission error, malformed JSON, or a
 * `version` this module doesn't recognize all fold to emptyFrontier(). A
 * corrupt ledger costs a rebuild (the frontier re-seeds itself from the next
 * funding-feed/VC-portfolio scan), not a crashed daemon — see AGENTS.md's
 * "FAIL LOUD, NEVER SILENTLY GUESS", which this deliberately does NOT
 * violate: there is no guess being made here, only a safe, documented,
 * always-the-same fallback for input this module cannot trust.
 *
 * @param {string} path - Absolute path to `frontier.json`.
 * @returns {{version: number, updated_at: string|null, companies: Object<string, FrontierEntry>}}
 */
export function readFrontier(path) {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyFrontier();
    if (parsed.version !== FRONTIER_VERSION) return emptyFrontier();
    if (!parsed.companies || typeof parsed.companies !== 'object' || Array.isArray(parsed.companies)) {
      return emptyFrontier();
    }
    return parsed;
  } catch {
    return emptyFrontier();
  }
}

/**
 * Write the frontier ledger atomically (temp file, same directory, then
 * rename — see renameSyncWithRetry's own header for why the rename itself
 * retries on Windows). Creates the parent directory if absent, and stamps
 * `updated_at` on the object being written (and thus, since `frontier` is
 * mutated in place, on the caller's own reference too).
 *
 * @param {string} path - Absolute path to `frontier.json`.
 * @param {{companies: Object<string, FrontierEntry>}} frontier - Mutated in place (version/updated_at stamped).
 * @returns {void}
 */
export function writeFrontier(path, frontier) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  frontier.version = FRONTIER_VERSION;
  frontier.updated_at = new Date().toISOString();
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(frontier, null, 2), 'utf-8');
  renameSyncWithRetry(tmpPath, path);
}
