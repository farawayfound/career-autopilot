// Fetch full job detail (JD text, location, questions, comp) straight from
// ATS APIs. A 404 from the API is the liveness signal: posting is gone.
import dns from 'node:dns';
import { isIP } from 'node:net';
import { htmlToText } from './util.mjs';
import { parseWorkdayJobUrl } from '../../providers/workday.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../../providers/_http.mjs';
import { providerFetchContext, isBlockedAddress } from '../../providers/_ip-guard.mjs';
import { safeUrl } from './url-guard.mjs';
import { authHeadersFor } from './fetch-auth.mjs';
import { readLeadCapture, jdFromLeadCapture } from './lead-capture.mjs';
import { rateLimitedError, isRateLimited } from './fetch-pacing.mjs';
import { extractJobPosting, compactSalary } from '../../providers/_jsonld.mjs';
import { genericPostingIdentity } from './posting-identity.mjs';

const TIMEOUT_MS = 15_000;

// Workday error codes confirmed (live, 2026-09-17) to mean "this posting is
// gone" rather than "something about our request was rejected": S22, seen on
// both an unpublished posting and an invite-only one. A generic API-gateway
// 403 envelope — `{errorCode, httpStatus, message}` is a common convention,
// not a Workday-specific one — could share this exact two-field shape for a
// reason that has nothing to do with the posting (a different WAF rule, a
// missing session cookie, IP reputation). Matching on shape alone would let
// any of those permanently retire a still-live row on the very first
// response, with no reopen path. Requiring the errorCode to be one actually
// observed to mean "gone" costs nothing on the case this fix exists for and
// closes that hole; extend this set only when a new code is confirmed live,
// the same way S22 was.
const WORKDAY_GONE_CODES = new Set(['S22']);

