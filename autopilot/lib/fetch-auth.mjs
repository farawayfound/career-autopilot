// Optional credentials for a small, operator-named allowlist of hosts —
// currently just LinkedIn, whose public jobs-guest API (see lib/jd.mjs) is
// what unblocked most email leads, but which still 429s/999s under load. A
// signed-in browser session behind that same URL sees the posting even then;
// this lets an operator hand fetchGeneric() that session's cookie for the
// rare fallback fetch, without ever risking it reaching a host they didn't
// name.
//
// Shape, opt-in and off by default — belongs in config/autopilot.local.yml
// (the gitignored overlay loadConfig() merges over config/autopilot.yml),
// never in the tracked base file:
//
//   fetch_auth:
//     - host: linkedin.com          # exact host, or any subdomain of it
//       cookie: "li_at=...; JSESSIONID=..."
//       headers:
//         x-li-lang: en_US
//
// Risk: sending a personal LinkedIn session cookie from automation can trip
// LinkedIn's anti-automation detection and get that account rate-limited or
// challenged — this is why it is opt-in, file-only, and never touches the
// dashboard (see lib/settings.mjs: fetch_auth is deliberately not in the
// EDITABLE registry, only its host list is exposed, read-only).
import { isForbiddenHost } from './url-guard.mjs';

// `new URL().hostname` never includes a port (host does) or userinfo (an
// old-style `https://user:pass@evil.com/` still resolves .hostname to
// `evil.com`) — using it, rather than parsing the raw string, is what makes
// the "port stripped" / "no userinfo tricks" guarantees below free.
function isIpLiteral(hostname) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4 literal
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true; // IPv6 literal
  return false;
}

// Never sends a cookie/header to anywhere the caller didn't explicitly name:
// exact-host or subdomain-of-host match only, on a label boundary (checked by
// string equality / a `.`-prefixed suffix, never `.endsWith(host)` alone —
// that would let `evillinkedin.com` match a configured `linkedin.com`), https
// only, and never an IP literal or a loopback/private/link-local address on
// either side of the comparison (the fetchAuth entry itself, or the URL being
// fetched) — the latter mostly redundant with fetchGeneric's own per-hop
// safeUrl() check, but this function has no guarantee of being called only
// from there.
export function authHeadersFor(url, fetchAuth) {
  if (!Array.isArray(fetchAuth) || !fetchAuth.length) return {};
  let parsed;
  try { parsed = new URL(String(url)); } catch { return {}; }
  if (parsed.protocol !== 'https:') return {};
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || isIpLiteral(hostname) || isForbiddenHost(hostname)) return {};

  for (const entry of fetchAuth) {
    if (!entry || typeof entry !== 'object') continue;
    const host = String(entry.host || '').trim().toLowerCase();
    if (!host || isIpLiteral(host)) continue;
    if (hostname !== host && !hostname.endsWith(`.${host}`)) continue;

    // { cookie: entry.cookie, ...entry.headers } — headers spread AFTER
    // cookie, so an (unusual) header literally named "cookie" wins, exactly
    // as the object-literal form reads.
    const out = {};
    if (entry.cookie !== undefined) out.cookie = entry.cookie;
    if (entry.headers && typeof entry.headers === 'object') {
      for (const [k, v] of Object.entries(entry.headers)) {
        if (v === undefined) continue;
        out[String(k).trim().toLowerCase()] = v;
      }
    }
    return out;
  }
  return {};
}
