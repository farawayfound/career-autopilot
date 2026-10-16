// @ts-check
/**
 * autopilot/lib/discovery-preferences.mjs — the candidate's stated location and
 * work-authorization preferences, as deterministic scoring signals for the
 * discovery node.
 *
 * TWO THINGS REACHED THE NODE BEFORE THIS FILE, AND NEITHER WAS ENOUGH.
 *
 * 1. `location_filter` — carried to the node verbatim inside the hub's
 *    `portals_yml` text, but read only by the SCANNER (scripts/scan/scan.mjs's
 *    buildLocationFilter, deciding what enters the pipeline at all). `scoreFind`
 *    never looked at it; the node ranked locations against its OWN
 *    `rank.local_terms` / `rank.remote_us_terms` lists plus a hardcoded
 *    NON_US_HINTS penalty list. Those two views of the same question disagreed,
 *    and the disagreement was expensive: NON_US_HINTS contains `london`,
 *    `dublin`, `ireland` and `united kingdom`, so every posting in a city the
 *    candidate actively WANTS was docked `non_us_only: -25` — 25 points against
 *    a ship threshold of 40. The hub-side twin of this bug (always_allow feeding
 *    `accepted` while `openToInternational` stayed false, scoring every London
 *    posting 0 at a pre-model gate) is being fixed in parallel; this is the same
 *    bug on the node.
 *
 * 2. The Profile tab's 96 answers — 14 of which are literally the questions
 *    "remote, hybrid or onsite?", "will you relocate?", "do you need
 *    sponsorship?" — reached the node not at all. `buildProfileBlock()`
 *    (autopilot/lib/discovery-node-ingest.mjs) forwarded exactly three keys:
 *    location, compensation, target_roles. A candidate could answer
 *    "Remote only" and "I need sponsorship" on the dashboard and the node would
 *    go on ranking a non-sponsoring onsite role in another state as a fine
 *    match.
 *
 * So: `location_filter`'s three ranking tiers (`primary` / `authorized` /
 * `sponsor_required`) and a strictly-bounded slice of the Profile answers are
 * parsed here into signals `scoreFind` adds to its existing additive score.
 *
 * WHAT IS DELIBERATELY NOT FORWARDED. `citizenship`, `security_clearance` and
 * `desired_salary` are marked `ai_context: false` in
 * autopilot/lib/profile-questions.mjs — they exist to autofill a form the
 * candidate is already filling in, never to feed a model or a ranking. They are
 * not in FORWARDED_PREFERENCE_IDS and must not be added to it. Comp is handled
 * separately and on purpose: the node's floor comes from
 * `config/profile.yml`'s `compensation.minimum`, never from the Profile tab's
 * `desired_salary`.
 *
 * Everything here is pure string/number logic — no network, no model, no clock
 * (AGENTS.md's zero-LLM constraint on the discovery node). JD text read here is
 * untrusted posting content: DATA, never instructions.
 */

/**
 * The Profile-tab answer ids the hub forwards to a discovery node.
 *
 * An allowlist, never a denylist: a question added to PROFILE_QUESTIONS later
 * is invisible to the node until someone puts it here on purpose, which is the
 * safe direction when the catalog also holds home addresses, demographics and
 * salary expectations. Every id below is a work-location or work-authorization
 * question with `ai_context` left on.
 *
 * NOT EVERY FORWARDED ANSWER IS SCORED, and that is deliberate rather than an
 * oversight. Three of them are carried so the node's own rendered profile.yml
 * shows what it believes about the candidate — which is how you debug a
 * surprising score on the box — but none is a usable ranking input:
 * `work_authorization` is a bare Yes/No whose "this country" is whichever form
 * the candidate was filling in, with no country attached for a scorer to
 * compare against; `visa_status` and `needs_sponsorship_future` describe a
 * status rather than a fact about any posting; `timezone` and
 * `commute_radius_miles` would need geocoding the node deliberately has no
 * means to do. The scored ones are `work_location_preference`,
 * `willing_to_relocate`, `willing_to_travel_pct`, `needs_sponsorship`, and
 * `authorized_in` from config/profile.yml.
 *
 * @type {string[]}
 */
