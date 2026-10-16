// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workable global job board — reads the public search API behind
// https://jobs.workable.com (the candidate-facing aggregator that lists every
// Workable customer who opted into it):
//
//   GET https://jobs.workable.com/api/v1/jobs
//       ?query=...&location=...&workplace=remote|hybrid|on_site
//       &day_range=N&limit=20&pageToken=...
//   → { title, totalSize, nextPageToken, jobs: [ { id, title, url, company:{title},
//       location:{city,subregion,countryName}, locations[], workplace, created,
//       updated, description, employmentType, department } ], autoAppliedFilters }
//
// Verified live 2026-10-15: no auth; `limit` above 20 answers 400 "Must be <=
// 20"; `day_range` is honoured (the older-looking `daysPosted` is silently
// ignored); the cursor is `nextPageToken`, an opaque string passed back as
// `pageToken`. robots.txt disallows `/search*` but not `/api/`.
//
// This is NOT providers/workable.mjs. That one reads ONE company's
// apply.workable.com account and auto-detects from a careers_url; this one is
// board-wide, so it is explicit-only (`provider: workable-global`) and needs a
// `searches:` matrix to be useful — the same shape as linkedin-guest. Job URLs
// here live on jobs.workable.com while workable.mjs emits apply.workable.com
// ones, so the two never collide on URL: cross-source dedup falls to the
// scanner's company+title pass.
//
// Pacing is mandatory, not a tuning knob. The rate limit is unknown (a dozen
// probe requests drew no 429), so every request after the first sleeps
// `gap_ms` (default 1000, floor 1000) via ctx.sleep. A 429 or 5xx is retried
// twice with the shared backoff, then propagates with `.status` so the portal-
// health bookkeeping sees it — never a silent empty result.
//
// Wire in via a `job_boards:` (or the discovery node's `boards:`) entry:
//   - { name: Workable jobs, provider: workable-global, day_range: 2,
//       searches: [ { query: "platform engineer", workplace: remote } ] }

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

const API_URL = 'https://jobs.workable.com/api/v1/jobs';
const TRUSTED_HOST = 'jobs.workable.com';

const MAX_LIMIT = 20; // the API's own ceiling
const DEFAULT_PAGES = 3;
const MAX_PAGES = 10;
const MAX_SEARCHES = 20;
const DEFAULT_DAY_RANGE = 2;
const MAX_DAY_RANGE = 30;
const MIN_GAP_MS = 1_000;
const WORKPLACES = new Set(['remote', 'hybrid', 'on_site']);
// Workable's own marker inside `locations[]` for a remote posting; not a place.
const LOCATION_MARKERS = new Set(['TELECOMMUTE']);

/** @param {string} url */
function assertWorkableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workable-global: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workable-global: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`workable-global: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} fallback */
function clampInt(v, lo, hi, fallback) {
  // Number(null) is 0, which would clamp a YAML `limit:` left blank up to the floor.
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
}

/**
 * Build one search request URL. Exported for unit tests.
 *
 * @param {{query?: string, keywords?: string, location?: string, workplace?: string, day_range?: number}} search
 * @param {{pageToken?: string, limit?: number, day_range?: number}} [opts] - Entry-level
 *   fallbacks (`day_range`, `limit`) and the cursor for pages after the first.
 * @returns {string}
 */
export function buildSearchUrl(search, opts = {}) {
  const url = new URL(API_URL);
  const query = String(search?.query ?? search?.keywords ?? '').trim();
  url.searchParams.set('query', query);
  const location = typeof search?.location === 'string' ? search.location.trim() : '';
  if (location) url.searchParams.set('location', location);
  const workplace = typeof search?.workplace === 'string' ? search.workplace.trim().toLowerCase() : '';
  if (WORKPLACES.has(workplace)) url.searchParams.set('workplace', workplace);
  const dayRange = clampInt(search?.day_range ?? opts.day_range, 1, MAX_DAY_RANGE, DEFAULT_DAY_RANGE);
  url.searchParams.set('day_range', String(dayRange));
  url.searchParams.set('limit', String(clampInt(opts.limit, 1, MAX_LIMIT, MAX_LIMIT)));
  if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken);
  return url.href;
}

/**
 * Normalize one job from the search response. Exported for unit tests.
 *
 *   - url:      `https://jobs.workable.com/view/<id>/<slug>` only (an off-host or
 *               non-https URL is untrusted and drops the item). Display and dedup
 *               key only; this provider never fetches it.
 *   - company:  `company.title`, falling back to the portal entry's name.
 *   - location: city, subregion, country as Workable renders them, plus
 *               "Remote" for a remote posting. The `TELECOMMUTE` marker is not a place.
 *   - postedAt: `created`, falling back to `updated` (ISO → epoch ms).
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number} | null}
 */
export function normalizeWorkableGlobalJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? decodeEntities(j.title).replace(/\s+/g, ' ').trim() : '';
  if (!title) return null;

  let url = '';
  try {
    const parsed = new URL(typeof j.url === 'string' ? j.url.trim() : '');
    if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST && !parsed.username && !parsed.password) {
      parsed.hash = '';
      url = parsed.href;
    }
  } catch {
    // malformed URL → dropped below
  }
  if (!url) return null;

  const company = typeof j.company?.title === 'string' && j.company.title.trim()
    ? decodeEntities(j.company.title).trim()
    : (fallbackCompany || 'Workable');

  const loc = j.location && typeof j.location === 'object' ? j.location : {};
  /** @type {string[]} */
  let parts = [loc.city, loc.subregion, loc.countryName]
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim());
  if (parts.length === 0 && Array.isArray(j.locations)) {
    parts = j.locations
      .filter((p) => typeof p === 'string' && p.trim() && !LOCATION_MARKERS.has(p.trim()))
      .map((p) => p.trim());
  }
  // The same place can appear as both city and subregion ("Dublin, Dublin").
  parts = parts.filter((p, i) => parts.indexOf(p) === i);
  if (j.workplace === 'remote') parts.push('Remote');

  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
  const job = { title, url, company, location: parts.join(', ') };
  const description = htmlToText(j.description);
  if (description) job.description = description;
  const stamp = Date.parse(typeof j.created === 'string' ? j.created : (typeof j.updated === 'string' ? j.updated : ''));
  if (Number.isFinite(stamp)) job.postedAt = stamp;
  return job;
}

/** @param {any} entry */
function resolveSearches(entry) {
  const raw = Array.isArray(entry.searches) ? entry.searches : [];
  const valid = raw
    .filter((s) => s && (typeof s.query === 'string' ? s.query.trim() : (typeof s.keywords === 'string' && s.keywords.trim())))
    .slice(0, MAX_SEARCHES);
  if (raw.length > MAX_SEARCHES) {
    console.error(`⚠️  workable-global: ${entry.name} configured ${raw.length} searches, keeping the first ${MAX_SEARCHES}`);
  }
  return valid;
}

/** @type {Provider} */
export default {
  id: 'workable-global',

  // Explicit-only: board-wide, and useless without a `searches:` list, so there
  // is no careers_url to auto-detect from. Auto-claiming jobs.workable.com URLs
  // would also hijack nothing useful: those are postings, not boards.
  detect(entry) {
    return entry?.provider === 'workable-global' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    const searches = resolveSearches(entry);
    if (searches.length === 0) {
      throw new Error(`workable-global: ${entry.name} has no usable "searches" entries (each needs a non-empty "query")`);
    }

    const configuredPages = entry.max_pages ?? entry.pages;
    let pages = clampInt(configuredPages, 1, MAX_PAGES, DEFAULT_PAGES);
    if (Number.isInteger(ctx.maxPages) && /** @type {number} */ (ctx.maxPages) > 0) pages = Math.min(pages, /** @type {number} */ (ctx.maxPages));
    const gapMs = Math.max(MIN_GAP_MS, Number.isFinite(entry.gap_ms) ? Number(entry.gap_ms) : MIN_GAP_MS);
    const defaults = { day_range: entry.day_range, limit: entry.limit };

    const seenIds = new Set();
    const jobs = [];
    let requestCount = 0;

    for (const search of searches) {
      let pageToken = '';
      for (let page = 0; page < pages; page++) {
        if (requestCount > 0) await sleep(gapMs, ctx);
        requestCount++;

        const url = assertWorkableUrl(buildSearchUrl(search, { ...defaults, pageToken }));
        // redirect:'error' + assertWorkableUrl keep every request pinned to
        // jobs.workable.com (a redirect would otherwise be followed anywhere).
        const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' }, { retries: 2 });
        if (!json || typeof json !== 'object' || !Array.isArray(/** @type {any} */ (json).jobs)) {
          throw new Error(`workable-global: unexpected API response — expected { jobs: [...] }, got keys: [${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}]`);
        }
        const body = /** @type {any} */ (json);

        for (const raw of body.jobs) {
          const id = typeof raw?.id === 'string' ? raw.id : '';
          if (id) {
            if (seenIds.has(id)) continue; // the same posting can match several searches
            seenIds.add(id);
          }
          const job = normalizeWorkableGlobalJob(raw, entry.name);
          if (job) jobs.push(job);
        }

        // No cursor, or a page with nothing on it: this search is exhausted.
        pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
        if (!pageToken || body.jobs.length === 0) break;
      }
    }
    return jobs;
  },
};
