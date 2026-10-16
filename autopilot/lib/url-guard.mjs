// SSRF / row-injection URL guard.
//
// Split out of leads.mjs (which still re-exports these for backward
// compatibility) because a second caller needed them without importing
// leads.mjs itself: lib/jd.mjs (fetchGeneric's per-hop redirect validation,
// see the fetch_auth work) already exports parseAtsUrl, which leads.mjs
// imports — importing leads.mjs back from jd.mjs would be a cycle.
import { isProcessableUrl } from './url-normalize.mjs';

// A literal newline, tab, other control char, bare space, or `|` in a URL
// would corrupt the pipe-delimited data/pipeline.md row or the tab-delimited
// data/scan-history.tsv row it gets written into — a newline specifically
// forges a brand-new `- [ ] https://...` line that parsePendingOffers' `^- \[
// \] (https?:\/\/\S+)` regex reads back as an unrelated pending entry. Checked
// against the raw string, never a `new URL()`-parsed one: the URL parser
// silently drops ASCII tab/newline rather than rejecting them.
function hasUnsafeUrlChars(v) {
  return /[\s\x00-\x1F\x7F|]/.test(String(v));
}

function parseIPv4Literal(host) {
  const m = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : parts;
}

// 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, and 100.64/10 (CGNAT —
// which also covers the tailnet's own 100.x addresses, exactly what an email
// link must never be able to reach).
function isForbiddenIPv4(parts) {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

// The IPv4 embedded in an IPv4-mapped IPv6 literal. `new URL()` always
// normalizes `::ffff:a.b.c.d` (any input form) to the all-hex serialization
// (e.g. `::ffff:7f00:1`), so that's the only shape that needs matching here.
function embeddedIPv4(addr) {
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

// ::1, ::, fe80::/10 (link-local), fc00::/7 (unique-local), and any
// IPv4-mapped literal whose embedded address is itself forbidden.
function isForbiddenIPv6(addrRaw) {
  const addr = String(addrRaw || '').toLowerCase().split('%')[0]; // drop a zone id
  if (!addr) return false;
  if (addr === '::1' || addr === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  const mapped = embeddedIPv4(addr);
  return mapped ? isForbiddenIPv4(mapped) : false;
}

// Literal-hostname checks only, deliberately no DNS resolution (the cycle's
// own fetchJobDetail already carries that exposure separately and is out of
// scope here). Loopback/private/link-local/CGNAT by address, plus localhost
// by name — none of these should ever be reachable from a link that arrived
// in an email.
//
// One trailing dot is the absolute spelling of the same name (`localhost.` and
// `foo.local.` resolve exactly like `localhost` and `foo.local`), so it is
// stripped before the name checks. `.local` is mDNS: a name that only ever
// resolves to a machine on the caller's own network, never to a job site.
export function isForbiddenHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const v4 = parseIPv4Literal(h);
  if (v4) return isForbiddenIPv4(v4);
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (bare.includes(':')) return isForbiddenIPv6(bare);
  return false;
}

// Single choke point every accepted/returned URL passes through: http(s)
// scheme + hostname (isProcessableUrl), not a forbidden host, and none of the
// row-corrupting characters above — always returned as the `new
// URL().toString()` normalized form, never the raw input, so nothing
// downstream ever writes an unparsed string. Null when any check fails.
export function safeUrl(candidate) {
  if (!isProcessableUrl(candidate) || hasUnsafeUrlChars(candidate)) return null;
  let parsed;
  try { parsed = new URL(String(candidate)); } catch { return null; }
  if (isForbiddenHost(parsed.hostname)) return null;
  return parsed.toString();
}
