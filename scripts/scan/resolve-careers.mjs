#!/usr/bin/env node
/**
 * scripts/scan/resolve-careers.mjs — resolve a company NAME to an ATS board by fingerprinting its own website, not by guessing a slug.
 *
 * scripts/scan/discover-ats.mjs resolves a company to an ATS board by GUESSING a slug
 * (`deriveSlug(name)`) and probing eleven vendors' well-known URL shapes. Its own
 * header names the failure: "JS-rendered portals, non-standard slugs, or Workday
 * without a hint — flagged for manual follow-up" — and Workday in particular is
 * UNGUESSABLE from a name alone (tenant + instance + site, only one of which is
 * name-shaped). This script resolves the same question a better way: fetch the
 * company's ACTUAL website, find its careers page, and FINGERPRINT the ATS vendor
 * out of that page's own HTML. The tenant/site Workday needs — and the real slug
 * every other vendor needs — are sitting in plain text in the embedded widget/
 * iframe/script URL; nothing about them needs to be guessed.
 *
 * THE CENTRAL DESIGN DECISION: this file does NOT hand-write regex fingerprints
 * duplicating each of the 85 providers' URL knowledge — that duplication would
 * drift the moment a provider changed. Instead every absolute URL sitting in the
 * page's markup (href, src, a data- attribute, an inline <script> string
 * literal) is run through
 * the SAME provider registry scripts/scan/scan.mjs uses (`providers/_registry.mjs`'s
 * `loadProviders`/`resolveProvider` machinery, applied per-candidate-URL here as
 * `fingerprintAtsUrls`): whichever provider's own `detect()` claims a URL IS the
 * vendor. This can never drift from the scanner, and it automatically covers every
 * provider that exists now or in the future — nothing here has to be told about a
 * new vendor when one is added under providers/.
 *
 * Liveness is then confirmed the same way scripts/scan/discover-ats.mjs confirms it — a
 * real fetch through the matched provider's own `.fetch()`, requiring >=1 job —
 * EXCEPT this deliberately does NOT route through discover-ats.mjs's
 * `resolveCompany`/`buildCandidateUrls` for that confirmation (see `confirmLive`
 * below for why: that path derives its probe URL from `company.slug ||
 * deriveSlug(company.name)`, which would silently re-introduce exactly the
 * "slug isn't derivable from the name" failure this script exists to fix). The
 * one exception is Workday, where `discover-ats.mjs`'s own `parseWorkdayHint` +
 * `resolveWorkday` are reused directly and verbatim (see discover-ats.mjs:325-352,
 * :528-573) — reading coordinates out of an already-discovered URL is not a guess,
 * and `resolveWorkday`'s single-page probe cap is a real efficiency win this file
 * has no reason to reimplement.
 *
 * CRAWL HYGIENE — this is a fingerprinter, not a web crawler, and that has to be
 * written down or it silently becomes one:
 *   - Hard TWO-HOP depth cap: homepage, then AT MOST ONE careers-page follow (the
 *     single best-ranked candidate from `findCareersLinks`). A page reached on
 *     that second hop is never itself crawled further. See `resolveOne` below.
 *   - robots.txt is fetched once per host, cached for the process, and a path
 *     disallowed under its `User-agent: *` group is never fetched (`createCrawlFetcher`).
 *   - Per-host pacing (`createCrawlFetcher`'s pacer) — default 3000ms, the same
 *     default as the discovery node's own `validate` job (`config/discovery-node.
 *     example.yml`'s `host_gap_ms`) — so two hops on the same host never arrive
 *     back-to-back.
 *   - SSRF: every fetch runs through `providers/_http.mjs` (`fetchTextHead`),
 *     whose imported `providers/_dns-cache.mjs` patches `dns.lookup` process-wide
 *     and `providers/_ip-guard.mjs` rejects a resolved private/loopback/link-local/
 *     metadata address INSIDE that patched lookup, scoped to provider-fetch async
 *     context (`providerFetchContext`, entered by `_http.mjs`'s `fetchWithTimeout`).
 *     That is the guard chosen over `autopilot/lib/url-guard.mjs`'s `safeUrl`:
 *     `url-guard.mjs`'s own header says it is deliberately "literal-hostname
 *     checks only... no DNS resolution" (a hostname that resolves PUBLIC-then-
 *     PRIVATE — DNS rebinding — sails through it), it lives in `autopilot/lib`
 *     (a layer `scripts/scan`/`providers` never depends on), and it pulls in
 *     `./companion-queue.mjs`, an unrelated dependency for a discovery-node
 *     script with no autopilot server running. `providers/_ip-guard.mjs` is also
 *     the IDENTICAL guard every other provider fetch in this codebase already
 *     runs under, so a URL harvested from a stranger's homepage gets exactly the
 *     same protection as a URL this script already trusts (a known ATS host).
 *   - Every response body is bounded (`fetchTextHead`'s `maxBytes` — a careers
 *     page is not a download) and every request carries a timeout.
 *   - User-Agent is `lib/user-agent.mjs`'s shared `DEFAULT_USER_AGENT` — no
 *     invented identifier.
 *
 * PREVIEW ONLY, by design and permanently: this script has no --write flag at
 * all and never touches portals.yml (a USER-LAYER file — AGENTS.md's Data
 * Contract). It prints what it found; a human promotes the good ones into
 * portals.yml by hand.
 *
 * Run: node scripts/scan/resolve-careers.mjs --in companies.yml
 *      node scripts/scan/resolve-careers.mjs --in companies.yml --summary
 *      node scripts/scan/resolve-careers.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

import { makeHttpCtx, fetchTextHead } from '../../providers/_http.mjs';
import { loadProviders } from '../../providers/_registry.mjs';
import { decodeEntities } from '../../providers/_html-entities.mjs';
import { collectJobPostings } from '../../providers/_jsonld.mjs';
import { DEFAULT_USER_AGENT } from '../../lib/user-agent.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { REPO_ROOT } from '../../lib/repo-root.mjs';
import { validateFlags, flagValue, hasFlag, safeIntFlag } from '../../lib/cli-flags.mjs';
import {
  parseCompanyInput,
  deriveSlug,
  parseWorkdayHint,
  resolveWorkday,
  resolveCompany,
  isDefinitiveAbsence,
} from './discover-ats.mjs';

// ── Tunables ──────────────────────────────────────────────────────────────

// A careers/homepage page is markup to read, not a download. 1.5MB is
// generous for real-world markup (even a heavy marketing homepage rarely
// clears a few hundred KB of HTML proper) while bounding an adversarial or
// misconfigured response that would otherwise stream forever inside the
// timeout window.
const MAX_PAGE_BYTES = 1_500_000;
// robots.txt is a small, well-known text file; a response far larger than
// this is not a real robots.txt and reading further buys nothing.
const MAX_ROBOTS_BYTES = 100_000;
const PAGE_TIMEOUT_MS = 10_000;
const ROBOTS_TIMEOUT_MS = 8_000;
// Matches config/discovery-node.example.yml's `validate.host_gap_ms` default —
// one crawler, one pacing default, so an operator tuning one already knows
// the other.
const DEFAULT_HOST_GAP_MS = 3_000;
// A homepage that 301s to www, or http->https, is the normal case, so refusing
// every redirect outright would fail on a large share of real company sites.
// Following them blindly is the other extreme: `redirect: 'follow'` lands on
// the target host without ever consulting ITS robots.txt and without pacing it,
// which quietly breaks both promises this fetcher makes. So each hop is walked
// by hand and re-guarded, and the walk is short — a company careers page is one
// or two redirects from its homepage, never five.
const MAX_REDIRECTS = 4;
// Lower than scripts/scan/discover-ats.mjs's DEFAULT_CONCURRENCY (8): those requests hit
// eleven KNOWN, high-capacity ATS APIs; these hit arbitrary third-party
// company homepages, which deserve more restraint by default.
const DEFAULT_CONCURRENCY = 5;
// A heavily-linked homepage can embed a surprising number of absolute URLs
// (analytics, social icons, ATS widgets, CDN assets). 200 is generous headroom
// for a real page's distinct URLs while keeping the extraction pass — and the
// array it returns — bounded against an adversarial or auto-generated page.
const MAX_CANDIDATE_URLS = 200;
// findCareersLinks ranks best-first and the caller only ever follows the top
// one (the two-hop depth cap) — 5 is enough for a caller that wants to see
// the runner-up candidates without holding an unbounded list.
const MAX_CAREERS_LINKS = 5;
const MAX_ANCHORS_SCANNED = 500;
const MAX_ANCHOR_HREF_CHARS = 2000;
const MAX_ANCHOR_INNER_CHARS = 2000;

const USAGE = `Usage:
  node scripts/scan/resolve-careers.mjs --in companies.yml            # PREVIEW — fingerprint + print, writes nothing
  node scripts/scan/resolve-careers.mjs Stripe Ramp Mollie             # company names as positional args (no website → unresolved)
  node scripts/scan/resolve-careers.mjs --in companies.yml --summary  # human-readable table
  node scripts/scan/resolve-careers.mjs --in companies.yml --concurrency 3
  node scripts/scan/resolve-careers.mjs --self-test                   # inline test suite
  node scripts/scan/resolve-careers.mjs --help                        # print this usage block

This command NEVER writes portals.yml and has no --write flag at all — see the
module header. It resolves each input company by crawling ITS OWN website
(homepage, then at most one careers-page follow) and fingerprinting the ATS
vendor out of the page's own markup, rather than guessing a slug.

Input YAML shape (same as scripts/scan/discover-ats.mjs, minus the workday hint —
this script discovers Workday coordinates itself):
  companies:
    - name: Adyen
      website: adyen.com
    - name: Mollie
      website: https://www.mollie.com
    - name: NoWebsiteYet   # no website → unresolved, reason states why`;

// ── Pure functions: HTML extraction (exported for tests) ───────────────────

/**
 * Every absolute http(s) URL literally present in a document's markup —
 * href="...", src="...", any data-* attribute, and a string literal inside an
 * inline <script> block — plus a protocol-relative `"//host/path"` (common in
 * embedded widget snippets), resolved against `baseUrl`'s scheme.
 *
 * Deliberately ONE pass over the raw text rather than separate attribute-name
 * and script-body extraction: attribute values and JS string literals are both
 * just "a URL-shaped run of characters between matching quotes" in the raw
 * markup, and `data-*` is open-ended (there is no fixed list of attribute
 * names to special-case), so scanning for the URL SHAPE itself covers every
 * case in one regex instead of drifting per attribute.
 *
 * @param {string} html
 * @param {string} [baseUrl] Used only to resolve a protocol-relative match's scheme.
 * @returns {string[]} Deduped, capped at MAX_CANDIDATE_URLS, in document order.
 */
