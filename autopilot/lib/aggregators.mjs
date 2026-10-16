// Zero-token discovery beyond tracked company boards: RemoteOK, Remotive,
// WeWorkRemotely RSS, and Hacker News "Who is hiring" (direct ATS links
// harvested from comments). New finds land in data/pipeline.md exactly like
// scanner hits and are deduped against scan history / pipeline / tracker.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { p, loadYamlFile, logEvent, htmlToText, decodeEntities, todayISO } from './util.mjs';
import { writeLeadCapture, pruneLeadCaptures } from './lead-capture.mjs';

const UA = { 'user-agent': 'career-ops-autopilot (personal job search agent)' };
const TIMEOUT_MS = 20_000;

async function get(url, asJson = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return asJson ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors scripts/scan/scan.mjs compileKeyword(): short all-letter acronyms (AI, ML, SRE,
// AWS...) match on WORD BOUNDARIES, so 'AI' no longer matches 'Maintenance' and
// 'ML' no longer matches 'HTML'. Everything else stays a fast substring match.
// Kept as a local copy rather than an import because scripts/scan/scan.mjs does a
// CWD-relative mkdirSync at module scope, and this module is deliberately
// CWD-independent (see util.mjs ROOT/p()).
function compileKeyword(kw) {
  if (/^[a-z]{2,3}$/.test(kw)) {
    const re = new RegExp(`\\b${kw}\\b`);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

function normalizeKeywords(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function buildTitleFilter() {
  const tf = loadYamlFile('portals.yml')?.title_filter || {};
  const pos = normalizeKeywords(tf.positive).map(compileKeyword);
  const neg = normalizeKeywords(tf.negative).map(compileKeyword);
  return (title) => {
    const l = String(title).toLowerCase();
    return (pos.length === 0 || pos.some((m) => m(l))) && !neg.some((m) => m(l));
  };
}

// Region gate for aggregator hits. Driven by portals.yml `location_filter`
// with the SAME tier semantics as scripts/scan/scan.mjs buildLocationFilter():
// empty location passes -> always_allow (and primary/authorized/sponsor_required,
// which occupy that exact same precedence slot) wins -> block rejects -> allow
// must match. This replaces a hardcoded US-only regex that silently dropped every
// Netherlands / Ireland / UK / France posting the aggregators returned.
// No `location_filter` in portals.yml -> every location passes.
//
// `primary`/`authorized`/`sponsor_required` are the candidate's own
// three-tier location model (see scripts/scan/scan.mjs's much longer
// comment on buildLocationFilter for the full rationale — kept short here
// deliberately, since it would just be a copy). The one line that matters
// for THIS gate: a `sponsor_required` city must reach the pipeline the same
// way an `always_allow` city does, because the sponsorship judgment (does
// this specific posting actually offer to sponsor?) happens downstream in
// the autopilot's location policy, never here — an aggregator hit dropped
// at this gate never gets that judgment at all.
//
// `block_hard` is the one tier nothing overrides, and until now this gate
// did not implement it AT ALL — not an oversight of this change, it was
// never here (confirmed against origin/main). So a posting the candidate had
// hard-blocked still reached the pipeline whenever it arrived through
// aggregator ingestion rather than the scanner, which is the entire thing
// `block_hard` exists to prevent: it was added in scan.mjs precisely because
// `always_allow` could rescue a posting from `block` ("Porto" beating
// "Brazil", "Malta" beating "USA"), and a tier that is unbeatable in one
// ingestion path and absent from another is not unbeatable. Checked first
// here, exactly as in scan.mjs and in autopilot.mjs's classifyLocation.
//
// `locationFilterConfig` is a test seam only, matching the `{ files }`
// convention on loadSeenUrls() above — production callers (runAggregators,
// below) call `buildLocationFilter()` with no argument and get the real
// portals.yml `location_filter` block via the default parameter. Exported
// (it was module-private before) so a test can exercise the tier
// precedence directly against a fixture object, instead of writing a real
// portals.yml to disk to reach this function at all.
export function buildLocationFilter(locationFilterConfig = loadYamlFile('portals.yml')?.location_filter) {
  const lf = locationFilterConfig;
  if (!lf) return () => true;
  const blockHard = normalizeKeywords(lf.block_hard);
  const alwaysAllow = normalizeKeywords(lf.always_allow);
  const primary = normalizeKeywords(lf.primary);
  const authorized = normalizeKeywords(lf.authorized);
  const sponsorRequired = normalizeKeywords(lf.sponsor_required);
  const allow = normalizeKeywords(lf.allow);
  const block = normalizeKeywords(lf.block);
  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const l = location.toLowerCase();
    if (blockHard.length > 0 && blockHard.some((k) => l.includes(k))) return false;
    if (alwaysAllow.length > 0 && alwaysAllow.some((k) => l.includes(k))) return true;
    if (primary.length > 0 && primary.some((k) => l.includes(k))) return true;
    if (authorized.length > 0 && authorized.some((k) => l.includes(k))) return true;
    if (sponsorRequired.length > 0 && sponsorRequired.some((k) => l.includes(k))) return true;
    if (block.length > 0 && block.some((k) => l.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some((k) => l.includes(k));
  };
}

// `files` is a test seam only (absolute paths) — production callers pass
// nothing and get the real, shared three files.
export function loadSeenUrls({ files } = {}) {
  const seen = new Set();
  const paths = files || ['data/scan-history.tsv', 'data/pipeline.md', 'data/applications.md'].map((rel) => p(rel));
  for (const f of paths) {
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'utf-8').matchAll(/https?:\/\/[^\s|)\t]+/g)) seen.add(m[0]);
  }
  return seen;
}

// `pipelinePath`/`historyPath` are a test seam only (absolute paths) —
// production callers pass nothing and get the real, shared files.
export function appendFinds(finds, source, { pipelinePath = p('data', 'pipeline.md'), historyPath = p('data', 'scan-history.tsv') } = {}) {
  if (!finds.length) return;
  const path = pipelinePath;
  let text = existsSync(path) ? readFileSync(path, 'utf-8') : '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';
  const idx = text.indexOf('## Pendientes');
  const insertAt = idx === -1 ? text.length : (text.indexOf('\n## ', idx + 13) === -1 ? text.length : text.indexOf('\n## ', idx + 13));
  const block = '\n' + finds.map((o) => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';
  text = text.slice(0, insertAt) + block + text.slice(insertAt);
  writeFileSync(path, text, 'utf-8');
  const histPath = historyPath;
  if (!existsSync(histPath)) writeFileSync(histPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  appendFileSync(histPath, finds.map((o) => `${o.url}\t${todayISO()}\t${source}\t${o.title}\t${o.company}\tadded`).join('\n') + '\n', 'utf-8');
}

export async function fromRemoteOk(titleOk, seen, cap) {
  const data = await get('https://remoteok.com/api');
  return (Array.isArray(data) ? data.slice(1) : [])
    .filter((j) => j.position && j.url && titleOk(j.position) && !seen.has(j.url))
    .slice(0, cap)
    .map((j) => ({ url: j.url, company: j.company || 'RemoteOK', title: j.position }));
}

export async function fromRemotive(searches, titleOk, seen, cap, locationOk = () => true) {
  const out = [];
  for (const q of searches) {
    try {
      const data = await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=50`);
      for (const j of data.jobs || []) {
        if (out.length >= cap) break;
        if (!titleOk(j.title) || seen.has(j.url) || !locationOk(j.candidate_required_location)) continue;
        seen.add(j.url);
        out.push({ url: j.url, company: j.company_name || 'Remotive', title: j.title });
      }
    } catch (err) {
      logEvent('aggregator_source_error', { source: `remotive:${q}`, error: String(err.message).slice(0, 150) });
    }
  }
  return out;
}

// A WWR category slug and nothing else. The feed name is spliced into a URL
// path; anything that is not a slug (`../..`, `?x=`, a full URL) is dropped
// with an event rather than fetched, so a typo — or a dashboard PATCH — can
// never point this box's outbound request at an arbitrary path.
const WWR_FEED_RE = /^[a-z0-9-]{1,60}$/;
export const wwrFeedSlug = (feed) => (WWR_FEED_RE.test(String(feed)) ? String(feed) : null);

// A feed <description> is HTML that XML has escaped once (`&lt;p&gt;…`) or
// wrapped in CDATA. Unwrap/decode it back to HTML FIRST and only then
// htmlToText it — that helper decodes entities after stripping tags, so
// without this step the escaped tags would survive as literal `<p>` text.
function feedHtml(inner) {
  const s = String(inner || '');
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(s);
}
const tagInner = (item, tag) => (item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')) || [])[1] || '';

/**
 * The WWR items one feed body yields, pure: `{url, company, title, location,
 * postedAt, text}` per item that passes the title filter and is not already
 * seen (the caller's `seen` set is extended, as fromWwr always did). `text`
 * is the <description> as plain text — on this feed, the FULL posting — or
 * '' when the item carried none. Exported for the tests; fromWwr is the
 * network-facing caller.
 */
export function parseWwrItems(xml, { titleOk = () => true, seen = new Set(), cap = Infinity } = {}) {
  const out = [];
  for (const item of String(xml || '').split('<item>').slice(1)) {
    if (out.length >= cap) break;
    const title = htmlToText(tagInner(item, 'title'));
    const link = tagInner(item, 'link').trim();
    const [company, ...roleParts] = title.split(':');
    const role = roleParts.join(':').trim() || title;
    if (!link || !titleOk(role) || seen.has(link)) continue;
    seen.add(link);
    const pub = Date.parse(tagInner(item, 'pubDate').trim());
    out.push({
      url: link,
      company: (company || 'WWR').trim(),
      title: role,
      location: htmlToText(tagInner(item, 'region') || tagInner(item, 'category')),
      postedAt: Number.isFinite(pub) ? pub : null,
      text: htmlToText(feedHtml(tagInner(item, 'description'))),
    });
  }
  return out;
}

/**
 * WeWorkRemotely, from its category RSS feeds. The feed is the only readable
 * copy of each posting — the listing page it links to answers every plain
 * fetch with a Cloudflare challenge (403), which is how 118 WWR rows came to
 * be retired as `unfetchable` on the autopilot host without one of them ever being
 * triaged — so the <description> is kept as a lead capture
 * (lib/lead-capture.mjs) and fetchJobDetail reads it back when the page
 * refuses. `fetchText`/`writeCapture` are injectable for the tests.
 */
export async function fromWwr(feeds, titleOk, seen, cap, { fetchText = (url) => get(url, false), writeCapture = writeLeadCapture } = {}) {
  const out = [];
  let captured = 0;
  for (const feed of feeds) {
    const slug = wwrFeedSlug(feed);
    if (!slug) {
      logEvent('aggregator_source_error', { source: 'weworkremotely', error: `feed name rejected (not a category slug): ${String(feed).slice(0, 60)}` });
      continue;
    }
    try {
      const xml = await fetchText(`https://weworkremotely.com/categories/${encodeURIComponent(slug)}.rss`);
      // Captures first, for EVERY item the title filter accepts — including
      // ones already seen. A row queued before this existed (or retired as
      // `unfetchable` by an earlier cycle) is still in the feed for a while,
      // and its capture is what a re-run or a retry reads; `seen` only decides
      // which rows are NEW, below. An unchanged capture is a read, not a write.
      const captures = new Map();
      for (const item of parseWwrItems(xml, { titleOk, seen: new Set() })) {
        if (!item.text) continue;
        const w = writeCapture({ url: item.url, company: item.company, title: item.title, location: item.location, text: item.text, source: 'weworkremotely-rss', postedAt: item.postedAt });
        if (w?.written) captured++;
        captures.set(item.url, Boolean(w?.written || w?.reason === 'unchanged'));
      }
      for (const item of parseWwrItems(xml, { titleOk, seen, cap: Math.max(0, cap - out.length) })) {
        out.push({
          url: item.url, company: item.company, title: item.title, location: item.location,
          captured: captures.get(item.url) === true,
        });
      }
    } catch (err) {
      logEvent('aggregator_source_error', { source: `wwr:${feed}`, error: String(err.message).slice(0, 150) });
    }
  }
  if (captured) logEvent('aggregator_captures_written', { source: 'weworkremotely', captured });
  return out;
}

export async function fromHn(titleOk, seen, cap) {
  const search = await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5');
  const story = (search.hits || []).find((h) => /who is hiring/i.test(h.title || ''));
  if (!story) return [];
  const thread = await get(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
  const out = [];
  for (const c of thread.children || []) {
    if (out.length >= cap) break;
    const text = htmlToText(c.text || '');
    if (!/remote/i.test(text)) continue;
    const header = text.split('\n')[0].slice(0, 140);
    const company = header.split('|')[0].trim().slice(0, 60) || 'HN';
    const atsUrl = (text.match(/https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/[^\s"<)]+|https?:\/\/jobs\.lever\.co\/[^\s"<)]+|https?:\/\/jobs\.ashbyhq\.com\/[^\s"<)]+/) || [])[0];
    if (!atsUrl || seen.has(atsUrl)) continue;
    // keyword-match the whole comment (titles are unstructured on HN)
    if (!titleOk(header) && !titleOk(text.slice(0, 600))) continue;
    seen.add(atsUrl);
    out.push({ url: atsUrl, company, title: header.includes('|') ? (header.split('|')[1] || header).trim().slice(0, 90) : header });
  }
  return out;
}

// The four sources and whether each runs. `aggregators.enabled` is the switch
// the dashboard shows ("Aggregators enabled (RemoteOK, Remotive, WWR, HN)"),
// and a per-source key turns ONE source off (`remoteok: false`). A per-source
// key that is simply absent counts as on. It used to count as off: every
// source was gated on its own boolean, `enabled: true` alone ran nothing, and
// the production render — fleet.yml's defaults.aggregators never carried the
// four keys — returned 0 finds on every cycle for weeks while the toggle read
// "enabled". The dev copy of config/autopilot.yml had noted exactly that and
// fixed it locally; this makes the toggle mean what it says everywhere.
export const AGGREGATOR_SOURCES = ['remoteok', 'remotive', 'weworkremotely', 'hn_whoishiring'];
export const DEFAULT_WWR_FEEDS = [
  'remote-devops-sysadmin-jobs',
  'remote-programming-jobs',
  'remote-back-end-programming-jobs',
  'remote-full-stack-programming-jobs',
];
export const sourceEnabled = (agg, name) => Boolean(agg?.enabled) && agg?.[name] !== false;
export const wwrFeedsFor = (agg) =>
  (Array.isArray(agg?.wwr_feeds) && agg.wwr_feeds.length ? agg.wwr_feeds : DEFAULT_WWR_FEEDS);

export async function runAggregators(cfg) {
  const agg = cfg.aggregators;
  if (!agg?.enabled) return { added: 0 };
  const titleOk = buildTitleFilter();
  const locationOk = buildLocationFilter();
  const seen = loadSeenUrls();
  const cap = agg.max_new_per_source ?? 60;
  const results = {};

  const on = (name) => sourceEnabled(agg, name);
  const sources = [
    ['remoteok', () => (on('remoteok') ? fromRemoteOk(titleOk, seen, cap) : [])],
    ['remotive', () => (on('remotive') ? fromRemotive(agg.remotive_searches || ['devops'], titleOk, seen, cap, locationOk) : [])],
    ['weworkremotely', () => (on('weworkremotely') ? fromWwr(wwrFeedsFor(agg), titleOk, seen, cap) : [])],
    ['hn_whoishiring', () => (on('hn_whoishiring') ? fromHn(titleOk, seen, cap) : [])],
  ];

  let total = 0;
  for (const [name, fn] of sources) {
    try {
      const finds = await fn();
      appendFinds(finds, name);
      results[name] = finds.length;
      total += finds.length;
    } catch (err) {
      results[name] = `error: ${String(err.message).slice(0, 120)}`;
      logEvent('aggregator_source_error', { source: name, error: String(err.message).slice(0, 200) });
    }
  }
  // A capture outlives its row by weeks (a re-process months later still
  // reads it); drop the ones no feed has shown for LEAD_CAPTURE_MAX_AGE_DAYS.
  try {
    const pruned = pruneLeadCaptures();
    if (pruned) logEvent('lead_captures_pruned', { pruned });
  } catch (err) {
    logEvent('lead_captures_prune_failed', { error: String(err?.message || err).slice(0, 150) });
  }
  logEvent('aggregators_done', { total, ...results });
  return { added: total, ...results };
}
