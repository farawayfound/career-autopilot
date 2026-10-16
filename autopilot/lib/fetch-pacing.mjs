// autopilot/lib/fetch-pacing.mjs — a 429 is a statement about OUR request
// rate, never a verdict on the posting, and the thing a remote rate-limits is
// the BUCKET it actually enforces the limit on, not the hostname we happened
// to dial.
//
// Measured incident (the autopilot host, 2026-09-15 10:53:54Z–10:57:51Z): the triage
// pre-pass fetched postings at 13 different Workday tenants — all
// `*.wd1.myworkdayjobs.com` — and got 27 × `HTTP 429` in four minutes.
// Workday rate-limits its shared `wdN` cluster by client IP, so 13 tenants at
// 2-concurrent each (autopilot.mjs's old `perHostFetchLimiter`, keyed on
// `new URL(url).host` — the TENANT hostname) looked to Workday like one host
// at ~26-concurrent. Before this module, a 429 was also indistinguishable
// from a genuine fetch failure: three of them retired a posting as
// `failed x3`, and a 429 on a generic (non-JSON-API) page was reported as
// `unsupported`, checking the row off as permanently unfetchable.
//
// This module supplies three things callers combine themselves (jd.mjs
// throws RateLimitedError on a 429/999; autopilot.mjs treats that throw as a
// DEFERRAL rather than a strike — see offerFailure there):
//   1. A typed error (RateLimitedError) + a classifier (isRateLimited) so a
//      429 can be told apart from every other fetch failure, including one
//      thrown by a code path this module has never heard of (the regex net
//      in isRateLimited).
//   2. The bucket rule (pacingKeyFor): every Workday tenant on the same
//      shard shares ONE bucket; everything else keeps its own hostname as
//      today.
//   3. A per-bucket pacer (createFetchPacer) that caps concurrency, spaces
//      consecutive starts, and — on a 429 — opens a CLUSTER-WIDE cooldown
//      that every caller sharing the bucket waits out, with one built-in
//      retry so the common case (one burst, one wait) resolves as a success
//      the offer itself never sees.

/**
 * Thrown for an HTTP 429 (or LinkedIn's own 999 rate-limit code) in place of
 * the generic `HTTP ${status} from ${url}` Error every other fetch failure
 * throws. `message` keeps that exact shape — `describeError()`
 * (autopilot/lib/llm.mjs) and every log grep for "HTTP 429" still work
 * unchanged — with an optional human-readable suffix appended only when a
 * Retry-After value is known.
 */