export function extractCandidateUrls(html, baseUrl) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();

  const add = (raw) => {
    if (out.length >= MAX_CANDIDATE_URLS) return;
    // Trailing punctuation is often swept up when a URL sits at the end of a
    // sentence or is followed immediately by markup ("</p>." style content,
    // or a trailing comma in a JS array literal) — trimmed rather than left
    // to corrupt every downstream URL parse.
    const cleaned = String(raw).replace(/[),.;:!?]+$/, '');
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };

  const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
  for (const m of text.matchAll(ABSOLUTE_URL_RE)) {
    if (out.length >= MAX_CANDIDATE_URLS) break;
    add(m[0]);
  }

  // Protocol-relative: only matched INSIDE quotes (an attribute value or a JS
  // string literal), never bare in running text — a bare "//" is far more
  // likely to be a comment inside an inline <script> than a URL, and quoting
  // is exactly what distinguishes the two.
  let scheme = 'https:';
  try { if (baseUrl) scheme = new URL(baseUrl).protocol; } catch { /* keep default */ }
  const PROTOCOL_RELATIVE_RE = /["'](\/\/[^"'\s<>]+)["']/g;
  for (const m of text.matchAll(PROTOCOL_RELATIVE_RE)) {
    if (out.length >= MAX_CANDIDATE_URLS) break;
    add(`${scheme}${m[1]}`);
  }

  return out;
}

