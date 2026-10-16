// @ts-check
/**
 * providers/generic-careers.mjs — reads a company's own bespoke careers page
 * when no ATS sits behind it, so scan.mjs can pick up postings from sources
 * the other 85 providers have no way to recognize.
 *
 * Every other provider here maps one KNOWN job source — a named ATS's API, a
 * named board's feed — onto the scanner's normalized Job shape. That list is
 * necessarily finite: a company running its own hand-built careers page (no
 * Greenhouse, no Lever, nothing an existing detect() claims) is invisible to
 * every one of them, no matter how well the scanner otherwise covers the ATS
 * landscape. This provider is the deliberate exception — explicit-only
 * (never auto-detected; see detect() below), reading whatever a bespoke page
 * happens to expose, in three strategies of descending confidence:
 *
 *   1. schema.org JobPosting JSON-LD — the same structured data Google for
 *      Jobs requires IN STATIC HTML, so a large share of bespoke career pages
 *      carry title/location/datePosted/description for free.
 *   2. An autodiscovered or conventional RSS/Atom feed.
 *   3. A heuristic scrape of anchors that look like postings — last resort,
 *      and deliberately conservative: see scrapeJobAnchors() below for why.
 *
 * Because this is a Provider like any other, everything downstream (title/
 * location filters, dedup, pipeline rows, liveness, scoring, shipping) works
 * unchanged; the only new code here is turning one bespoke page into Job[].
 *
 * The anchor scrape is the strategy worth being afraid of: a loose scrape
 * turns a nav menu into fifty fake postings. Every rule it applies is written
 * down at its own definitions below rather than left implicit, because a
 * "tidier" relaxation of any one of them is exactly how that happens.
 *
 * Every byte parsed here came out of a fetched third-party page — DATA, never
 * instructions (AGENTS.md, "Untrusted External Content").
 */

/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { collectJobPostings, jobFromJsonLd } from './_jsonld.mjs';

// ── Strategy 2: feed discovery/parsing ──────────────────────────────────────

// Autodiscovery is capped at 3 URLs, and the async fetch() below never spends
// more than 3 extra requests TOTAL on strategy 2 (discovered links plus
// conventional-path probes combined) — a bespoke careers page is read once,
// not crawled.
const MAX_FEED_URLS = 3;

// Root-relative siblings of the careers URL worth a blind probe when the page
// declares no <link rel="alternate"> of its own. Order is the order probed.
const CONVENTIONAL_FEED_PATHS = ['feed', 'rss', 'jobs.rss', 'careers/feed'];

