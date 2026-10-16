#!/usr/bin/env node

/**
 * scripts/scan/company-funded.mjs - discover recently funded companies for manual review.
 *
 * V1 is intentionally narrow: it reads structured public feeds/APIs, writes a
 * report/JSON candidate list, and never probes arbitrary company websites or
 * edits portals.yml.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { isIP } from 'net';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { decodeEntities } from '../../providers/_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../../lib/user-agent.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../lib/path-resolver.mjs';
import { REPO_ROOT } from '../../lib/repo-root.mjs';

const ROOT = REPO_ROOT;
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_LIMIT = 20;
const DEFAULT_MONTHS = 3;
const DEFAULT_SORT = 'date';
const DEFAULT_SOURCES = ['techcrunch', 'prnewswire', 'guardian', 'hn'];

const RSS_SOURCES = {
  techcrunch: [
    'https://techcrunch.com/feed/',
    'https://techcrunch.com/category/startups/feed/',
    'https://techcrunch.com/tag/funding/feed/',
  ],
  prnewswire: [
    'https://www.prnewswire.com/rss/news-releases-list.rss',
    'https://www.prnewswire.com/rss/venture-capital-list.rss',
  ],
  guardian: ['https://www.theguardian.com/technology/rss'],
};

const SOURCE_HOSTS = {
  techcrunch: ['techcrunch.com'],
  prnewswire: ['prnewswire.com'],
  guardian: ['theguardian.com'],
  hacker_news: ['hn.algolia.com', 'news.ycombinator.com'],
};

const SOURCE_RANK = {
  techcrunch: 70,
  prnewswire: 65,
  guardian: 50,
  hacker_news: 35,
  web: 5,
};

const GENERIC_NAMES = new Set([
  'ai',
  'startup',
  'startups',
  'company',
  'companies',
  'founder',
  'founders',
  'developer',
  'developers',
  'edtech platform',
  'fintech platform',
  'healthcare platform',
  'security platform',
  'techcrunch',
  'pr newswire',
  'business wire',
  'globenewswire',
  'crunchbase',
  'hacker news',
  'valuation',
  'valuations',
  'bubble',
  'fears',
  'funding',
  'fund',
  'round',
]);

function usage() {
  console.log(`Usage:
  node scripts/scan/company-funded.mjs --dry-run
  node scripts/scan/company-funded.mjs --limit 25 --months 6 --sort date
  node scripts/scan/company-funded.mjs --sources techcrunch,prnewswire,guardian,hn --dry-run

Options:
  --limit <n>             Max companies in the review list. Default: 20.
  --months <n>            Recent-funding window. Default: 3.
  --sort <date|score>     Candidate ordering. Default: date.
  --sources <csv>         Sources. Default: techcrunch,prnewswire,guardian,hn.
  --dry-run               Print only; do not write report/JSON files.
  --json                  Print machine-readable JSON.
  --self-test             Run offline self-test.
`);
}

function parseArgs(argv) {
  const opts = {
    limit: DEFAULT_LIMIT,
    months: DEFAULT_MONTHS,
    sort: DEFAULT_SORT,
    sources: [...DEFAULT_SOURCES],
    dryRun: false,
    json: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--limit') opts.limit = Number(argv[++i] || '');
    else if (arg === '--months') opts.months = Number(argv[++i] || '');
    else if (arg === '--sort') opts.sort = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--sources') opts.sources = parseSources(argv[++i] || '');
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit <= 0 || opts.limit > 100) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  if (!Number.isInteger(opts.months) || opts.months <= 0 || opts.months > 120) {
    throw new Error('--months must be an integer from 1 to 120');
  }
  if (!['date', 'score'].includes(opts.sort)) {
    throw new Error('--sort must be date or score');
  }
  return opts;
}

function parseSources(value) {
  const out = String(value || '')
    .split(',')
    .map((s) => normalizeSourceName(s.trim()))
    .filter(Boolean);
  const unique = [...new Set(out)];
  const allowed = new Set(['techcrunch', 'prnewswire', 'guardian', 'hn']);
  for (const source of unique) {
    if (!allowed.has(source)) throw new Error(`unknown source in --sources: ${source}`);
  }
  return unique.length ? unique : [...DEFAULT_SOURCES];
}

function normalizeSourceName(value) {
  const s = String(value || '').toLowerCase().replace(/[_\s]+/g, '-');
  if (s === 'hacker-news' || s === 'hackernews' || s === 'hn') return 'hn';
  return s.replace(/-/g, '');
}

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function companySlug(name) {
  return compact(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function matchesDomain(hostname, domain) {
  const host = String(hostname || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  return Boolean(host && d && (host === d || host.endsWith(`.${d}`)));
}

function allowedSourceDomains(source) {
  return SOURCE_HOSTS[source === 'hn' ? 'hacker_news' : source] || [];
}

function parseHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

function trustedForSource(raw, source) {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  const domains = allowedSourceDomains(source);
  return domains.some((domain) => matchesDomain(url.hostname, domain));
}

function isPrivateIpv4(parts) {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv4Part(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
  return NaN;
}

function parseIpv4Hostname(host) {
  const parts = String(host || '').split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => part === '')) return null;
  if (!parts.every((part) => /^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(part))) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((num) => !Number.isSafeInteger(num) || num < 0)) return null;
  const prefix = nums.slice(0, -1);
  if (prefix.some((num) => num > 255)) return null;
  const last = nums.at(-1);
  const remainingBytes = 5 - nums.length;
  if (last > 256 ** remainingBytes - 1) return null;
  if (nums.length === 1) return [(last >>> 24) & 255, (last >>> 16) & 255, (last >>> 8) & 255, last & 255];
  if (nums.length === 2) return [nums[0], (last >>> 16) & 255, (last >>> 8) & 255, last & 255];
  if (nums.length === 3) return [nums[0], nums[1], (last >>> 8) & 255, last & 255];
  return nums;
}

function parseIpv4MappedIpv6(host) {
  const normalized = String(host || '').toLowerCase();
  const dotted = normalized.match(/^(?:0:0:0:0:0:ffff:|::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return parseIpv4Hostname(dotted[1]);
  const hex = normalized.match(/^(?:0:0:0:0:0:ffff:|::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (high > 0xffff || low > 0xffff) return null;
  return [(high >>> 8) & 255, high & 255, (low >>> 8) & 255, low & 255];
}

function isPrivateOrInternalHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipv4 = parseIpv4Hostname(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  const version = isIP(host);
  if (version !== 6) return false;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const mappedIpv4 = parseIpv4MappedIpv6(host);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  const firstHextet = host.split(':')[0];
  if (/^f[cd][0-9a-f]{0,2}$/i.test(firstHextet)) return true;
  const first = Number.parseInt(firstHextet, 16);
  return Number.isFinite(first) && first >= 0xfe80 && first <= 0xfebf;
}

function untrustedSourceMeta(url, finalUrl, message, status = 0, contentType = '') {
  return {
    url,
    finalUrl,
    status,
    ok: false,
    contentType,
    text: '',
    blocked: false,
    error: message,
  };
}

async function releaseResponseBody(res) {
  try {
    if (res?.bodyUsed) return;
    await res?.arrayBuffer?.();
  } catch {
    // Best-effort cleanup for rejected responses.
  }
}

export function sourceFromUrl(raw, fallback = 'web') {
  const url = parseHttpUrl(raw);
  if (!url) return fallback;
  for (const [source, domains] of Object.entries(SOURCE_HOSTS)) {
    if (domains.some((domain) => matchesDomain(url.hostname, domain))) return source;
  }
  return fallback;
}

function trustedEvidenceUrl(raw, source) {
  const url = parseHttpUrl(raw);
  if (!url) return '';
  const derived = sourceFromUrl(url.href, '');
  if (!derived) return '';
  if (source && source !== 'web' && derived !== source && !(source === 'hn' && derived === 'hacker_news')) return '';
  return url.href;
}

function cdataValue(text) {
  const match = String(text || '').match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return match ? match[1] : text;
}

function xmlText(text) {
  return compact(decodeEntities(cdataValue(String(text || ''))));
}

function stripPublisher(title) {
  return compact(title)
    .replace(/\s+\|\s+.*$/i, '')
    .replace(/\s+-\s+(TechCrunch|Crunchbase|Forbes|Reuters|Bloomberg|BusinessWire|PR Newswire|SiliconANGLE|VentureBeat|The Guardian).*$/i, '')
    .replace(/^Show HN:\s*/i, '')
    .replace(/^Ask HN:\s*/i, '');
}

