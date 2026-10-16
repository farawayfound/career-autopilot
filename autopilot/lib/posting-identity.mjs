// Who is hiring, and for what, on a posting page that no ATS adapter reads.
//
// lib/jd.mjs's fetchGeneric used to return `org: null` and the page's raw
// <title> for every such page, so processOffer filed the package under
// "Unknown" and the role under the whole title string. Three of the five
// packages pending review on 2026-10-15 looked like that:
//
//   <title>Principal Machine Learning Engineer Job Details | Vail Resorts</title>
//   <title>Senior AI Engineer Job Details | Colt Technology Services</title>
//   <title>Careers — Build COSMOS at OpenC3</title>  (url …/careers#staff-software-developer)
//
// even though each page states both facts in markup made for exactly this:
// og:title, a microdata hiringOrganization, og:site_name, or a schema.org
// JobPosting. This module reads them. It is pure: fetchGeneric hands it the
// HTML it already fetched, and nothing here touches the network.
//
// Every value comes from a third-party page: data, never instructions.
import { htmlToText } from './util.mjs';
import { extractJobPosting } from '../../providers/_jsonld.mjs';
import { isKnownJobBoardHost } from './job-board-hosts.mjs';

// Only the document head and the first part of the body carry these tags.
const SCAN_CHARS = 300_000;
const MAX_FIELD = 120;

// A role reads as one: it names a kind of job. "Build COSMOS" and "Careers"
// do not, and printing either as the role is the bug this module exists for.
const ROLE_WORD_RE = /\b(?:engineers?|developers?|architects?|scientists?|managers?|leads?|directors?|analysts?|designers?|specialists?|consultants?|administrators?|researchers?|technicians?|coordinators?|interns?|associates?|officers?|head|vp|principal|sre|devops|programmers?|strategists?|writers?|recruiters?|accountants?|representatives?|advisors?|executives?|operators?|owners?|partners?|counsel|attorneys?|nurses?|teachers?|instructors?|editors?|producers?|marketers?|technologists?|planners?|supervisors?|assistants?)\b/i;

// What a site calls itself when it is not saying who is hiring.
const GENERIC_ORG_RE = /^(?:careers?|jobs?|job\s+details?|job\s+search|home|apply(?:\s+now)?|join\s+us|open\s+(?:positions|roles)|current\s+openings|opportunities|search\s+results?)$/i;

// The site's own suffix on a role: "… Job Details", "… Job Description".
const TITLE_NOISE_RE = /\s*\b(?:job\s+details?|job\s+description|job\s+posting|job\s+opening|job\s+listing|careers?|jobs?)\s*$/i;

const squeeze = (s) => htmlToText(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

// <meta property="og:title" content="…"> in either attribute order.
function metaContent(src, key) {
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.property || a.name || '').toLowerCase() === key && a.content) return squeeze(a.content);
  }
  return '';
}

