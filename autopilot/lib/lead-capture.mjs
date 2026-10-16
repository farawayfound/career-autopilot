// autopilot/lib/lead-capture.mjs — a posting's text captured at DISCOVERY
// time, for hosts whose listing pages cannot be fetched afterwards.
//
// WeWorkRemotely is the motivating case (2026-09-15): its category RSS feeds
// are public and every <item>'s <description> carries the full posting, but
// the per-listing page the feed links to sits behind a Cloudflare "Just a
// moment…" challenge (HTTP 403 to any plain fetch). The aggregator used to
// keep exactly the one URL that can never be read again and throw away the
// one payload it could have used: 118 WWR rows retired as `unfetchable` on
// the autopilot host, none of them ever triaged. So the aggregator now writes the feed
// text here, keyed by the posting URL, and lib/jd.mjs's fetchJobDetail falls
// back to it when — and only when — the live fetch comes back `unsupported`
// (blocked, walled, a client-rendered shell). A 404/410 still wins: a capture
// is a copy of the posting, not proof that it is still open.
//
// Keyed by URL rather than by pipeline row, on purpose: every reader of a
// posting — the triage pre-pass, processOffer's own fetch on a direct or
// re-processed run, the interview-prep JD backfill — reaches it through the
// same fetchJobDetail(url) call with no new plumbing, and a row's URL is the
// one thing all of them already have.
//
// Same trust level as any other fetched JD text (AGENTS.md "Untrusted
// External Content"): posting input for the model, never candidate facts.
//
// Files: data/lead-captures/{key}.json — user layer, machine-written,
// gitignored, pruned by the aggregator run after LEAD_CAPTURE_MAX_AGE_DAYS.
// ONE directory, shared by the admin's and every guest's discovery run, on
// purpose: a capture is the public feed's copy of a public posting, identical
// for whoever reads the feed, with nothing of the reader in it — the same
// shape as data/cache/ats-companies/, not data/users/<uid>/. A guest's cycle
// writes and reads it like the admin's, and DELETE /api/users/:uid has
// nothing here to purge.
import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { p, readJsonSafe, writeJson } from './util.mjs';

export const LEAD_CAPTURES_REL = 'data/lead-captures';
// The same floor lib/jd.mjs's page captures use: a teaser is not a posting.
export const LEAD_CAPTURE_MIN_CHARS = 400;
export const LEAD_CAPTURE_MAX_CHARS = 60_000;
export const LEAD_CAPTURE_MAX_AGE_DAYS = 45;
const STRIP_PARAMS = /^(utm_[a-z]+|ref|source|src|fbclid|gclid|mc_cid|mc_eid)$/i;

const dirOf = (dir) => dir || p('data', 'lead-captures');

/**
 * The capture key for a posting URL: host (no www.), path (no trailing slash)
 * and the query minus tracking params, hashed. Two spellings of one listing
 * (with/without utm_*, a trailing slash, WWW) share a key; two listings never
 * do. `null` for anything `new URL()` cannot parse.
 */
export function leadCaptureKey(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !STRIP_PARAMS.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return createHash('sha1').update(`${host}${path}${query ? `?${query}` : ''}`).digest('hex').slice(0, 16);
}

export function leadCapturePath(url, { dir } = {}) {
  const key = leadCaptureKey(url);
  return key ? join(dirOf(dir), `${key}.json`) : null;
}

/** Normalize a capture's text the way jdFromCapture (lib/jd.mjs) does. */
const cleanText = (text) => String(text || '')
  .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Store a posting captured at discovery time. Refuses anything shorter than
 * LEAD_CAPTURE_MIN_CHARS and leaves an existing capture alone when its text is
 * unchanged, so a feed re-read every cycle never rewrites hundreds of
 * identical files. Never throws: a capture that fails to write costs nothing
 * but the fallback it would have provided, and a discovery pass must not.
 *
 * @returns {{written: boolean, path?: string, reason?: string}}
 */
export function writeLeadCapture(
  { url, company = '', title = '', location = '', text = '', source = 'feed', postedAt = null } = {},
  { dir, now = new Date() } = {},
) {
  const path = leadCapturePath(url, { dir });
  if (!path) return { written: false, reason: 'bad url' };
  const body = cleanText(text);
  if (body.length < LEAD_CAPTURE_MIN_CHARS) return { written: false, reason: 'too short', path };
  const clipped = body.slice(0, LEAD_CAPTURE_MAX_CHARS);
  try {
    const existing = existsSync(path) ? readJsonSafe(path, null) : null;
    if (existing && existing.text === clipped) {
      // Not rewritten, but SEEN: pruneLeadCaptures reads mtime as "last seen
      // in a feed", and a posting that stays listed unchanged for 45 days is
      // exactly the one whose capture must not expire out from under it.
      try { utimesSync(path, now, now); } catch { /* best-effort */ }
      return { written: false, reason: 'unchanged', path };
    }
    const posted = postedAt != null ? new Date(postedAt) : null;
    writeJson(path, {
      version: 1,
      url: String(url),
      company: oneLine(company, 120),
      title: oneLine(title, 200),
      location: oneLine(location, 200),
      text: clipped,
      source: String(source || 'feed').slice(0, 60),
      posted_at: posted && Number.isFinite(posted.getTime()) ? posted.toISOString() : null,
      captured_at: now.toISOString(),
    });
    return { written: true, path };
  } catch (err) {
    return { written: false, reason: String(err?.message || err).slice(0, 120), path };
  }
}

/** The stored capture for a URL, or null. */
export function readLeadCapture(url, { dir } = {}) {
  const path = leadCapturePath(url, { dir });
  if (!path || !existsSync(path)) return null;
  const cap = readJsonSafe(path, null);
  if (!cap || typeof cap !== 'object' || typeof cap.text !== 'string') return null;
  return cap;
}

/**
 * A capture as the JD shape fetchJobDetail returns — the page-capture shape
 * (lib/jd.mjs jdFromCapture) with its own `ats`, so a report, an archive and
 * a log line can say where the text came from. No screening questions (a
 * feed carries none), apply URL = the listing, liveness unconfirmed.
 */
export function jdFromLeadCapture(url, cap) {
  if (!cap || typeof cap !== 'object') return null;
  const text = cleanText(cap.text);
  if (text.length < LEAD_CAPTURE_MIN_CHARS) return null;
  const day = String(cap.captured_at || '').slice(0, 10) || 'an unknown date';
  return {
    live: true,
    ats: 'lead-capture',
    org: oneLine(cap.company, 120) || null,
    title: oneLine(cap.title, 200),
    location: oneLine(cap.location, 200),
    text: text.slice(0, LEAD_CAPTURE_MAX_CHARS),
    questions: [],
    comp: null,
    updatedAt: cap.captured_at || null,
    applyUrl: String(url),
    verificationNote: `${cap.source || 'feed'} capture — posting text read from the discovery feed on ${day}; `
      + 'the listing page itself could not be fetched, so liveness is unconfirmed',
  };
}

/**
 * Drop captures older than `maxAgeDays` by file mtime — a capture is only
 * rewritten when its text changed, so mtime reads as "last seen in a feed".
 * Best-effort; returns how many were removed.
 */
export function pruneLeadCaptures({ dir, maxAgeDays = LEAD_CAPTURE_MAX_AGE_DAYS, now = Date.now() } = {}) {
  const d = dirOf(dir);
  if (!existsSync(d)) return 0;
  const cutoff = now - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(d)) {
    if (!name.endsWith('.json')) continue;
    const full = join(d, name);
    try {
      if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++; }
    } catch { /* a file that vanished mid-sweep is already pruned */ }
  }
  return removed;
}