export class RateLimitedError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.url - The URL that was fetched.
   * @param {number} opts.status - 429, or 999 for LinkedIn's own code.
   * @param {string} [opts.host=''] - `new URL(url).host`, or '' when url did not parse.
   * @param {number|null} [opts.retryAfterMs=null] - Parsed Retry-After, ms, or null when absent/unparseable.
   */
  constructor({ url, status, host = '', retryAfterMs = null }) {
    const suffix = retryAfterMs != null ? ` (retry after ${Math.round(retryAfterMs / 1000)}s)` : '';
    super(`HTTP ${status} from ${url}${suffix}`);
    this.name = 'RateLimitedError';
    this.code = 'RATE_LIMITED';
    this.status = status;
    this.url = url;
    this.host = host;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Ceiling on any parsed Retry-After — a remote asking for longer than this waits at most this long. */
export const RETRY_AFTER_MAX_MS = 300_000;

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 *
 * Accepts either form the spec allows: delta-seconds (`"30"` → 30000ms) or an
 * HTTP-date (parsed and measured against `now`, floored at 0 for a date
 * already in the past — the server is saying "you may retry", not "time
 * travel"). Anything else, or a missing value, is not an error: it just
 * means the caller falls back to its own policy default.
 *
 * @param {string|null|undefined} headerValue - The raw `retry-after` header value.
 * @param {{now?: number}} [opts] - `now` in ms epoch, injectable for tests.
 * @returns {number|null} Milliseconds to wait, capped at RETRY_AFTER_MAX_MS, or null.
 */
export function parseRetryAfter(headerValue, { now = Date.now() } = {}) {
  if (headerValue == null) return null;
  const raw = String(headerValue).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return Math.min(parseInt(raw, 10) * 1000, RETRY_AFTER_MAX_MS);
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return Math.min(Math.max(0, parsed - now), RETRY_AFTER_MAX_MS);
  }
  return null;
}

/**
 * Build a RateLimitedError from a fetch URL + a fetch Response-like object.
 *
 * Tolerant of `res.headers` being absent or not carrying a `.get` (a caller
 * may hand this a minimal stand-in, in tests or otherwise) — no header means
 * no Retry-After, not a throw.
 *
 * @param {string} url - The URL that was fetched.
 * @param {{status?: number, headers?: {get?: (name: string) => string|null}}} res - A fetch Response, or a Response-like.
 * @returns {RateLimitedError}
 */
export function rateLimitedError(url, res) {
  const status = res?.status ?? 429;
  let host = '';
  try { host = new URL(url).host; } catch { /* unparseable url — host stays '' */ }
  const headerValue = (res?.headers && typeof res.headers.get === 'function')
    ? res.headers.get('retry-after')
    : null;
  return new RateLimitedError({ url, status, host, retryAfterMs: parseRetryAfter(headerValue) });
}

/**
 * Is `err` a rate-limit signal? Checked three ways, widest last: a typed
 * RateLimitedError (`code`), a plain object shaped like one (`status`), and —
 * the net that catches a 429/999 thrown by a code path this module was never
 * wired into, present or future — a message of the exact `HTTP 429/999 from
 * …` shape every fetch failure in this codebase throws. Anchored to the
 * START of the message on purpose: LlmPool.chat (autopilot/lib/llm.mjs)
 * aggregates every endpoint attempt into one `All inference attempts failed
 * for role "…":\n<name>: HTTP 429 from …` error when a role's endpoints all
 * fail, and an unanchored substring match would call a genuine total
 * inference outage a harmless job-board deferral the moment any ONE
 * attempted endpoint happened to 429 — masking the outage (no strike, no
 * skip, no backoff) instead of surfacing it. Every message this net is
 * actually meant to catch — this module's own RateLimitedError, and every
 * plain `HTTP ${status} from ${url}` a fetch path in this codebase throws —
 * already starts with exactly that text, so anchoring loses no coverage.
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isRateLimited(err) {
  return err?.code === 'RATE_LIMITED'
    || err?.status === 429
    || /^HTTP (429|999)\b/.test(String(err?.message || ''));
}

/**
 * Pacing-bucket rules, first match wins. A rule's `key` is what every fetch
 * matching `test` shares a bucket with; no match falls back to the lowercase
 * host (today's per-host behaviour, unchanged).
 *
 * `workday-shard`: Workday's public job-search API is served off a shared
 * `wdN` cluster (`https://<tenant>.wd1.myworkdayjobs.com/...`) that Workday
 * itself rate-limits by client IP across every tenant on it — see the module
 * header for the measured burst. `<tenant>` is exactly one label (every
 * tenant seen in that incident — wf, usbank, tencent, uslbm, topcon,
 * trimble, unum, stryker, stjude, maxar, r1rcm, rakuten, oclc — fits this
 * shape), so a two-label prefix (`a.b.wd1.myworkdayjobs.com`) deliberately
 * does not match and keeps its own hostname bucket rather than guessing.
 */
export const PACING_RULES = [
  {
    name: 'workday-shard',
    test: /^[\w-]+\.(wd[\w-]*)\.myworkdayjobs\.com$/i,
    key: (host, m) => `${m[1].toLowerCase()}.myworkdayjobs.com`,
  },
];

/**
 * Map a posting URL onto its pacing bucket key.
 *
 * A URL `new URL()` cannot parse gets the raw string as its own key rather
 * than throwing or sharing one bucket with every other unparseable URL
 * (which would serialise them against each other for no reason — the same
 * choice autopilot.mjs's original perHostFetchLimiter made).
 *
 * @param {string} url
 * @returns {string}
 */
export function pacingKeyFor(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return String(url);
  }
  const lower = host.toLowerCase();
  for (const rule of PACING_RULES) {
    const m = lower.match(rule.test);
    if (m) return rule.key(lower, m);
  }
  return lower;
}

/** Every bucket with no more specific policy: today's perHostFetchLimiter behaviour — 2 concurrent, no spacing. */
export const DEFAULT_POLICY = { limit: 2, minIntervalMs: 0, cooldownMs: 45_000 };

// A slower cadence and a longer cooldown than the default reflect a ceiling
// shared by every tenant on the shard, not one dialled host: the 2026-09-15
// incident measured 27 × HTTP 429 in four minutes from 13 tenants on wd1
// alone, each pacing itself independently at 2-concurrent and adding up to
// ~26-concurrent against Workday's own per-IP limit.
export const WORKDAY_POLICY = { limit: 2, minIntervalMs: 750, cooldownMs: 60_000 };

/**
 * Resolve the pacing policy for a bucket key (the output of `pacingKeyFor`,
 * or `keyFor` when a caller overrides it).
 *
 * @param {string} key
 * @returns {{limit: number, minIntervalMs: number, cooldownMs: number}}
 */
export function pacingPolicyFor(key) {
  if (typeof key === 'string' && key.toLowerCase().endsWith('.myworkdayjobs.com')) return WORKDAY_POLICY;
  return DEFAULT_POLICY;
}