const FEED_LINK_TAG_RE = /<link\b([^>]*)\/?>/gi;
const FEED_TYPE_ATTR_RE = /\btype=["'](application\/rss\+xml|application\/atom\+xml)["']/i;

/**
 * Same-origin `<link rel="alternate" type="application/rss+xml|atom+xml">`
 * feed URLs declared in a careers page's own `<head>`, absolute, deduped, and
 * capped at MAX_FEED_URLS.
 *
 * Scoped to `<head>…</head>` when present — feed autodiscovery `<link>` tags
 * are only ever valid there, and scoping avoids a stray `<link>` elsewhere in
 * the body being mistaken for one. A page with no `<head>` tag at all (some
 * bespoke templates are sloppy) falls back to scanning the whole document
 * rather than finding nothing.
 *
 * Off-origin candidates are dropped, never counted toward the cap — a feed
 * this provider does not control fetching is not something to probe.
 *
 * @param {string} html - Careers page HTML.
 * @param {string} baseUrl - The careers page's own URL (for origin + relative resolution).
 * @returns {string[]} Absolute, same-origin, http(s) feed URLs, in document order.
 */
export function discoverFeedUrls(html, baseUrl) {
  if (typeof html !== 'string' || !html.trim()) return [];
  let origin;
  try {
    origin = new URL(String(baseUrl)).origin;
  } catch {
    return [];
  }

  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const scope = headMatch ? headMatch[1] : html;

  const found = [];
  const seen = new Set();
  for (const m of scope.matchAll(FEED_LINK_TAG_RE)) {
    if (found.length >= MAX_FEED_URLS) break;
    const attrs = m[1] || '';
    if (!/\brel=["']alternate["']/i.test(attrs)) continue;
    if (!FEED_TYPE_ATTR_RE.test(attrs)) continue;
    const hrefM = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefM) continue;

    let url;
    try {
      url = new URL(decodeEntities(hrefM[1]).trim(), baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.origin !== origin) continue; // off-origin feeds are never probed
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push(href);
  }
  return found;
}

/** CDATA-unwrapped raw inner text of the first `<tag>` in `block` matching one of `tags`, or ''. */
function firstTagRaw(block, tags) {
  for (const tag of tags) {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!m) continue;
    const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    return cdata ? cdata[1] : m[1];
  }
  return '';
}

/** Entity-decoded, trimmed text of the first `<tag>` in `block` matching one of `tags`, or ''. */
function firstTagText(block, tags) {
  const raw = firstTagRaw(block, tags);
  return raw ? decodeEntities(raw).trim() : '';
}

/**
 * An item/entry's posting link.
 *
 * RSS writes it as plain text (`<link>URL</link>`); Atom writes it as a `href`
 * attribute on a self-closing `<link/>`, and an entry may carry several `<link>`
 * tags (alternate, self, …) — `rel="alternate"` wins when present, otherwise
 * the first href found. The RSS shape has no attributes to match, so it is
 * tried only after the attribute-based Atom shape comes back empty.
 */
function extractItemLink(block) {
  let altHref = '';
  let firstHref = '';
  for (const m of block.matchAll(FEED_LINK_TAG_RE)) {
    const attrs = m[1] || '';
    const hrefM = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]).trim();
    if (!href) continue;
    if (!firstHref) firstHref = href;
    const relM = attrs.match(/\brel=["']([^"']+)["']/i);
    const rel = relM ? relM[1].toLowerCase() : 'alternate';
    if (rel === 'alternate' && !altHref) altHref = href;
  }
  if (altHref) return altHref;
  if (firstHref) return firstHref;

  const rss = block.match(/<link\b[^>]*>([^<]*)<\/link>/i);
  return rss && rss[1].trim() ? decodeEntities(rss[1]).trim() : '';
}

/** Epoch ms from the first present of pubDate/published/updated/dc:date, or undefined. */
function extractPostedAt(block) {
  const raw = firstTagText(block, ['pubDate', 'published', 'updated', 'dc:date']);
  if (!raw) return undefined;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? undefined : ts;
}

/**
 * RSS `<item>` / Atom `<entry>` elements → the scanner's normalized Job shape.
 *
 * No XML dependency — the same tiny tag-extraction approach as
 * providers/weworkremotely.mjs and scripts/scan/company-funded.mjs's
 * parseRssItems, reused here rather than re-derived because both already
 * carry the CDATA/entity edge cases a naive regex misses.
 *
 * @param {string} xml - Raw feed body (RSS 2.0 or Atom).
 * @param {{baseUrl?: string, company?: string}} [opts]
 * @returns {import('./_types.js').Job[]}
 */
export function parseJobsFeed(xml, { baseUrl = '', company = '' } = {}) {
  if (typeof xml !== 'string' || !xml.trim()) return [];

  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];

  const jobs = [];
  for (const blockMatch of blocks) {
    const block = blockMatch[1];
    const title = firstTagText(block, ['title']);
    if (!title) continue;

    const rawLink = extractItemLink(block);
    if (!rawLink) continue;
    let url;
    try {
      url = baseUrl ? new URL(rawLink, baseUrl).href : new URL(rawLink).href;
    } catch {
      continue;
    }
    if (!/^https?:$/.test(new URL(url).protocol)) continue;

    /** @type {import('./_types.js').Job} */
    const job = { title, url, company: company || '', location: '' };

    // content:encoded/description (RSS) or summary/content (Atom) may carry
    // markup — htmlToText strips it rather than leaving raw tags in a title
    // filter's description input.
    const descRaw = firstTagRaw(block, ['content:encoded', 'description', 'summary', 'content']);
    const description = descRaw ? htmlToText(descRaw) : '';
    if (description) job.description = description;

    const postedAt = extractPostedAt(block);
    if (postedAt !== undefined) job.postedAt = postedAt;

    jobs.push(job);
  }
  return jobs;
}

