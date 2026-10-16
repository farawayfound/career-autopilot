// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Hacker News job stories — the YC-company hiring posts that appear on
// news.ycombinator.com/jobs ("PostEra (YC W20) Is Hiring AI Researchers for Drug
// Discovery"). These are a different thing from the monthly "Ask HN: Who is
// hiring?" thread that providers/hackernews.mjs and aggregators.mjs's fromHn
// read: each is a story of type `job` posted by the company, linking straight
// to a posting (often a Lever / Ashby / YC page, otherwise the company's own
// careers page).
//
//   GET https://hn.algolia.com/api/v1/search_by_date?tags=job&hitsPerPage=50&page=0
//   → { hits: [ { objectID, title, url, created_at_i, author } ], nbPages, page }
//
// Algolia rather than Firebase's /v0/jobstories.json: that endpoint returns bare
// ids, so a run costs one request per story, where this returns title, url and
// time for 50 stories in one. Verified live 2026-10-15: no auth; hn.algolia.com
// serves no robots.txt (404), news.ycombinator.com's own robots is not involved;
// ~13 stories a month, so the single default page spans a couple of months.
//
// The company is parsed from the title ("<Company> (YC <batch>) Is Hiring
// <role>"), and the role becomes the job title so the scanner's title_filter
// judges the role and not the boilerplate. A title with no role after "Is Hiring"
// takes it from a ycombinator.com posting URL's slug when there is one, and
// otherwise stays as written (nothing to match, which is the honest outcome).
//
// The `url` is whatever the poster linked, so it is untrusted data: only a
// public https DNS-name URL (no userinfo, port, IP literal or internal-looking
// name) survives, and anything else falls back to the story's own HN page, which
// is always on news.ycombinator.com. This provider never fetches it.
//
// Explicit-only (board-wide). Wire in via a `job_boards:` (or the discovery
// node's `boards:`) entry:
//   - { name: HN job stories, provider: hn-jobs }

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date';
const TRUSTED_HOST = 'hn.algolia.com';
const ITEM_BASE = 'https://news.ycombinator.com/item?id=';
const YC_HOST = 'www.ycombinator.com';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;
const DEFAULT_PAGES = 1;
const MAX_PAGES = 5;
const MIN_GAP_MS = 1_000;
const MAX_URL_CHARS = 2048;
const ID_RE = /^\d{1,12}$/;

// "<Company> [(YC W20)] Is Hiring [<role>]": the lazy company group grows until
// the rest reads as an optional YC batch followed by "is/are hiring". The
// separator class takes the colon, hyphen, en dash and em dash the posts use.
const HIRING_RE = /^(.*?)\s*(?:\(\s*YC\s*[A-Za-z]?\d{2,4}\s*\)\s*)?\b(?:is|are)\s+hiring\b[\s:\-\u2013\u2014]*(.*)$/i;
const LEADING_FILLER_RE = /^(?:(?:a|an|the|our|for)\s+)+/i;
// "Is Hiring in Austin, TX" names a place, not a role.
const LOCATION_ONLY_RE = /^(?:in|at|from|across)\s+\S+(?:\s+\S+){0,3}$/i;
const YC_JOB_PATH_RE = /^\/companies\/[^/]+\/jobs\/([A-Za-z0-9]+)-([^/]+)$/;
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/** @param {string} url */
function assertAlgoliaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hn-jobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`hn-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`hn-jobs: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} fallback */
function clampInt(v, lo, hi, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
}

/**
 * The poster's link, if it is safe to carry into the pipeline; else ''.
 * Exported for unit tests.
 * @param {unknown} raw
 * @returns {string}
 */
export function safePostingUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL_CHARS) return '';
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
  // A public DNS name: dotted, not an IP literal ([::1] / 1.2.3.4 / 0x7f.1), not internal-looking.
  if (!host.includes('.') || host.includes(':') || host.startsWith('[') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return '';
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return '';
  u.hash = '';
  return u.href;
}

