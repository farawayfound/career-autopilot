// @ts-check
/**
 * providers/_jsonld.mjs — shared schema.org JSON-LD extraction.
 *
 * Three callers, three deliberately different shapes, one implementation:
 *
 *   1. autopilot/lib/jd.mjs reads ONE posting out of ONE posting page
 *      (`extractJobPosting`). Its walk is deliberately narrow — top-level
 *      object, top-level array, or `@graph` — and returns the FIRST hit.
 *   2. providers/icims.mjs reads `datePosted`/`jobLocation` off a posting page
 *      (`extractJsonLdNodes` + `pickDatePosted`/`pickLocation`). Its flatten is
 *      ONE level (array spread / `@graph` spread / bare object) and its pickers
 *      carry lenient fallbacks that its tests pin.
 *   3. providers/generic-careers.mjs reads EVERY posting out of a LISTING page
 *      (`collectJobPostings`). That one needs the deep walk: a careers page
 *      commonly wraps its postings in an `ItemList`, whose `itemListElement[]`
 *      entries hold the `JobPosting` under `item`.
 *
 * (1) and (2) are moved here VERBATIM rather than unified, because their
 * differences are not accidents — jd.mjs's comment calls its three-shape walk
 * deliberate, and icims' pickers document a lenient fallback that exists
 * because a tenant emitting no `@type` left every posting on that board
 * undated. A "tidier" merged walk would silently change both.
 *
 * The block regex IS unified, taking the stricter half of each: iCIMS' negative
 * lookbehind (so `data-type="application/ld+json"` is not mistaken for the real
 * attribute, and a CSP nonce emitted before `type=` still matches) plus jd.mjs's
 * 200KB-per-block / 20-block bound (so a malformed or adversarial page can only
 * ever fail to find a posting, never hang the process).
 *
 * Every value here comes out of a fetched third-party page. It is DATA — a
 * posting's own text — never instructions, exactly like every other provider
 * response (AGENTS.md, "Untrusted External Content").
 */

import { htmlToText } from './_html-to-text.mjs';

// Bounded, non-hanging extraction: each block's body is capped before the
// non-greedy match runs, and at most MAX_BLOCKS blocks are ever scanned.
//
// These defaults are autopilot/lib/jd.mjs's, and they are sized for ITS input:
// an arbitrary third-party posting page reached from a lead, where a malformed
// or adversarial document must only ever fail to find a posting. A caller
// reading a page it fetched from a known ATS host has a weaker threat model and
// a stronger correctness requirement, and can raise them — see
// providers/icims.mjs, whose own extraction was unbounded before this module
// existed and whose pages legitimately carry widget-injected Organization /
// BreadcrumbList / related-posting blocks ahead of the JobPosting.
const MAX_BLOCK_CHARS = 200_000;
const MAX_BLOCKS = 20;

/**
 * `<script type="application/ld+json">…</script>`.
 *
 * `(?<![\w-])type=` rather than `\btype=`: `\b` matches inside `data-type=`
 * (the `-` is a non-word character), so the looser form claimed attributes
 * that are not the one we want. `[^>]*` before it allows the CSP `nonce=`
 * a tenant emits ahead of `type=`.
 */
export function jsonLdBlockRe(maxBlockChars = MAX_BLOCK_CHARS) {
  return new RegExp(
    '<script\\b[^>]*(?<![\\w-])type=["\']application/ld\\+json["\'][^>]*>'
    + `([\\s\\S]{0,${maxBlockChars}}?)`
    + '</script\\s*>',
    'gi',
  );
}

/** The default-bounded pattern, kept as a constant for callers that inspect it. */
export const JSONLD_BLOCK_RE = jsonLdBlockRe();

/**
 * Every parseable JSON-LD document in a page, in source order.
 *
 * @param {string} html
 * @param {{maxBlocks?: number, maxBlockChars?: number}} [limits]
 * @returns {unknown[]} One entry per block that parsed; unparseable blocks are skipped.
 */
export function parseJsonLdBlocks(html, { maxBlocks = MAX_BLOCKS, maxBlockChars = MAX_BLOCK_CHARS } = {}) {
  const out = [];
  const re = maxBlockChars === MAX_BLOCK_CHARS ? JSONLD_BLOCK_RE : jsonLdBlockRe(maxBlockChars);
  for (const block of [...String(html).matchAll(re)].slice(0, maxBlocks)) {
    let parsed;
    try { parsed = JSON.parse(block[1]); } catch { continue; }
    out.push(parsed);
  }
  return out;
}