// ── Strategy 3: heuristic anchor scrape ─────────────────────────────────────

// A listing page legitimately carries at most a few hundred open roles; a
// cap exists so an adversarial or malformed page can only ever under-report,
// never hang the process or flood the pipeline. Reported when hit (below)
// rather than truncated silently — a silent cut here would read as "this
// employer only has 200 roles today", which is a claim about the employer
// this code has no basis to make.
const MAX_ANCHOR_JOBS = 200;

const MIN_ANCHOR_TEXT_LEN = 3;
const MAX_ANCHOR_TEXT_LEN = 120;

// Segments that make a path "job-ish". Exact-segment match (not substring) —
// deliberately, so "/subject-career-path" (a blog post) does not qualify just
// because "career" appears inside a longer word.
const JOB_PATH_WORDS = new Set([
  'job', 'jobs', 'career', 'careers', 'position', 'positions',
  'opening', 'openings', 'vacancy', 'vacancies', 'opportunity',
  'role', 'roles',
]);

// Anchor text that reads as navigation chrome rather than a posting title —
// a small, deliberately closed set of the words/phrases these pages actually
// use for their own nav (case-insensitive; text is entity-decoded and
// whitespace-collapsed before this is checked).
const NAV_WORDS = new Set([
  'home', 'about', 'contact', 'apply', 'apply now', 'search', 'filter',
  'login', 'sign in', 'view all', 'see all', 'all jobs', 'all openings',
  'learn more', 'read more', 'back', 'next', 'previous', 'menu',
  'careers', 'jobs', 'open roles', 'benefits', 'culture', 'life at',
  'privacy', 'terms', 'cookie', 'cookies',
]);

/**
 * Whether normalized anchor text reads as nav chrome.
 *
 * A single-word entry (e.g. "menu") only matches the WHOLE text — a real job
 * title never collides with one of these bare words. A multi-word entry (e.g.
 * "view all") also matches as a PREFIX ("View all jobs", "View all openings",
 * …), because real pages append a noun to it far more often than they use it
 * bare; a single-word entry never gets this looser treatment, so it can't
 * turn a genuine title like "Careers Coordinator" into a false rejection just
 * because it starts with "careers".
 */
function isNavText(text) {
  const lower = text.toLowerCase();
  if (NAV_WORDS.has(lower)) return true;
  for (const phrase of NAV_WORDS) {
    if (phrase.includes(' ') && lower.startsWith(`${phrase} `)) return true;
  }
  return false;
}

// A small, deliberately narrow set of ATS/board hosts a bespoke careers page
// commonly links its actual postings out to (e.g. "Careers" nav → an embedded
// Greenhouse board). An off-origin anchor elsewhere is rejected outright —
// this is a fingerprinter reading ONE page, not a crawler that follows
// arbitrary outbound links. Deliberately not imported from
// providers/_trust-validator.mjs: that list is private to a different
// module's own contract (company/domain trust scoring), and entangling the
// two would make a change to one silently change the other's behavior.
const RECOGNIZED_ATS_HOSTS = [
  'greenhouse.io', 'ashbyhq.com', 'lever.co', 'myworkdayjobs.com',
  'smartrecruiters.com', 'jobvite.com', 'icims.com', 'workable.com',
  'breezy.hr', 'bamboohr.com', 'recruitee.com', 'teamtailor.com',
  'taleo.net', 'applytojob.com',
];

function isRecognizedAtsHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return RECOGNIZED_ATS_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function hasJobPathSegment(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  return segments.some((seg) => JOB_PATH_WORDS.has(seg.toLowerCase()));
}

/** The final path segment must contain a digit or a hyphen — an index page
 * like "/careers" or "/jobs" carries no such segment and must never qualify. */
function hasDistinguishingFinalSegment(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean);
  if (!segments.length) return false;
  return /[0-9-]/.test(segments[segments.length - 1]);
}

function collapseWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Conservative last-resort scrape of `<a href>` anchors that look like job
 * postings.
 *
 * An anchor qualifies only when ALL of these hold:
 *   - its href resolves to an absolute http(s) URL;
 *   - that URL is same-origin as `baseUrl`, OR on a RECOGNIZED_ATS_HOSTS host;
 *   - its path contains an exact job-ish segment (JOB_PATH_WORDS);
 *   - its path's FINAL segment contains a digit or a hyphen — so "/careers"
 *     and "/jobs" (the index pages themselves) are never mistaken for a
 *     posting;
 *   - its visible text, after entity-decode + whitespace-collapse, is 3-120
 *     characters and is not one of NAV_WORDS.
 *
 * Every scraped Job carries NO description and NO postedAt: this strategy
 * genuinely does not know either, and inventing one would poison downstream
 * freshness scoring with a fabricated date (AGENTS.md, no-fabrication).
 *
 * @param {string} html - Careers page HTML.
 * @param {{baseUrl?: string, company?: string}} [opts]
 * @returns {import('./_types.js').Job[]}
 */
export function scrapeJobAnchors(html, { baseUrl = '', company = '' } = {}) {
  if (typeof html !== 'string' || !html.trim() || !baseUrl) return [];
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const jobs = [];
  const seen = new Set();
  let truncated = false;

  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (jobs.length >= MAX_ANCHOR_JOBS) { truncated = true; break; }

    const attrs = m[1] || '';
    const hrefM = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefM) continue;
    const rawHref = decodeEntities(hrefM[1]).trim();
    if (!rawHref) continue;

    let url;
    try {
      url = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.origin !== origin && !isRecognizedAtsHost(url.hostname)) continue;
    if (!hasJobPathSegment(url.pathname)) continue;
    if (!hasDistinguishingFinalSegment(url.pathname)) continue;

    const text = collapseWhitespace(decodeEntities((m[2] || '').replace(/<[^>]*>/g, ' ')));
    if (text.length < MIN_ANCHOR_TEXT_LEN || text.length > MAX_ANCHOR_TEXT_LEN) continue;
    if (isNavText(text)) continue;

    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    jobs.push({ title: text, url: href, company: company || '', location: '' });
  }

  if (truncated) {
    console.error(
      `generic-careers: anchor scrape hit the ${MAX_ANCHOR_JOBS}-job cap for ${company || baseUrl}`
      + ' — later anchors on this page were not scanned. Reported rather than truncated silently,'
      + ' since a silent cut here would read as "this employer only has that many roles today".',
    );
  }

  return jobs;
}

// ── Pure HTML parse: strategies 1 and 3, plus feed-URL discovery ───────────

/**
 * Parse a careers page's HTML with no network access: runs strategy 1
 * (JSON-LD), then strategy 3 (the anchor scrape), and always reports the feed
 * URLs discovered on the page so the async fetch() below can decide whether
 * to spend a request on strategy 2 IN BETWEEN the two.
 *
 * `jobs`/`strategy` follow descending confidence: JSON-LD wins outright when
 * it yields at least one posting; otherwise the anchor scrape's result (which
 * may itself be empty) is reported instead.
 *
 * @param {string} html - Careers page HTML.
 * @param {{baseUrl?: string, company?: string}} [opts]
 * @returns {{jobs: import('./_types.js').Job[], strategy: 'jsonld'|'anchors'|null, feedUrls: string[]}}
 */
export function parseCareersHtml(html, { baseUrl = '', company = '' } = {}) {
  if (typeof html !== 'string' || !html.trim()) return { jobs: [], strategy: null, feedUrls: [] };

  const feedUrls = discoverFeedUrls(html, baseUrl);

  const jsonldJobs = collectJobPostings(html)
    .map((node) => jobFromJsonLd(node, { baseUrl, company }))
    .filter((job) => job !== null);
  if (jsonldJobs.length) return { jobs: jsonldJobs, strategy: 'jsonld', feedUrls };

  const anchorJobs = scrapeJobAnchors(html, { baseUrl, company });
  if (anchorJobs.length) return { jobs: anchorJobs, strategy: 'anchors', feedUrls };

  return { jobs: [], strategy: null, feedUrls };
}

