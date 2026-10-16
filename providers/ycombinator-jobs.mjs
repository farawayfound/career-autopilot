// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Y Combinator jobs provider — the "Work at a Startup" listings YC publishes on
// its own site, one page per role (and optionally per location):
//
//   GET https://www.ycombinator.com/jobs/role/<role>[/<location>]
//     e.g. /jobs/role/software-engineer, /jobs/role/software-engineer/remote
//
// The page is server-rendered with an Inertia payload in one attribute,
// `data-page="{&quot;component&quot;:&quot;WaasJobListingsPage&quot;,
// &quot;props&quot;:{&quot;jobPostings&quot;:[ ... ]}}"` (HTML-escaped JSON).
// Each posting: { id, title, url (relative /companies/<co>/jobs/<id>-<slug>),
// location, type, role, salaryRange, minExperience, visa, companyName,
// companyBatchName, createdAt ("15 days"), lastActive }.
//
// Verified live 2026-10-15: no auth; 37-50 postings per page; the pages do NOT
// paginate (`?page=2` and `?page=3` returned the same set), so coverage comes
// from the role x location combinations, not from paging. robots.txt only
// disallows /companies?* and /verify/*. The payload shape is an Inertia
// implementation detail and can change without notice — a page with no
// `jobPostings` array throws instead of returning an empty list.
//
// `createdAt` is a relative phrase ("15 days", "about 5 hours"), so `postedAt`
// is that age subtracted from now: day-resolution at best, which is right for
// a freshness filter and wrong for anything finer.
//
// Explicit-only; the same posting also reaches the pipeline as a Hacker News
// "Is Hiring" job story (providers/hn-jobs.mjs), under the same canonical
// ycombinator.com URL, so the two dedup against each other.
//
// Wire in via a `job_boards:` (or the discovery node's `boards:`) entry:
//   - { name: YC jobs, provider: ycombinator-jobs,
//       roles: [software-engineer], locations: [remote, new-york] }

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.ycombinator.com';
const TRUSTED_HOST = 'www.ycombinator.com';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const DEFAULT_ROLES = ['software-engineer'];
// Each page is ~270 KB; this bounds a run to a few MB and a minute or two of
// pacing however long the configured lists are.
const MAX_PAGES_TOTAL = 24;
const MIN_GAP_MS = 2_000;
// The page itself is ~270 KB; this only stops a runaway response.
const MAX_HTML_CHARS = 3_000_000;

const UNIT_MS = /** @type {Record<string, number>} */ ({
  second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000,
  week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
});