// ── (2) iCIMS' one-level flatten + lenient pickers, moved verbatim ──────────

/**
 * Flatten the JSON-LD shapes iCIMS / schema.org emit: a bare JobPosting
 * object, an array of nodes, or a graph document (`{"@graph":[…]}`).
 *
 * ONE level by design — this is the shape providers/icims.mjs has always
 * passed to `pickDatePosted`/`pickLocation`. For a listing page's nested
 * `ItemList`, use `collectJobPostings` instead.
 *
 * @param {string} html
 * @param {{maxBlocks?: number, maxBlockChars?: number}} [limits] - Raise the
 *   defaults for a caller whose input is a known ATS page rather than an
 *   arbitrary one; see the note on MAX_BLOCK_CHARS above.
 * @returns {any[]}
 */
export function extractJsonLdNodes(html, limits = {}) {
  const nodes = [];
  for (const data of parseJsonLdBlocks(html, limits)) {
    if (Array.isArray(data)) nodes.push(...data);
    else if (Array.isArray(/** @type {any} */ (data)?.['@graph'])) nodes.push(...(/** @type {any} */ (data)['@graph']));
    else nodes.push(data);
  }
  return nodes;
}

// ISO country codes are what iCIMS emits, but location_filter matches on the
// words a human wrote in portals.yml ("Canada", "United States"), so a bare
// "US" would sail past a block list that spells the country out.
const COUNTRY_NAMES = { US: 'United States', CA: 'Canada' };

/**
 * From flattened JSON-LD nodes, build "Locality, Region, Country" out of the
 * first JobPosting's first jobLocation address. Partial addresses are kept:
 * the country alone is already enough for location_filter to decide.
 *
 * @param {any[]} nodes
 * @returns {string|null}
 */
export function pickLocation(nodes) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !node.jobLocation) continue;
    const place = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
    const addr = place?.address;
    if (!addr || typeof addr !== 'object') continue;
    const clean = (v) => {
      const s = String(v ?? '').trim();
      // iCIMS writes the literal string UNAVAILABLE into fields it has no value
      // for, so an unchecked join yields "UNAVAILABLE, MD, United States".
      return !s || /^unavailable$/i.test(s) ? '' : s;
    };
    const country = clean(addr.addressCountry);
    const parts = [
      clean(addr.addressLocality),
      clean(addr.addressRegion),
      COUNTRY_NAMES[country.toUpperCase()] || country,
    ].filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  return null;
}

/**
 * From flattened JSON-LD nodes, return the datePosted of the first JobPosting
 * node; if none carries a @type, fall back to the first node that has a
 * datePosted at all (preserves the original lenient single-object behavior).
 *
 * @param {any[]} nodes
 * @returns {string|null}
 */
export function pickDatePosted(nodes) {
  let fallback = null;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !node.datePosted) continue;
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node.datePosted;
    if (fallback == null) fallback = node.datePosted;
  }
  return fallback;
}

// ── (1) jd.mjs's narrow three-shape walk, moved verbatim ───────────────────

/**
 * A JobPosting node can be the top-level object, an element of a top-level
 * array, or nested inside an @graph array (either shape is common schema.org
 * output) — walk those three shapes only, never arbitrary object nesting.
 *
 * @param {any} node
 * @returns {any|null}
 */
export function findJobPosting(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')) return node;
  if (Array.isArray(node['@graph'])) return findJobPosting(node['@graph']);
  return null;
}

/**
 * The first schema.org JobPosting in a page, or null.
 *
 * @param {string} html
 * @returns {any|null}
 */
export function extractJobPosting(html) {
  for (const parsed of parseJsonLdBlocks(html)) {
    const job = findJobPosting(parsed);
    if (job) return job;
  }
  return null;
}

// ── (3) The deep walk, for a LISTING page ──────────────────────────────────

// Bounds on the deep walk. A listing page legitimately carries one JobPosting
// per open role; a page carrying more than this is either paginated wrong or
// adversarial, and either way the scanner's own filters are a better place to
// decide than an unbounded recursion here.
const MAX_WALK_DEPTH = 8;
const MAX_WALK_NODES = 2000;

/** @param {any} node */
export function isJobPostingNode(node) {
  if (!node || typeof node !== 'object') return false;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
}

