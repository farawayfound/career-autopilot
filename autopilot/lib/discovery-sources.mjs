// @ts-check
/**
 * autopilot/lib/discovery-sources.mjs — where a discovery node hears about an
 * employer it has never scanned.
 *
 * Every source the node scanned before this file was enumerated by a human:
 * 95 tracked companies in the hub's portals.yml, 11 board providers and 75
 * local-employer names in the node's own config, and the public ATS
 * directories. Nothing generated a NEW name. This is the job that does —
 * it writes candidates into the frontier ledger
 * (autopilot/lib/discovery-frontier.mjs), which the `resolve` job then drains
 * into scannable boards.
 *
 * IT DELIBERATELY DOES NOT WALK THE VC PORTFOLIOS BY DEFAULT. The node already
 * has a `seeds` job that runs scripts/scan/scan-ats-full.mjs --seeds yc,a16z
 * every 12 hours, and YC alone is ~250 sequential HTTP round trips through the
 * public company API. Turning `vc` on here without turning `seeds` off gives
 * one box two independent full walks of the same public catalogue on
 * overlapping schedules — real duplicated network cost for the same names. The
 * default source list is `funding` alone, because that is the one this project
 * already had code for and had never once called.
 *
 * `scripts/scan/company-funded.mjs` has existed, tested, with an npm alias and
 * a --self-test, referenced by NOTHING. It reads funding-announcement RSS
 * (TechCrunch, PR Newswire, the Guardian) plus HN, filters out layoff headlines
 * that also mention a raise, and returns company names. A company that raised a
 * round last week is hiring and is not yet on anybody's job board — which is
 * precisely the posting this whole feature exists to find.
 *
 * Zero LLM calls, zero auth (AGENTS.md's hard constraint on the node). Every
 * fetcher is injectable so the tests run fully offline, and every name that
 * comes back is untrusted third-party text: DATA, never instructions.
 */

import { addCandidates, readFrontier, writeFrontier, pruneFrontier, frontierStats } from './discovery-frontier.mjs';

/**
 * The sources this job knows how to read, and whether it reads them unasked.
 *
 * @type {Record<string, {label: string, defaultOn: boolean, note: string}>}
 */
export const SOURCE_CATALOG = {
  funding: {
    label: 'Funding announcements (TechCrunch / PR Newswire / Guardian / HN)',
    defaultOn: true,
    note: 'Names only — no website. The resolver falls back to slug probing for these.',
  },
  pipeline: {
    label: 'Companies already in this node\'s own pipeline with no tracked board',
    defaultOn: true,
    note: 'Free: no network at all, just names the node has already seen go by.',
  },
  vc: {
    label: 'VC portfolios (Y Combinator, a16z)',
    defaultOn: false,
    note: 'OFF by default — the node\'s own `seeds` job already walks these. Turn this on only if you turn `seeds` off.',
  },
};

/** @returns {string[]} The source keys enabled when config names none. */
export function defaultSources() {
  return Object.keys(SOURCE_CATALOG).filter((k) => SOURCE_CATALOG[k].defaultOn);
}

/**
 * Funding-announcement candidates.
 *
 * `discoverFundedCompanies` returns a company NAME and the article that
 * mentioned it, never a website — so `website` is null here and stays null.
 * Guessing `{slug}.com` would be the exact mistake seeds/vc-portfolios.mjs's
 * toPortalEntry makes (a Greenhouse URL invented from a slug with no evidence);
 * the resolver handles a name with no domain perfectly well by falling through
 * to the 11-vendor slug probe discover-ats.mjs already does.
 *
 * @param {{months?: number, limit?: number, discover?: Function}} [opts]
 * @returns {Promise<{candidates: Array<object>, diagnostics: Array<object>}>}
 */