/**
 * Milliseconds in a Rails `distance_of_time_in_words` phrase ("15 days",
 * "about 5 hours", "less than a minute", "over 1 year"). Null when it is not one.
 * Exported for unit tests.
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseRelativeAge(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().toLowerCase().match(/(?:^|\s)(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\b/);
  if (!m) return null;
  const n = m[1] === 'a' || m[1] === 'an' ? 1 : Number(m[1]);
  return Number.isFinite(n) ? n * UNIT_MS[m[2]] : null;
}

/** @param {string} url */
function assertYcUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ycombinator-jobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ycombinator-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`ycombinator-jobs: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * The listing pages to read: each role's own page, plus the role narrowed to
 * each configured location. A slug outside [a-z0-9-] is dropped (it is
 * interpolated into a path). Exported for unit tests.
 * @param {{roles?: unknown, locations?: unknown}} entry
 * @returns {string[]}
 */
export function buildPageUrls(entry) {
  const slugs = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : [])
    .filter((s) => typeof s === 'string' && SLUG_RE.test(s.trim().toLowerCase()))
    .map((s) => /** @type {string} */ (s).trim().toLowerCase())
    .filter((s, i, all) => all.indexOf(s) === i);
  const roles = slugs(entry?.roles);
  const locations = slugs(entry?.locations);
  const urls = [];
  for (const role of roles.length ? roles : DEFAULT_ROLES) {
    urls.push(`${ORIGIN}/jobs/role/${role}`);
    for (const loc of locations) urls.push(`${ORIGIN}/jobs/role/${role}/${loc}`);
  }
  return urls.slice(0, MAX_PAGES_TOTAL);
}

/**
 * Pull the job postings out of one listing page. Exported for unit tests.
 *
 * The attribute value is HTML-escaped JSON, so it goes through the shared
 * entity decoder before JSON.parse. Throws when the page is not the listing
 * shape (a Cloudflare interstitial, or the Inertia payload moved).
 *
 * @param {string} html
 * @param {number} [now] - Epoch ms the relative `createdAt` is measured back from.
 * @returns {Array<{id: string, title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseYcJobsPage(html, now = Date.now()) {
  if (typeof html !== 'string' || !html) throw new Error('ycombinator-jobs: empty page');
  const attr = html.slice(0, MAX_HTML_CHARS).match(/\bdata-page="([^"]*)"/);
  if (!attr) throw new Error('ycombinator-jobs: no data-page payload on the page (blocked, or the page layout changed)');
  let page;
  try {
    page = JSON.parse(decodeEntities(attr[1]));
  } catch (err) {
    throw new Error(`ycombinator-jobs: the data-page payload is not valid JSON (${/** @type {Error} */ (err).message})`);
  }
  const postings = page?.props?.jobPostings;
  if (!Array.isArray(postings)) {
    throw new Error('ycombinator-jobs: the data-page payload has no props.jobPostings array (the page layout changed)');
  }

  const out = [];
  for (const p of postings) {
    if (!p || typeof p !== 'object') continue;
    const title = typeof p.title === 'string' ? decodeEntities(p.title).replace(/\s+/g, ' ').trim() : '';
    if (!title) continue;

    // The posting URL is relative; resolve it against the site and keep it only
    // if it is still a /companies/<co>/jobs/... page on ycombinator.com (the
    // `applyUrl` points at a login wall and is never used).
    let url = '';
    try {
      const parsed = new URL(typeof p.url === 'string' ? p.url : '', ORIGIN);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST && /^\/companies\/[^/]+\/jobs\/[^/]+$/.test(parsed.pathname)) {
        url = `${ORIGIN}${parsed.pathname}`;
      }
    } catch {
      // malformed → dropped below
    }
    if (!url) continue;

    const company = typeof p.companyName === 'string' ? decodeEntities(p.companyName).replace(/\s+/g, ' ').trim() : '';
    const location = typeof p.location === 'string' ? decodeEntities(p.location).replace(/\s+/g, ' ').trim() : '';
    /** @type {{id: string, title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { id: String(p.id ?? url), title, url, company, location };
    const age = parseRelativeAge(p.createdAt);
    if (age !== null) job.postedAt = now - age;
    out.push(job);
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'ycombinator-jobs',

  // Explicit-only: board-wide, and which role/location pages to read is a
  // choice the entry has to make.
  detect(entry) {
    return entry?.provider === 'ycombinator-jobs' ? { url: `${ORIGIN}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    let urls = buildPageUrls(entry);
    if (Number.isInteger(ctx.maxPages) && /** @type {number} */ (ctx.maxPages) > 0) urls = urls.slice(0, /** @type {number} */ (ctx.maxPages));
    const gapMs = Math.max(MIN_GAP_MS, Number.isFinite(entry.gap_ms) ? Number(entry.gap_ms) : MIN_GAP_MS);
    const now = Date.now();

    const seen = new Set();
    const jobs = [];
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) await sleep(gapMs, ctx);
      // redirect:'error' + assertYcUrl pin every request to www.ycombinator.com.
      const html = await fetchTextWithRetry(ctx, assertYcUrl(urls[i]), { redirect: 'error', headers: { accept: 'text/html' } }, { retries: 2 });
      for (const { id, ...job } of parseYcJobsPage(html, now)) {
        // The same posting shows up on the role page and on each location page.
        if (seen.has(id)) continue;
        seen.add(id);
        jobs.push(job);
      }
    }
    return jobs;
  },
};