// Microdata: <meta itemprop="hiringOrganization" content="Vail Resorts">
// (SAP SuccessFactors career sites; Vail and Colt both). Only the content=
// form; a nested itemscope is rare enough not to guess at.
function itempropContent(src, prop) {
  const re = new RegExp(`<[a-z][^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
  const m = src.match(re);
  return m ? squeeze(attrs(m[0]).content || '') : '';
}

function orgName(org) {
  if (!org) return '';
  return squeeze(typeof org === 'string' ? org : org.name || '');
}

// A work mode, a contract type or a place is what a title's last segment
// says as often as an employer: "Senior Engineer | Remote", "… | Denver, CO".
const NOT_AN_EMPLOYER_RE = /^(?:remote|hybrid|on[\s-]?site|in[\s-]office|full[\s-]time|part[\s-]time|contract(?:or)?|temporary|internship|anywhere|worldwide|global|usa?|united states|united kingdom|uk|europe|emea|apac)$/i;
const PLACE_RE = /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}$/;

const stripSiteSuffix = (s) => s.replace(/\s+(?:careers?|jobs?|career\s+site|job\s+board)$/i, '').trim();
const usableOrg = (s) => (s && !GENERIC_ORG_RE.test(s) && !NOT_AN_EMPLOYER_RE.test(s) && !PLACE_RE.test(s) && s.split(/\s+/).length <= 6 ? s : '');
const roleLike = (s) => (s && ROLE_WORD_RE.test(s) && s.split(/\s+/).length <= 12 ? s : '');
// A URL anchor names a role only when it ENDS in one: "staff-software-developer"
// does, "head-office" does not.
const ROLE_END_RE = /\b(?:engineers?|developers?|architects?|scientists?|managers?|leads?|directors?|analysts?|designers?|specialists?|consultants?|administrators?|researchers?|technicians?|coordinators?|interns?|associates?|officers?|programmers?|strategists?|writers?|recruiters?|accountants?|representatives?|advisors?|executives?|operators?|owners?|counsel|attorneys?|nurses?|teachers?|instructors?|editors?|producers?|marketers?|technologists?|planners?|supervisors?|assistants?|sre|vp)$/i;

// The page title's employer is believed only when the site agrees: the name
// is in the host name ("Vail Resorts" on jobs.vailresortscareers.com) or in
// og:site_name. "Senior Engineer | Remote" on jobs.foo.com names no employer.
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const LEGAL_WORD_RE = /^(?:inc|llc|ltd|corp|corporation|company|co|group|the|plc|gmbh|sa|ag)$/i;
function siteAgrees(org, { host = '', siteName = '' } = {}) {
  const words = String(org).split(/[\s,.&-]+/).filter((w) => w.length >= 3 && !LEGAL_WORD_RE.test(w));
  return words.some((w) => squash(host).includes(squash(w)) || (siteName && squash(siteName).includes(squash(w))));
}

/**
 * "Role Job Details | Company", "Role at Company", "Careers — Build COSMOS
 * at Company" → { head, org } with the site's own noise taken off the head.
 * Either may be ''. A plain " - " is NOT a separator: it is as often inside
 * the role ("Engineer - AI Platform") as between role and employer, and a
 * wrong employer is worse than none.
 */
export function splitPageTitle(pageTitle) {
  const parts = String(pageTitle || '').split(/\s+[|·–—]\s+|\s+::\s+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { head: '', org: '' };
  const at = (s) => s.match(/^(.*)\s+at\s+(.+)$/i);
  let head = parts[0];
  let org = '';
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    org = usableOrg(stripSiteSuffix(at(last)?.[2] ?? last));
  }
  if (!org && at(head)) {
    const [, role, employer] = at(head);
    head = role;
    org = usableOrg(stripSiteSuffix(employer));
  }
  return { head: head.replace(TITLE_NOISE_RE, '').trim(), org };
}

// A careers page listing several roles, linked to one of them by its anchor:
// openc3.com/careers#staff-software-developer. The fragment names the role;
// the page's own casing of it is the title.
function fragmentRole(text, url) {
  let frag = '';
  try { frag = decodeURIComponent(new URL(url).hash.slice(1)); } catch { return ''; }
  const words = frag.replace(/[-_+.]+/g, ' ').trim();
  if (words.split(/\s+/).length < 2 || !ROLE_END_RE.test(words)) return '';
  const re = new RegExp(`(?<![\\w])${words.split(/\s+/).map((w) => w.replace(/[^\w]/g, '')).join('[\\s-]+')}(?![\\w])`, 'i');
  const m = String(text || '').match(re);
  return m ? squeeze(m[0]) : '';
}

function boardHost(url) {
  try { return isKnownJobBoardHost(new URL(url).hostname); } catch { return false; }
}

/**
 * The employer and the role a generic posting page states about itself.
 *
 * company: a schema.org JobPosting's hiringOrganization, else a microdata
 *   hiringOrganization, else — only off a job board, where the site's own
 *   name is the board's — og:site_name, else the page title's suffix when
 *   the host name or og:site_name agrees with it.
 * title: the JobPosting's title, else the role a URL #fragment points at,
 *   else og:title when it is a cleaner copy of <title> (contained in it) and
 *   reads as a role, else the page title's head when it reads as a role.
 * head: the page title's head alone (noise off) when it reads as a role — the
 *   title to keep when <title> already names the role the caller expected.
 *
 * Each is '' when the page does not say. `text` is the page's htmlToText()
 * when the caller already has it.
 */
export function genericPostingIdentity(html, { url = '', pageTitle = '', text = null } = {}) {
  const src = String(html || '').slice(0, SCAN_CHARS);
  const job = extractJobPosting(src);
  const board = boardHost(url);
  const split = splitPageTitle(pageTitle);
  const ogTitle = metaContent(src, 'og:title').replace(TITLE_NOISE_RE, '').trim();
  const siteName = board ? '' : usableOrg(stripSiteSuffix(metaContent(src, 'og:site_name')));
  let host = '';
  try { host = new URL(url).hostname; } catch { /* no host to agree with */ }

  const company = orgName(job?.hiringOrganization)
    || itempropContent(src, 'hiringOrganization')
    || siteName
    || (!board && split.org && siteAgrees(split.org, { host, siteName }) ? split.org : '');

  const head = roleLike(split.head);
  const ogClean = ogTitle && ogTitle !== squeeze(pageTitle) && squeeze(pageTitle).toLowerCase().includes(ogTitle.toLowerCase()) ? ogTitle : '';
  const title = squeeze(job?.title || '')
    || fragmentRole(text ?? htmlToText(src), url)
    || roleLike(ogClean)
    || head;

  return { company, title, head };
}