/**
 * Rewrite a fingerprinted URL to the spelling a provider's `detect()` will
 * actually claim, when its own detection regex only recognizes a NEWER host
 * spelling than what a page in the wild still embeds. The input is returned
 * unchanged whenever no rewrite applies.
 *
 * Verified against providers/lever.mjs, providers/ashby.mjs,
 * providers/smartrecruiters.mjs, providers/workable.mjs and the four
 * subdomain vendors (recruitee/breezy/bamboohr/pinpoint) — none of them
 * accept more than one host spelling for `careers_url`, so none needs this.
 * providers/greenhouse.mjs is the one exception found: `ALLOWED_GREENHOUSE_
 * HOSTS` includes the older public host `boards.greenhouse.io`, but
 * `resolveApiUrl()` — what `detect()` actually calls — only matches
 * `job-boards(.eu).greenhouse.io` in `careers_url`; `boards.greenhouse.io` is
 * accepted ONLY via an explicit `api:` field, which a fingerprinted
 * `careers_url` never carries. Most still-live embedded Greenhouse widgets
 * point at the older host, so left unrewritten every one of them would be
 * invisible to fingerprintAtsUrls even though scripts/scan/scan.mjs could scan it fine
 * once given the right careers_url.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeAtsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname.toLowerCase() === 'boards.greenhouse.io') {
    parsed.hostname = 'job-boards.greenhouse.io';
    return parsed.href;
  }
  return url;
}

/** Lowercased, trailing-slash-stripped pathname; empty path normalizes to '/'. */
function normalizedPath(pathname) {
  const stripped = String(pathname || '').toLowerCase().replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

const CAREERS_WORD_RE = /^(?:careers?|jobs?)$/;
const CAREERS_TEXT_RE = /\b(?:careers?|jobs?)\b/i;
const ANCHOR_RE = new RegExp(
  '<a\\b[^>]*?href\\s*=\\s*(["\'])'
  + `([^"']{0,${MAX_ANCHOR_HREF_CHARS}})`
  + '\\1[^>]*>'
  + `([\\s\\S]{0,${MAX_ANCHOR_INNER_CHARS}}?)`
  + '<\\/a\\s*>',
  'gi',
);
const STRIP_TAGS_RE = /<[^>]*>/g;

/**
 * Same-origin candidate careers-page URLs found on a homepage (or any page),
 * ranked best-first:
 *   tier 0 — the href's path is EXACTLY `/careers` or `/jobs` (one segment).
 *   tier 1 — the href's path ENDS in `/careers` or `/jobs` but has more
 *            segments (e.g. `/about/careers`).
 *   tier 2 — neither, but the anchor's visible TEXT mentions "career(s)" or
 *            "job(s)" (e.g. text "Careers" linking to `/join-us`).
 * Capped at MAX_CAREERS_LINKS. mailto:/javascript:/tel:/etc. and CROSS-ORIGIN
 * links are rejected outright — including a cross-origin link straight to a
 * known ATS host, which is a resolution in itself and is picked up by running
 * `fingerprintAtsUrls` over the page's own `extractCandidateUrls` output
 * instead (see `resolveOne`), not by this function.
 *
 * @param {string} html
 * @param {string} baseUrl Absolute URL the page was fetched from.
 * @returns {string[]}
 */
export function findCareersLinks(html, baseUrl) {
  const text = String(html || '');
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  /** @type {{url: string, tier: number, order: number}[]} */
  const found = [];
  let scanned = 0;
  for (const m of text.matchAll(ANCHOR_RE)) {
    if (scanned >= MAX_ANCHORS_SCANNED) break;
    scanned += 1;

    const hrefRaw = decodeEntities(m[2]).trim();
    if (!hrefRaw) continue;
    const explicitScheme = hrefRaw.match(/^([a-z][a-z0-9+.-]*):/i);
    if (explicitScheme && !/^https?$/i.test(explicitScheme[1])) continue; // mailto:, javascript:, tel:, ...

    let resolved;
    try {
      resolved = new URL(hrefRaw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (resolved.hostname !== base.hostname) continue; // cross-origin — not this function's job

    const path = normalizedPath(resolved.pathname);
    const segments = path.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';

    let tier;
    if (segments.length === 1 && CAREERS_WORD_RE.test(last)) {
      tier = 0;
    } else if (CAREERS_WORD_RE.test(last)) {
      tier = 1;
    } else {
      const innerText = decodeEntities(m[3].replace(STRIP_TAGS_RE, ' ')).trim();
      if (CAREERS_TEXT_RE.test(innerText)) tier = 2;
      else continue;
    }

    found.push({ url: resolved.href, tier, order: found.length });
  }

  found.sort((a, b) => a.tier - b.tier || a.order - b.order);
  const out = [];
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    out.push(f.url);
    if (out.length >= MAX_CAREERS_LINKS) break;
  }
  return out;
}

/**
 * Which ATS vendor(s), if any, a page's own markup fingerprints — found by
 * running every absolute URL on the page through the SAME provider registry
 * scripts/scan/scan.mjs uses, and keeping the ones whose own `detect()` claims them.
 * See the module header for why this beats hand-written per-vendor regexes.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {{providers: Map<string, object>}} opts `providers` is the id→provider
 *   Map from `providers/_registry.mjs`'s `loadProviders()` (or an injected fake
 *   Map for tests — the whole point of taking it as a parameter).
 * @returns {{url: string, providerId: string}[]} Best-first (document order),
 *   deduped by providerId — one candidate per vendor is enough; confirming
 *   liveness is a separate, later step.
 */
export function fingerprintAtsUrls(html, baseUrl, { providers } = {}) {
  const registry = providers instanceof Map ? providers : new Map();
  const candidates = extractCandidateUrls(html, baseUrl);
  /** @type {{url: string, providerId: string}[]} */
  const hits = [];
  const claimed = new Set();

  for (const raw of candidates) {
    if (claimed.size === registry.size && registry.size > 0) break; // every known vendor already has its best candidate
    const url = normalizeAtsUrl(raw);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    const entry = { name: '', careers_url: url };
    for (const provider of registry.values()) {
      if (!provider || typeof provider.id !== 'string' || claimed.has(provider.id)) continue;
      let hit;
      try {
        hit = provider.detect?.(entry);
      } catch {
        continue; // a misbehaving detect() disqualifies this candidate for this vendor, not the whole run
      }
      if (hit) {
        hits.push({ url, providerId: provider.id });
        claimed.add(provider.id);
        break; // this URL is spoken for; move on to the next candidate
      }
    }
  }

  return hits;
}

const SUBDOMAIN_ATS_SUFFIXES = ['.recruitee.com', '.breezy.hr', '.bamboohr.com', '.pinpointhq.com'];

/**
 * Best-effort DISPLAY slug for a resolved match — cosmetic only, never used to
 * construct a probe URL (that would be exactly the slug-guessing this module
 * exists to avoid; liveness is always confirmed against the discovered URL
 * itself, see `confirmLive`). Subdomain vendors report the subdomain label;
 * path vendors report the last path segment, skipping a trailing literal
 * "jobs" segment (rippling's `<slug>/jobs` shape) so the reported slug is the
 * tenant, not the word "jobs".
 * @param {string} url
 * @returns {string}
 */
function guessDisplaySlug(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  if (SUBDOMAIN_ATS_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return host.split('.')[0];
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length > 1 && segments[segments.length - 1].toLowerCase() === 'jobs') {
    return segments[segments.length - 2];
  }
  return segments[segments.length - 1] || '';
}

/**
 * Build the ResolvedMatch record for a confirmed-live fingerprint hit — the
 * same shape scripts/scan/discover-ats.mjs emits, so it can be promoted into portals.yml
 * by hand exactly the way a discover-ats.mjs hit is.
 *
 * Pure: takes the already-confirmed `jobCount` rather than fetching anything
 * itself (network/liveness is `resolveOne`'s and `confirmLive`'s job).
 *
 * @param {{name: string}} company
 * @param {{url: string, providerId: string}} hit
 * @param {number|null} jobCount Confirmed job count, or null when the source
 *   is a discovered jobs feed whose contents the two-hop cap forbids fetching
 *   to count (see `resolveOne`'s generic-careers fallback).
 * @returns {{name: string, vendor: string, slug: string, careers_url: string, jobCount: number|null, api?: string, provider?: string}}
 */
export function buildResolvedEntry(company, hit, jobCount) {
  const name = company?.name || '';
  const url = normalizeAtsUrl(hit.url);
  /** @type {any} */
  const resolved = {
    name,
    vendor: hit.providerId,
    slug: '',
    careers_url: url,
    jobCount: jobCount === undefined ? null : jobCount,
  };

  if (hit.providerId === 'workday') {
    const coords = parseWorkdayHint({ careers_url: url });
    resolved.slug = coords ? coords.tenant : guessDisplaySlug(url);
    // Mirrors discover-ats.mjs's renderPortalEntry: Workday always gets an
    // explicit provider: line (its detect() keys off the myworkdayjobs.com
    // host, but pinning it is unambiguous and matches how provider-specific
    // entries are written elsewhere in portals.yml).
    resolved.provider = 'workday';
  } else if (hit.providerId === 'generic-careers') {
    resolved.slug = deriveSlug(name);
    resolved.provider = 'generic-careers';
  } else {
    resolved.slug = guessDisplaySlug(url);
    if (hit.providerId === 'greenhouse') {
      // The one piece of vendor URL-shape knowledge this module carries by
      // design (see normalizeAtsUrl above) — reused here so a promoted entry
      // gets the same api: line scripts/scan/discover-ats.mjs would have written.
      const m = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
      if (m) resolved.api = `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs`;
    }
  }

  return resolved;
}

// ── Pure functions: robots.txt (exported for tests) ─────────────────────────

/**
 * Minimal robots.txt parser: `User-agent:` groups and `Disallow:` prefixes
 * only. `Allow:`, `Crawl-delay:`, `Sitemap:` and every other field are
 * intentionally ignored — this crawler makes at most two requests per host
 * per company and has no use for them. Comments (`#...`) and blank lines are
 * stripped; consecutive `User-agent:` lines before the first directive share
 * one group, matching the standard robots.txt grouping rule.
 *
 * @param {string} text
 * @returns {{agents: string[], disallow: string[]}[]}
 */
export function parseRobotsRules(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  /** @type {{agents: string[], disallow: string[]}[]} */
  const groups = [];
  /** @type {string[]} */
  let pendingAgents = [];
  /** @type {{agents: string[], disallow: string[]}|null} */
  let activeGroup = null;

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === 'user-agent') {
      if (activeGroup) {
        // A directive has already been seen for the current group — a new
        // User-agent line starts a FRESH group rather than extending it.
        pendingAgents = [];
        activeGroup = null;
      }
      pendingAgents.push(value.toLowerCase());
    } else if (field === 'disallow') {
      if (!activeGroup) {
        activeGroup = { agents: pendingAgents.length ? pendingAgents.slice() : ['*'], disallow: [] };
        groups.push(activeGroup);
      }
      if (value) activeGroup.disallow.push(value); // an empty Disallow: means "nothing blocked" — no prefix to add
    }
  }
  return groups;
}