export async function fundingCandidates({ months = 3, limit = 40, discover = null } = {}) {
  const fn = discover || (await import('../../scripts/scan/company-funded.mjs')).discoverFundedCompanies;
  const result = await fn({ months, limit, sort: 'date' });
  const candidates = [];
  for (const c of Array.isArray(result?.companies) ? result.companies : []) {
    if (!c || typeof c.company !== 'string' || !c.company.trim()) continue;
    // The per-evidence source ('techcrunch', 'hacker_news', …) is already
    // computed; tag it so a later join can say which channel found a company
    // that eventually produced an interview.
    const via = c.funding?.sources?.[0]?.source;
    candidates.push({
      name: c.company.trim(),
      website: null,
      source: `crawl:${typeof via === 'string' && via ? via : 'funding'}`,
    });
  }
  return { candidates, diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics : [] };
}

/**
 * VC-portfolio candidates. Off by default — see the file header.
 *
 * These DO carry a website (`SeedCompany.url`), which is what lets the resolver
 * use its site-fingerprint path rather than guessing a slug. An empty url is an
 * expected partial match (a16z's second parse strategy), not a failure.
 *
 * @param {{fetchers?: Record<string, Function>}} [opts]
 * @returns {Promise<{candidates: Array<object>, diagnostics: Array<object>}>}
 */
export async function vcCandidates({ fetchers = null } = {}) {
  const sources = fetchers || (await import('../../seeds/vc-portfolios.mjs')).SEED_SOURCES;
  const candidates = [];
  const diagnostics = [];
  for (const [key, entry] of Object.entries(sources || {})) {
    const fetchFn = typeof entry === 'function' ? entry : entry?.fetch;
    if (typeof fetchFn !== 'function') continue;
    try {
      const companies = await fetchFn();
      let kept = 0;
      for (const c of Array.isArray(companies) ? companies : []) {
        if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
        candidates.push({
          name: c.name.trim(),
          website: (typeof c.url === 'string' && c.url.trim()) ? c.url.trim() : null,
          source: `crawl:${c.source || key}`,
        });
        kept += 1;
      }
      diagnostics.push({ source: key, status: 'ok', candidate_count: kept });
    } catch (err) {
      diagnostics.push({ source: key, status: 'error', candidate_count: 0, errors: [String(err?.message || err)] });
    }
  }
  return { candidates, diagnostics };
}

/**
 * Companies the node has ALREADY seen go past in its own pipeline that are not
 * on the tracked list.
 *
 * The cheapest source there is — zero network, pure re-reading of rows the
 * aggregators and board scans already produced. A company whose posting reached
 * this node via RemoteOK or a "Who is hiring" comment is a company worth
 * resolving to its own board, where every one of its OTHER openings lives.
 *
 * @param {{rows?: Array<{company?: string}>, trackedKeys?: Set<string>,
 *   keyFn: (name: string) => string, limit?: number}} opts
 * @returns {{candidates: Array<object>, diagnostics: Array<object>}}
 */
export function pipelineCandidates({ rows = [], trackedKeys = new Set(), keyFn, limit = 200 }) {
  const seen = new Set();
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = typeof row?.company === 'string' ? row.company.trim() : '';
    if (!name) continue;
    const key = keyFn(name);
    if (!key || seen.has(key) || trackedKeys.has(key)) continue;
    seen.add(key);
    candidates.push({ name, website: null, source: 'crawl:pipeline' });
    if (candidates.length >= limit) break;
  }
  return {
    candidates,
    diagnostics: [{ source: 'pipeline', status: 'ok', candidate_count: candidates.length }],
  };
}

