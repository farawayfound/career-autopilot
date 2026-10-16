// autopilot/lib/hosted-url-policy.mjs — which URLs a HOSTED discovery find may carry.
//
// A leaf, on purpose, imported from BOTH ends of the hosted protocol:
//   * the CareerAutopilot server (autopilot/lib/discovery-user.mjs in the full
//     repository, which this package does not include) applies it to every find
//     a node submits, because the server fetches each accepted find on a schedule
//     with no click, for any free guest; and
//   * the discovery node itself (autopilot/discovery-node.mjs, which ships in the
//     public package) applies the SAME rules before it ships anything, so a find
//     the server is certain to refuse never leaves the machine — a refused
//     submission still spends a quarter-unit of the guest's daily allowance.
// Two copies would drift (a host added on one side only turns every find from
// that host into a quiet rejection), so there is one. Pure: no file access, no
// network, and only imports that already ship in the public package.
//
// What is accepted:
//   1. an ATS posting URL whose HOST is that ATS's own (the ATS fetchers call a
//      fixed API host built from the org and id — never the URL itself); or
//   2. a public listing host on GUEST_NODE_HOSTS. Those are fetched as plain
//      pages, with manual redirects and every hop re-validated (jd.mjs
//      fetchGeneric).
// The host test is on the STORED URL. parseAtsUrl matches its patterns anywhere
// in the string, so `https://evil.example/?u=boards.greenhouse.io/x/jobs/1`
// parses as a Greenhouse ref; checking the host is what stops that, and an
// embedded-board ref (a bare gh_jid on any site) is refused outright because its
// fetch falls back to the page itself.
import { parseAtsUrl } from './jd.mjs';
import { canonicalUrlForRef } from './lead-keys.mjs';
import { safeUrl } from './url-guard.mjs';

/** Longest URL a hosted find may carry (the server's NODE_URL_MAX is pinned equal by a test). */
export const HOSTED_URL_MAX = 2048;

export const ATS_HOSTS = {
  greenhouse: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/,
  lever: /^jobs(?:\.eu)?\.lever\.co$/,
  ashby: /^jobs\.ashbyhq\.com$/,
  workable: /^apply\.workable\.com$/,
  smartrecruiters: /^jobs\.smartrecruiters\.com$/,
  recruitee: /^[a-z0-9-]+\.recruitee\.com$/,
  workday: /^[a-z0-9-]+\.wd[a-z0-9-]*\.myworkdayjobs\.com$/,
  linkedin: /^www\.linkedin\.com$/, // always rewritten to https://www.linkedin.com/jobs/view/{id}/
};

/**
 * Public job-listing hosts a hosted find may point at when it is not an ATS
 * posting. `www` also admits the www. spelling, `subdomains` any subdomain, and
 * `path` narrows to the listing-page shape that host serves. The HOST is the
 * boundary; the path only keeps obvious non-listing URLs out.
 * Keep this in step with the boards the user example config enables
 * (config/discovery-node.user.example.yml): a board whose host is missing here
 * ships finds that the node drops as unsupported_host.
 */
export const GUEST_NODE_HOSTS = Object.freeze([
  { host: 'weworkremotely.com', www: true, path: /^\/remote-jobs\// },
  { host: 'remoteok.com', www: true, path: /^\/(?:remote-jobs|l)\// },
  { host: 'remoteok.io', www: true, path: /^\/(?:remote-jobs|l)\// },
  { host: 'remotive.com', www: true, path: /^\/(?:remote-jobs|remote\/jobs)\// },
  { host: 'news.ycombinator.com', path: /^\/item$/ },
  { host: 'ycombinator.com', www: true, path: /^\/companies\/[^/]+\/jobs\// },
  { host: 'jobs.workable.com', path: /^\/view\// },
  { host: 'europa.eu', path: /^\/eures\// },
  { host: 'applytojob.com', subdomains: true, path: /^\/apply\// },
  { host: 'himalayas.app', path: /^\/companies\/[^/]+\/jobs\// },
  { host: 'jobicy.com', path: /^\/jobs?\// },
  { host: 'themuse.com', www: true, path: /^\/jobs\// },
  { host: 'workingnomads.com', www: true, path: /^\/jobs\// },
  { host: 'nodesk.co', path: /^\/remote-jobs\// },
  { host: 'jobspresso.co', path: /^\/(?:job|jobs|remote-jobs)\// },
  { host: '4dayweek.io', path: /^\/(?:remote-)?jobs?\// },
  { host: 'arbeitnow.com', www: true, path: /^\/jobs\// },
  { host: 'agentic-engineering-jobs.com', www: true },
]);

function hostMatchesRule(rule, host) {
  if (host === rule.host) return true;
  if (rule.www && host === `www.${rule.host}`) return true;
  return rule.subdomains === true && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) && host.endsWith(`.${rule.host}`);
}

/**
 * Does a SANITIZED find ({canonicalUrl, ref}) satisfy the hosted host policy?
 * The server calls this on sanitizeFind's `find`; checkHostedUrl builds the same
 * pair from a bare URL.
 */
export function hostedUrlAllowed(find) {
  let url;
  try { url = new URL(find.canonicalUrl); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const ref = find.ref;
  if (ref) {
    if (ref.embedded === true) return false;
    const re = ATS_HOSTS[ref.ats];
    return Boolean(re) && re.test(host);
  }
  return GUEST_NODE_HOSTS.some((rule) => hostMatchesRule(rule, host) && (!rule.path || rule.path.test(url.pathname)));
}

/**
 * The whole hosted URL policy for one raw URL: https only, no port, no
 * userinfo, at most 2048 characters, a public address, then the host rules
 * above. This is the URL half of the server's sanitizeFind(…, {hosted: true})
 * followed by hostedUrlAllowed (a test in the full repository pins the two to the
 * same verdict over a corpus), minus the bits that need the server's own
 * modules: the dead-host list is subsumed by the allowlist (a refused host gets
 * `unsupported_host` here where the server says `dead_host`; both are refusals).
 *
 * @param {unknown} rawUrl
 * @returns {{ok: true, canonicalUrl: string, ref: object|null} | {ok: false, reason: string}}
 *   `reason` is one of malformed | url_too_long | invalid_url | bad_url | unsupported_host.
 */
export function checkHostedUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return { ok: false, reason: 'malformed' };
  // Length first: safeUrl and parseAtsUrl run regexes over the whole string.
  if (rawUrl.length > HOSTED_URL_MAX) return { ok: false, reason: 'url_too_long' };
  const safe = safeUrl(rawUrl);
  if (!safe) return { ok: false, reason: 'invalid_url' };
  const parsed = new URL(safe);
  if (parsed.username || parsed.password) return { ok: false, reason: 'bad_url' };
  if (parsed.protocol !== 'https:' || parsed.port || parsed.hostname.endsWith('.')) return { ok: false, reason: 'bad_url' };
  let ref = null;
  try { ref = parseAtsUrl(safe); } catch { ref = null; }
  const canonicalUrl = canonicalUrlForRef(ref) || safe;
  if (!hostedUrlAllowed({ canonicalUrl, ref })) return { ok: false, reason: 'unsupported_host' };
  return { ok: true, canonicalUrl, ref };
}