/**
 * Is `pathname` allowed under the `User-agent: *` group(s) of already-parsed
 * robots rules? Only the wildcard group is consulted — this crawler's
 * User-Agent (`lib/user-agent.mjs`'s `DEFAULT_USER_AGENT`) names no token a
 * site's robots.txt would target specifically, so a named-agent group can
 * never be the more specific match here the way it could for a real named
 * bot.
 *
 * @param {{agents: string[], disallow: string[]}[]} groups
 * @param {string} pathname
 * @returns {boolean}
 */
export function isPathAllowedByRobots(groups, pathname) {
  const path = String(pathname || '/');
  const rules = (Array.isArray(groups) ? groups : [])
    .filter((g) => g && Array.isArray(g.agents) && g.agents.includes('*'))
    .flatMap((g) => g.disallow || []);
  return !rules.some((prefix) => path.startsWith(prefix));
}

// ── Pure function: output envelope (exported for tests) ────────────────────

/**
 * The stdout JSON shape — identical to scripts/scan/discover-ats.mjs's envelope so the
 * discovery node's existing consumption code (`if (result.ok)` on exit code
 * alone) works unmodified. `previewOnly` is always true: this script never
 * writes portals.yml and has no code path that could set it false.
 *
 * @param {{resolved: any[], unresolved: any[], warnings?: string[]}} results
 * @returns {{metadata: {resolved: number, unresolved: number, previewOnly: true, warnings: string[]}, resolved: any[], unresolved: any[]}}
 */
