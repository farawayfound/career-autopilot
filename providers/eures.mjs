// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EURES provider — the European Commission's job-mobility portal, which
// aggregates the national public employment services of the EU/EEA plus partner
// vacancy feeds. Reads the same public search API the portal's own page calls:
//
//   POST https://europa.eu/eures/api/jv-searchengine/public/jv-search/search
//   { resultsPerPage: <=50, page: 1.., sortSearch: "MOST_RECENT",
//     keywords: [ { keyword, specificSearchCode: "EVERYWHERE" } ],
//     publicationPeriod: "LAST_THREE_DAYS" | "LAST_WEEK" | "LAST_MONTH" | null,
//     locationCodes: ["ie", "nl"], ...empty filter arrays..., sessionId }
//   → { numberRecords, jvs: [ { id, title, description, creationDate (ms),
//       lastModificationDate, locationMap: { IE: ["IE061"] },
//       employer: { name }, translations: { en: { title, description } } } ], facets }
//
// Verified live 2026-10-15: no auth; `resultsPerPage` above 50 answers 400 "Too
// many results per page were requested"; location codes are case-insensitive;
// several `keywords` entries are ANDed (python + devops matched nothing where
// either alone matched dozens), so run an OR as separate searches; a
// `publicationPeriod` of TODAY / LAST_24_HOURS / LAST_3_DAYS answers 400.
// This is an undocumented endpoint behind the portal's own SPA, so it can
// change without notice — the response check below fails loudly rather than
// returning an empty list. europa.eu/eures/robots.txt answers 404 (no
// restriction published); the legal notice was not reviewed.
//
// The payload has no URL field. The portal's detail page is built from the id:
// https://europa.eu/eures/portal/jv-se/jv-details/<id>?lang=en
//
// Explicit-only (board-wide, needs a `searches:` matrix). Wire in via a
// `job_boards:` (or the discovery node's `boards:`) entry:
//   - { name: EURES, provider: eures, publication_period: last_week,
//       searches: [ { keywords: "platform engineer", countries: [ie, nl, fr] } ] }

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

const API_URL = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const DETAIL_BASE = 'https://europa.eu/eures/portal/jv-se/jv-details/';
const TRUSTED_HOST = 'europa.eu';

const MAX_PER_PAGE = 50; // the API's own ceiling
const DEFAULT_PAGES = 2;
const MAX_PAGES = 10;
const MAX_SEARCHES = 20;
const MAX_COUNTRIES = 40;
const MIN_GAP_MS = 1_000;
const ID_RE = /^[A-Za-z0-9_-]{4,200}$/;

const PERIODS = /** @type {Record<string, string|null>} */ ({
  last_3_days: 'LAST_THREE_DAYS',
  last_three_days: 'LAST_THREE_DAYS',
  last_week: 'LAST_WEEK',
  last_month: 'LAST_MONTH',
  any: null,
});
const DEFAULT_PERIOD = 'LAST_WEEK';

// Location strings feed location_filter, which matches the words a human wrote
// in portals.yml ("Ireland", "Netherlands"), so a bare "IE" would sail past a
// block list that spells the country out. The EURES coverage area is small, so
// the names are spelled out here rather than depending on the ICU build;
// Intl.DisplayNames is only the fallback. EL and UK are the EU's own codes for
// Greece and the United Kingdom, which ISO writes GR and GB.
const COUNTRY_NAMES = /** @type {Record<string, string>} */ ({
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', CZ: 'Czechia',
  DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France', DE: 'Germany', EL: 'Greece',
  GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LV: 'Latvia', LT: 'Lithuania',
  LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden', IS: 'Iceland', LI: 'Liechtenstein',
  NO: 'Norway', CH: 'Switzerland', UK: 'United Kingdom', GB: 'United Kingdom',
});