// ── Provider ─────────────────────────────────────────────────────────────

/**
 * Explicit-only claim of a portals.yml entry.
 *
 * NEVER auto-claims by URL pattern: providers/_registry.mjs loads every
 * providers/*.mjs file in ALPHABETICAL ORDER and runs detect() in that
 * order, first hit wins — 'generic-careers' sorts ahead of almost every
 * other provider id (greenhouse, lever, ashby, workday, …), so a
 * pattern-matching detect() here would swallow entries a more specific
 * provider should have handled instead. A bespoke careers page has no
 * stable URL pattern to detect by anyway — that is the whole reason this
 * provider exists.
 *
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {{url: string}|null}
 */
function detectGenericCareers(entry) {
  return entry && entry.provider === 'generic-careers' && typeof entry.careers_url === 'string' && entry.careers_url
    ? { url: entry.careers_url }
    : null;
}

/** @param {string} raw @param {string} label */
function assertHttpUrl(raw, label) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new Error(`generic-careers: invalid ${label}: ${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`generic-careers: ${label} must be http(s): ${raw}`);
  }
  return parsed.href;
}

/** @type {Provider} */
export default {
  id: 'generic-careers',

  detect: detectGenericCareers,

  /**
   * Resolve a bespoke careers page into Job[] by the three strategies
   * described at the top of this file, stopping at the first that yields at
   * least one job. Returns [] when the page carries nothing recognizable —
   * "no postings today" is not a broken board. A genuine transport failure
   * on the careers page itself is NOT swallowed: it propagates so
   * scan.mjs's portal-health bookkeeping sees a real failure, not a quiet
   * empty result.
   *
   * @param {import('./_types.js').PortalEntry} entry
   * @param {import('./_types.js').Context} ctx
   * @returns {Promise<import('./_types.js').Job[]>}
   */
  async fetch(entry, ctx) {
    const hit = detectGenericCareers(entry);
    if (!hit) {
      throw new Error(
        `generic-careers: entry "${entry?.name || '?'}" requires provider: generic-careers plus careers_url`,
      );
    }
    const careersUrl = assertHttpUrl(hit.url, 'careers_url');
    const company = typeof entry?.name === 'string' ? entry.name : '';

    // redirect:'error' prevents SSRF via a server-side redirect (house
    // convention; see providers/README.md "Security conventions"). The
    // per-connection SSRF/DNS-rebinding guard (providers/_ip-guard.mjs) is
    // applied globally inside _http.mjs's fetch context, so it covers this
    // request and every feed probe below with no extra call here.
    const html = await ctx.fetchText(careersUrl, { redirect: 'error' });

    const { jobs, strategy, feedUrls } = parseCareersHtml(html, { baseUrl: careersUrl, company });
    if (strategy === 'jsonld' && jobs.length) return jobs;

    // Strategy 2: spend at most MAX_FEED_URLS extra requests total, combining
    // whatever <link rel="alternate"> autodiscovery already found with the
    // conventional root-relative siblings, same-origin only.
    const origin = new URL(careersUrl).origin;
    const candidates = [...feedUrls];
    const seenCandidates = new Set(feedUrls);
    for (const path of CONVENTIONAL_FEED_PATHS) {
      if (candidates.length >= MAX_FEED_URLS) break;
      let url;
      try {
        url = new URL(path, `${origin}/`).href;
      } catch {
        continue;
      }
      if (seenCandidates.has(url)) continue;
      seenCandidates.add(url);
      candidates.push(url);
    }

    for (const feedUrl of candidates.slice(0, MAX_FEED_URLS)) {
      let xml;
      try {
        xml = await ctx.fetchText(feedUrl, { redirect: 'error' });
      } catch {
        // A probed conventional sibling (or a stale <link>) 404ing is
        // expected, not a transport failure worth throwing on — only the
        // careers page fetch above is load-bearing enough to propagate.
        continue;
      }
      const feedJobs = parseJobsFeed(xml, { baseUrl: feedUrl, company });
      if (feedJobs.length) return feedJobs;
    }

    // Strategy 3: whatever the anchor scrape inside parseCareersHtml already
    // found (possibly []).
    return jobs;
  },
};