export function buildEnvelope({ resolved, unresolved, warnings } = {}) {
  const resolvedList = Array.isArray(resolved) ? resolved : [];
  const unresolvedList = Array.isArray(unresolved) ? unresolved : [];
  return {
    metadata: {
      resolved: resolvedList.length,
      unresolved: unresolvedList.length,
      previewOnly: true,
      warnings: Array.isArray(warnings) ? warnings : [],
    },
    resolved: resolvedList,
    unresolved: unresolvedList,
  };
}

// ── Impure: liveness confirmation ───────────────────────────────────────────

/**
 * Confirm a fingerprint hit actually lists >=1 job, returning the count (or
 * `null` when confirmation itself failed — a transient network error, not an
 * answer). Never guesses: every request here is made against the EXACT
 * discovered URL, not a reconstructed one.
 *
 * Workday alone is confirmed via scripts/scan/discover-ats.mjs's own `parseWorkdayHint`
 * + `resolveWorkday` (discover-ats.mjs:325-352, :528-573): coordinates read
 * straight out of the already-discovered URL (deterministic, not a guess),
 * and `resolveWorkday`'s probe caps itself to a single CXS page instead of
 * paginating an entire tenant just to learn "is this live".
 *
 * Every other vendor is confirmed by calling ITS OWN `provider.fetch()`
 * directly, rather than through discover-ats.mjs's `resolveCompany` /
 * `buildCandidateUrls`. That path always derives its probe URL from
 * `company.slug || deriveSlug(company.name)` — routing through it here would
 * silently re-guess a slug for a company whose real slug the fingerprint
 * already proved ISN'T derivable from its name, which is exactly the bug
 * this script exists to fix. Calling the matched provider's `fetch()` on the
 * URL `fingerprintAtsUrls` already had that SAME provider's `detect()`
 * confirm is not a guess — it is the identical request scripts/scan/scan.mjs would make
 * for this entry once promoted into portals.yml.
 *
 * @param {{name: string}} company
 * @param {{url: string, providerId: string}} hit
 * @param {{ctx: object, providers: Map<string, object>}} deps
 * @returns {Promise<number|null>}
 */
export async function confirmLive(company, hit, { ctx, providers } = {}) {
  if (!ctx) return null;

  if (hit.providerId === 'workday') {
    const coords = parseWorkdayHint({ careers_url: hit.url });
    if (!coords) return null;
    let result;
    try {
      result = await resolveWorkday({ name: company?.name || '' }, coords, ctx);
    } catch {
      return null;
    }
    if (result?.resolved) return result.resolved.jobCount;
    return result?.status === 'empty' ? 0 : null;
  }

  const provider = providers instanceof Map ? providers.get(hit.providerId) : null;
  if (!provider || typeof provider.fetch !== 'function') return null;
  try {
    const jobs = await provider.fetch({ name: company?.name || '', careers_url: hit.url }, ctx);
    return Array.isArray(jobs) ? jobs.length : 0;
  } catch {
    return null;
  }
}

// ── Impure: one company end to end ──────────────────────────────────────────

/**
 * Resolve a company that has no website at all, by slug probe alone.
 *
 * Delegates wholesale to scripts/scan/discover-ats.mjs's `resolveCompany`, which
 * probes VENDOR_ORDER's eleven slug-derivable vendors and confirms a board is
 * live before claiming it. Its `resolved` record is already the exact
 * ResolvedMatch shape this script's own envelope emits, so nothing is remapped.
 *
 * The one thing added: a top-level `definitive` flag when EVERY probe error was
 * a definitive absence (404/410). The caller — the discovery node — reads that
 * to decide `dead` versus `retry with backoff`, and a 5xx or a timeout must
 * never be mistaken for proof that a company has no board (discover-ats.mjs's
 * `isDefinitiveAbsence`, and the #2883 comment above it). One transient failure
 * among the errors is enough to leave the question open.
 *
 * @param {{name: string}} company
 * @param {{ctx: object}} deps
 * @returns {Promise<{resolved: object}|{unresolved: object}>}
 */
export async function slugProbeOnly(company, { ctx } = {}) {
  if (!ctx) {
    return { unresolved: { name: company?.name || '', reason: 'no HTTP transport supplied — nothing was probed' } };
  }
  const out = await resolveCompany(company, { ctx });
  if (out?.resolved) return out;
  const unresolved = { ...(out?.unresolved || { name: company?.name || '', reason: 'probe failed' }) };
  const errors = Array.isArray(unresolved.errors) ? unresolved.errors : [];
  // A LIVE BOARD THAT LISTS NOTHING TODAY IS THE OPPOSITE OF PROOF OF ABSENCE.
  // resolveCompany reports it separately as `emptyBoards`, with its own reason
  // ("board(s) found but currently list 0 jobs — re-run later"), and the common
  // real shape is exactly one live-but-empty vendor plus a 404 from each of the
  // other ten — where looking only at `errors` says "every probe was a
  // definitive 404" and retires a company that has a real careers board and
  // will post on it next week. The node reads this flag straight into
  // recordResolution's `dead` branch, which dueCandidates never offers again.
  const emptyBoards = Array.isArray(unresolved.emptyBoards) ? unresolved.emptyBoards : [];
  if (emptyBoards.length === 0 && errors.length > 0 && errors.every(isDefinitiveAbsence)) {
    unresolved.definitive = true;
  }
  return { unresolved };
}