/**
 * Company and role out of a job story's title. Exported for unit tests.
 * @param {string} title - Already entity-decoded.
 * @returns {{company: string, role: string}} Either may be ''.
 */
export function parseHiringTitle(title) {
  const m = title.match(HIRING_RE);
  if (!m) return { company: '', role: '' };
  const company = m[1].replace(/\s+/g, ' ').trim();
  let role = m[2].replace(/\s+/g, ' ').trim();
  role = role.replace(LEADING_FILLER_RE, '').trim();
  if (!role || LOCATION_ONLY_RE.test(role)) role = '';
  return { company, role };
}

/** A ycombinator.com job URL's slug as words ("…/jobs/bFcgIe4-implementations" → "implementations"). */
function roleFromYcUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== YC_HOST) return '';
    const m = u.pathname.match(YC_JOB_PATH_RE);
    if (!m) return '';
    let slug = m[2];
    try { slug = decodeURIComponent(slug); } catch { /* keep literal */ }
    return slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Normalize one Algolia hit. Exported for unit tests.
 * @param {any} hit
 * @returns {{title: string, url: string, company: string, location: string, postedAt?: number} | null}
 */
export function normalizeHnJob(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const id = String(hit.objectID ?? '');
  if (!ID_RE.test(id)) return null;
  const rawTitle = typeof hit.title === 'string' ? decodeEntities(hit.title).replace(/\s+/g, ' ').trim() : '';
  if (!rawTitle) return null;

  const url = safePostingUrl(hit.url) || `${ITEM_BASE}${id}`;
  const { company, role } = parseHiringTitle(rawTitle);
  const title = role || roleFromYcUrl(url) || rawTitle;

  /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
  const job = { title, url, company, location: '' };
  if (Number.isFinite(hit.created_at_i) && hit.created_at_i > 0) job.postedAt = hit.created_at_i * 1000;
  return job;
}

/** @type {Provider} */
export default {
  id: 'hn-jobs',

  // Explicit-only: board-wide. (providers/hackernews.mjs is the monthly
  // "Who is hiring" thread and has no detect() either.)
  detect(entry) {
    return entry?.provider === 'hn-jobs' ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const perPage = clampInt(entry.hits_per_page, 1, MAX_PER_PAGE, DEFAULT_PER_PAGE);
    let pages = clampInt(entry.max_pages ?? entry.pages, 1, MAX_PAGES, DEFAULT_PAGES);
    if (Number.isInteger(ctx.maxPages) && /** @type {number} */ (ctx.maxPages) > 0) pages = Math.min(pages, /** @type {number} */ (ctx.maxPages));
    const gapMs = Math.max(MIN_GAP_MS, Number.isFinite(entry.gap_ms) ? Number(entry.gap_ms) : MIN_GAP_MS);

    const seen = new Set();
    const jobs = [];
    for (let page = 0; page < pages; page++) {
      if (page > 0) await sleep(gapMs, ctx);
      const url = new URL(SEARCH_URL);
      url.searchParams.set('tags', 'job');
      url.searchParams.set('hitsPerPage', String(perPage));
      url.searchParams.set('page', String(page));
      // redirect:'error' + assertAlgoliaUrl pin every request to hn.algolia.com.
      const json = await fetchJsonWithRetry(ctx, assertAlgoliaUrl(url.href), { redirect: 'error' }, { retries: 2 });
      if (!json || typeof json !== 'object' || !Array.isArray(/** @type {any} */ (json).hits)) {
        throw new Error(`hn-jobs: unexpected API response — expected { hits: [...] }, got keys: [${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}]`);
      }
      const body = /** @type {any} */ (json);
      for (const hit of body.hits) {
        const id = String(hit?.objectID ?? '');
        if (seen.has(id)) continue; // a page can shift under us between requests
        seen.add(id);
        const job = normalizeHnJob(hit);
        if (job) jobs.push(job);
      }
      // A short page, or the last page the index reports, ends the walk.
      if (body.hits.length < perPage || (Number.isFinite(body.nbPages) && page + 1 >= body.nbPages)) break;
    }
    return jobs;
  },
};