/**
 * Run the enabled sources and fold everything they returned into the frontier.
 *
 * Never throws for a single source's sake: one dead RSS host must not cost the
 * whole pass, so a failing source is recorded as a diagnostic (the same
 * per-source health shape company-funded.mjs already uses) and the others still
 * land. Only a frontier read/write failure propagates — that one means the
 * ledger itself is broken and the caller should hear about it.
 *
 * @param {object} opts
 * @param {string} opts.frontierPath - `data/discovery-node/frontier.json`.
 * @param {string[]} [opts.sources] - Source keys; defaults to defaultSources().
 * @param {number} [opts.months] - Funding lookback window.
 * @param {number} [opts.limit] - Max funding candidates per run.
 * @param {Array<object>} [opts.pipelineRows] - Parsed rows for the `pipeline` source.
 * @param {Set<string>} [opts.trackedKeys] - Already-tracked company keys.
 * @param {(name: string) => string} [opts.keyFn] - Company-name normalizer.
 * @param {number} [opts.now] - Injected clock (tests).
 * @param {Record<string, Function>} [opts.impl] - Injected source fetchers (tests).
 * @param {boolean} [opts.dryRun] - Compute and report, write NOTHING. The
 *   daemon's `--dry-run` is documented as "no pipeline writes, no ship", and
 *   the frontier is this job's equivalent of a pipeline write.
 * @returns {Promise<{added: number, updated: number, skipped: number,
 *   diagnostics: Array<object>, stats: object, dry_run?: boolean}>}
 */
export async function runSources({
  frontierPath,
  sources = null,
  months = 3,
  limit = 40,
  pipelineRows = [],
  trackedKeys = new Set(),
  keyFn = (s) => String(s || '').toLowerCase().trim(),
  now = Date.now(),
  impl = {},
  dryRun = false,
} = {}) {
  const enabled = Array.isArray(sources) && sources.length ? sources : defaultSources();
  /** @type {Array<object>} */
  const all = [];
  /** @type {Array<object>} */
  const diagnostics = [];

  for (const key of enabled) {
    if (!Object.prototype.hasOwnProperty.call(SOURCE_CATALOG, key)) {
      diagnostics.push({ source: key, status: 'error', candidate_count: 0, errors: ['unknown source'] });
      continue;
    }
    try {
      let out = { candidates: [], diagnostics: [] };
      if (key === 'funding') {
        out = await fundingCandidates({ months, limit, discover: impl.funding || null });
      } else if (key === 'vc') {
        out = await vcCandidates({ fetchers: impl.vc || null });
      } else if (key === 'pipeline') {
        out = pipelineCandidates({ rows: pipelineRows, trackedKeys, keyFn, limit: 200 });
      }
      all.push(...out.candidates);
      diagnostics.push(...(out.diagnostics.length
        ? out.diagnostics
        : [{ source: key, status: 'ok', candidate_count: out.candidates.length }]));
    } catch (err) {
      diagnostics.push({ source: key, status: 'error', candidate_count: 0, errors: [String(err?.message || err)] });
    }
  }

  // The fold happens either way — a dry run has to report what WOULD change,
  // and addCandidates is pure over the in-memory ledger. Only the write is
  // skipped, so the on-disk file is untouched and the object dies with the
  // process.
  const frontier = readFrontier(frontierPath);
  const folded = addCandidates(frontier, all, { now });
  pruneFrontier(frontier, { now });
  if (!dryRun) writeFrontier(frontierPath, frontier);

  return {
    ...folded, diagnostics, stats: frontierStats(frontier, { now }),
    ...(dryRun ? { dry_run: true } : {}),
  };
}

/**
 * One line for the daemon log — the same shape the aggregators job reports.
 *
 * @param {{added: number, updated: number, stats: object, diagnostics: Array<object>}} result
 * @returns {string}
 */
export function summarizeSources(result) {
  const failed = (result.diagnostics || []).filter((d) => d && d.status === 'error').map((d) => d.source);
  const s = result.stats || {};
  return `${result.dry_run ? 'dry-run: ' : ''}${result.added} new, ${result.updated} seen again — frontier ${s.total ?? 0} `
    + `(${s.new ?? 0} new, ${s.resolved ?? 0} resolved, ${s.due ?? 0} due)`
    + (failed.length ? ` — failed: ${failed.join(', ')}` : '');
}