function cleanCompanyName(raw) {
  let s = stripPublisher(xmlText(raw))
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/'s$/i, '')
    .replace(/’s$/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s*,.*$/g, '')
    .trim();

  const afterStartup = s.match(/\bstartup\s+(.+)$/i);
  if (afterStartup?.[1]) s = afterStartup[1].trim();
  if (/\bstartup$/i.test(s) && /['’]s\b/i.test(s)) return '';
  if (/['’]s\b.*\b(company|startup)\b/i.test(s)) return '';
  s = s.replace(/\s+in talks to$/i, '');
  s = s.replace(/\s+reportedly$/i, '');
  s = s.replace(/\s+defies\s+.+$/i, '');
  s = s.replace(/^[A-Z][A-Za-z0-9&.-]+-backed\s+/i, '');
  s = s.replace(/\b(?:maker|creator)\s+of\s+.+$/i, '');
  s = s.replace(/^(?:the\s+)?(?:(?:ai|genai|agentic|coding|developer tools|developer|data|security|fintech|startup|software|robotics|defense|healthcare|biotech|open-source|enterprise|infrastructure|crypto|climate)\s+)+(?:startup|company|platform)?\s+/i, '');
  s = s.replace(/^.+\bmaker\s+/i, '');
  s = s.replace(/^(?:startup|company|platform)\s+/i, '');
  s = compact(s);

  if (s.length < 2 || s.length > 70) return '';
  if (/[<>]/.test(s)) return '';
  if (GENERIC_NAMES.has(s.toLowerCase())) return '';
  if (/^(ai|genai|agentic|edtech|fintech|security|healthcare|biotech|robotics|climate|crypto|developer tools?)\s+(startup|company|platform)$/i.test(s)) return '';
  if (/\b(valuation|valuations|bubble|fears|earnings|fund)\b/i.test(s)) return '';
  if (!/[a-z0-9]/i.test(s)) return '';
  return s;
}

// ── Company-name extraction (subject-then-verb) ──────────────────────────
//
// Rewritten 2026-09-18, after the discovery crawler started consuming these
// names. Measured against 240 hand-labelled funding headlines, the previous
// whole-headline pattern list scored 75.4% precision / 76.5% recall; this
// scores 99.0% / 98.0%. That gap WAS the crawler's yield problem: each name
// seeds a frontier candidate, and the old extractor emitted "Mazama Energy
// just", "Health benefits platform Tha", "Instinct has" and "That Wants to
// Kill Tokenmaxx" alongside its real catches.
//
// WHY EVERY STEP BELOW RETURNS '' RATHER THAN GUESS. A name reaches the
// frontier (autopilot/lib/discovery-frontier.mjs), where it is probed against
// eleven ATS vendors and then RETRIED on a 1/3/7/21/60-day backoff. A miss
// costs one posting. A wrong name costs eleven live probes and two months of
// retries, and a junk name can never resolve, so it always runs the schedule to
// the end.
//
// Subject-then-verb, rather than a list of whole-headline patterns:
//
//   1. Clean: decode entities, drop "Ask HN:" / "Breaking News:" lead-ins, drop
//      (...) and [...] groups (YC batch tags, tickers, asides — decorative).
//   2. Find the funding VERB at its earliest position such that real funding
//      evidence (a currency amount, a bare "NNNM" amount, or a round keyword)
//      appears AFTER it. "Startup Boom Raises Questions" has the verb and no
//      such object, so it is not a funding headline.
//   3. SUBJECT is the text to its left, then: drop "<Investor>-backed"
//      attributions; drop a leading possessive ("Kenya's"); if the subject is
//      delimiter-bounded ("Name, appositive,") take the leading clause, because
//      an appositive describes rather than renames; else cut through the LAST
//      descriptor noun ("AI voice assistant developer Rokid" -> "Rokid"); else
//      validate it as a capitalised-word sequence.
//   4. A verbless "$N valuation for <descriptor> <Name>" shape is tried last.
//
// A subject that is pure description with nothing following the descriptor
// ("Stable Diffusion Startup", "Legal industry disruptor", "Sock startup")
// settles the question and returns '' — those headlines genuinely name no
// company, and inventing one is the expensive direction.
//
// Every helper is prefixed `fx_` so this block cannot collide with the host
// module's own helpers — B's draft independently re-declared GENERIC_NAMES,
// which is exactly the collision the prefix exists to make impossible.


function fx_compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Token-shape vocabulary
// ---------------------------------------------------------------------------

// Interior connectors a real company name can legitimately contain even
// though they are not themselves capitalised-looking words ("Bank of
// America", "The Browser Company", "Procter and Gamble").
const fx_ALLOWED_CONNECTORS = new Set(['of', 'and', '&', 'the']);

// Function words that disqualify a candidate outright, even when a headline's
// Title Case has capitalised them ("Uber Rival Gett Looking TO Raise ...").
// This is what keeps "For Kids Everloop" / "in Talks to" / "How to" from
// validating as names.
const fx_DISALLOWED_FUNCTION_WORDS = new Set([
  'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'after', 'before',
  'into', 'onto', 'over', 'under', 'through', 'as', 'than', 'then', 'when', 'while',
  'if', 'out', 'up', 'down', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'that', 'which', 'who', 'whom', 'whose', 'this', 'these', 'those', 'or',
  'nor', 'but', 'so', 'not', 'no', 'has', 'have', 'had',
]);

// Whole-candidate rejects: generic nouns that are never themselves the funded
// company, even when they end up capitalised and alone.
const fx_GENERIC_NAMES = new Set([
  'ai', 'genai', 'agentic', 'startup', 'startups', 'company', 'companies', 'platform',
  'founder', 'founders', 'developer', 'developers', 'app', 'service', 'services',
  'the', 'research', 'boom', 'fund', 'round', 'funding', 'valuation', 'bubble',
  'fears', 'it', 'its', 'they', 'he', 'she', 'we', 'our', 'your', 'i', 'how',
]);

// A brand stylized as an all-lowercase domain ("mygola.com", "jina.ai") is
// still a valid name token even though it fails the leading-capital test.
const fx_LOWERCASE_DOMAIN_RE = /^[a-z0-9][\w-]*\.(?:com|io|ai|co|net|org|app)$/i;

function fx_isNameLikeToken(tok) {
  const lower = tok.toLowerCase();
  if (fx_ALLOWED_CONNECTORS.has(lower)) return true;
  if (fx_DISALLOWED_FUNCTION_WORDS.has(lower)) return false;
  if (fx_LOWERCASE_DOMAIN_RE.test(tok)) return true;
  return /^[A-Z0-9]/.test(tok);
}

function fx_looksLikeCompanyName(s) {
  const tokens = fx_compact(s).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  if (!/^[A-Z0-9]/.test(tokens[0]) && !fx_LOWERCASE_DOMAIN_RE.test(tokens[0])) return false;
  return tokens.every(fx_isNameLikeToken);
}

function fx_trailingCapRun(s) {
  const tokens = fx_compact(s).split(' ').filter(Boolean);
  let start = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (fx_isNameLikeToken(tokens[i])) start = i;
    else break;
  }
  return tokens.slice(start).join(' ');
}

function fx_leadingCapRun(s) {
  const tokens = fx_compact(s).split(' ').filter(Boolean);
  let end = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (fx_isNameLikeToken(tokens[i])) end = i + 1;
    else break;
  }
  return tokens.slice(0, end).join(' ');
}

function fx_applyFinalGate(s) {
  let clean = fx_compact(s).replace(/^[-'".\s]+|[-'".\s]+$/g, '');
  clean = clean.replace(/['’]s$/i, '');
  if (clean.length < 2 || clean.length > 70) return '';
  if (!/[a-z0-9]/i.test(clean)) return '';
  if (fx_GENERIC_NAMES.has(clean.toLowerCase())) return '';
  // A number with at most a short unit suffix ("1,000mph", "$50k") is not a
  // company name, even though it token-shapes like one (starts with a digit).
  if (/^[\d,.]+[a-zA-Z]{0,3}$/.test(clean)) return '';
  return clean;
}

function fx_stripTrailingAdverbs(s) {
  let out = s;
  let prev;
  do {
    prev = out;
    out = out.replace(
      /\s+(?:quietly|reportedly|allegedly|apparently|officially|secretly|finally|recently|just|now|already|has|have|had)$/i,
      ''
    );
  } while (out !== prev);
  return out;
}

// A descriptor-stripped remainder (or whole subject) that OPENS with a
// relative pronoun is a subordinate clause describing the company, not the
// name itself ("... Startup That Wants to Kill Passwords Raises $10M" strips
// "Startup" down to "That Wants to Kill Passwords" — a clause, not a name,
// even though "Kill Passwords" title-cases like one). Reject outright rather
// than let the trailing-capitalised-run fallback below pick its tail off.
const fx_RELATIVE_CLAUSE_RE = /^(?:that|which|who|whom|whose)\b/i;

function fx_finalizeCandidate(sRaw) {
  let s = fx_compact(sRaw).replace(/[.,;:!?]+$/, '');
  s = fx_stripTrailingAdverbs(s);
  s = fx_compact(s).replace(/[.,;:!?]+$/, '');
  if (!s) return '';
  if (fx_RELATIVE_CLAUSE_RE.test(s)) return '';
  if (fx_looksLikeCompanyName(s)) return fx_applyFinalGate(s);
  const trail = fx_trailingCapRun(s);
  if (trail && fx_looksLikeCompanyName(trail)) return fx_applyFinalGate(trail);
  return '';
}

// ---------------------------------------------------------------------------
// Subject cleanup helpers
// ---------------------------------------------------------------------------

function fx_stripBackedPrefix(s) {
  const m = s.match(/-backed\s+(.+)$/i);
  if (m && m[1].trim()) return m[1].trim();
  return s;
}

function fx_stripLeadingPossessive(s) {
  const m = s.match(/^([A-Z][a-zA-Z]*)['’]s\s+(.+)$/);
  if (m && m[2].trim()) return m[2].trim();
  return s;
}

// "Name, an aside," / "Name – aside," — only when the WHOLE subject is
// itself delimiter-bounded (ends in a comma/dash right before the verb), so
// a clause that flows straight into the verb ("... investors to raise ...")
// is never mistaken for an appositive. The head can itself contain a second,
// unrelated clause ("Lambda School graduates first class,") — if the whole
// head doesn't validate, its own leading capitalised run is tried before
// giving up, which is what makes "Lambda School" survive that case.
function fx_leadClauseCandidate(subject) {
  const trimmed = subject.trim();
  const idx = trimmed.search(/[,;–—]/);
  if (idx <= 0) return '';
  const head = fx_compact(trimmed.slice(0, idx)).replace(/[.,;:!?]+$/, '');
  if (!head) return '';

  const endsInDelimiter = /[,;–—]\s*$/.test(trimmed);
  let tailIsPureDescription = false;
  if (!endsInDelimiter) {
    const tail = trimmed.slice(idx + 1).replace(/[,;–—]\s*$/, '').trim();
    if (tail) {
      const tailDesc = fx_stripDescriptorPrefix(tail);
      tailIsPureDescription = tailDesc.found && !tailDesc.remainder;
    }
  }
  if (!endsInDelimiter && !tailIsPureDescription) return '';

  if (fx_looksLikeCompanyName(head)) return fx_applyFinalGate(head);
  const lead = fx_leadingCapRun(head);
  if (lead && fx_looksLikeCompanyName(lead)) return fx_applyFinalGate(lead);
  return '';
}

// Descriptor nouns that precede a name ("AI voice assistant developer
// Rokid", "Precision Health and Genomics Firm Color", "15B valuation for
// drone-maker DJI"). Deliberately excludes words that are common as the
// TRAILING word of a real brand name itself (company, labs, studio, group,
// ventures) — "company" was dropped specifically because "The Browser
// Company" is a real, labelled example: stripping through a terminal
// "Company" would zero out its own name. That is a known blind spot in the
// other direction (a genuinely generic "... Company" headline with nothing
// after "Company" now falls through to whole-subject validation instead of
// being recognised as pure description) — see risks.
const fx_DESCRIPTOR_WORDS = [
  'startup', 'start-up', 'firm', 'platform', 'service', 'services', 'app',
  'application', 'developer', 'developers', 'maker', 'makers', 'creator',
  'creators', 'founder', 'founders', 'provider', 'operator', 'manufacturer',
  'disruptor', 'unicorn', 'giant', 'bank', 'rival', 'network', 'marketplace',
  'engine', 'builder', 'builders', 'retailer', 'fintech', 'edtech', 'healthtech',
  'biotech', 'insurtech', 'proptech', 'agency', 'exchange',
];
const fx_DESCRIPTOR_RE_SOURCE = '\\b(?:' + fx_DESCRIPTOR_WORDS.join('|') + ')\\b';
// Hyphenated compounds like "drone-maker" carry the descriptor as a suffix;
// normalize the hyphen to a space for detection only (same length, so
// positions still map back onto the original string 1:1).
const fx_HYPHEN_SUFFIX_RE = /-(?=(?:maker|makers|creator|creators|founder|founders|developer|developers|provider|operator|manufacturer|builder|builders)\b)/gi;

function fx_stripDescriptorPrefix(s) {
  const scan = s.replace(fx_HYPHEN_SUFFIX_RE, ' ');
  const re = new RegExp(fx_DESCRIPTOR_RE_SOURCE, 'gi');
  let lastEnd = -1;
  let m;
  while ((m = re.exec(scan))) lastEnd = m.index + m[0].length;
  if (lastEnd === -1) return { found: false, remainder: s };
  return { found: true, remainder: s.slice(lastEnd).trim() };
}

// ---------------------------------------------------------------------------
// Verb-phrase detection + funding-evidence guard
// ---------------------------------------------------------------------------

// Multi-word / intent phrases are listed before their bare single-word
// components so "DoorDash Nears Deal to Secure Funding" cuts the subject at
// "Nears", not at the bare "Secure" buried inside the phrase; likewise
// "Looking to Raise", "Files to Raise", "emerges from stealth".
const fx_VERB_ALTERNATIVES = [
  'nears?\\s+(?:a\\s+)?deal\\s+to\\s+(?:raise|secure)',
  'files?\\s+to\\s+raise',
  'plans?\\s+to\\s+raise',
  '(?:looking|seeking|hoping|planning)\\s+to\\s+raise',
  'in\\s+talks?\\s+to\\s+raise',
  'emerges?\\s+from\\s+stealth',
  'comes?\\s+out\\s+of\\s+stealth',
  'has\\s+acquired',
  'raises?', 'raised',
  'lands?', 'landed',
  'secures?', 'secured',
  'closes?', 'closed',
  'nabs?', 'nabbed',
  'bags?', 'bagged',
  'gets', 'got',
  'receives?', 'received',
  'hits?', 'hit',
  'reaches?', 'reached',
  'valued\\s+at',
  'announces?', 'announced',
  // Added 2026-09-18 from the crawler's first live run, which missed all of
  // these. Every one is safe only because a verb still has to be FOLLOWED by
  // real funding evidence — the verb alone never decides.
  'captures?', 'captured',
  'locks?\\s+down', 'locked\\s+down',
  'hauls?\\s+in', 'hauled\\s+in',
  'pulls?\\s+in', 'pulled\\s+in',
  'picks?\\s+up', 'picked\\s+up',
  'snags?', 'snagged',
  'scoops?\\s+up', 'scooped\\s+up',
  'scores?', 'scored',
  // NOT 'banks?'. "Acme banks $10M" is a real headline shape, but `bank` is
  // also in fx_DESCRIPTOR_WORDS and the noun is far commoner: adding the verb
  // made "Challenger bank N26 raises $900M" read `bank` as the verb, take
  // "Challenger" as the subject and answer "Challenger". A token that is both
  // a funding verb and a descriptor noun has to lose the tie as a verb.
];
const fx_VERB_RE = new RegExp('\\b(?:' + fx_VERB_ALTERNATIVES.join('|') + ')\\b', 'gi');

const fx_CURRENCY = '(?:US\\$|C\\$|A\\$|\\$|€|£|¥)';
const fx_UNIT = '(?:bn|billion|mm|mn|m|million|k|thousand|b|t)';
const fx_EVIDENCE_RE = new RegExp(
  `${fx_CURRENCY}\\s?[\\d,]+(?:\\.\\d+)?\\s*${fx_UNIT}?` +
  `|\\b[\\d,]+(?:\\.\\d+)?\\s*${fx_UNIT}\\b` +
  `|\\b[\\d,]+(?:\\.\\d+)?\\s*${fx_UNIT}?\\s*${fx_CURRENCY}` +
  `|\\b(?:funding|round|series\\s+[a-h]|seed|pre-seed|investment|financing|valuation|valued|stealth|capital|money)\\b`,
  'i'
);

function fx_findQualifyingVerb(raw) {
  fx_VERB_RE.lastIndex = 0;
  let m;
  while ((m = fx_VERB_RE.exec(raw))) {
    const after = raw.slice(m.index + m[0].length);
    if (fx_EVIDENCE_RE.test(after)) return m;
    if (m.index === fx_VERB_RE.lastIndex) fx_VERB_RE.lastIndex++; // guard against zero-length match
  }
  return null;
}

function fx_subjectToCandidate(subjectRaw) {
  let subject = subjectRaw.trim();
  if (!subject) return '';
  subject = fx_stripBackedPrefix(subject);
  subject = fx_stripLeadingPossessive(subject);
  subject = fx_compact(subject);
  if (!subject) return '';

  const lead = fx_leadClauseCandidate(subject);
  if (lead) return lead;

  // The descriptor scan takes the LAST descriptor in the subject, which must
  // not reach across a comma into an appositive: "AI logistics startup Augment,
  // from Deliverr founder," has `founder` as its last descriptor, and stripping
  // through it leaves nothing at all. The name lives in the first clause.
  const firstClause = subject.split(/\s*,\s*/)[0].trim() || subject;
  const desc = fx_stripDescriptorPrefix(firstClause);
  if (desc.found) {
    const finalized = fx_finalizeCandidate(desc.remainder);
    if (finalized) return finalized;
    // "AI chip startup Etched defies skeptics" strips to "Etched defies
    // skeptics", which is not a name — but its LEADING capitalised run is.
    // Only ever narrows, so it cannot invent a name the subject did not carry.
    const lead2 = fx_leadingCapRun(desc.remainder);
    if (lead2) return fx_finalizeCandidate(lead2);
    return '';
  }

  // Weakest-evidence path: nothing stripped this subject down to a name, we
  // are about to trust it whole. A bare "X and Y" here is far more often two
  // people (co-founders, an actor-and-actor byline) than one company's own
  // name — company names built on "and" almost always surface via the
  // descriptor-stripped or appositive paths above, which have already had
  // their shot by this point. Refuse rather than guess.
  if (/\b(?:and|&)\b/i.test(subject)) return '';

  return fx_finalizeCandidate(subject);
}

function fx_extractViaVerb(raw) {
  const match = fx_findQualifyingVerb(raw);
  if (!match) return '';
  const subject = raw.slice(0, match.index);
  return fx_subjectToCandidate(subject);
}

// No-verb reversed shape: "15B valuation for drone-maker DJI". Only tried
// when the verb path found nothing.
const fx_VALUATION_FOR_RE = new RegExp(
  `${fx_CURRENCY}?\\s?[\\d,]+(?:\\.\\d+)?\\s*${fx_UNIT}?\\s+valuation\\s+for\\s+(.+)$`,
  'i'
);

function fx_extractViaValuationFor(raw) {
  const m = raw.match(fx_VALUATION_FOR_RE);
  if (!m || !m[1]) return '';
  return fx_subjectToCandidate(m[1]);
}

// ---------------------------------------------------------------------------
// Title cleanup
// ---------------------------------------------------------------------------

const fx_PUBLISHER_SUFFIX_RE =
  /\s+-\s+(TechCrunch|Crunchbase|Forbes|Reuters|Bloomberg|BusinessWire|PR Newswire|SiliconANGLE|VentureBeat|The Guardian)\s*$/i;
const fx_LEAD_IN_RE = /^(breaking\s+news|exclusive|update|just\s+in|scoop|report)\s*:\s*/i;
const fx_NON_FUNDING_PREFIX_RE = /^(ask\s+hn|tell\s+hn|who\s+is\s+hiring|launch\s+hn)\b/i;
const fx_SHOW_HN_RE = /^show\s+hn:\s*/i;
const fx_YC_BATCH_RE = /\s*\(?\s*YC[\s-]?[SWF]\d{2,3}\)?\s*/gi;

function fx_cleanTitle(title) {
  let raw = fx_compact(decodeEntities(String(title || '')));
  if (!raw) return '';
  if (fx_NON_FUNDING_PREFIX_RE.test(raw)) return '';

  raw = raw.replace(/\s+\|\s+.*$/, '');
  raw = raw.replace(fx_PUBLISHER_SUFFIX_RE, '');
  raw = raw.replace(fx_SHOW_HN_RE, '');
  raw = raw.replace(fx_LEAD_IN_RE, '');

  // Decorative bracket/paren groups (YC batch tags, tickers, asides) — never
  // load-bearing for the name.
  raw = raw.replace(/\([^()]*\)/g, ' ').replace(/\[[^[\]]*\]/g, ' ');
  raw = raw.replace(fx_YC_BATCH_RE, ' ');
  raw = fx_compact(raw);
  return raw;
}

/**
 * The company that RAISED money in a funding headline, or '' when none is named.
 *
 * @param {string} title - A headline, as fetched. Untrusted third-party text.
 * @returns {string} The company name, or '' when the headline names none.
 */
// "<Person or fund> raises $X FOR <descriptor> <Name>" puts the funded company
// AFTER the verb, so the subject-then-verb path reads the raiser instead — and
// the raiser here is usually a person ("Ex-DeepMind David Silver Raises $1.1B
// for AI Startup Ineffable" yielded "Ex-DeepMind David Silver"). That is the
// wrong-name direction, so this shape is checked FIRST, before the subject is
// ever considered. The old pattern list had it first for the same reason.
// "<Name> <weak verb> ... with $600M in new funding" — the money phrase carries
// the meaning, not the verb, so this is anchored on "in (new) funding" rather
// than on a verb loose enough to fire on "Spotify charts show $1B in revenue".
const fx_WITH_FUNDING_RE =
  /^(.+?)\s+\w[\w\s'-]{0,48}?\bwith\s+[$€£]?\s?[\d.,]+\s*(?:billion|million|bn|[bkmt])?\s+in\s+(?:new\s+|fresh\s+|additional\s+)?funding\b/i;

const fx_RAISES_FOR_RE = new RegExp(
  '\\b(?:raises?|raised|lands?|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged)\\s+'
  + '(?:an?\\s+|over\\s+|more\\s+than\\s+|up\\s+to\\s+)?'
  + '(?:[$€£]\\s?[\\d.,]+\\s*(?:billion|million|bn|[bkmt])?|[\\d.,]+\\s*(?:billion|million|bn|[bkmt]))\\s+'
  + 'for\\s+(.+)$',
  'i',
);

/**
 * The company that RAISED money in a funding headline, or '' when none is named.
 *
 * @param {string} title - A headline, as fetched. Untrusted third-party text.
 * @returns {string} The company name, or '' when the headline names none.
 */
export function extractCompanyFromFundingTitle(title) {
  const raw = fx_cleanTitle(title);
  if (!raw) return '';

  const forMatch = raw.match(fx_RAISES_FOR_RE);
  if (forMatch) {
    const tail = fx_compact(forMatch[1]).replace(/[.,;:]+$/, '');
    const desc = fx_stripDescriptorPrefix(tail);
    const named = fx_finalizeCandidate(desc.found ? desc.remainder : tail)
      || fx_finalizeCandidate(fx_trailingCapRun(tail));
    // Only accept it when a real name falls out; "raises $40M for expansion"
    // must fall through to the normal path rather than yield "expansion".
    if (named) return named;
  }

  const viaVerb = fx_extractViaVerb(raw) || fx_extractViaValuationFor(raw);
  if (viaVerb) return viaVerb;

  const withFunding = raw.match(fx_WITH_FUNDING_RE);
  if (withFunding) {
    const subject = fx_compact(withFunding[1]);
    const lead = fx_leadingCapRun(subject);
    if (lead) {
      const desc = fx_stripDescriptorPrefix(lead);
      const named = fx_finalizeCandidate(desc.found ? desc.remainder : lead);
      if (named) return named;
    }
  }
  return '';
}

export function extractFundingDetails(text) {
  const raw = xmlText(text);
  const amount = raw.match(/\$[\d,.]+(?:\.\d+)?\s*(?:billion|million|bn|m|b|k)?/i)?.[0] || '';
  const round = raw.match(/\b(?:pre-seed|seed|series\s+[a-h]|strategic|venture|growth)\b/i)?.[0] || '';
  return {
    amount: compact(amount),
    round: round ? round.replace(/\s+/g, ' ').replace(/\bseries\b/i, 'Series') : '',
  };
}

function companyKey(name) {
  return compact(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function diagnostic(source) {
  return {
    source,
    status: 'ok',
    fetched_items: 0,
    funding_like_items: 0,
    candidate_count: 0,
    blocked: false,
    errors: [],
  };
}

function markDiagnosticError(diag, message, { blocked = false } = {}) {
  if (!message) return;
  diag.errors.push(message);
  if (blocked) diag.blocked = true;
  if (diag.status !== 'blocked') diag.status = blocked ? 'blocked' : 'error';
}

function detectBlockedContent(text, { status = 200, contentType = '' } = {}) {
  const raw = String(text || '').slice(0, 20_000);
  if ([401, 403, 429, 503].includes(Number(status))) return true;
  if (/text\/html/i.test(contentType) || /<html/i.test(raw)) {
    return /\b(access denied|captcha|cloudflare|attention required|verify you are human|enable javascript|unusual traffic|temporarily blocked|bot detection|ddos-guard|akamai|perimeterx)\b/i.test(raw);
  }
  return false;
}

async function fetchTextMeta(url, { timeoutMs = 12_000, source = '' } = {}) {
  const startUrl = String(url || '');
  if (!trustedForSource(startUrl, source)) return untrustedSourceMeta(startUrl, startUrl, `untrusted source URL: ${startUrl}`);
  if (isPrivateOrInternalHostname(new URL(startUrl).hostname)) {
    return untrustedSourceMeta(startUrl, startUrl, `internal source URL rejected: ${startUrl}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = startUrl;
    for (let hops = 0; hops <= 5; hops++) {
      const res = await fetch(currentUrl, {
        headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'application/rss+xml,application/xml,text/xml,text/plain,*/*' },
        redirect: 'manual',
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type') || '';
      if ([301, 302, 303, 307, 308].includes(Number(res.status))) {
        const location = res.headers.get('location') || '';
        if (!location) {
          await releaseResponseBody(res);
          return untrustedSourceMeta(startUrl, currentUrl, `redirect without Location: ${currentUrl}`, res.status, contentType);
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch {
          await releaseResponseBody(res);
          return untrustedSourceMeta(startUrl, currentUrl, `invalid redirect Location: ${location}`, res.status, contentType);
        }
        const nextHost = new URL(nextUrl).hostname;
        if (isPrivateOrInternalHostname(nextHost)) {
          await releaseResponseBody(res);
          return untrustedSourceMeta(startUrl, nextUrl, `internal redirect target rejected: ${nextUrl}`, res.status, contentType);
        }
        if (!trustedForSource(nextUrl, source)) {
          await releaseResponseBody(res);
          return untrustedSourceMeta(startUrl, nextUrl, `untrusted final source URL: ${nextUrl}`, res.status, contentType);
        }
        await releaseResponseBody(res);
        currentUrl = nextUrl;
        continue;
      }

      const finalUrl = res.url || currentUrl;
      if (!trustedForSource(finalUrl, source)) {
        await releaseResponseBody(res);
        return untrustedSourceMeta(startUrl, finalUrl, `untrusted final source URL: ${finalUrl}`, res.status, contentType);
      }
      const text = await res.text().catch(() => '');
      return {
        url: startUrl,
        finalUrl,
        status: res.status,
        ok: res.ok,
        contentType,
        text,
        blocked: detectBlockedContent(text, { status: res.status, contentType }),
        error: res.ok ? '' : `HTTP ${res.status}`,
      };
    }
    return untrustedSourceMeta(startUrl, startUrl, 'too many redirects');
  } catch (err) {
    return {
      url: startUrl,
      finalUrl: startUrl,
      status: 0,
      ok: false,
      contentType: '',
      text: '',
      blocked: false,
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonMeta(url, { timeoutMs = 12_000, source = '' } = {}) {
  const meta = await fetchTextMeta(url, { timeoutMs, source });
  if (!meta.ok) return { ...meta, json: null };
  try {
    return { ...meta, json: JSON.parse(meta.text) };
  } catch (err) {
    return { ...meta, ok: false, json: null, error: `invalid JSON: ${err.message}` };
  }
}

function tagValue(xml, names) {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const match = String(xml || '').match(re);
    if (match?.[1]) return xmlText(match[1]);
  }
  return '';
}

function attrValue(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, 'i');
  return xmlText(String(xml || '').match(re)?.[1] || '');
}

function categoriesFromXml(xml) {
  return [...String(xml || '').matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)]
    .map((match) => xmlText(match[1]))
    .filter(Boolean);
}

function parsePublishedDate(value) {
  const raw = compact(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return {
    value: date.toISOString().slice(0, 10),
    precision: 'day',
    date,
  };
}

export function parseRssItems(xml, { source = 'web' } = {}) {
  const out = [];
  const raw = String(xml || '');
  const blocks = [
    ...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...raw.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];
  for (const blockMatch of blocks) {
    const block = blockMatch[1];
    const title = tagValue(block, ['title']);
    const description = tagValue(block, ['description', 'summary', 'content:encoded', 'content']);
    const link = compact(tagValue(block, ['link'])) || attrValue(block, 'link', 'href');
    const observedDate = parsePublishedDate(tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']));
    const sourceCompany = tagValue(block, ['dc:contributor', 'dc:creator', 'author', 'source']);
    const itemSource = sourceFromUrl(link, source);
    if (!title && !link) continue;
    out.push({
      source: itemSource === 'web' ? source : itemSource,
      title,
      url: trustedEvidenceUrl(link, itemSource === 'web' ? source : itemSource),
      published_at: observedDate?.date?.toISOString() || '',
      observedDate,
      text: compact(`${title} ${description}`),
      categories: categoriesFromXml(block),
      source_company: sourceCompany,
    });
  }
  return out;
}

function hasFundingLanguage(text) {
  return /\b(funding|funded|raises?|raised|raise|series\s+[a-h]|seed\s+round|pre-seed|venture\s+round|investment|financing|valuation|valued\s+at|lands?|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged|emerges?\s+from\s+stealth|in\s+talks\s+to\s+raise)\b/i.test(text);
}

function isExcludedFundingItem(item) {
  const text = `${item.title || ''} ${item.text || ''} ${item.categories?.join(' ') || ''}`;
  const exclusions = [
    // (?<!\w)/(?!\w), not \b: the `cuts N%` alternative ends in "%", and a
    // trailing \b can never match after a non-word character — so that
    // alternative was dead and layoff headlines that also mention a raise
    // ("Acme raises $40M Series A, then cuts 30% of staff") were surfaced as
    // funding leads. Same symbol-edge class as the fix in #2227. For every
    // other alternative (all of which end in a word character) \b and the
    // lookarounds are equivalent, so their behaviour is unchanged.
    /(?<!\w)(acquires?|acquired|acquisition|merger|spac|ipo|bankruptcy|layoffs?|earnings|quarterly results)(?!\w)/i,
    // A layoff announced in the same headline as a raise is the case #2404
    // fixed, but it only covered one spelling — "cuts N%". These reach the
    // same reader with the same harm, the tool recommending a company that
    // just announced job losses:
    //   "raises $40M …, then cuts 30 % of staff"    (a space before the percent)
    //   "raises $40M …, then cuts 1,200 jobs"       (a count, no percent)
    //   "raises $40M … and lays off 300 employees"  (a different verb)
    //
    // EVERY form requires a workforce noun, percent included. The percent
    // alternative used to sit in the group above with no such requirement, so
    // "cuts 30% of cloud costs" — a cost story at a company that may well
    // still be hiring — was excluded as if it were a layoff. Scoping it here
    // fixes that and makes the two numeric forms consistent, which splitting
    // them did not (CodeRabbit review). The optional "of its/the/their"
    // carries the spellings the corpus uses ("cuts 15% of its workforce").
    /(?<!\w)(cuts?|axes|slashes|eliminates|sheds)\s+\d[\d,.]*\s*(?:%\s*)?(?:of\s+)?(?:its\s+|the\s+|their\s+)?(jobs|roles|positions|staff|employees|workers|workforce|headcount)(?!\w)/i,
    // Plural too: "amid workforce reductions" bypassed the singular-only form.
    /\b(lays?\s+off|laying\s+off|laid\s+off|job\s+cuts|workforce\s+reductions?|headcount\s+reductions?|staff\s+reductions?)\b/i,
    /\b(public offering|registered direct offering|private placement|atm offering|offering of common stock)\b/i,
    /\braises?\s+\$[\d,.]+(?:\.\d+)?\s*(?:billion|million|bn|m|b|k)?\s+fund\b/i,
    /\b(venture fund|vc fund|investment fund|private equity fund|capital fund|fund ii|fund iii|fund iv|new fund)\b/i,
    /\b(grant|grants|scholarship|scholarships|award|awards|donation|donates?)\b/i,
    /\b(how to raise|ways to raise|guide to fundraising|startup valuations|bubble fears)\b/i,
  ];
  if (exclusions.some((re) => re.test(text))) return true;
  return !hasFundingLanguage(text);
}

function inferredDateFromText(text, now = new Date()) {
  const raw = String(text || '');
  const year = raw.match(/\b(20\d{2})\b/)?.[1];
  if (year) {
    const currentYear = now.getUTCFullYear();
    const date = Number(year) === currentYear ? new Date(now.getTime()) : new Date(`${year}-01-01T00:00:00Z`);
    return { value: String(year), precision: 'year', date };
  }
  return { value: now.toISOString().slice(0, 10), precision: 'observed', date: now };
}

function bestObservedDate(item, now) {
  if (item.observedDate?.date instanceof Date && !Number.isNaN(item.observedDate.date.getTime())) return item.observedDate;
  if (item.published_at) {
    const parsed = parsePublishedDate(item.published_at);
    if (parsed) return parsed;
  }
  return inferredDateFromText(`${item.title || ''} ${item.text || ''}`, now);
}

function withinMonths(date, months, now) {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return date >= cutoff && date <= now;
}

function confidenceFor(item, details) {
  const sourceStrong = ['techcrunch', 'prnewswire', 'guardian'].includes(item.source);
  const detailStrong = Boolean(details.amount || details.round);
  if (sourceStrong && detailStrong) return 'high';
  if (sourceStrong || detailStrong) return 'medium';
  return 'low';
}

function candidateFromItem(item, { now }) {
  if (isExcludedFundingItem(item)) return null;
  const observed = bestObservedDate(item, now);
  const details = extractFundingDetails(`${item.title || ''} ${item.text || ''}`);
  const sourceCompany = item.source === 'prnewswire' ? cleanCompanyName(item.source_company || '') : '';
  const company = extractCompanyFromFundingTitle(item.title) || sourceCompany;
  if (!company) return null;
  return {
    company,
    amount: details.amount,
    round: details.round,
    source: item.source || sourceFromUrl(item.url),
    title: compact(item.title || ''),
    url: trustedEvidenceUrl(item.url || '', ''),
    observedDate: observed,
    confidence: confidenceFor(item, details),
  };
}

export function buildCandidates(items, {
  months = DEFAULT_MONTHS,
  sort = DEFAULT_SORT,
  limit = DEFAULT_LIMIT,
  now = new Date(),
  diagnostics = [],
} = {}) {
  const grouped = new Map();
  for (const item of items || []) {
    const candidate = candidateFromItem(item, { now });
    if (!candidate) continue;
    if (!withinMonths(candidate.observedDate.date, months, now)) continue;
    const key = companyKey(candidate.company);
    if (!key) continue;
    const current = grouped.get(key) || {
      company: candidate.company,
      amount: '',
      round: '',
      funding: { status: 'recent_funding', confidence: 'low', sources: [] },
      discovery_score: 0,
      suggested_action: 'review_company_manually',
    };
    if (!current.amount && candidate.amount) current.amount = candidate.amount;
    if (!current.round && candidate.round) current.round = candidate.round;
    const evidence = {
      source: candidate.source,
      title: candidate.title,
      url: candidate.url,
      observed_date: candidate.observedDate.value,
      date_precision: candidate.observedDate.precision,
    };
    const evidenceKey = `${evidence.source}\n${evidence.title}\n${evidence.url}\n${evidence.observed_date}`;
    const duplicateEvidence = current.funding.sources.some((src) => `${src.source}\n${src.title}\n${src.url}\n${src.observed_date}` === evidenceKey);
    if (!duplicateEvidence) {
      current.funding.sources.push(evidence);
      const sourceRank = SOURCE_RANK[candidate.source] || SOURCE_RANK.web;
      const detailBonus = (candidate.amount ? 10 : 0) + (candidate.round ? 8 : 0);
      const confidenceBonus = candidate.confidence === 'high' ? 15 : candidate.confidence === 'medium' ? 8 : 0;
      current.discovery_score += sourceRank + detailBonus + confidenceBonus;
      current.funding.confidence = bestConfidence(current.funding.confidence, candidate.confidence);
    }
    grouped.set(key, current);
  }

  const candidates = [...grouped.values()].map((candidate) => {
    candidate.funding.sources.sort((a, b) => String(b.observed_date || '').localeCompare(String(a.observed_date || '')));
    return candidate;
  });

  candidates.sort((a, b) => {
    if (sort === 'score') return b.discovery_score - a.discovery_score || a.company.localeCompare(b.company);
    const ad = a.funding.sources[0]?.observed_date || '';
    const bd = b.funding.sources[0]?.observed_date || '';
    return bd.localeCompare(ad) || b.discovery_score - a.discovery_score || a.company.localeCompare(b.company);
  });
  const finalCandidates = candidates.slice(0, limit);

  for (const diag of diagnostics) {
    diag.candidate_count = finalCandidates.filter((c) => c.funding.sources.some((s) => s.source === sourceNameForDiagnostic(diag.source))).length;
  }

  return finalCandidates;
}

function sourceNameForDiagnostic(source) {
  return source === 'hn' ? 'hacker_news' : source;
}

function bestConfidence(a, b) {
  const rank = { low: 1, medium: 2, high: 3 };
  return rank[b] > rank[a] ? b : a;
}

async function fetchRssDiscovery(source, diagnostics) {
  const diag = diagnostics.find((d) => d.source === source) || diagnostic(source);
  const out = [];
  for (const url of RSS_SOURCES[source] || []) {
    const meta = await fetchTextMeta(url, { source });
    if (!meta.ok || meta.blocked) {
      markDiagnosticError(diag, `${url}: ${meta.error || (meta.blocked ? 'blocked/challenge page' : 'fetch failed')}`, { blocked: meta.blocked });
      continue;
    }
    const items = parseRssItems(meta.text, { source });
    diag.fetched_items += items.length;
    for (const item of items) {
      if (isExcludedFundingItem(item)) continue;
      diag.funding_like_items += 1;
      out.push(item);
    }
  }
  if (diag.fetched_items === 0 && diag.errors.length === 0) markDiagnosticError(diag, 'no RSS items fetched');
  return out;
}

function hnQueries() {
  return [
    'AI startup raises funding',
    'Series A AI startup',
    'developer tools startup funding',
    'infrastructure startup raises funding',
    'agentic AI raises seed',
  ];
}

async function fetchHnDiscovery({ months = DEFAULT_MONTHS, diagnostics = [] } = {}) {
  const diag = diagnostics.find((d) => d.source === 'hn') || diagnostic('hn');
  const cutoff = Math.floor(Date.now() / 1000) - months * 31 * 24 * 60 * 60;
  const out = [];
  for (const query of hnQueries()) {
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
      `&tags=story&hitsPerPage=50&numericFilters=created_at_i>${cutoff}`;
    const meta = await fetchJsonMeta(url, { source: 'hacker_news' });
    if (!meta.ok || meta.blocked || !meta.json) {
      markDiagnosticError(diag, `${url}: ${meta.error || (meta.blocked ? 'blocked/challenge page' : 'fetch failed')}`, { blocked: meta.blocked });
      continue;
    }
    const hits = Array.isArray(meta.json?.hits) ? meta.json.hits : [];
    diag.fetched_items += hits.length;
    for (const hit of hits) {
      const title = compact(hit.title || hit.story_title || '');
      if (!title) continue;
      const fallbackUrl = `https://news.ycombinator.com/item?id=${encodeURIComponent(String(hit.objectID || ''))}`;
      const itemUrl = trustedEvidenceUrl(hit.url || '', '') || trustedEvidenceUrl(fallbackUrl, 'hacker_news');
      const item = {
        source: 'hacker_news',
        title: xmlText(title),
        url: itemUrl,
        published_at: hit.created_at ? new Date(hit.created_at).toISOString() : '',
        observedDate: hit.created_at ? { value: hit.created_at.slice(0, 10), precision: 'day', date: new Date(hit.created_at) } : null,
        text: xmlText(hit.story_text || ''),
        categories: [],
        source_company: '',
      };
      if (isExcludedFundingItem(item)) continue;
      diag.funding_like_items += 1;
      out.push(item);
    }
  }
  if (diag.fetched_items === 0 && diag.errors.length === 0) markDiagnosticError(diag, 'no HN items fetched');
  return out;
}

async function collectDiscoveryItems(opts, diagnostics) {
  const requested = new Set(opts.sources || DEFAULT_SOURCES);
  const hits = [];
  for (const source of ['techcrunch', 'prnewswire', 'guardian']) {
    if (requested.has(source)) hits.push(...await fetchRssDiscovery(source, diagnostics));
  }
  if (requested.has('hn')) {
    hits.push(...await fetchHnDiscovery({ months: opts.months, diagnostics }));
  }
  return hits;
}

function markdownText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, ' ');
}

function safeReportUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return '';
  return url.href.replace(/[<>\s]/g, encodeURIComponent);
}

export function renderReport(result) {
  const lines = [];
  lines.push(`# Funded Company Discovery - ${markdownText(result.generated_at)}`);
  lines.push('');
  lines.push('Review-first output. No companies were added to portals.yml and no company websites were probed.');
  lines.push('');
  lines.push(`Window: ${result.window_months} months`);
  lines.push(`Sort: ${markdownText(result.sort)}`);
  lines.push(`Sources: ${result.sources.map(markdownText).join(', ')}`);
  lines.push(`Candidates: ${result.companies.length}`);
  lines.push('');
  lines.push('## Source Health');
  lines.push('');
  lines.push('| Source | Status | Fetched | Funding-like | Candidates | Notes |');
  lines.push('|--------|--------|---------|--------------|------------|-------|');
  for (const diag of result.diagnostics) {
    lines.push(`| ${markdownText(diag.source)} | ${markdownText(diag.status)} | ${diag.fetched_items} | ${diag.funding_like_items} | ${diag.candidate_count} | ${markdownText(diag.errors.join('; '))} |`);
  }
  lines.push('');
  lines.push('| # | Company | Funding | Date | Source | Action |');
  lines.push('|---|---------|---------|------|--------|--------|');
  result.companies.forEach((candidate, idx) => {
    const src = candidate.funding.sources?.[0] || {};
    const funding = [candidate.round, candidate.amount, candidate.funding.status].filter(Boolean).join(' / ');
    lines.push(`| ${idx + 1} | ${markdownText(candidate.company)} | ${markdownText(funding)} | ${markdownText(src.observed_date || '')} | ${markdownText(src.source || '')} | ${markdownText(candidate.suggested_action)} |`);
  });
  lines.push('');
  for (const candidate of result.companies) {
    lines.push(`## ${markdownText(candidate.company)}`);
    lines.push('');
    lines.push(`- Funding signal: ${markdownText(candidate.funding.status)} (${markdownText(candidate.funding.confidence)})`);
    if (candidate.round || candidate.amount) lines.push(`- Round/amount: ${markdownText([candidate.round, candidate.amount].filter(Boolean).join(', '))}`);
    lines.push(`- Suggested action: ${markdownText(candidate.suggested_action)}`);
    lines.push('- Evidence:');
    for (const src of candidate.funding.sources.slice(0, 3)) {
      const url = safeReportUrl(src.url);
      const suffix = url ? ` - ${url}` : '';
      lines.push(`  - ${markdownText(src.source)}${src.observed_date ? `, ${markdownText(src.observed_date)}` : ''}: ${markdownText(src.title)}${suffix}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function writeArtifacts(result) {
  const outDir = join(DATA_ROOT, 'output');
  const reportDir = join(DATA_ROOT, 'reports');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const jsonPath = join(outDir, `funded-companies-${result.generated_at}.json`);
  const reportPath = join(reportDir, `funded-companies-${result.generated_at}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  writeFileSync(reportPath, renderReport(result), 'utf-8');
  return { jsonPath, reportPath };
}

function printHuman(result) {
  console.log(`Funded company discovery - ${result.generated_at}`);
  console.log(`Window: ${result.window_months} months`);
  console.log(`Sort: ${result.sort}`);
  console.log(`Sources: ${result.sources.join(', ')}`);
  console.log(`Candidates: ${result.companies.length}`);
  if (result.artifacts) {
    console.log(`JSON: ${result.artifacts.jsonPath}`);
    console.log(`Report: ${result.artifacts.reportPath}`);
  }
  const unhealthy = result.diagnostics.filter((d) => d.status !== 'ok' || d.blocked || d.fetched_items === 0);
  if (unhealthy.length || result.companies.length === 0) {
    console.log('');
    console.log('Source health:');
    for (const diag of result.diagnostics) {
      const note = diag.errors.length ? ` - ${diag.errors.join('; ')}` : '';
      console.log(`  ${diag.source}: ${diag.status}, fetched ${diag.fetched_items}, funding-like ${diag.funding_like_items}, candidates ${diag.candidate_count}${note}`);
    }
  }
  console.log('');
  for (const [idx, candidate] of result.companies.entries()) {
    const src = candidate.funding.sources?.[0] || {};
    console.log(`${idx + 1}. ${candidate.company}`);
    console.log(`   Funding: ${[candidate.round, candidate.amount, candidate.funding.status].filter(Boolean).join(' / ')} (${candidate.funding.confidence})${src.observed_date ? `, ${src.observed_date}` : ''}`);
    console.log(`   Source: ${src.source || 'n/a'} - ${src.title || 'n/a'}`);
    console.log(`   Evidence: ${src.url || 'n/a'}`);
    console.log(`   Action: ${candidate.suggested_action}`);
  }
}

export async function discoverFundedCompanies(opts = {}) {
  const months = opts.months || DEFAULT_MONTHS;
  const sources = (opts.sources || DEFAULT_SOURCES).map(normalizeSourceName);
  const diagnostics = [...new Set(sources)].map(diagnostic);
  const hits = Array.isArray(opts.discoveryItems)
    ? opts.discoveryItems
    : await collectDiscoveryItems({ ...opts, months, sources }, diagnostics);
  const companies = buildCandidates(hits, {
    months,
    sort: opts.sort || DEFAULT_SORT,
    limit: opts.limit || DEFAULT_LIMIT,
    diagnostics,
  });

  return {
    generated_at: isoDate(),
    window_months: months,
    sort: opts.sort || DEFAULT_SORT,
    dry_run: Boolean(opts.dryRun),
    sources,
    diagnostics,
    companies,
  };
}

function isoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function selfTest() {
  const examples = [
    ['Prime Intellect raises $130M Series A', 'Prime Intellect'],
    ['AI coding startup Cursor maker Anysphere raises Series C funding', 'Anysphere'],
    ['Ex-DeepMind David Silver Raises $1.1B for AI Startup Ineffable', 'Ineffable'],
    ['Travis Kalanick&#8217;s robotics company raises $1.7B, led by a16z', ''],
    ['AI startup valuations raise bubble fears as funding surges', ''],
    ["Yann LeCun's AI startup raises $1B seed round", ''],
    ['Acme closes $25M Series A round', 'Acme'],
    ['Ask HN: Who is hiring?', ''],
  ];
  for (const [title, expected] of examples) {
    const got = extractCompanyFromFundingTitle(title);
    if (got !== expected) throw new Error(`extractCompanyFromFundingTitle(${JSON.stringify(title)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }

  const details = extractFundingDetails('Acme closes $25M Series A round');
  if (details.amount !== '$25M' || details.round !== 'Series A') {
    throw new Error(`extractFundingDetails failed: ${JSON.stringify(details)}`);
  }

  const candidates = buildCandidates([
    {
      source: 'techcrunch',
      title: 'Acme raises $25M Series B',
      url: 'https://techcrunch.com/acme',
      observedDate: { value: '2026-06-10', precision: 'day', date: new Date('2026-06-10T00:00:00Z') },
      text: 'Acme raises $25M Series B funding.',
      categories: ['Startups'],
    },
    {
      source: 'hacker_news',
      title: 'Startup raises seed funding in March 2026',
      url: 'https://news.ycombinator.com/item?id=2',
      observedDate: { value: '2026-03-10', precision: 'day', date: new Date('2026-03-10T00:00:00Z') },
      text: '',
      categories: [],
    },
  ], { months: 3, now: new Date('2026-07-20T00:00:00Z') });
  if (candidates.length !== 1 || candidates[0].company !== 'Acme') {
    throw new Error(`buildCandidates failed: ${JSON.stringify(candidates)}`);
  }

  console.log('company-funded self-test OK');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (opts.selfTest) {
    await selfTest();
    return;
  }
  const result = await discoverFundedCompanies(opts);
  if (!opts.dryRun) result.artifacts = writeArtifacts(result);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`company-funded: ${err.message}`);
    process.exit(1);
  });
}
