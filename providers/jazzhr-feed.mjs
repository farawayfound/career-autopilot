// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// JazzHR (applytojob.com) global feed provider. JazzHR publishes ONE Google-for-
// Jobs sitemap that lists every public posting across every tenant:
//
//   GET https://app.jazz.co/feeds/google/xml/<0..4>      (page 5 is empty)
//   <url><loc>https://<tenant>.applytojob.com/apply/<id>/<Title-Slug>?source=GS</loc>
//        <lastmod>2026-10-15T00:00:00+00:00</lastmod></url>
//
// It is advertised by every tenant's own robots.txt (`Sitemap: …/feeds/google/xml/N`,
// with `Disallow: /cb` the only restriction for generic agents). Verified live
// 2026-10-15: five pages of ~4 MB, ~110,000 postings across thousands of tenants.
//
// The feed carries NO title, company, location or date as fields, so this
// provider derives what it can and says so:
//   - title    from the URL slug ("Dutch-Sales-Consultant-Parttime-And-Remote"),
//   - company  from the tenant subdomain, as written (`easeinc`, not a guess at
//              "Ease Inc"),
//   - location empty,
//   - postedAt unset: `lastmod` is ALWAYS today's date on every row, so it is not
//              a freshness signal and is deliberately not used as one.
// An undated job is dropped by scanners that require a date; scan.mjs keeps it.
//
// Scale is the design constraint. The raw feed is ~20 MB, so it is cached under
// data/cache/ for at most 24 hours (one download a day however often this runs),
// and the output is capped at 5000 jobs per run. With no pre-filter that cap
// would keep an arbitrary prefix of ~110k rows, so an entry should name
// `keywords:` — a lower-cased substring match against the slug-derived title,
// applied BEFORE the cap — and let the scanner's title_filter do the precise
// cut. The filter is configuration, not a built-in opinion about what a good
// title is.
//
// Explicit-only (board-wide). Wire in via a `job_boards:` (or the discovery
// node's `boards:`) entry:
//   - { name: JazzHR, provider: jazzhr-feed,
//       keywords: [engineer, developer, devops, sre, platform, software] }

const FEED_BASE = 'https://app.jazz.co/feeds/google/xml/';
const FEED_HOST = 'app.jazz.co';
const FEED_PAGES = 5;
const TENANT_HOST_SUFFIX = '.applytojob.com';

const CACHE_FILE = 'jazzhr-feed.json';
const DEFAULT_CACHE_DIR = 'data/cache';
// The ceiling as well as the default: a longer-lived cache would only serve
// postings JazzHR has since taken down.
const MAX_CACHE_HOURS = 24;
const MAX_JOBS = 5000;
const MAX_KEYWORDS = 50;
const PAGE_GAP_MS = 1_500;
// One page is ~4 MB; the shared default timeout is sized for JSON APIs.
const PAGE_TIMEOUT_MS = 120_000;

const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const SLUG_RE = /^[A-Za-z0-9._~%-]{1,300}$/;
// <loc>https://<tenant>.applytojob.com/apply/<id>/<slug>[?query]</loc>, matched
// on the decoded text so an `&amp;` in a query cannot break it.
const LOC_RE = /<loc>\s*https:\/\/([a-z0-9][a-z0-9-]{0,62})\.applytojob\.com\/apply\/([A-Za-z0-9_-]{4,128})\/([^/?#<\s]+)[^<]*<\/loc>/gi;

/** @param {string} url */
function assertFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jazzhr-feed: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jazzhr-feed: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== FEED_HOST) {
    throw new Error(`jazzhr-feed: untrusted hostname "${parsed.hostname}" — must be ${FEED_HOST}`);
  }
  return url;
}

/**
 * Posting slug → readable title: percent-decoded, hyphens to spaces. Exported
 * for unit tests.
 * @param {string} slug
 */
export function titleFromSlug(slug) {
  let text = slug;
  try { text = decodeURIComponent(slug); } catch { /* a stray % stays literal */ }
  return decodeEntities(text).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse one sitemap page into compact `[tenant, id, slug]` tuples (the form the
 * cache stores). Rows that are not a `/apply/<id>/<slug>` posting on a
 * `<tenant>.applytojob.com` host — tenant roots, anything off-domain — are
 * skipped. Exported for unit tests.
 * @param {string} xml
 * @returns {Array<[string, string, string]>}
 */
export function parseJazzFeed(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const out = [];
  for (const m of decodeEntities(xml).matchAll(LOC_RE)) {
    const tenant = m[1].toLowerCase();
    if (!TENANT_RE.test(tenant) || !ID_RE.test(m[2]) || !SLUG_RE.test(m[3])) continue;
    out.push(/** @type {[string, string, string]} */ ([tenant, m[2], m[3]]));
  }
  return out;
}

/**
 * Tuple → Job, or null when it fails the host/shape lock. Exported for unit tests.
 * The URL is rebuilt from validated parts (tracking query dropped), never echoed.
 * @param {[string, string, string]} tuple
 * @returns {{title: string, url: string, company: string, location: string} | null}
 */
export function jobFromTuple([tenant, id, slug]) {
  if (!TENANT_RE.test(tenant) || !ID_RE.test(id) || !SLUG_RE.test(slug)) return null;
  const title = titleFromSlug(slug);
  if (!title) return null;
  const url = `https://${tenant}${TENANT_HOST_SUFFIX}/apply/${id}/${slug}`;
  try {
    if (new URL(url).hostname !== `${tenant}${TENANT_HOST_SUFFIX}`) return null;
  } catch {
    return null;
  }
  return { title, url, company: tenant, location: '' };
}

/** @param {any} entry */
function resolveKeywords(entry) {
  const raw = Array.isArray(entry.keywords) ? entry.keywords : [];
  return raw
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim().toLowerCase())
    .slice(0, MAX_KEYWORDS);
}