export const FORWARDED_PREFERENCE_IDS = [
  'work_location_preference',
  'willing_to_relocate',
  'commute_radius_miles',
  'willing_to_travel_pct',
  'timezone',
  'work_authorization',
  'needs_sponsorship',
  'needs_sponsorship_future',
  'visa_status',
];

/** @param {unknown} list @returns {string[]} */
function stringList(list) {
  return (Array.isArray(list) ? list : [])
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * The three RANKING tiers out of a portals.yml `location_filter` block.
 *
 * These sit alongside the existing gate keys (`always_allow` / `allow` /
 * `block` / `block_hard`) and never gate anything themselves — by the time a
 * row reaches the node's scorer the scanner's own filter has already decided
 * it was worth surfacing. Absent keys yield empty lists, which make every
 * matcher below inert and leave scoring exactly as it was.
 *
 * @param {object|null} portalsDoc - The parsed hub `portals.yml` document.
 * @returns {{primary: string[], authorized: string[], sponsorRequired: string[]}}
 */
export function parseLocationPolicy(portalsDoc) {
  const lf = (portalsDoc && typeof portalsDoc === 'object' && portalsDoc.location_filter) || {};
  return {
    primary: stringList(lf.primary),
    authorized: stringList(lf.authorized),
    sponsorRequired: stringList(lf.sponsor_required),
  };
}

/**
 * The preference block the hub sends to a node, from the two places the
 * candidate's answers actually live.
 *
 * `config/profile.yml` is the authored file (AGENTS.md's user layer, never
 * machine-written); `answers` is the Profile tab's stored map on
 * `data/user-profile.json`. Where both speak, profile.yml wins — it is the
 * file the candidate wrote by hand, and the one every other career-ops surface
 * already treats as the source of truth.
 *
 * @param {object|null} profileYml - The parsed `config/profile.yml`.
 * @param {Record<string, unknown>|null} answers - Profile-tab `answers` map.
 * @returns {object} A flat, JSON-safe block. Unknown/blank values are null,
 *   never omitted, so the criteria hash is stable across runs.
 */
export function buildPreferenceBlock(profileYml, answers) {
  const loc = (profileYml && profileYml.location) || {};
  const comp = (profileYml && profileYml.compensation) || {};
  const a = (answers && typeof answers === 'object') ? answers : {};

  /** @param {string} id */
  const answer = (id) => {
    if (!FORWARDED_PREFERENCE_IDS.includes(id)) return null; // belt and braces
    const v = a[id];
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  };

  // profile.yml's `needs_sponsorship` is a real boolean; the Profile tab's is
  // the string 'Yes'/'No'. Normalize to a boolean-or-null so one consumer
  // handles both, and so "unanswered" stays distinguishable from "No".
  let needsSponsorship = null;
  if (typeof loc.needs_sponsorship === 'boolean') needsSponsorship = loc.needs_sponsorship;
  else {
    const raw = answer('needs_sponsorship');
    if (raw === 'Yes') needsSponsorship = true;
    else if (raw === 'No') needsSponsorship = false;
  }

  return {
    work_location_preference: answer('work_location_preference'),
    willing_to_relocate: answer('willing_to_relocate'),
    willing_to_travel_pct: answer('willing_to_travel_pct'),
    commute_radius_miles: answer('commute_radius_miles'),
    timezone: answer('timezone') ?? (typeof loc.timezone === 'string' ? loc.timezone : null),
    work_authorization: answer('work_authorization'),
    needs_sponsorship: needsSponsorship,
    needs_sponsorship_future: answer('needs_sponsorship_future'),
    visa_status: (typeof loc.visa_status === 'string' && loc.visa_status.trim())
      ? loc.visa_status.trim()
      : answer('visa_status'),
    authorized_in: stringList(loc.authorized_in),
    location_flexibility: (typeof comp.location_flexibility === 'string' && comp.location_flexibility.trim())
      ? comp.location_flexibility.trim()
      : null,
  };
}

// ── Posting-text signals ──────────────────────────────────────────────────
//
// Matched against the SAME normalized haystack scoreFind already builds
// (location + title + a 400-char JD snippet, lowercased, whitespace-collapsed).
// Every pattern below is deliberately narrow: a miss costs nothing (no signal),
// a false positive costs a real posting, so ambiguity resolves to silence.

/**
 * A posting that states it will not sponsor. Requires an explicit negation
 * next to the sponsorship word — "sponsorship" alone appears just as often in
 * postings that DO sponsor, and in boilerplate equal-opportunity paragraphs.
 */
export const NO_SPONSORSHIP_RE =
  /(?:not?(?:\s+be)?\s+(?:able|willing)\s+to\s+sponsor|unable\s+to\s+sponsor|(?:do(?:es)?|will|can)\s*n(?:o|')t\s+(?:offer\s+|provide\s+)?sponsor|(?:do(?:es)?|will|can)\s+not\s+(?:offer\s+|provide\s+)?sponsor|no\s+(?:visa\s+)?sponsorship|without\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship|sponsorship\s+is\s+not\s+(?:available|offered|provided))/;

/** A posting that states it WILL sponsor — the mirror signal. */
export const SPONSORSHIP_OFFERED_RE =
  /(?:(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided|possible)|(?:we|will)\s+(?:can\s+)?sponsor|open\s+to\s+sponsor|happy\s+to\s+sponsor|relocation\s+and\s+(?:visa\s+)?sponsorship)/;

/**
 * A negation sitting just before a match, in the SAME clause.
 *
 * Every keyword below describes an arrangement, and a posting is as likely to
 * name one to rule it out ("this role is not on-site", "we are not a hybrid
 * team") as to claim it. A bare keyword test read both as the claim. The window
 * is short and stops at a sentence boundary so a negation about something else
 * earlier in the paragraph cannot reach forward and suppress a real match.
 */
const NEGATION_BEFORE_RE =
  /(?:(?<![a-z0-9])(?:not|no|never|cannot|without|neither|nor)(?![a-z0-9])|n't)[^.;:!?]{0,20}$/;
const NEGATION_WINDOW = 32;

/**
 * Does `re` match `text` anywhere it is NOT immediately negated?
 *
 * @param {RegExp} re - A pattern without the global flag.
 * @param {string} text - Normalized posting text.
 * @returns {boolean}
 */
export function matchesUnnegated(re, text) {
  const hay = String(text || '');
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m = g.exec(hay);
  while (m !== null) {
    const before = hay.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
    if (!NEGATION_BEFORE_RE.test(before)) return true;
    if (m.index === g.lastIndex) g.lastIndex += 1; // zero-length match guard
    m = g.exec(hay);
  }
  return false;
}

/**
 * A posting that names an onsite/in-person arrangement. "hybrid" is excluded by
 * the caller rather than here, because a hybrid posting legitimately contains
 * the word "onsite" when describing its office days.
 *
 * Read through `matchesUnnegated` — see ONSITE_ONLY below — never directly.
 */
export const ONSITE_TERMS_RE =
  /(?:(?<![a-z0-9])on[- ]?site(?![a-z0-9])|in[- ]office|in[- ]person|100%\s*in[- ]?(?:office|person)|fully\s+on[- ]?site)/;

/**
 * "no remote" / "not remote" — a NEGATION that asserts the posting IS onsite,
 * which is why it is kept apart from ONSITE_TERMS_RE rather than folded in: the
 * negation guard would read its own "no" as suppressing it.
 */
export const NO_REMOTE_RE = /(?:no\s+remote|not\s+(?:a\s+)?remote|remote\s+is\s+not)/;

/**
 * Is this posting onsite/in-person, as opposed to merely mentioning the words?
 *
 * @param {string} text - Normalized posting text.
 * @returns {boolean}
 */
export function isOnsiteOnly(text) {
  return matchesUnnegated(ONSITE_TERMS_RE, text) || NO_REMOTE_RE.test(String(text || ''));
}

/** A posting that describes a hybrid arrangement. Read via `isHybrid`. */
export const HYBRID_RE = /(?<![a-z0-9])hybrid(?![a-z0-9])/;

/**
 * @param {string} text - Normalized posting text.
 * @returns {boolean}
 */
export function isHybrid(text) {
  return matchesUnnegated(HYBRID_RE, text);
}

/**
 * A travel expectation expressed as a percentage, in either of the two orders
 * postings use ("up to 25% travel" / "travel up to 25%").
 */
export const TRAVEL_PCT_RE =
  /(?:(?:up\s+to\s+)?(\d{1,3})\s*%\s*(?:of\s+(?:the\s+)?time\s+)?(?:domestic\s+|international\s+)?travel|travel(?:\s+requirement)?[:\s]+(?:up\s+to\s+)?(\d{1,3})\s*%)/;

/**
 * The largest travel percentage a posting names, or null.
 *
 * @param {string} haystack - Normalized posting text.
 * @returns {number|null}
 */
export function postingTravelPct(haystack) {
  const m = TRAVEL_PCT_RE.exec(String(haystack || ''));
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * The candidate's stated travel ceiling as a number, from the Profile tab's
 * option strings ('0%', 'Up to 10%', '10-25%', '25-50%', '50-75%', '75%+').
 *
 * A RANGE reads as its UPPER bound: someone who answered '25-50%' is telling
 * you 50% is acceptable, so only a posting above 50 is a mismatch. Reading the
 * lower bound instead would flag as a conflict the exact range they chose.
 *
 * @param {string|number|null} raw
 * @returns {number|null}
 */
export function travelTolerancePct(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^75%\+$/.test(s)) return 100;
  const nums = [...s.matchAll(/(\d{1,3})\s*%?/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

/**
 * @typedef {object} PreferenceSignals
 * @property {Array<{reason: string, key: string, kind: 'weight'|'penalty'}>} signals
 *   Each is a reason string for the score's `reasons[]` plus the weights/penalties
 *   config key to apply. The caller owns the arithmetic, so a node that zeroes a
 *   key in its own `rank:` block turns that signal off without code changes.
 * @property {string|null} drop - A drop_reason, or null.
 */

/**
 * Turn the candidate's preferences plus one posting into scoring signals.
 *
 * ONE HARD GATE, AND ONLY ONE. A candidate who needs sponsorship, applying to
 * a posting that states it does not sponsor, cannot be hired — that is a fact
 * about the posting, not a matter of degree, so it is a drop rather than a
 * penalty. Everything else is additive, because every other preference is a
 * preference: someone who prefers remote can still want an excellent hybrid
 * role, and a scorer that hard-gated on it would hide the role rather than
 * rank it lower.
 *
 * SILENCE IS NEVER A DROP. Most postings say nothing at all about sponsorship,
 * and that silence is the case the candidate most wants to see and judge for
 * themselves — a scorer that treated "unstated" as "refused" would filter out
 * the majority of them. The gate needs the posting to SAY it will not sponsor.
 * An unstated posting in a location that needs one is surfaced and labelled
 * (`pref_sponsorship_unstated`, a zero-weight reason by default) so the flag
 * travels with the row instead of becoming a silent verdict.
 *
 * @param {object} opts
 * @param {string} opts.haystack - scoreFind's normalized location+title+JD text.
 * @param {string} [opts.fullText] - The WHOLE normalized JD when one is
 *   available. Sponsorship and travel clauses are boilerplate that lives at the
 *   bottom of a posting, well past the 400-character snippet `haystack` carries,
 *   so matching them against the snippet alone would almost never fire.
 * @param {object|null} opts.prefs - buildPreferenceBlock()'s output, via criteria.
 * @param {boolean} opts.local - Whether the posting matched a local/primary term.
 * @param {boolean} opts.remote - Whether the posting says "remote".
 * @param {boolean} opts.elsewhere - Whether the posting named a location that is
 *   neither local nor remote (i.e. relocation would be required).
 * @param {boolean} [opts.sponsorLocation] - Whether the posting's location matched
 *   a `location_filter.sponsor_required` term.
 * @returns {PreferenceSignals}
 */
export function preferenceSignals({
  haystack, fullText = '', prefs, local = false, remote = false, elsewhere = false, sponsorLocation = false,
}) {
  /** @type {Array<{reason: string, key: string, kind: 'weight'|'penalty'}>} */
  const signals = [];
  if (!prefs || typeof prefs !== 'object') return { signals, drop: null };
  const text = String(haystack || '');
  // Clause text: the full JD when we have it, else whatever the snippet holds.
  const clauses = String(fullText || '') || text;

  // -- sponsorship: the only gate, and only on an explicit refusal --
  const needsSponsor = prefs.needs_sponsorship === true;
  if (needsSponsor || sponsorLocation) {
    const refuses = NO_SPONSORSHIP_RE.test(clauses);
    const offers = matchesUnnegated(SPONSORSHIP_OFFERED_RE, clauses);
    if (needsSponsor && refuses) {
      return { signals, drop: 'no_sponsorship_offered' };
    }
    if (offers) {
      signals.push({ reason: 'pref_sponsorship_offered', key: 'pref_sponsorship_offered', kind: 'weight' });
    } else if (!refuses) {
      // Conditional, not incompatible — surfaced for a human to judge.
      signals.push({ reason: 'pref_sponsorship_unstated', key: 'pref_sponsorship_unstated', kind: 'weight' });
    }
  }

  // -- remote / hybrid / onsite --
  const hybrid = isHybrid(text);
  // A hybrid posting mentioning its office days is not an onsite-only posting.
  const onsiteOnly = !remote && !hybrid && isOnsiteOnly(text);
  const pref = String(prefs.work_location_preference || '');
  if (pref === 'Remote') {
    if (remote) signals.push({ reason: 'pref_work_location_match', key: 'pref_work_location_match', kind: 'weight' });
    else if (onsiteOnly) signals.push({ reason: 'pref_work_location_mismatch', key: 'pref_work_location_mismatch', kind: 'penalty' });
  } else if (pref === 'Onsite' || pref === 'Hybrid') {
    // Satisfied by a posting near home in the arrangement they asked for. A
    // remote posting is never penalized here — it is compatible with wanting
    // an office, just not what they asked for.
    if (local && (pref === 'Hybrid' ? hybrid || onsiteOnly : onsiteOnly || !remote)) {
      signals.push({ reason: 'pref_work_location_match', key: 'pref_work_location_match', kind: 'weight' });
    }
  }

  // -- relocation --
  // Only fires when the posting genuinely requires moving: somewhere else,
  // not remote, and the candidate said no. 'Depends on the role' is
  // deliberately inert — that answer is an invitation to be asked, not a rule.
  if (prefs.willing_to_relocate === 'No' && elsewhere && !remote && !local) {
    signals.push({ reason: 'pref_relocation_required', key: 'pref_relocation_required', kind: 'penalty' });
  }

  // -- travel --
  const tolerance = travelTolerancePct(prefs.willing_to_travel_pct);
  const demanded = postingTravelPct(clauses);
  if (tolerance !== null && demanded !== null && demanded > tolerance) {
    signals.push({ reason: 'pref_travel_exceeds', key: 'pref_travel_exceeds', kind: 'penalty' });
  }

  return { signals, drop: null };
}