/**
 * Build a per-key fetch pacer: `pace(url, fn)` runs `fn` no sooner than its
 * bucket's policy allows, and never more than `policy.limit` of that
 * bucket's `fn` calls run at once.
 *
 * Per-key in-memory state: `{ active, queue: [resolve], nextAt, coolUntil,
 * policy }`. `policy` is resolved once, at bucket creation, from `policyFor`.
 *
 * Concurrency (the slot) and pacing (nextAt/coolUntil) are orthogonal and
 * both apply per bucket:
 *
 *   1. SLOT — at most `policy.limit` callers run `fn` at once, queued FIFO
 *      beyond that. The slot is HANDED OVER to the next waiter in `finally`,
 *      never released and re-taken: a finisher that decrements and lets the
 *      woken waiter re-increment leaves a window in which a newly arriving
 *      call takes the free slot first, and the waiter then pushes the
 *      bucket one over the cap. (Inherited verbatim from
 *      autopilot.mjs's original perHostFetchLimiter.)
 *   2. PACING — holding the slot, wait until `max(nextAt, coolUntil)`
 *      before calling `fn`, then set `nextAt = now() + minIntervalMs`. The
 *      wait is a LOOP that re-reads `nextAt`/`coolUntil` after every sleep,
 *      not one wait-then-go: `coolUntil` is bucket-shared mutable state a
 *      concurrent caller can raise (never lower — see below) while this
 *      caller is asleep, most obviously right when a burst first turns into
 *      a 429 — a single wait computed BEFORE that update would walk this
 *      caller straight into the cooldown someone else just opened, defeating
 *      the whole point of a cluster-wide cooldown.
 *   3. On a RATE-LIMITED throw from `fn` (`isRateLimited(err)` true):
 *      `coolUntil` becomes `max(coolUntil, now() + (err.retryAfterMs ??
 *      policy.cooldownMs))` — MAX, never shortened, so one caller's
 *      Retry-After can never cut short a longer cooldown another caller in
 *      the same bucket already opened. `log?.('fetch_rate_limited', { key,
 *      host, status, retry_in_ms, attempt })` fires every time this
 *      happens, retried or not. While `attempt < maxRetries`, loop back and
 *      retry `fn` on the SAME slot once the (possibly just-raised) cooldown
 *      clears; otherwise rethrow the same error — a caller sees a
 *      RateLimitedError, never a generic one, so it can tell a deferral from
 *      a real failure.
 *   4. Any OTHER error from `fn` propagates untouched: no retry, no
 *      cooldown, no change to `nextAt`.
 *
 * `now`/`sleep` are injectable so tests can drive a virtual clock instead of
 * real timers; `log` is the ctx.logEvent seam (event name, payload object).
 *
 * @param {object} [opts]
 * @param {(url: string) => string} [opts.keyFor] - Maps a URL to its pacing bucket key.
 * @param {(key: string) => {limit: number, minIntervalMs: number, cooldownMs: number}} [opts.policyFor]
 * @param {() => number} [opts.now] - Current time, ms epoch.
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {((name: string, payload: object) => void)|null} [opts.log]
 * @param {number} [opts.maxRetries] - Retries inside the pacer before a RateLimitedError is rethrown.
 * @returns {(url: string, fn: () => Promise<any>) => Promise<any>}
 */
export function createFetchPacer({
  keyFor = pacingKeyFor,
  policyFor = pacingPolicyFor,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = null,
  maxRetries = 1,
} = {}) {
  const buckets = new Map(); // key -> { active, queue: [resolve], nextAt, coolUntil, policy }

  const bucketFor = (key) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { active: 0, queue: [], nextAt: 0, coolUntil: 0, policy: policyFor(key) };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  return async function pace(url, fn) {
    const key = keyFor(url);
    const bucket = bucketFor(key);
    let host = '';
    try { host = new URL(url).host; } catch { /* unparseable — host stays '' for the log line */ }

    // 1. Slot — see the WHY above: handed over, never released-and-retaken.
    if (bucket.active >= bucket.policy.limit) {
      await new Promise((resolve) => bucket.queue.push(resolve));
    } else {
      bucket.active++;
    }

    try {
      let attempt = 0;
      for (;;) {
        // 2. Pacing — re-checked in a loop; see the WHY above.
        for (;;) {
          const waitUntil = Math.max(bucket.nextAt, bucket.coolUntil);
          const waitMs = waitUntil - now();
          if (waitMs <= 0) break;
          await sleep(waitMs);
        }
        bucket.nextAt = now() + bucket.policy.minIntervalMs;
        try {
          return await fn();
        } catch (err) {
          if (!isRateLimited(err)) throw err; // 4. any other error — untouched, no retry
          // 3. Rate-limited — open (never shorten) the cluster-wide cooldown.
          const retryInMs = err.retryAfterMs ?? bucket.policy.cooldownMs;
          bucket.coolUntil = Math.max(bucket.coolUntil, now() + retryInMs);
          if (log) {
            log('fetch_rate_limited', {
              key,
              host: err.host || host,
              status: err.status ?? 429,
              retry_in_ms: retryInMs,
              attempt,
            });
          }
          if (attempt >= maxRetries) throw err;
          attempt++;
          // Loop back to the outer for(;;): wait out the (now current)
          // cooldown on this same slot, then retry fn().
        }
      }
    } finally {
      const next = bucket.queue.shift();
      if (next) next(); else bucket.active--;
    }
  };
}