/**
 * Where the feed cache lives: `data/cache` unless the entry names another
 * directory, which must sit under `data/` or the OS temp dir. The setting comes
 * from a portals.yml entry (which a hub can supply to a node), and this is a
 * place the process writes to, so it is not left free to point anywhere.
 * @param {any} entry
 */
function resolveCacheDir(entry) {
  if (typeof entry.cache_dir !== 'string' || !entry.cache_dir) return DEFAULT_CACHE_DIR;
  const dir = path.resolve(entry.cache_dir);
  const inside = (root) => { const rel = path.relative(path.resolve(root), dir); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (!inside('data') && !inside(os.tmpdir())) {
    throw new Error(`jazzhr-feed: cache_dir must be a directory under data/ (or the OS temp dir), got ${JSON.stringify(entry.cache_dir)}`);
  }
  return entry.cache_dir;
}

/** @param {any} entry */
function resolveCacheHours(entry) {
  const h = Number(entry.cache_hours);
  return Number.isFinite(h) && h > 0 ? Math.min(h, MAX_CACHE_HOURS) : MAX_CACHE_HOURS;
}

/**
 * Read the cached tuple list. Returns null when absent, unreadable, or
 * (unless `allowStale`) older than the TTL.
 * @param {string} file
 * @param {number} maxAgeHours
 * @param {boolean} [allowStale]
 * @returns {Array<[string, string, string]>|null}
 */
function readCache(file, maxAgeHours, allowStale = false) {
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    if (doc?.version !== 1 || !Array.isArray(doc.entries)) return null;
    if (!allowStale) {
      const ageHours = (Date.now() - statSync(file).mtimeMs) / 3_600_000;
      if (!(ageHours < maxAgeHours)) return null;
    }
    return doc.entries;
  } catch {
    return null; // a torn or hand-edited cache is just a cache miss
  }
}

/** @type {Provider} */
export default {
  id: 'jazzhr-feed',

  // Explicit-only: board-wide, and the *.applytojob.com careers pages it lists
  // are individual postings, not boards to auto-claim.
  detect(entry) {
    return entry?.provider === 'jazzhr-feed' ? { url: `${FEED_BASE}0` } : null;
  },

  async fetch(entry, ctx) {
    const cacheDir = resolveCacheDir(entry);
    const cacheFile = path.join(cacheDir, CACHE_FILE);
    const cacheHours = resolveCacheHours(entry);
    const probe = Number.isInteger(ctx.maxPages) && /** @type {number} */ (ctx.maxPages) > 0;

    let tuples = probe ? null : readCache(cacheFile, cacheHours);
    if (!tuples) {
      const pages = probe ? Math.min(FEED_PAGES, /** @type {number} */ (ctx.maxPages)) : FEED_PAGES;
      /** @type {Array<[string, string, string]>} */
      const fresh = [];
      try {
        for (let page = 0; page < pages; page++) {
          if (page > 0) await sleep(PAGE_GAP_MS, ctx);
          // redirect:'error' + assertFeedUrl pin every request to app.jazz.co.
          const xml = await fetchTextWithRetry(ctx, assertFeedUrl(`${FEED_BASE}${page}`), { redirect: 'error', timeoutMs: PAGE_TIMEOUT_MS }, { retries: 2 });
          const rows = parseJazzFeed(xml);
          if (rows.length === 0) {
            // Page 5 is legitimately empty. An empty FIRST page is not: it is
            // a changed feed or a block, and must not be cached as "no jobs".
            if (page === 0) throw new Error('jazzhr-feed: the first feed page had no postings (blocked, or the feed layout changed)');
            break;
          }
          fresh.push(...rows);
        }
      } catch (err) {
        // A stale list beats nothing, but only out loud: the warning names the
        // failure and the file, and the run is otherwise unchanged.
        const stale = probe ? null : readCache(cacheFile, cacheHours, true);
        if (!stale) throw err;
        console.error(`⚠️  jazzhr-feed: feed download failed (${/** @type {Error} */ (err).message}) — using the stale cache ${cacheFile}`);
        tuples = stale;
      }
      if (!tuples) {
        tuples = fresh;
        if (!probe) {
          // A probe reads a fraction of the feed; caching that would pass for the whole list.
          try {
            mkdirSync(cacheDir, { recursive: true });
            writeFileSync(cacheFile, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), entries: fresh }), 'utf-8');
          } catch (err) {
            console.error(`⚠️  jazzhr-feed: could not write the feed cache ${cacheFile} (${/** @type {Error} */ (err).message}) — the next run will download it again`);
          }
        }
      }
    }

    const keywords = resolveKeywords(entry);
    const cap = Math.min(MAX_JOBS, Number.isInteger(entry.max_jobs) && entry.max_jobs > 0 ? entry.max_jobs : MAX_JOBS);
    const seen = new Set();
    const jobs = [];
    let matched = 0;
    for (const tuple of tuples) {
      const job = jobFromTuple(tuple);
      if (!job) continue;
      if (keywords.length && !keywords.some((k) => job.title.toLowerCase().includes(k))) continue;
      const key = `${tuple[0]}/${tuple[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched++;
      if (jobs.length < cap) jobs.push(job);
    }
    if (matched > cap) {
      console.error(`⚠️  jazzhr-feed: ${matched} postings matched${keywords.length ? '' : ' (no "keywords" configured)'}, keeping the first ${cap} in feed order — narrow "keywords" to cover the rest`);
    }
    return jobs;
  },
};