/**
 * EVERY JobPosting in a page, in source order, deduped by identity.
 *
 * Unlike `findJobPosting` this descends the containers a listing page uses —
 * `@graph`, `itemListElement[]` and each ListItem's `item` — because a careers
 * page commonly emits one `ItemList` wrapping every open role rather than one
 * JobPosting per block. Still not arbitrary nesting: only those containers,
 * depth- and count-bounded.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function collectJobPostings(html) {
  const found = [];
  const seen = new Set();
  let budget = MAX_WALK_NODES;

  /** @param {any} node @param {number} depth */
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH || budget <= 0) return;
    budget -= 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isJobPostingNode(node) && !seen.has(node)) {
      seen.add(node);
      found.push(node);
      // A JobPosting is a leaf for this walk — never descend into its own
      // description/hiringOrganization looking for more postings.
      return;
    }
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'mainEntityOfPage']) {
      if (node[key]) walk(node[key], depth + 1);
    }
  };

  for (const parsed of parseJsonLdBlocks(html)) walk(parsed, 0);
  return found;
}

// ── Field extraction ───────────────────────────────────────────────────────

/**
 * schema.org baseSalary is either a MonetaryAmount ({ currency, value }) or a
 * bare string some sites emit directly — either way, compact it to one line
 * rather than handing the caller a nested object to format itself.
 *
 * @param {any} salary
 * @returns {string|null}
 */
export function compactSalary(salary) {
  if (typeof salary === 'string') return salary.trim() || null;
  if (!salary || typeof salary !== 'object') return null;
  const currency = typeof salary.currency === 'string' ? salary.currency : '';
  const v = salary.value;
  let amount = null;
  if (v && typeof v === 'object') {
    if (v.minValue != null && v.maxValue != null) amount = `${v.minValue}-${v.maxValue}`;
    else if (v.value != null) amount = String(v.value);
    if (amount && v.unitText) amount += `/${String(v.unitText).toLowerCase()}`;
  } else if (typeof v === 'number' || typeof v === 'string') {
    amount = String(v);
  }
  if (!amount) return null;
  return [currency, amount].filter(Boolean).join(' ').trim();
}

/** @param {any} value */
function firstString(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  if (value && typeof value === 'object') {
    for (const key of ['name', 'url', '@id', 'value']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return '';
}

/**
 * `jobLocationType: TELECOMMUTE` is schema.org's remote marker; some sites
 * also leave `jobLocation` empty and put the word in `applicantLocationRequirements`.
 *
 * @param {any} node
 * @returns {string}
 */
function remoteLabel(node) {
  const type = firstString(node.jobLocationType);
  if (!/telecommute/i.test(type)) return '';
  const where = firstString(node.applicantLocationRequirements);
  return where ? `Remote, ${where}` : 'Remote';
}

/**
 * One schema.org JobPosting node → the scanner's normalized Job shape, or null
 * when the node carries no usable title or URL.
 *
 * `url` resolves against `baseUrl` so a relative `url`/`@id` (common) still
 * produces the absolute URL the scanner uses as its dedup key. A node with no
 * URL of its own falls back to `fallbackUrl` (the listing page) ONLY when the
 * caller supplies one — without a per-posting URL every role on the page would
 * otherwise collapse to a single dedup key.
 *
 * @param {any} node
 * @param {{baseUrl?: string, company?: string, fallbackUrl?: string}} [opts]
 * @returns {{title: string, url: string, company: string, location: string,
 *   description?: string, postedAt?: number}|null}
 */
export function jobFromJsonLd(node, { baseUrl = '', company = '', fallbackUrl = '' } = {}) {
  if (!isJobPostingNode(node)) return null;

  const title = firstString(node.title) || firstString(node.name);
  if (!title) return null;

  const rawUrl = firstString(node.url) || firstString(node['@id']) || fallbackUrl;
  if (!rawUrl) return null;
  let url;
  try {
    url = baseUrl ? new URL(rawUrl, baseUrl).href : new URL(rawUrl).href;
  } catch {
    return null;
  }
  if (!/^https?:$/.test(new URL(url).protocol)) return null;

  const location = pickLocation([node]) || remoteLabel(node) || '';
  const org = firstString(node.hiringOrganization) || company;

  /** @type {any} */
  const job = { title, url, company: org, location };

  const description = typeof node.description === 'string' ? htmlToText(node.description) : '';
  if (description) job.description = description;

  const ts = Date.parse(firstString(node.datePosted) || '');
  if (!Number.isNaN(ts)) job.postedAt = ts;

  return job;
}