async function getJson(url, extraHeaders = {}, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'career-ops/1.0 (+local job-search assistant)',
        ...extraHeaders,
      },
    });
    if (res.status === 404) return { notFound: true };
    // A 429 is a statement about our request rate, never about the posting —
    // typed separately so it rides the pacer's cluster-wide cooldown/retry
    // (autopilot.mjs) instead of the plain failed-xN strike machinery below.
    if (res.status === 429) throw rateLimitedError(url, res);
    // Diagnosed live on the autopilot host 2026-09-17: Workday answers 403 for a posting
    // that has been unpublished (or made invite-only), where Greenhouse/Lever
    // answer 404 for the same situation — confirmed by re-fetching the exact
    // same externalPath the CXS *listing* endpoint had just returned 200 for,
    // and by a listing search showing the req was no longer posted. Callers
    // that know their 403 body carries Workday's own JSON error shape (today
    // only the workday branch below) opt in with `deniedIsGone`; every other
    // caller is unaffected — a 403 for them still throws exactly as before.
    // Detection requires BOTH the shape and a known code, not shape alone: the
    // observed body was `{"errorCode":"S22","httpStatus":403,"message":"permission
    // denied"}`. A 403 whose body doesn't parse as JSON, isn't an object, or
    // carries an `errorCode` outside WORKDAY_GONE_CODES (an unrelated gateway's
    // `{errorCode,httpStatus}` 403, an HTML Cloudflare/WAF challenge page, an
    // empty body) falls through to the generic throw below and stays in the
    // transient `failed xN` lane, because that one is a bad day, not a verdict
    // about the posting.
    if (res.status === 403 && opts.deniedIsGone) {
      let body = null;
      try { body = await res.json(); } catch { /* not JSON — not Workday's shape */ }
      if (body && typeof body === 'object' && body.httpStatus === 403 && WORKDAY_GONE_CODES.has(body.errorCode)) {
        return { denied: true };
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return { json: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

export function parseAtsUrl(url) {
  let m = url.match(/(?:boards|job-boards)(\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#&]+)(?:\/jobs\/(\d+))?/);
  if (m) {
    const id = m[3] || (url.match(/gh_jid=(\d+)/) || [])[1];
    if (id) return { ats: 'greenhouse', org: m[2], id, eu: Boolean(m[1]) };
  }
  m = url.match(/jobs(\.eu)?\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (m) return { ats: 'lever', org: m[2], id: m[3], eu: Boolean(m[1]) };
  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (m) return { ats: 'ashby', org: m[1], id: m[2] };
  m = url.match(/apply\.workable\.com\/([^/?#]+)\/(?:j|jobs\/view)\/([a-z0-9]+)/i);
  if (m) return { ats: 'workable', org: m[1], id: m[2] };
  // SmartRecruiters publishes two shapes, and the API path is the same for both:
  //   /{Org}/postings/{id}   ← current (3 segments)
  //   /{Org}/{id}-{slug}     ← legacy  (2 segments)
  // The `postings/` segment must be optional AND consumed. Without that, m[2]
  // captured the literal word "postings", neither id pattern matched it, and the
  // `|| m[2]` fallback produced id === 'postings' → a doubled API path
  // (/companies/{Org}/postings/postings) that SmartRecruiters answers with HTTP
  // 400, not 404 — so it threw instead of reading as a liveness signal, and the
  // offer was retried every cycle forever.
  m = url.match(/(?:jobs\.smartrecruiters\.com|api\.smartrecruiters\.com\/v1\/companies)\/([^/?#]+)\/(?:postings\/)?([^/?#]+)/i);
  if (m) {
    const id = m[2].match(/^([0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1]
      || m[2].match(/^(\d+)/)?.[1]
      || m[2];
    if (id.toLowerCase() !== 'postings') return { ats: 'smartrecruiters', org: m[1], id };
  }
  m = url.match(/https?:\/\/([a-z0-9-]+)\.recruitee\.com\/o\/([^/?#]+)/i);
  if (m) return { ats: 'recruitee', org: m[1], id: m[2] };
  // Workday: the posting is a client-rendered SPA, so the generic fetch only
  // ever saw the empty shell (<400 chars → "unsupported"). The public CXS
  // detail endpoint carries the full JD. `org` must be set — fetchJobDetail
  // dereferences ref.org before dispatching on ats.
  const wd = parseWorkdayJobUrl(url);
  if (wd) return { ats: 'workday', org: wd.tenant, id: wd.externalPath, ...wd };

  // LinkedIn: the email-leads pipeline's biggest single source of dead
  // fetches. A bare fetchGeneric() of /jobs/view/{id} gets LinkedIn's
  // auth-wall sign-in page (a real HTML document, well over the 400-char
  // floor) instead of the posting, and that page silently scored 1/5
  // "requires sign-in" — permanently, because "requires sign-in" is not a
  // `failed xN` reason (see isTransientSkip in lib/discovery.mjs). The
  // public jobs-guest API (fetchJobDetail below) needs no auth at all.
  //
  // Any subdomain (www, a country code, or none), an optional `comm/`
  // prefix, and an optional descriptive slug before the id — LinkedIn emits
  // all of these. Host and path come from an actual URL parse, never from a
  // substring scan of the raw string: a linkedin/whatjobs ref REWRITES the
  // stored lead URL downstream (canonicalUrlForRef in lib/leads.mjs), so a
  // full ATS URL smuggled inside another host's query string
  // (tracker.example.com/click?u=http://whatjobs.com/gfj/123...) must never
  // fabricate a ref — it would silently replace the lead's real destination
  // and collapse distinct leads into one dedup key.
  let parsedUrl = null;
  try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
  const host = parsedUrl ? parsedUrl.hostname.toLowerCase() : '';
  const hostIs = (base) => host === base || host.endsWith(`.${base}`);
  if (parsedUrl && hostIs('linkedin.com')) {
    m = parsedUrl.pathname.match(/^\/(?:comm\/)?jobs\/view\/(?:[a-z0-9-]*-)?(\d{6,})(?:\/|$)/i);
    if (m) return { ats: 'linkedin', id: m[1] };
    // The other shape LinkedIn issues a job link in: a /jobs/search or
    // /jobs/collections page with the id only in the query string.
    if (/^\/jobs(?:\/|$)/i.test(parsedUrl.pathname)) {
      const jobId = parsedUrl.searchParams.get('currentJobId') || '';
      if (/^\d{6,}$/.test(jobId)) return { ats: 'linkedin', id: jobId };
    }
  }

  // WhatJobs: the email-leads pipeline's other major dead-end redirect
  // source. An alert email links a job as
  // whatjobs.com/jbe__cpl__{digits}?...&keyword=Title-Slug — that URL serves
  // an HTML bouncer page with NO HTTP redirect, so generic redirect-
  // resolution leaves it exactly as-is and a plain fetch sees a useless ~5KB
  // shell. /gfj/{digits} is the endpoint that actually 302s to the public
  // whatjobs.com/jobs/...?...&id={digits} posting page (see fetchJobDetail
  // below) — both URL shapes name the same posting id.
  if (parsedUrl && hostIs('whatjobs.com')) {
    m = parsedUrl.pathname.match(/^\/(?:gfj\/(\d{6,})|jbe__cpl__(\d{6,}))(?:\/|$)/i);
    if (m) return { ats: 'whatjobs', id: m[1] || m[2] };
  }

  // Company-hosted / embedded Greenhouse boards. The JD lives on the company's
  // own domain (<div id="grnhse_app"> filled in by boards.greenhouse.io's embed
  // script), so only the query string carries the ATS identity:
  //   coreweave.com/careers/job?4692028006&board=coreweave&gh_jid=4692028006
  //   stripe.com/jobs/search?gh_jid=8044460
  //   job-boards.greenhouse.io/embed/job_app?for=stripe&token=8044460
  // Greenhouse's own boards-api returns these as `absolute_url`, so the scanner
  // writes them into pipeline.md verbatim. Without this branch they fell through
  // to fetchGeneric, which scraped the client-rendered shell and returned the
  // site-wide <title> as the role for EVERY posting on that site.
  // Checked last so a real ATS-hosted URL always wins first.
  const ghId = (url.match(/[?&](?:gh_jid|token)=(\d+)/i) || [])[1];
  if (ghId) {
    const board = (url.match(/[?&](?:board|for)=([A-Za-z0-9_.-]+)/i) || [])[1] || null;
    // org may be null — fetchJobDetail resolves it via the embed redirect.
    return { ats: 'greenhouse', org: board, id: ghId, eu: /\.eu\.greenhouse\.io/i.test(url), embedded: true };
  }
  return null;
}

// A bare gh_jid does not name a board. Greenhouse's legacy embed endpoint answers
// that: GET /embed/job_app?token=<id> 301s to ...?for=<board>&token=<id>. Header
// only — the body is never fetched.
async function resolveGreenhouseBoard(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(id)}`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'career-ops/1.0 (+local job-search assistant)' },
    });
    return (String(res.headers.get('location') || '').match(/[?&]for=([A-Za-z0-9_.-]+)/) || [])[1] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Pick a URL the apply worker can actually fill.
//
// For an EMBEDDED board, `absolute_url` points back at the customer's own site
// (coreweave.com/careers/job?...), which hosts no <form> — the embed script
// injects one at runtime. The obvious substitute, /{org}/jobs/{id}, does not
// help either: on an embedded board it 302-redirects straight back to that same
// company page. Measured across coreweave/stripe/elastic, /{org}/jobs/{id}
// served 0-1 file inputs and zero `first_name` fields, while
// /embed/job_app?for={org}&token={id} served a real form every time (2 file
// inputs, 8 first_name fields). So embedded boards must use the embed endpoint.
//
// Natively-hosted boards are left alone: there /{org}/jobs/{id} carries the
// form itself (verified on anthropic), and `absolute_url` is already correct.
export function greenhouseApplyUrl(ref, json = {}) {
  if (ref.embedded) {
    return `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(ref.org)}&token=${encodeURIComponent(ref.id)}`;
  }
  const abs = String(json.absolute_url || '');
  if (/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io/i.test(abs)) return abs;
  return `https://job-boards${ref.eu ? '.eu' : ''}.greenhouse.io/${ref.org}/jobs/${ref.id}`;
}

const textFrom = (...values) => values
  .flat(Infinity)
  .filter(Boolean)
  .map((value) => htmlToText(typeof value === 'string' ? value : value.text || value.description || ''))
  .filter(Boolean)
  .join('\n\n');

function questionFrom(source) {
  return {
    label: source.label || source.question || source.body || source.name || '',
    required: Boolean(source.required || source.mandatory),
    type: source.type || source.kind || 'input_text',
    values: (source.values || source.options || source.choices || [])
      .map((value) => value.label ?? value.name ?? value.value ?? String(value)),
  };
}

// Does this page actually talk about the role the scanner found?
//
// Token overlap, not exact containment: a real JD page routinely renders the
// role with different punctuation, or without a trailing "(Remote)" or level
// suffix, so a strict substring match would reject good postings. Requiring most
// of the distinctive words still rules out a client-rendered board shell, which
// shares none of them. Returns true when there is nothing meaningful to check,
// so a posting with no scanner title behaves exactly as it did before.
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'our', 'you', 'are', 'job', 'jobs', 'role', 'remote', 'careers']);
export function pageMentionsRole(pageText, expectTitle, threshold = 0.6) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = [...new Set(norm(expectTitle).split(' '))].filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  if (tokens.length < 2) return true; // not enough signal to judge — don't block
  const body = ` ${norm(pageText)} `;
  const hits = tokens.filter((t) => body.includes(` ${t} `)).length;
  return hits / tokens.length >= threshold;
}

// Deterministic sign-in-wall detection, checked BEFORE the 400-char floor and
// before an LLM ever sees the page: a LinkedIn (or similar) auth wall is a
// real, substantial HTML document — nav, marketing copy, a sign-in form — so
// it clears the floor easily and used to get triaged and scored as if it were
// the posting (permanently: "requires sign-in" is not a `failed xN` reason,
// so isTransientSkip in lib/discovery.mjs never retried it). Checked against
// the URL first (cheap, and immune to a page's own copy mentioning "login" in
// a footer link); `looksLikeAuthWallPage` below is the fallback for a wall
// that answers 200 at the posting's own URL instead of redirecting.
// Tested against the PATHNAME alone, as whole path segments — never the
// hostname. An earlier draft matched a bare \bcheckpoint\b against
// hostname+pathname, which permanently retired every posting from any
// employer whose DOMAIN contains such a word (careers.checkpoint.com is a
// real company). A whole path segment is a claim the site makes about the
// page; a hostname substring is just somebody's name.
const AUTH_WALL_PATH_PATTERNS = [
  /\/authwall(?:\/|$)/i,
  /\/uas\/login(?:\/|$)/i,
  /\/signin(?:\/|$)/i,
  /\/login(?:\/|$)/i,
  /\/account\/login(?:\/|$)/i,
];
// "checkpoint" is an ordinary word as well as LinkedIn's challenge
// interstitial (/checkpoint/…) — trusted as a wall signal only on
// LinkedIn's own hosts.
const LINKEDIN_WALL_PATH_RE = /\/checkpoint(?:\/|$)/i;
export function isAuthWallUrl(urlStr) {
  let parsed;
  try { parsed = new URL(String(urlStr)); } catch { return false; }
  const path = parsed.pathname;
  if (AUTH_WALL_PATH_PATTERNS.some((re) => re.test(path))) return true;
  const host = parsed.hostname.toLowerCase();
  return (host === 'linkedin.com' || host.endsWith('.linkedin.com'))
    && LINKEDIN_WALL_PATH_RE.test(path);
}
// LinkedIn's own sign-in form names its password field `session_password` but
// keeps `session_key` (the email/username field) as the more stable tell
// across their form revisions; a bare password input covers every other
// site's wall the same way.
function looksLikeAuthWallPage(html) {
  return /<input\b[^>]*\btype="password"/i.test(html) || /\bname="session_key"/i.test(html);
}
const AUTH_WALL_RESULT = () => ({ live: null, ats: 'generic', text: null, unsupported: true, reason: 'requires sign-in' });

// Redirects a page may take before we give up. The platform's own `follow`
// allows 20; 5 (inherited from the rarely used fetch_auth loop) retired a real
// posting behind an http → https → www → locale → canonical chain as
// permanently unsupported with no stated reason. 10 is generous for any real
// careers page and still bounds a loop; the whole walk shares one timeout.
const GENERIC_MAX_HOPS = 10;
const GENERIC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) career-ops';
const LOOKUP_TIMEOUT_MS = 5_000;

// Does this hostname resolve to an address nothing here may connect to?
//
// The check that matters runs at DIAL time: providers/_dns-cache.mjs patches
// dns.lookup process-wide and, for any request made inside
// providerFetchContext, refuses a private/loopback/link-local/CGNAT answer —
// which is also rebinding-safe, since the address validated is the address
// dialled (see providers/_ip-guard.mjs). fetchGeneric runs every hop inside
// that context, so a single-label name like `intranet`, a tailnet `*.ts.net`
// name or a `.local` name that resolves privately never gets a connection.
//
// That patch has one off switch, CAREER_OPS_NO_DNS_CACHE=1, and with it set the
// dial-time guard does not exist. Only in that configuration this resolves the
// name itself first — and fails CLOSED, because the one layer that would have
// caught a rebind is the layer that is off. With the guard installed (the
// default) this returns false without a lookup, so a normal fetch costs nothing
// extra and the existing offline tests need no resolver.
export async function hostResolvesPrivate(hostname, lookup = dns.promises.lookup) {
  if (process.env.CAREER_OPS_NO_DNS_CACHE !== '1') return false;
  const bare = String(hostname || '').replace(/^\[|\]$/g, '');
  if (isIP(bare)) return isBlockedAddress(bare);
  let timer;
  try {
    const answers = await Promise.race([
      lookup(bare, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lookup timeout')), LOOKUP_TIMEOUT_MS); }),
    ]);
    return !Array.isArray(answers) || answers.length === 0 || answers.some((a) => isBlockedAddress(a?.address));
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// A Location header, the way the platform reads one. Header values reach JS as
// a latin1 view of the raw bytes, so a server that sends `/jobs/développeur`
// unencoded (some Apache and PHP sites do) arrives as mojibake; undici re-reads
// the bytes as UTF-8 before it follows a redirect, and a hand-rolled walk has to
// do the same or it builds a different URL (`d%C3%83%C2%A9veloppeur`), usually a
// 404, and retires a live posting as closed. Only a value that is entirely
// within latin1 and has a non-ASCII byte is re-read; plain ASCII (the normal
// case) and anything a header could not carry are returned as they are.
export function decodeLocationHeader(value) {
  const raw = String(value);
  return /[^\x00-\x7f]/.test(raw) && !/[^\x00-\xff]/.test(raw)
    ? Buffer.from(raw, 'latin1').toString('utf8')
    : raw;
}

// One page fetch with every redirect hop handled HERE, never by the platform:
// each hop is re-validated by safeUrl (scheme, literal loopback/private
// addresses, row-corrupting characters) and by the resolved-address guard
// above before any socket opens, and the chain is bounded. `redirect:
// 'follow'` validated only the first URL — a public page that 302s to
// http://169.254.169.254/ was fetched without a second look.
//
// The credential (config's `fetch_auth`, empty for every caller but the
// LinkedIn jobs-guest fallback) is recomputed per hop, so a redirect that
// leaves the authorized host silently carries none. Resolves {res, finalUrl},
// or {reason} when a hop was refused or the chain never settled — a stated
// reason, because the offer is retired for good on it.
async function fetchGenericPage(url, { auth, signal, lookup }) {
  let current = url;
  for (let hop = 0; hop < GENERIC_MAX_HOPS; hop++) {
    const safe = safeUrl(current);
    // safeUrl matches `localhost` by exact name, so `localhost.` (a valid
    // absolute name that resolves to loopback) gets through it; the dial-time
    // guard would still stop the connection, this stops the request.
    const host = safe ? new URL(safe).hostname : '';
    if (!safe || host.endsWith('.') || await hostResolvesPrivate(host, lookup)) {
      return { reason: hop === 0 ? 'URL is not a public http(s) address' : 'redirect to a non-public address refused' };
    }
    const res = await providerFetchContext.run({ url: safe }, () => fetch(safe, {
      signal,
      redirect: 'manual',
      headers: { 'user-agent': GENERIC_USER_AGENT, ...authHeadersFor(safe, auth) },
    }));
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let next = null;
      if (location) { try { next = new URL(decodeLocationHeader(location), safe).toString(); } catch { next = null; } }
      // No (usable) Location: hand the 3xx back — it reads as not-ok below.
      if (!next) return { res, finalUrl: safe };
      current = next;
      continue;
    }
    return { res, finalUrl: safe };
  }
  return { reason: `more than ${GENERIC_MAX_HOPS} redirects` };
}

// Non-ATS URLs: fetch the page itself and strip to text so any posting is
// evaluable. The apply worker treats these as assisted-fill only.
//
// opts.auth (config's `fetch_auth` array — see lib/fetch-auth.mjs) is empty
// for every caller today except the LinkedIn jobs-guest fallback, and stays
// empty unless an operator opts in. opts.lookup is a test seam for the
// resolved-address check (hostResolvesPrivate).
async function fetchGeneric(url, { expectTitle = '', auth = [], lookup } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const page = await fetchGenericPage(url, { auth, signal: controller.signal, lookup });
    if (page.reason) return { live: null, ats: 'generic', text: null, unsupported: true, reason: page.reason };
    const { res, finalUrl } = page;

    // Liveness outranks the wall: a 404/410 means the posting is gone, and
    // "closed" is the truthful label even when the dead URL is login-shaped.
    if (res.status === 404 || res.status === 410) return { live: false, ats: 'generic' };
    if (isAuthWallUrl(finalUrl)) return AUTH_WALL_RESULT();
    // A 429 is a statement about our request rate, not about the posting —
    // returning `unsupported` here checked the row off permanently as
    // unfetchable (27 Workday postings on 2026-09-15 were one Cloudflare/WAF
    // mood away from exactly that). Throw instead so it rides the pacer's
    // cluster-wide cooldown/retry and offerFailure's deferral, never a
    // permanent triage-out.
    if (res.status === 429) throw rateLimitedError(finalUrl, res);
    if (!res.ok) return { live: null, ats: 'generic', text: null, unsupported: true };
    const html = await res.text();
    const text = htmlToText(html);
    if (text.length < 400) return { live: null, ats: 'generic', text: null, unsupported: true };
    // A wall that answered 200 at the posting's own URL rather than
    // redirecting. A bare password field is NOT proof by itself — corporate
    // career pages routinely embed an "existing applicant sign-in" widget
    // next to a full JD — so the tell only counts when the page also fails
    // to look like the posting: the expected role is absent, or (with no
    // title to check against) the whole stripped page is too short to be a
    // JD. The bias is deliberate: a missed wall costs one triage call and a
    // 1/5 score, exactly the pre-fix behavior; a false positive permanently
    // retires a real posting with no retry.
    const roleAbsent = expectTitle ? !pageMentionsRole(text, expectTitle) : text.length < 1500;
    if (looksLikeAuthWallPage(html) && roleAbsent) {
      return AUTH_WALL_RESULT();
    }
    const pageTitle = htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 120);

    // The 400-char floor is a liveness heuristic, not a relevance check: a
    // client-rendered careers shell (nav + marketing copy + footer) clears it
    // easily and yields the site-wide <title> as the "role". Evaluating that
    // scores the company's homepage, not a job description — and every posting
    // on that site collapses to one identical item. The scanner already parsed
    // the true title into pipeline.md, so if the fetched page doesn't contain
    // it, we did not get the JD. Refuse rather than invent.
    if (expectTitle && !pageMentionsRole(text, expectTitle)) {
      return {
        live: null, ats: 'generic', text: null, unsupported: true,
        reason: 'page does not mention the expected role (client-rendered board shell?)',
      };
    }
    // Even when the body checks out, prefer the scanner's title over a
    // board-level <title> like "Explore Our Open Positions | CoreWeave".
    // lib/posting-identity.mjs: the employer and a clean role from the page's own markup.
    const identity = genericPostingIdentity(html, { url, pageTitle, text });
    const title = (expectTitle && !pageMentionsRole(pageTitle, expectTitle)) ? expectTitle : ((expectTitle && identity.head) || identity.title || pageTitle);
    return {
      live: true, ats: 'generic', org: identity.company || null, title, location: '',
      text: text.slice(0, 60_000), questions: [], comp: null, updatedAt: null,
      applyUrl: url, verificationNote: 'generic fetch — liveness unconfirmed',
    };
  } catch (err) {
    // A RateLimitedError thrown above (the 429 branch) must escape this
    // catch-all, not be swallowed back into `unsupported` — that would
    // silently undo the whole point of throwing it (a permanent check-off
    // instead of a retryable deferral). Every other thrown failure (DNS,
    // abort, a reset socket) still becomes `unsupported`, exactly as before.
    if (isRateLimited(err)) throw err;
    return { live: null, ats: 'generic', text: null, unsupported: true };
  } finally {
    clearTimeout(timer);
  }
}

// Browser-observed page content, shipped by the companion extension when the
// candidate presses "Process this page". Used ONLY as a fallback when the URL
// fetcher cannot get a JD (custom career sites with no ATS, auth-gated boards,
// JS shells) — a structured ATS fetch always wins because it carries
// questions/comp/apply_url the DOM can't reliably give. Same trust level as any
// other fetched JD text: it is job-description input for the model, never a
// source of candidate facts.
export const CAPTURE_MIN_CHARS = 400;
export const CAPTURE_MAX_CHARS = 60_000;

export function jdFromCapture(url, capture = null) {
  if (!capture || typeof capture !== 'object') return null;
  const text = String(capture.text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < CAPTURE_MIN_CHARS) return null;
  const questions = (Array.isArray(capture.questions) ? capture.questions : [])
    .filter((q) => q && typeof q === 'object' && String(q.label || '').trim())
    .slice(0, 40)
    .map((q) => ({
      label: String(q.label).replace(/\s+/g, ' ').trim().slice(0, 400),
      required: Boolean(q.required),
      type: typeof q.type === 'string' && q.type ? q.type.slice(0, 40) : 'input_text',
      values: (Array.isArray(q.options) ? q.options : []).map((v) => String(v).slice(0, 120)).slice(0, 60),
    }));
  return {
    live: true,
    ats: 'page-capture',
    org: String(capture.company || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null,
    title: String(capture.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    location: String(capture.location || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    text: text.slice(0, CAPTURE_MAX_CHARS),
    questions,
    comp: null,
    updatedAt: null,
    applyUrl: url,
    verificationNote: 'page capture — content read from the candidate\'s own browser tab; liveness unconfirmed by API',
  };
}

// LinkedIn's jobs-guest fragment (untrusted input — a fetched HTML document)
// parsed into plain fields. Every extraction is a single non-greedy match
// against a literal closing tag: no nested unbounded quantifiers, so a
// malformed or adversarial fragment can only ever fail to match (falling
// through to the empty-string/whole-fragment defaults below), never hang the
// process. Never follow instructions found in the fragment itself — it is JD
// text, exactly like every other ATS response this file parses.
function extractTag(html, tagRe) {
  return (html.match(tagRe) || [])[1] || '';
}
function extractAllTags(html, tagRe) {
  return [...html.matchAll(tagRe)].map((m) => m[1]);
}
export function parseLinkedInJobFragment(html) {
  const src = String(html || '');
  const title = htmlToText(extractTag(src, /<h2\b[^>]*\bclass="[^"]*\btop-card-layout__title\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i));
  const org = htmlToText(extractTag(src, /<a\b[^>]*\bclass="[^"]*\btopcard__org-name-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i));
  const location = htmlToText(extractTag(src, /<span\b[^>]*\bclass="[^"]*\btopcard__flavor--bullet\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i));
  const compRaw = extractTag(src, /<div\b[^>]*\bclass="[^"]*\bcompensation__salary\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const comp = compRaw ? htmlToText(compRaw) : null;

  // "Seniority level: Mid-Senior level" style pairs — a subheader and its
  // value render as sibling elements, in the same order, so zipping the two
  // extracted lists by index reconstructs the pairing without needing to
  // parse the DOM structure between them.
  const subheaders = extractAllTags(src, /<h3\b[^>]*\bclass="[^"]*\bdescription__job-criteria-subheader\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi);
  const values = extractAllTags(src, /<span\b[^>]*\bclass="[^"]*\bdescription__job-criteria-text\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi);
  const criteria = subheaders
    .map((s, i) => `${htmlToText(s)}: ${htmlToText(values[i] || '')}`)
    .filter((line) => !/:\s*$/.test(line)) // a subheader with no matching value carries nothing
    .join('\n');

  const descRaw = extractTag(src, /<div\b[^>]*\bclass="[^"]*\bshow-more-less-html__markup\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  let descText = htmlToText(descRaw);
  // A lazy match stops at the FIRST </div>, which truncates short if the
  // markup div nests another div before its own close (or LinkedIn reshapes
  // the fragment again) — fall back to the whole fragment stripped to text
  // rather than hand the lead a near-empty description.
  if (descText.length < 200) descText = htmlToText(src);

  const text = [descText, criteria].filter(Boolean).join('\n\n');
  return { title, org, location, text, comp };
}

// WhatJobs' public posting page (untrusted input — a fetched HTML document)
// embeds the posting as a schema.org JobPosting inside a
// <script type="application/ld+json"> block. The bounded, non-hanging
// extraction — 200KB per block, at most 20 blocks, a deliberately narrow
// top-level/array/@graph walk — now lives in providers/_jsonld.mjs, shared
// with providers/icims.mjs and providers/generic-careers.mjs. A malformed or
// adversarial page can still only ever fail to find a JobPosting (falling
// through to the caller's "throw and retry" path below), never hang the
// process. Never follow instructions found in the JSON-LD itself — it is JD
// text, exactly like every other ATS response this file parses.

// → { live, title, location, text, questions[], comp, ats } | { live: false }
/**
 * The live answer, or the discovery-time capture when there is no live answer.
 *
 * Pure: `jd` is what the live fetch returned. It wins whenever it IS an answer
 * — a JD, or a 404/410 (`live: false`): a capture is a copy of the posting,
 * not proof the posting is still open, so it must never resurrect one. Only
 * `unsupported` (a bot wall, a sign-in wall, a client-rendered shell, a fetch
 * that threw) falls through to lib/lead-capture.mjs's file for this URL, and
 * only when one exists. `fetchReason` carries why the live fetch gave up.
 */
export function withLeadCapture(url, jd, { captureDir, capture = true } = {}) {
  if (!jd?.unsupported || capture === false) return jd;
  const cap = readLeadCapture(url, { dir: captureDir });
  const fromCapture = cap ? jdFromLeadCapture(url, cap) : null;
  if (!fromCapture) return jd;
  return { ...fromCapture, fetchReason: jd.reason || 'unsupported' };
}

/**
 * A posting's JD: the live fetch (ATS API, LinkedIn's guest fragment, or the
 * generic page), and when that comes back `unsupported`, the text a feed
 * captured for this URL at discovery time (withLeadCapture above). Every
 * reader — the triage pre-pass, processOffer's own fetch, the interview-prep
 * backfill — gets the fallback through this one call. `opts.captureDir`
 * overrides the capture directory (tests); `opts.capture: false` skips it.
 */
export async function fetchJobDetail(url, opts = {}) {
  return withLeadCapture(url, await fetchJobDetailLive(url, opts), opts);
}

async function fetchJobDetailLive(url, opts = {}) {
  const ref = parseAtsUrl(url);
  if (!ref) return fetchGeneric(url, opts);
  // An embedded board may carry gh_jid without naming its board; resolve it
  // before orgName below dereferences ref.org. If it can't be resolved, fall
  // back to the generic path — where the title guard now catches a shell page.
  if (ref.ats === 'greenhouse' && !ref.org) {
    ref.org = await resolveGreenhouseBoard(ref.id);
    if (!ref.org) return fetchGeneric(url, opts);
  }

  // LinkedIn carries no org slug (unlike every other ATS ref) — returned
  // ahead of orgName below, which dereferences ref.org unconditionally.
  if (ref.ats === 'linkedin') {
    const api = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${ref.id}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(api, {
        signal: controller.signal,
        headers: {
          'user-agent': BROWSER_LIKE_USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 410) return { live: false, ats: 'linkedin' };
    if (!res.ok) {
      // jobs-guest needs no auth of its own, so a non-200/404/410 here
      // (429, or LinkedIn's own 999) is a bad day for LinkedIn's rate
      // limiter, not a verdict about the posting. Only when the operator
      // configured LinkedIn auth is a credentialed page fetch worth the
      // extra request; otherwise a rate-limit status rides the pacer's
      // cluster-wide cooldown/retry and offerFailure's deferral (never a
      // failed-xN strike, and never the permanent triage-out a plain
      // `unsupported` result would be) — any other non-ok status still rides
      // the existing failed-xN retry machinery in autopilot.mjs.
      if (Object.keys(authHeadersFor(url, opts.auth)).length) {
        return fetchGeneric(`https://www.linkedin.com/jobs/view/${ref.id}/`, { expectTitle: opts.expectTitle, auth: opts.auth });
      }
      if (res.status === 429 || res.status === 999) throw rateLimitedError(api, res);
      throw new Error(`HTTP ${res.status} from ${api}`);
    }
    const html = await res.text();
    const parsed = parseLinkedInJobFragment(html);
    // LinkedIn sometimes answers 200 with an interstitial/sign-in page instead
    // of the posting (no 404/410, no auth-wall markup jobs-guest recognizes as
    // such) — a real posting always carries the title heading, so its absence
    // means we did not get the JD. Throw rather than return it live-with-text:
    // that would otherwise get LLM-evaluated as a role literally named "Sign
    // in". Throwing rides the same failed-xN transient retry lane as the
    // non-ok branch above — another chance after a cooldown, not a permanent
    // triage-out. A real dead posting already returned via the 404/410 check.
    // When the operator configured LinkedIn credentials, a credentialed page
    // fetch is worth trying first — same recovery the non-ok branch above
    // uses; a 200-interstitial is the same wall wearing a different status.
    if (!parsed.title) {
      if (Object.keys(authHeadersFor(url, opts.auth)).length) {
        return fetchGeneric(`https://www.linkedin.com/jobs/view/${ref.id}/`, { expectTitle: opts.expectTitle, auth: opts.auth });
      }
      throw new Error('linkedin jobs-guest returned a page with no posting title (rate-limited or interstitial)');
    }
    return {
      live: true,
      ats: 'linkedin',
      org: parsed.org,
      title: parsed.title,
      location: parsed.location,
      text: parsed.text,
      questions: [],
      comp: parsed.comp,
      updatedAt: null,
      applyUrl: `https://www.linkedin.com/jobs/view/${ref.id}/`,
      verificationNote: 'linkedin jobs-guest fetch',
    };
  }

  // WhatJobs also carries no org slug (id only, like LinkedIn above) —
  // returned ahead of orgName below, which dereferences ref.org
  // unconditionally.
  if (ref.ats === 'whatjobs') {
    const gfjUrl = `https://www.whatjobs.com/gfj/${ref.id}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(gfjUrl, {
        signal: controller.signal,
        headers: {
          'user-agent': BROWSER_LIKE_USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 410) return { live: false, ats: 'whatjobs' };
    // 403 is a fetch verdict, not a bad day. whatjobs put the whole site
    // behind a Cloudflare JS challenge (`Cf-Mitigated: challenge`, observed
    // 2026-08-31): every /gfj/ id 403s identically for any plain HTTP
    // client, browser headers included, and stayed that way across hours —
    // retrying the same request cannot ever succeed. Riding the failed-xN
    // lane here burned the full three strikes on 38 leads across three bulk
    // runs in one evening, then parked them as transient-looking `failed x3`
    // skips that a `skipped`-status re-run would restart from strike one.
    // Returning `unsupported` instead makes it a first-touch skip whose
    // reason marks it unfetchable, at the cost of one cheap HTTP request per
    // lead — if the challenge is ever lifted, new leads flow again with no
    // code change. Deliberately NOT extended to fetchGeneric: an employer
    // page's 403 carries no such structural evidence.
    if (res.status === 403) {
      return {
        live: null, ats: 'whatjobs', text: null, unsupported: true,
        reason: 'blocked: HTTP 403 (bot challenge)',
      };
    }
    // Remaining error statuses (429/5xx — rate limit, outage) really are a
    // bad day for whatjobs, not a verdict about the posting: without this,
    // a non-redirected error response falls through the no-id?= check below
    // and reads as confirmed-dead. A 429 rides the pacer's cluster-wide
    // cooldown/retry and offerFailure's deferral; any other non-ok status
    // still throws so it rides the failed-xN retry lane, same as the
    // LinkedIn branch above.
    if (res.status === 429) throw rateLimitedError(gfjUrl, res);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${gfjUrl}`);
    const finalUrl = res.url || gfjUrl;
    // An expired/unknown id 302s to a generic /jobs/... search page with no
    // id= query param (and no JobPosting block) — that IS how whatjobs
    // answers a dead id, not a fetch failure. Landing on the bare homepage is
    // the same signal in different clothes.
    let hasId = false;
    let path = '';
    try {
      const parsed = new URL(finalUrl);
      hasId = parsed.searchParams.has('id');
      path = parsed.pathname;
    } catch { /* malformed final URL — treated as expired below */ }
    if (!hasId || path === '/' || path === '') return { live: false, ats: 'whatjobs' };
    const html = await res.text();
    const job = extractJobPosting(html);
    // No JobPosting found on a page that DID carry id= is a parser/layout
    // miss (whatjobs reshaped the page, or served something unexpected), not
    // a verdict about the posting — throw so this rides the failed-xN
    // transient retry lane (isTransientSkip in lib/discovery.mjs) instead of
    // a permanent triage-out. A real dead posting already returned above.
    if (!job) throw new Error('whatjobs: no JobPosting JSON-LD found on an id= page');
    const address = (job.jobLocation && job.jobLocation.address) || {};
    const location = [address.addressLocality, address.addressRegion]
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => htmlToText(v))
      .join(', ');
    return {
      live: true,
      ats: 'whatjobs',
      org: job.hiringOrganization?.name ? htmlToText(String(job.hiringOrganization.name)) : null,
      title: htmlToText(String(job.title || '')),
      location,
      text: htmlToText(String(job.description || '')),
      questions: [],
      comp: job.baseSalary ? compactSalary(job.baseSalary) : null,
      updatedAt: job.datePosted || null,
      applyUrl: finalUrl,
      verificationNote: 'whatjobs JSON-LD fetch',
    };
  }

  const orgName = ref.org.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  if (ref.ats === 'greenhouse') {
    // ONE boards-api host, for EU boards too. `boards-api.eu.greenhouse.io`
    // does not exist — no A record anywhere, ENOTFOUND (verified 2026-09-15):
    // Greenhouse's EU data-residency split covers the job-board PAGES
    // (job-boards.eu.greenhouse.io, which greenhouseApplyUrl still builds), and
    // the public boards API serves an EU board from this host with its
    // questions intact (Proton 4739749101, Speechmatics 4950383101: 200). The
    // old code asked the `.eu` API host first and fell back only on a 404 — a
    // thrown ENOTFOUND never reached the fallback, so every EU Greenhouse
    // posting failed as a bare `fetch failed` on every cycle for as long as its
    // row lived (Speechmatics / Proton: 9–10 strikes each over the first
    // fortnight of 2026-09) and was parked as `failed x3`.
    const api = `https://boards-api.greenhouse.io/v1/boards/${ref.org}/jobs/${ref.id}?questions=true`;
    const { json, notFound } = await getJson(api);
    // A board resolved by redirect (rather than named by ?board=) can be wrong.
    // Degrade to the generic path instead of declaring the posting dead, which
    // would check the row off in pipeline.md irreversibly.
    if (notFound) return ref.embedded ? fetchGeneric(url, opts) : { live: false, ats: 'greenhouse' };
    const comp = (json.pay_input_ranges || []).map((r) =>
      `${r.title || ''} ${r.min_cents ? '$' + Math.round(r.min_cents / 100).toLocaleString() : ''}-${r.max_cents ? '$' + Math.round(r.max_cents / 100).toLocaleString() : ''} ${r.currency_type || ''}`.trim()
    ).join('; ') || null;
    return {
      live: true,
      org: orgName,
      ats: 'greenhouse',
      title: json.title,
      location: json.location?.name || '',
      text: htmlToText(json.content || ''),
      questions: (json.questions || []).map((q) => ({
        label: q.label,
        required: Boolean(q.required),
        type: q.fields?.[0]?.type || 'input_text',
        values: (q.fields?.[0]?.values || []).map((v) => v.label ?? v.value ?? String(v)),
      })),
      comp,
      updatedAt: json.updated_at || null,
      applyUrl: greenhouseApplyUrl(ref, json),
    };
  }

  if (ref.ats === 'workday') {
    // GET {origin}/wday/cxs/{tenant}/{site}{externalPath} → { jobPostingInfo }.
    // Browser-like headers: some tenants sit behind Cloudflare bot management
    // that 500s a bare fetch (see providers/workday.mjs).
    const api = `${ref.origin}/wday/cxs/${ref.tenant}/${ref.site}${ref.externalPath}`;
    const { json, notFound, denied } = await getJson(api, {
      'user-agent': BROWSER_LIKE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      origin: ref.origin,
      referer: `${ref.jobUrl}/`,
    }, { deniedIsGone: true });
    // A shape-matched 403 (see getJson) is the same "posting is gone" verdict
    // a 404 already is — not a fetch failure to retry.
    if (denied) return { live: false, ats: 'workday' };
    const info = notFound ? null : json?.jobPostingInfo;
    if (!info) return { live: false, ats: 'workday' };
    // hiringOrganization.name is the legal entity ("FREEDOM SOLUTIONS GR" for
    // Litera) — the tenant slug is the brand recruiters and the tracker use.
    const location = [info.location, info.additionalLocations?.length ? `+${info.additionalLocations.length} more` : '']
      .filter(Boolean).join(' ');
    return {
      live: true,
      org: orgName,
      ats: 'workday',
      title: info.title || '',
      location: location || info.locationsText || '',
      text: htmlToText(info.jobDescription || ''),
      questions: [], // Workday's questionnaire renders only inside the authenticated apply flow
      comp: null,
      updatedAt: info.startDate || null,
      // The browsed URL minus /apply/…: keeps the locale segment so the queue
      // item matches the tab the companion is sitting on.
      applyUrl: ref.jobUrl,
      jobReqId: info.jobReqId || null,
    };
  }

  if (ref.ats === 'lever') {
    // EU tenants are served from api.eu.lever.co; hitting the US host 404s,
    // which reads as "posting closed" and silently checks the row off.
    const { json, notFound } = await getJson(`https://api${ref.eu ? '.eu' : ''}.lever.co/v0/postings/${ref.org}/${ref.id}`);
    if (notFound) return { live: false, ats: 'lever' };
    const lists = (json.lists || []).map((l) => `${l.text}\n${htmlToText(l.content || '')}`).join('\n\n');
    const text = [json.descriptionPlain || htmlToText(json.description || ''), lists, json.additionalPlain || ''].filter(Boolean).join('\n\n');
    const sr = json.salaryRange;
    return {
      live: true,
      org: orgName,
      ats: 'lever',
      title: json.text,
      location: json.categories?.location || '',
      text,
      questions: [], // Lever exposes questions on the /apply page only
      comp: sr ? `${sr.currency || 'USD'} ${Number(sr.min).toLocaleString()}-${Number(sr.max).toLocaleString()} (${sr.interval || ''})` : null,
      updatedAt: json.createdAt ? new Date(json.createdAt).toISOString() : null,
      applyUrl: json.applyUrl || `https://jobs.lever.co/${ref.org}/${ref.id}/apply`,
    };
  }

  if (ref.ats === 'ashby') {
    // Ashby posting list API includes descriptions per job.
    const { json, notFound } = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${ref.org}?includeCompensation=true`);
    if (notFound) return { live: false, ats: 'ashby' };
    const job = (json.jobs || []).find((j) => (j.jobUrl || '').toLowerCase().includes(ref.id.toLowerCase()));
    if (!job) return { live: false, ats: 'ashby' };
    return {
      live: true,
      org: orgName,
      ats: 'ashby',
      title: job.title,
      location: job.location || '',
      text: htmlToText(job.descriptionHtml || job.descriptionPlain || ''),
      questions: [], // Ashby application questions render client-side only
      comp: job.compensation?.compensationTierSummary || null,
      updatedAt: job.publishedAt || null,
      applyUrl: (job.jobUrl ? job.jobUrl + '/application' : url),
    };
  }

  if (ref.ats === 'workable') {
    const { json, notFound } = await getJson(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(ref.org)}?details=true`,
    );
    if (notFound) return { live: false, ats: 'workable' };
    const jobs = json.jobs || json.results || [];
    const job = jobs.find((item) =>
      String(item.shortcode || item.id || '').toLowerCase() === ref.id.toLowerCase()
      || String(item.url || item.shortlink || '').toLowerCase().includes(ref.id.toLowerCase()));
    if (!job) return { live: false, ats: 'workable' };
    const location = typeof job.location === 'string'
      ? job.location
      : [job.location?.city, job.location?.region, job.location?.country]
        .filter(Boolean).join(', ');
    const salary = job.salary || job.salary_range;
    const comp = typeof salary === 'string' ? salary
      : salary ? [salary.currency, salary.min, salary.max, salary.period].filter((v) => v != null).join(' ') : null;
    return {
      live: job.state ? /published|open/i.test(job.state) : true,
      org: json.name || json.account?.name || orgName,
      ats: 'workable',
      title: job.title,
      location,
      text: textFrom(job.description, job.full_description, job.requirements, job.benefits),
      questions: (job.questions || []).map(questionFrom),
      comp,
      updatedAt: job.updated_at || job.published_on || job.created_at || null,
      applyUrl: job.application_url || job.apply_url || `${url.replace(/\/$/, '')}/apply`,
    };
  }

  if (ref.ats === 'smartrecruiters') {
    const { json, notFound } = await getJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(ref.org)}/postings/${encodeURIComponent(ref.id)}`,
    );
    if (notFound) return { live: false, ats: 'smartrecruiters' };
    const sections = json.jobAd?.sections || {};
    const location = [
      json.location?.city,
      json.location?.region,
      json.location?.country,
      json.location?.remote ? 'Remote' : null,
    ].filter(Boolean).join(', ');
    const salary = json.compensation || json.salary;
    return {
      live: json.active !== false,
      org: json.company?.name || orgName,
      ats: 'smartrecruiters',
      title: json.name || json.title,
      location,
      text: textFrom(
        sections.companyDescription,
        sections.jobDescription,
        sections.qualifications,
        sections.additionalInformation,
      ),
      questions: [],
      comp: typeof salary === 'string' ? salary
        : salary ? [salary.currency, salary.min || salary.minimum, salary.max || salary.maximum]
          .filter((v) => v != null).join(' ') : null,
      updatedAt: json.releasedDate || json.updatedDate || null,
      applyUrl: json.applyUrl || json.ref || url,
    };
  }

  // Recruitee careers-site API supports an offer ID or slug without auth.
  const { json, notFound } = await getJson(
    `https://${ref.org}.recruitee.com/api/offers/${encodeURIComponent(ref.id)}`,
  );
  if (notFound) return { live: false, ats: 'recruitee' };
  const job = json.offer || json;
  return {
    live: !job.status || job.status === 'published',
    org: job.company_name || orgName,
    ats: 'recruitee',
    title: job.title,
    location: typeof job.location === 'string'
      ? job.location
      : [job.location?.city, job.location?.country].filter(Boolean).join(', '),
    text: textFrom(job.description, job.requirements, job.additional_information),
    questions: (job.open_questions || job.questions || []).map(questionFrom),
    comp: job.salary || job.salary_range || null,
    updatedAt: job.updated_at || job.published_at || job.created_at || null,
    applyUrl: job.careers_apply_url || `${url.replace(/\/$/, '')}/c/new`,
  };
}
