// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn guest-search provider — reads LinkedIn's public, no-login
// "jobs-guest" search endpoint (the same server-rendered fragment LinkedIn's
// own search-results page fetches for an unauthenticated visitor):
//
//   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//       ?keywords=...&location=...&f_TPR=r604800&f_WT=2&start=0
//
// No login, no cookies, no session — every request is independent. This is
// explicit-only (like jobicy/weworkremotely): it never auto-detects a
// portals.yml entry from a careers_url, only from `provider: linkedin-guest`,
// because the endpoint is board-wide and needs a `searches:` list to be
// useful at all.
//
// Pacing is mandatory, not a tuning knob: LinkedIn rate-limits (and can
// outright block) a guest client that requests faster than a human paging
// through search results would. Every request after the first sleeps
// `gap_ms` (default 12000, floor 5000) jittered up to +50%, via ctx.sleep
// when the caller supplies one (tests use this to run instantly with no wall
// clock wait — see _http.mjs's sleep()). A 429/999 (LinkedIn's own
// "you've been throttled" status) is never caught here: it propagates as the
// ctx error carrying `.status`, exactly like every other provider's non-2xx,
// so scan.mjs's portal-health bookkeeping and backoff see it and this board
// gets throttled down like any other misbehaving source — never a silent
// empty result.
//
// Paging: `start` advances by however many cards the PREVIOUS request
// actually returned, never an assumed page size — measured live 2026-09-17
// (keywords=platform engineer, location=Denver, Colorado, United States,
// f_TPR=r604800), LinkedIn's guest endpoint answers 10 cards per request at
// every offset tried (0, 10, 20, 25, 50): a sliding window over one ordered
// result list. Requesting start=0,25,50... on the old assumption of 25/page
// skipped results 10-24 outright and silently dropped 60% of the first 35
// results of every configured search. A page returning fewer cards than the
// one before it (or zero) ends that search's pagination — the next request
// would come back empty and cost a paced sleep for nothing.
//
// See docs/SUPPORTED_JOB_BOARDS.md's ToS note: this reads a public endpoint
// at personal-scale volume, but LinkedIn's Terms of Service still govern use
// — review them before enabling this board.

import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const TRUSTED_HOST = 'www.linkedin.com';

// Each page is one paced request — nothing here assumes how many cards it
// returns (see the header comment). At the currently-measured 10 cards per
// request, DEFAULT_PAGES pulls ~30 results per search; a 20-search matrix at
// 3 pages/search is 60 requests ≈ 12-18 min at the default 12s jittered gap.
const DEFAULT_PAGES = 3;
const MAX_PAGES = 10;
const MAX_SEARCHES = 20;

const DEFAULT_GAP_MS = 12_000;
const MIN_GAP_MS = 5_000;
// Up to +50% jitter on top of the gap, so concurrent/scheduled runs across a
// fleet don't all knock on LinkedIn's door in lockstep.
const JITTER_FACTOR = 0.5;

const POSTED_WITHIN_TO_TPR = {
  '24h': 'r86400',
  week: 'r604800',
  month: 'r2592000',
};