/**
 * Resolve one company by crawling its own website (homepage, then at most one
 * careers-page follow — the hard two-hop depth cap) and fingerprinting the
 * ATS vendor out of whichever page's markup carries it.
 *
 * @param {{name: string, website?: string}} company
 * @param {{ctx?: object, fetchText: (url: string) => Promise<string>, providers?: Map<string, object>}} deps
 *   `fetchText` is the ONLY network seam — inject a fake in tests to drive
 *   the whole flow offline. In production it is `createCrawlFetcher(...)`'s
 *   return value: robots-checked, paced, SSRF-guarded, byte-bounded.
 * @returns {Promise<{resolved: any}|{unresolved: any}>}
 */
export async function resolveOne(company, { ctx, fetchText, providers } = {}) {
  const name = company?.name || '';
  const website = typeof company?.website === 'string' ? company.website.trim() : '';
  if (!website) {
    // A NAME WITH NO DOMAIN IS THE COMMON CASE, NOT AN EDGE CASE. The
    // discovery node's default source is funding announcements
    // (scripts/scan/company-funded.mjs), which yield a company name and an
    // article URL and never the company's own domain — and inventing one from
    // the name is precisely the mistake this script exists to avoid. Returning
    // "nothing to crawl" here would make every funding-derived candidate
    // permanently unresolvable: it would back off on the frontier's schedule
    // and die `exhausted` without a single board ever having been probed.
    //
    // So fall back to what discover-ats.mjs already does well — probe the
    // eleven slug-derivable vendors. Note this is the OPPOSITE choice from
    // confirmLive() below, which deliberately avoids resolveCompany because it
    // re-derives a slug from the name. That matters when a fingerprint already
    // proved the real slug; here there is no fingerprint and no website, so a
    // derived slug is the only thing there is to try.
    return slugProbeOnly(company, { ctx });
  }

  let homepageUrl;
  try {
    const withScheme = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    homepageUrl = new URL(withScheme).href;
  } catch {
    return { unresolved: { name, reason: `invalid website URL: ${website}`, website } };
  }

  if (typeof fetchText !== 'function') {
    return { unresolved: { name, reason: 'no fetchText transport supplied — nothing was fetched', website } };
  }
  const registry = providers instanceof Map ? providers : new Map();

  // Hop 1: the homepage.
  let homepageHtml;
  try {
    homepageHtml = await fetchText(homepageUrl);
  } catch (err) {
    return { unresolved: { name, reason: `could not fetch homepage: ${err?.message || err}`, website } };
  }

  let hit = fingerprintAtsUrls(homepageHtml, homepageUrl, { providers: registry })[0] || null;
  let sourceUrl = homepageUrl;
  let sourceHtml = homepageHtml;

  // Hop 2: AT MOST ONE careers-page follow — the hard depth cap the module
  // header documents. findCareersLinks already ranks best-first; taking only
  // its top candidate is what keeps this "homepage + careers page", not an
  // unbounded fan-out across every plausible link a homepage carries.
  if (!hit) {
    const [bestLink] = findCareersLinks(homepageHtml, homepageUrl);
    if (bestLink) {
      try {
        const careersHtml = await fetchText(bestLink);
        sourceUrl = bestLink;
        sourceHtml = careersHtml;
        hit = fingerprintAtsUrls(careersHtml, bestLink, { providers: registry })[0] || null;
      } catch {
        // Careers page unreachable (robots, network, timeout) — fall through
        // to the homepage's own HTML for the structured-data fallback below
        // rather than giving up outright.
      }
    }
  }

  if (hit) {
    const jobCount = await confirmLive(company, hit, { ctx, providers: registry });
    if (jobCount === null) {
      return {
        unresolved: {
          name,
          reason: `found a ${hit.providerId} board at ${hit.url} but could not confirm it is live — re-run`,
          website,
        },
      };
    }
    if (jobCount === 0) {
      return {
        unresolved: {
          name,
          reason: `found a ${hit.providerId} board at ${hit.url} but it currently lists 0 jobs — re-run later`,
          website,
        },
      };
    }
    return { resolved: buildResolvedEntry(company, hit, jobCount) };
  }

  // No known ATS vendor claimed anything on either page. Fall back to
  // schema.org JobPostings on whichever page was actually reached — no extra
  // fetch, the HTML is already in hand.
  let postings = [];
  try {
    postings = collectJobPostings(sourceHtml);
  } catch {
    postings = [];
  }
  if (postings.length > 0) {
    return { resolved: buildResolvedEntry(company, { url: sourceUrl, providerId: 'generic-careers' }, postings.length) };
  }

  // ...or an autodiscovered jobs feed. The import stays lazy and guarded: this
  // is a FALLBACK path, reached only when no ATS claimed the page and no
  // JSON-LD was found, and a failure to load the feed helper should cost this
  // one candidate its feed check rather than the whole batch its run.
  let discoverFeedUrls = null;
  try {
    const mod = await import('../../providers/generic-careers.mjs');
    if (typeof mod.discoverFeedUrls === 'function') discoverFeedUrls = mod.discoverFeedUrls;
  } catch {
    discoverFeedUrls = null;
  }
  if (discoverFeedUrls) {
    let feeds = [];
    try {
      feeds = discoverFeedUrls(sourceHtml, sourceUrl) || [];
    } catch {
      feeds = [];
    }
    if (Array.isArray(feeds) && feeds.length > 0) {
      // jobCount is left null (see buildResolvedEntry's doc): fetching the
      // feed to count entries would be a THIRD hop, which the depth cap
      // forbids. Discovering the source is the win here — a subsequent real
      // scan (once promoted into portals.yml) reports the real count.
      return { resolved: buildResolvedEntry(company, { url: sourceUrl, providerId: 'generic-careers' }, null) };
    }
  }

  return {
    unresolved: {
      name,
      reason: 'no known ATS embed, JobPosting structured data, or jobs feed found on the homepage or careers page',
      website,
    },
  };
}