/** @type {Intl.DisplayNames | null | undefined} */
let regionNames;
/** @param {string} code */
function countryName(code) {
  const upper = String(code).toUpperCase();
  if (Object.hasOwn(COUNTRY_NAMES, upper)) return COUNTRY_NAMES[upper];
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }
  }
  try {
    const name = regionNames?.of(upper);
    // DisplayNames echoes an unknown code back (or says "Unknown Region").
    if (name && name !== upper && name !== 'Unknown Region') return name;
  } catch {
    // not a region code (e.g. a "NO-LOCATION" marker) → keep the raw code
  }
  return upper;
}

/** @param {string} url */
function assertEuresUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`eures: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`eures: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`eures: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
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
 * Resolve a `publication_period` value to the API's enum (or null for "no
 * limit"). Search-level wins over the entry's; an unrecognized string falls back
 * to LAST_WEEK rather than sending a value the API answers 400 to.
 * @param {unknown} searchValue
 * @param {unknown} entryValue
 * @returns {string|null}
 */
function resolvePeriod(searchValue, entryValue) {
  for (const v of [searchValue, entryValue]) {
    const key = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (key && Object.hasOwn(PERIODS, key)) return PERIODS[key];
  }
  return DEFAULT_PERIOD;
}

/**
 * Build the POST body for one search page. Exported for unit tests.
 *
 * @param {{keywords?: string|string[], countries?: string[], locations?: string[], publication_period?: string}} search
 * @param {{page?: number, perPage?: number, publication_period?: string}} [opts]
 * @returns {Record<string, unknown>}
 */
export function buildSearchBody(search, opts = {}) {
  const rawKeywords = Array.isArray(search?.keywords) ? search.keywords : [search?.keywords];
  const keywords = rawKeywords
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => ({ keyword: /** @type {string} */ (k).trim(), specificSearchCode: 'EVERYWHERE' }));
  const rawCountries = Array.isArray(search?.countries) ? search.countries : (Array.isArray(search?.locations) ? search.locations : []);
  const locationCodes = rawCountries
    .filter((c) => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c.trim()))
    .map((c) => c.trim().toLowerCase())
    .slice(0, MAX_COUNTRIES);
  return {
    resultsPerPage: clampInt(opts.perPage, 1, MAX_PER_PAGE, MAX_PER_PAGE),
    page: clampInt(opts.page, 1, 1000, 1),
    sortSearch: 'MOST_RECENT',
    keywords,
    publicationPeriod: resolvePeriod(search?.publication_period, opts.publication_period),
    occupationUris: [],
    skillUris: [],
    requiredExperienceCodes: [],
    positionScheduleCodes: [],
    sectorCodes: [],
    educationAndQualificationLevelCodes: [],
    positionOfferingCodes: [],
    locationCodes,
    euresFlagCodes: [],
    otherBenefitsCodes: [],
    requiredLanguages: [],
    minNumberPost: null,
    sessionId: 'career-ops',
  };
}

/**
 * Normalize one vacancy. Exported for unit tests.
 *
 *   - title/description: the English translation when the vacancy carries one,
 *     else the vacancy's own language (the scanner's title_filter then sees
 *     whatever the employer wrote).
 *   - url:      the portal detail page built from the id (the payload has none).
 *   - company:  `employer.name`, falling back to the portal entry's name.
 *   - location: the country names behind `locationMap`'s keys.
 *   - postedAt: `creationDate` (epoch ms). Not `lastModificationDate`: the
 *               portal's period filter keys on edits, so an old vacancy that
 *               was touched last week is still old.
 *
 * @param {any} jv
 * @param {string} [fallbackCompany]
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number} | null}
 */
export function normalizeEuresJob(jv, fallbackCompany) {
  if (!jv || typeof jv !== 'object') return null;

  const id = typeof jv.id === 'string' ? jv.id.trim() : '';
  if (!ID_RE.test(id)) return null;

  const en = jv.translations && typeof jv.translations === 'object' && Object.hasOwn(jv.translations, 'en') ? jv.translations.en : null;
  const rawTitle = typeof en?.title === 'string' && en.title.trim() ? en.title : jv.title;
  const title = typeof rawTitle === 'string' ? decodeEntities(rawTitle).replace(/\s+/g, ' ').trim() : '';
  if (!title) return null;

  const company = typeof jv.employer?.name === 'string' && jv.employer.name.trim()
    ? decodeEntities(jv.employer.name).replace(/\s+/g, ' ').trim()
    : (fallbackCompany || 'EURES');

  const codes = jv.locationMap && typeof jv.locationMap === 'object' ? Object.keys(jv.locationMap) : [];
  const location = codes.map(countryName).filter((n, i, all) => all.indexOf(n) === i).join(', ');

  const url = `${DETAIL_BASE}${id}?lang=en`;
  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
  const job = { title, url, company, location };
  const description = htmlToText(typeof en?.description === 'string' && en.description ? en.description : jv.description);
  if (description) job.description = description;
  if (Number.isFinite(jv.creationDate) && jv.creationDate > 0) job.postedAt = jv.creationDate;
  return job;
}

/** @param {any} entry */
function resolveSearches(entry) {
  const raw = Array.isArray(entry.searches) ? entry.searches : [];
  const hasKeywords = (/** @type {any} */ s) => Array.isArray(s?.keywords)
    ? s.keywords.some((/** @type {any} */ k) => typeof k === 'string' && k.trim())
    : typeof s?.keywords === 'string' && s.keywords.trim();
  const valid = raw.filter(hasKeywords).slice(0, MAX_SEARCHES);
  if (raw.length > MAX_SEARCHES) {
    console.error(`⚠️  eures: ${entry.name} configured ${raw.length} searches, keeping the first ${MAX_SEARCHES}`);
  }
  return valid;
}

/** @type {Provider} */
export default {
  id: 'eures',

  // Explicit-only: board-wide, and a useless firehose without a `searches:` list.
  detect(entry) {
    return entry?.provider === 'eures' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    const searches = resolveSearches(entry);
    if (searches.length === 0) {
      throw new Error(`eures: ${entry.name} has no usable "searches" entries (each needs non-empty "keywords")`);
    }

    let pages = clampInt(entry.max_pages ?? entry.pages, 1, MAX_PAGES, DEFAULT_PAGES);
    if (Number.isInteger(ctx.maxPages) && /** @type {number} */ (ctx.maxPages) > 0) pages = Math.min(pages, /** @type {number} */ (ctx.maxPages));
    const perPage = clampInt(entry.results_per_page, 1, MAX_PER_PAGE, MAX_PER_PAGE);
    const gapMs = Math.max(MIN_GAP_MS, Number.isFinite(entry.gap_ms) ? Number(entry.gap_ms) : MIN_GAP_MS);

    const seenIds = new Set();
    const jobs = [];
    let requestCount = 0;

    for (const search of searches) {
      for (let page = 1; page <= pages; page++) {
        if (requestCount > 0) await sleep(gapMs, ctx);
        requestCount++;

        const body = buildSearchBody(search, { page, perPage, publication_period: entry.publication_period });
        // redirect:'error' + assertEuresUrl pin every request to europa.eu.
        const json = await fetchJsonWithRetry(ctx, assertEuresUrl(API_URL), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
        }, { retries: 2 });
        if (!json || typeof json !== 'object' || !Array.isArray(/** @type {any} */ (json).jvs)) {
          throw new Error(`eures: unexpected API response — expected { jvs: [...] }, got keys: [${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}]`);
        }
        const res = /** @type {any} */ (json);

        for (const jv of res.jvs) {
          const id = typeof jv?.id === 'string' ? jv.id : '';
          if (id) {
            if (seenIds.has(id)) continue; // overlapping searches return the same vacancy
            seenIds.add(id);
          }
          const job = normalizeEuresJob(jv, entry.name);
          if (job) jobs.push(job);
        }

        // A short page is the last one; so is reaching the reported total.
        const total = Number.isFinite(res.numberRecords) ? res.numberRecords : Infinity;
        if (res.jvs.length < perPage || page * perPage >= total) break;
      }
    }
    return jobs;
  },
};