/** @param {string} url */
function assertLinkedInUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`linkedin-guest: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`linkedin-guest: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`linkedin-guest: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Resolve a `posted_within` value (search-level, falling back to the entry's
 * own default, falling back to 'week') to the `f_TPR` query value. An
 * unrecognized string (typo, future LinkedIn option) falls back to 'week'
 * rather than sending a param LinkedIn will ignore anyway — the search still
 * runs, just without the freshness narrowing.
 * @param {string|undefined} searchValue
 * @param {string|undefined} entryDefault
 */
function resolvePostedWithinTPR(searchValue, entryDefault) {
  const chosen = POSTED_WITHIN_TO_TPR[searchValue] ? searchValue : (POSTED_WITHIN_TO_TPR[entryDefault] ? entryDefault : 'week');
  return POSTED_WITHIN_TO_TPR[chosen];
}

/**
 * Build one guest-search request URL. Exported for unit tests.
 *
 * @param {{keywords: string, location?: string, remote?: boolean, posted_within?: string}} search
 * @param {number} start - Offset into the result list, in results (not
 *   pages): 0 for the first page, then however many cards the previous page
 *   actually returned. Whatever LinkedIn's page size is today, the caller
 *   never assumes it here — see the file header.
 * @param {{posted_within?: string}} [defaults] - Entry-level fallbacks (currently just posted_within).
 * @returns {string}
 */
export function buildSearchUrl(search, start, defaults = {}) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('keywords', String(search?.keywords ?? '').trim());
  const location = typeof search?.location === 'string' ? search.location.trim() : '';
  if (location) url.searchParams.set('location', location);
  url.searchParams.set('f_TPR', resolvePostedWithinTPR(search?.posted_within, defaults?.posted_within));
  if (search?.remote === true) url.searchParams.set('f_WT', '2');
  url.searchParams.set('start', String(Math.max(0, Number(start) || 0)));
  return url.href;
}

/**
 * Extract one card's inner text for a given class-name fragment, unwrapping
 * the innermost tag's text content and decoding entities. `tagRe` matches the
 * OPENING tag only (LinkedIn's own markup is not self-closing here), so this
 * captures everything up to the next closing tag of the same kind — good
 * enough for the flat, single-level markup these fields render as.
 * @param {string} block
 * @param {RegExp} re - Must have exactly one capture group for the inner text.
 */
function extractField(block, re) {
  const m = block.match(re);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse LinkedIn's guest-search HTML fragment into normalized cards.
 * Exported for unit tests (fixture: tests/fixtures/linkedin-guest-search.html).
 *
 * Each posting renders as a block carrying
 * `data-entity-urn="urn:li:jobPosting:{id}"` somewhere in its opening tag;
 * blocks are segmented by that marker, so a card LinkedIn renders with no
 * `data-entity-urn` at all (an ad slot, a "promoted" placeholder) is never
 * picked up in the first place — nothing to explicitly skip.
 *
 * @param {string} html
 * @returns {Array<{id: string, title: string, company: string, location: string, postedAt?: number}>}
 */
export function parseGuestSearchHtml(html) {
  if (typeof html !== 'string' || !html) return [];

  const MARKER_RE = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  /** @type {Array<{id: string, start: number}>} */
  const markers = [];
  let m;
  while ((m = MARKER_RE.exec(html)) !== null) {
    markers.push({ id: m[1], start: m.index });
  }
  if (markers.length === 0) return [];

  const cards = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].start;
    const end = i + 1 < markers.length ? markers[i + 1].start : html.length;
    const block = html.slice(start, end);

    const title = extractField(block, /base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    if (!title) continue; // spec: skip cards without an id or title — id is guaranteed by the marker match above

    // Company sits inside the subtitle's own <a> — falling back to the whole
    // subtitle keeps a company name on the rare card that renders it as bare
    // text instead of a link, rather than dropping the field to ''.
    const subtitleBlock = block.match(/base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
    const company = subtitleBlock
      ? extractField(subtitleBlock[1], /<a\b[^>]*>([\s\S]*?)<\/a>/i) || decodeEntities(subtitleBlock[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
      : '';

    const location = extractField(block, /job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

    const dateM = block.match(/<time\b[^>]*\bdatetime="(\d{4}-\d{2}-\d{2})"/i);
    const postedAt = dateM ? Date.parse(`${dateM[1]}T00:00:00Z`) : undefined;

    cards.push({
      id: markers[i].id,
      title,
      company,
      location,
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
    });
  }
  return cards;
}

/** @param {import('./_types.js').PortalEntry & {searches?: any[], pages?: number, posted_within?: string, gap_ms?: number}} entry */
function resolveSearches(entry) {
  const raw = Array.isArray(entry.searches) ? entry.searches : [];
  const valid = raw
    .filter((s) => s && typeof s.keywords === 'string' && s.keywords.trim())
    .slice(0, MAX_SEARCHES);
  if (raw.length > MAX_SEARCHES) {
    console.error(`⚠️  linkedin-guest: ${entry.name} configured ${raw.length} searches, keeping the first ${MAX_SEARCHES}`);
  }
  return valid;
}

/** @type {Provider} */
export default {
  id: 'linkedin-guest',

  // Explicit-only: the endpoint is board-wide (not tied to any careers_url),
  // and useless without a `searches:` list, so there is nothing to
  // auto-detect from a portals.yml entry's URL — same style as jobicy.mjs /
  // weworkremotely.mjs.
  detect(entry) {
    return entry?.provider === 'linkedin-guest' ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const searches = resolveSearches(entry);
    if (searches.length === 0) {
      throw new Error(`linkedin-guest: ${entry.name} has no usable "searches" entries (each needs a non-empty "keywords")`);
    }

    const pages = Math.min(MAX_PAGES, Math.max(1, Number.isFinite(entry.pages) ? Number(entry.pages) : DEFAULT_PAGES));
    const baseGapMs = Math.max(MIN_GAP_MS, Number.isFinite(entry.gap_ms) ? Number(entry.gap_ms) : DEFAULT_GAP_MS);
    const defaults = { posted_within: entry.posted_within };

    const headers = {
      'user-agent': BROWSER_LIKE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
    };

    const seenIds = new Set();
    const jobs = [];
    let requestCount = 0;

    for (const search of searches) {
      let start = 0;
      let previousCount = null; // null until the first page has an answer to compare against
      for (let page = 0; page < pages; page++) {
        // Every request but the very first is paced — jittered so a fleet of
        // scheduled runs (or several searches back-to-back) never lands in
        // lockstep on LinkedIn's rate limiter.
        if (requestCount > 0) {
          const jittered = baseGapMs * (1 + Math.random() * JITTER_FACTOR);
          await sleep(jittered, ctx);
        }
        requestCount++;

        const url = assertLinkedInUrl(buildSearchUrl(search, start, defaults));
        // redirect:'error' prevents SSRF via server-side redirects, same as
        // every other provider's mandatory guard; combined with
        // assertLinkedInUrl above it keeps every request pinned to
        // www.linkedin.com. A non-2xx (429 throttled, 999 LinkedIn's own bot
        // block) is intentionally left to propagate — see the file header.
        const html = await ctx.fetchText(url, { headers, redirect: 'error' });

        const cards = parseGuestSearchHtml(html);
        if (cards.length === 0) break; // end of this search's results — stop paging it

        for (const card of cards) {
          if (seenIds.has(card.id)) continue; // dedup by id across searches/pages
          seenIds.add(card.id);
          jobs.push({
            title: card.title,
            // Canonical LinkedIn posting URL — matches canonicalUrlForRef() in
            // autopilot/lib/leads.mjs so this provider's finds dedup against
            // every other LinkedIn lead the pipeline already knows about
            // (tracker rows, email leads, aggregator hits) instead of
            // re-queuing the same posting under a tracking-param variant.
            url: `https://www.linkedin.com/jobs/view/${card.id}/`,
            company: card.company,
            location: card.location,
            ...(card.postedAt !== undefined ? { postedAt: card.postedAt } : {}),
          });
        }

        // Advance by what this page actually returned (see the header
        // comment) and stop once a page comes back smaller than the one
        // before it — that's the end of this search's result list, and the
        // next request would just be an empty page paid for at full pacing
        // cost.
        const shrank = previousCount !== null && cards.length < previousCount;
        start += cards.length;
        previousCount = cards.length;
        if (shrank) break;
      }
    }

    return jobs;
  },
};