// ── Impure: crawl transport (robots + pacing + bounded, SSRF-guarded fetch) ─

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the `fetchText` seam `resolveOne` expects: per-host paced, robots.txt-
 * respecting, byte-bounded, SSRF-guarded (via `providers/_http.mjs` — see the
 * module header for why that guard over `autopilot/lib/url-guard.mjs`).
 *
 * Every knob is injectable so this is still testable without a real clock or
 * network — resolve-careers.mjs's own tests instead drive `resolveOne`
 * directly with a fake `fetchText`, which is the documented seam for that;
 * this function is exercised by the pure `parseRobotsRules`/
 * `isPathAllowedByRobots` tests plus a light integration test with fakes for
 * `fetchTextRaw`/`sleep`/`now`.
 *
 * @param {object} [opts]
 * @param {(url: string, opts: object) => Promise<string>} [opts.fetchTextRaw] Low-level transport; default providers/_http.mjs's fetchTextHead.
 * @param {number} [opts.hostGapMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {(url: string) => Promise<string>}
 */
export function createCrawlFetcher({
  fetchTextRaw = fetchTextHead,
  hostGapMs = DEFAULT_HOST_GAP_MS,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  /** @type {Map<string, {agents: string[], disallow: string[]}[]>} */
  const robotsCache = new Map();
  /** @type {Map<string, number>} */
  const lastFetchAt = new Map();

  async function pace(host) {
    const last = lastFetchAt.get(host);
    if (last !== undefined) {
      const wait = hostGapMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    lastFetchAt.set(host, now());
  }

  async function robotsGroupsFor(origin, host) {
    if (robotsCache.has(host)) return robotsCache.get(host);
    let groups = [];
    try {
      await pace(host);
      const text = await fetchTextRaw(`${origin}/robots.txt`, {
        timeoutMs: ROBOTS_TIMEOUT_MS,
        maxBytes: MAX_ROBOTS_BYTES,
        headers: { 'user-agent': DEFAULT_USER_AGENT },
      });
      groups = parseRobotsRules(text);
    } catch {
      groups = []; // no robots.txt, or it failed to fetch — the conservative default every crawler uses: nothing is blocked
    }
    robotsCache.set(host, groups);
    return groups;
  }

  return async function fetchCareersPage(url) {
    let current = String(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(current); // a malformed URL is the caller's bug, not ours to guess at — let it throw
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`resolve-careers: refusing non-http(s) scheme: ${parsed.protocol}`);
      }
      // EVERY hop is re-guarded, not just the first — that is the whole point
      // of walking them by hand. A redirect onto another host gets that host's
      // own robots.txt and its own pacing slot, exactly as if the crawler had
      // been pointed at it directly. Mirrors the per-hop discipline in
      // autopilot/lib/liveness-sweep.mjs and lib/jd.mjs.
      // Keyed on `host`, not `hostname`: the port is part of the origin, so
      // example.com and example.com:8443 serve different robots.txt files and
      // deserve their own pacing clocks. A redirect hop onto another port would
      // otherwise reuse the first one's rules and slot.
      const groups = await robotsGroupsFor(`${parsed.protocol}//${parsed.host}`, parsed.host);
      if (!isPathAllowedByRobots(groups, parsed.pathname || '/')) {
        throw new Error(`resolve-careers: blocked by robots.txt: ${current}`);
      }
      await pace(parsed.host);
      try {
        return await fetchTextRaw(current, {
          timeoutMs: PAGE_TIMEOUT_MS,
          maxBytes: MAX_PAGE_BYTES,
          redirect: 'manual',
          headers: { 'user-agent': DEFAULT_USER_AGENT },
        });
      } catch (err) {
        // Under redirect:'manual' a 3xx arrives as a non-ok response, which
        // providers/_http.mjs raises with `.status` and `.location` attached.
        // Anything else — a 404, a timeout, a refused connection — is a real
        // answer or a real failure and propagates untouched.
        const status = Number(err?.status);
        const location = err?.location;
        if (!(status >= 300 && status < 400) || !location) throw err;
        let next;
        try { next = new URL(String(location), current).toString(); } catch { throw err; }
        current = next;
      }
    }
    throw new Error(`resolve-careers: too many redirects (>${MAX_REDIRECTS}) starting at ${url}`);
  };
}

/** Bounded-concurrency map. Mirrors scripts/scan/discover-ats.mjs's own (unexported) parallelEach — a
 * generic ~10-line helper duplicated the same way across this codebase's scan
 * scripts (see discover-ats.mjs's comment on its own copy) rather than
 * elevated to a shared module for something this small. */
async function parallelEach(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// ── Self-test (pure, no network) ────────────────────────────────────────────

function runSelfTest() {
  let passCount = 0;
  let failCount = 0;
  const check = (cond, label) => {
    if (cond) passCount += 1;
    else { failCount += 1; console.error(`  FAIL: ${label}`); }
  };

  check(normalizeAtsUrl('https://boards.greenhouse.io/acme') === 'https://job-boards.greenhouse.io/acme', 'normalizeAtsUrl rewrites the legacy Greenhouse host');
  check(normalizeAtsUrl('https://job-boards.greenhouse.io/acme') === 'https://job-boards.greenhouse.io/acme', 'normalizeAtsUrl leaves a canonical URL alone');
  check(normalizeAtsUrl('https://jobs.lever.co/acme') === 'https://jobs.lever.co/acme', 'normalizeAtsUrl leaves an unrelated vendor alone');

  const html = '<a href="/careers">Work with us</a> <a href="/about/careers">About</a> <a href="/join">Careers team</a> <a href="mailto:hr@acme.com">Email HR</a> <a href="https://evil.example.com/careers">Off-site</a>';
  const links = findCareersLinks(html, 'https://acme.com/');
  check(links[0] === 'https://acme.com/careers', 'findCareersLinks ranks the exact /careers path first');
  check(links[1] === 'https://acme.com/about/careers', 'findCareersLinks ranks a suffix match second');
  check(links[2] === 'https://acme.com/join', 'findCareersLinks ranks a text-only match third');
  check(links.length === 3, 'findCareersLinks drops mailto: and cross-origin links');

  const candHtml = '<iframe src="https://job-boards.greenhouse.io/acme"></iframe><script>var w="https://jobs.ashbyhq.com/acme-inc";</script>';
  const cands = extractCandidateUrls(candHtml, 'https://acme.com/');
  check(cands.includes('https://job-boards.greenhouse.io/acme'), 'extractCandidateUrls finds an iframe src');
  check(cands.includes('https://jobs.ashbyhq.com/acme-inc'), 'extractCandidateUrls finds a URL inside an inline script string literal');

  const wdHtml = '<iframe src="https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers"></iframe>';
  const wdCands = extractCandidateUrls(wdHtml, 'https://acme.com/');
  check(wdCands.some((u) => u.includes('acme.wd5.myworkdayjobs.com') && u.includes('AcmeCareers')), 'extractCandidateUrls extracts a Workday embed intact');

  const robots = 'User-agent: *\nDisallow: /careers/internal\nDisallow: /private\n\nUser-agent: SomeBot\nDisallow: /\n';
  const groups = parseRobotsRules(robots);
  check(isPathAllowedByRobots(groups, '/careers'), 'robots parser allows an un-listed path under the * group');
  check(!isPathAllowedByRobots(groups, '/private/x'), 'robots parser disallows a Disallow-prefixed path');
  check(!isPathAllowedByRobots(groups, '/careers/internal/x'), 'robots parser disallows a sub-path of a Disallow prefix');

  const env = buildEnvelope({ resolved: [{ name: 'A' }], unresolved: [{ name: 'B', reason: 'x' }], warnings: ['w'] });
  check(env.metadata.resolved === 1 && env.metadata.unresolved === 1 && env.metadata.previewOnly === true, 'buildEnvelope metadata shape');

  console.log(`\n  resolve-careers self-test: ${passCount} passed, ${failCount} failed\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

// ── CLI ──────────────────────────────────────────────────────────────────

// KEEP IN STEP WITH buildScannerCommand('resolve', …) in
// autopilot/lib/discovery-node.mjs. The discovery node spawns this script with
// whatever argv that function builds, and validateFlags() below EXITS 1 on an
// unrecognized flag — so a flag added there and not here does not degrade, it
// kills the job on every run. `--host-gap-ms` shipped that way: the daemon
// passed it, this list did not have it, and the resolve job would have exited 1
// every time under the shipped example config. tests/discovery-node-jobs.test.mjs
// now feeds each built argv through the target script's own validator.
const KNOWN_FLAGS = ['--in', '--concurrency', '--host-gap-ms', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--in', '--concurrency', '--host-gap-ms'];

function printSummary({ resolved, unresolved }) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Careers-page ATS resolver — career-ops');
  console.log(`  resolved: ${resolved.length} | unresolved: ${unresolved.length}`);
  console.log(`${'='.repeat(78)}\n`);
  if (resolved.length) {
    console.log('  ' + 'Company'.padEnd(24) + 'Vendor'.padEnd(16) + 'Jobs'.padEnd(7) + 'Board');
    console.log('  ' + '-'.repeat(90));
    for (const r of resolved) {
      console.log('  ' + String(r.name).slice(0, 22).padEnd(24) + String(r.vendor).padEnd(16)
        + String(r.jobCount ?? '?').padEnd(7) + r.careers_url);
    }
    console.log('');
  }
  if (unresolved.length) {
    console.log('  Unresolved:');
    for (const u of unresolved) console.log(`    - ${u.name}${u.website ? ` [${u.website}]` : ''}: ${u.reason}`);
    console.log('');
  }
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  if (hasFlag(args, '--self-test')) runSelfTest();

  let rawYaml = '';
  const inPath = flagValue(args, '--in');
  if (inPath) {
    const path = resolve(process.cwd(), inPath);
    if (!existsSync(path)) {
      console.error(`Error: input file not found: ${inPath}`);
      process.exit(1);
    }
    rawYaml = readFileSync(path, 'utf-8');
  }

  // Positional args (not flags, not a consumed flag value) are bare company
  // names — mirrors scripts/scan/discover-ats.mjs's own parseArgs. Indices, not
  // `indexOf`, because indexOf would resolve every occurrence of a repeated
  // token to its FIRST position, silently keeping a later duplicate that sits
  // right after a value-flag.
  const consumedValueIndices = new Set();
  args.forEach((a, idx) => {
    if (VALUE_FLAGS.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumedValueIndices.add(idx + 1);
    }
  });
  const names = args.filter((a, idx) => !a.startsWith('-') && !consumedValueIndices.has(idx));
  const { companies, warnings } = parseCompanyInput(rawYaml, names);

  const summary = hasFlag(args, '--summary');
  if (companies.length === 0) {
    const out = buildEnvelope({ resolved: [], unresolved: [], warnings });
    if (summary) printSummary(out);
    else console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const providers = await loadProviders(join(REPO_ROOT, 'providers'));
  const ctx = makeHttpCtx();
  const hostGapMs = safeIntFlag(flagValue(args, '--host-gap-ms'), DEFAULT_HOST_GAP_MS);
  const fetchText = createCrawlFetcher({ hostGapMs });
  const concurrency = safeIntFlag(flagValue(args, '--concurrency'), DEFAULT_CONCURRENCY);

  /** @type {any[]} */
  const resolved = [];
  /** @type {any[]} */
  const unresolved = [];
  await parallelEach(companies, Math.max(1, concurrency), async (company) => {
    const result = await resolveOne(company, { ctx, fetchText, providers });
    if (result.resolved) resolved.push(result.resolved);
    else unresolved.push(result.unresolved);
  });

  const out = buildEnvelope({ resolved, unresolved, warnings });
  if (summary) printSummary(out);
  else console.log(JSON.stringify(out, null, 2));
  // PREVIEW ONLY, always exit 0: the discovery node reads success off the
  // exit code alone (see scripts/scan/discover-ats.mjs's own convention, which this
  // mirrors), not off whether anything resolved.
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`resolve-careers: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
