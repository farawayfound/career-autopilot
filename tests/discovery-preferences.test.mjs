// tests/discovery-preferences.test.mjs — the candidate's own stated preferences,
// and the location tiers, as they reach the discovery node's scorer.
//
// Two defects are pinned here, because both were invisible rather than loud:
//
//  1. `location_filter` travelled to the node inside portals_yml and only the
//     SCANNER read it. scoreFind ranked locations against its own term lists
//     plus a hardcoded NON_US_HINTS penalty containing `london`, `dublin`,
//     `ireland` and `united kingdom` — so a posting in a city the candidate had
//     explicitly asked for was docked 25 points against a ship threshold of 40.
//  2. The Profile tab's work-location and work-authorization answers reached
//     the node not at all. buildProfileBlock forwarded location, compensation
//     and target_roles; nothing else.
//
// The backward-compatibility case matters as much as the new behaviour: a
// config with none of the three tiers and no Profile answers must score exactly
// as it did before any of this existed.

import { pass, fail } from './helpers.mjs';
import {
  parseLocationPolicy, buildPreferenceBlock, preferenceSignals,
  travelTolerancePct, postingTravelPct, FORWARDED_PREFERENCE_IDS,
  NO_SPONSORSHIP_RE, SPONSORSHIP_OFFERED_RE, isOnsiteOnly, isHybrid, matchesUnnegated,
} from '../autopilot/lib/discovery-preferences.mjs';
import { scoreFind, mergeBoards, boardKey, renderPortalsYml } from '../autopilot/lib/discovery-node.mjs';

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
// scoreFind returns { reasons }; preferenceSignals returns { signals: [{reason}] }.
const reasonsOf = (r) => r.reasons.join(',');
const signalsOf = (r) => r.signals.map((s) => s.reason).join(',');

console.log('\nDiscovery node — location tiers and Profile preferences');

// ── parseLocationPolicy ────────────────────────────────────────────────────
{
  const empty = parseLocationPolicy(null);
  ok(empty.primary.length === 0 && empty.authorized.length === 0 && empty.sponsorRequired.length === 0,
    'a null portals doc yields three empty lists, never a throw');
  ok(parseLocationPolicy({ location_filter: {} }).primary.length === 0,
    'a location_filter with none of the three keys yields empty lists (backward compatible)');

  const p = parseLocationPolicy({
    location_filter: {
      primary: ['Denver', ' Boulder '],
      authorized: ['United States', 42, null],
      sponsor_required: ['London', 'Amsterdam'],
    },
  });
  ok(p.primary.join('|') === 'Denver|Boulder', 'primary terms are trimmed and kept in order');
  ok(p.authorized.join('|') === 'United States', 'non-string entries are dropped rather than coerced');
  ok(p.sponsorRequired.join('|') === 'London|Amsterdam', 'sponsor_required maps to sponsorRequired');
}

// ── buildPreferenceBlock: the allowlist is the whole point ─────────────────
{
  const answers = {
    work_location_preference: 'Remote',
    willing_to_relocate: 'No',
    willing_to_travel_pct: '10-25%',
    needs_sponsorship: 'Yes',
    // Every one of these is ai_context:false or contact data and must not pass.
    citizenship: 'United States',
    security_clearance: 'Top Secret',
    desired_salary: '$250,000',
    full_name: 'A Candidate',
    email: 'a@example.com',
    home_address: '1 Main St',
  };
  const block = buildPreferenceBlock({ location: {}, compensation: {} }, answers);
  ok(block.work_location_preference === 'Remote', 'a forwarded answer comes through');
  ok(block.needs_sponsorship === true, "the Profile tab's 'Yes' normalizes to a boolean");
  for (const forbidden of ['citizenship', 'security_clearance', 'desired_salary', 'full_name', 'email', 'home_address']) {
    ok(!(forbidden in block), `"${forbidden}" never reaches the node`);
  }
  ok(!FORWARDED_PREFERENCE_IDS.includes('citizenship') && !FORWARDED_PREFERENCE_IDS.includes('desired_salary'),
    'and the allowlist itself does not name them');

  // profile.yml is the authored file and wins where both speak.
  const both = buildPreferenceBlock(
    { location: { needs_sponsorship: false, visa_status: 'Citizen' }, compensation: {} },
    { needs_sponsorship: 'Yes', visa_status: 'H-1B' },
  );
  ok(both.needs_sponsorship === false, 'config/profile.yml wins over the Profile tab for sponsorship');
  ok(both.visa_status === 'Citizen', 'and for visa status');

  const none = buildPreferenceBlock(null, null);
  ok(none.needs_sponsorship === null, 'unanswered stays null — distinguishable from an answered "No"');
  ok(Array.isArray(none.authorized_in) && none.authorized_in.length === 0, 'authorized_in defaults to an empty array');
  ok(Object.prototype.hasOwnProperty.call(none, 'work_location_preference'),
    'keys are always present (null when unset) so the criteria hash is stable across runs');
}

// ── travel parsing ─────────────────────────────────────────────────────────
{
  ok(travelTolerancePct('10-25%') === 25, "a range reads as its UPPER bound — '10-25%' tolerates 25");
  ok(travelTolerancePct('0%') === 0, "'0%' is zero, not null");
  ok(travelTolerancePct('75%+') === 100, "'75%+' means no practical ceiling");
  ok(travelTolerancePct('') === null && travelTolerancePct(null) === null, 'unanswered is null');
  ok(postingTravelPct('up to 50% travel required') === 50, 'posting travel parsed in the "50% travel" order');
  ok(postingTravelPct('travel: up to 30%') === 30, 'and in the "travel up to 30%" order');
  ok(postingTravelPct('no travel mentioned here') === null, 'a posting that names no percentage yields null');
}

// ── sponsorship: the one gate, and the silence rule ────────────────────────
{
  const needs = { needs_sponsorship: true };
  const refusing = 'we are not able to sponsor visas for this role';
  ok(NO_SPONSORSHIP_RE.test(refusing), 'an explicit refusal matches');
  ok(preferenceSignals({ haystack: '', fullText: refusing, prefs: needs }).drop === 'no_sponsorship_offered',
    'a candidate who needs sponsorship + a posting that refuses it = drop');

  const silent = 'we are hiring a platform engineer to build our data pipeline';
  const q = preferenceSignals({ haystack: '', fullText: silent, prefs: needs });
  ok(q.drop === null, 'SILENCE IS NEVER A DROP — most postings say nothing, and that is the case to surface');
  ok(signalsOf(q).includes('pref_sponsorship_unstated'),
    'it is flagged instead, so the uncertainty travels with the row');

  const offering = 'visa sponsorship is available for exceptional candidates';
  ok(SPONSORSHIP_OFFERED_RE.test(offering), 'an explicit offer matches');
  const o = preferenceSignals({ haystack: '', fullText: offering, prefs: needs });
  ok(o.drop === null && signalsOf(o).includes('pref_sponsorship_offered'), 'an offer is a positive signal');

  // Someone who does NOT need sponsorship is unaffected by any of it.
  const noNeed = preferenceSignals({ haystack: '', fullText: refusing, prefs: { needs_sponsorship: false } });
  ok(noNeed.drop === null && noNeed.signals.length === 0,
    'a candidate who needs no sponsorship is never dropped by a no-sponsorship clause');
}

// ── work-location preference ───────────────────────────────────────────────
{
  const remotePref = { work_location_preference: 'Remote' };
  const matched = preferenceSignals({ haystack: 'remote united states', prefs: remotePref, remote: true });
  ok(signalsOf(matched).includes('pref_work_location_match'), 'Remote preference + remote posting = match');

  const onsite = preferenceSignals({ haystack: 'denver co this role is 100% in-office', prefs: remotePref, remote: false });
  ok(signalsOf(onsite).includes('pref_work_location_mismatch'), 'Remote preference + onsite-only posting = penalty');

  const hybrid = preferenceSignals({ haystack: 'hybrid: 3 days onsite in denver', prefs: remotePref, remote: false });
  ok(!signalsOf(hybrid).includes('pref_work_location_mismatch'),
    'a HYBRID posting is not onsite-only, even though it says "onsite" when describing its office days');

  const onsitePref = preferenceSignals({
    haystack: 'denver co onsite', prefs: { work_location_preference: 'Onsite' }, local: true, remote: false,
  });
  ok(signalsOf(onsitePref).includes('pref_work_location_match'), 'Onsite preference + a local onsite role = match');

  const onsitePrefRemoteRole = preferenceSignals({
    haystack: 'fully remote', prefs: { work_location_preference: 'Onsite' }, remote: true,
  });
  ok(onsitePrefRemoteRole.signals.length === 0,
    'wanting an office never PENALIZES a remote role — it is compatible, just not what was asked for');
}

// ── negation: a posting naming an arrangement to RULE IT OUT ───────────────
//
// Every keyword these patterns look for is as likely to appear in a denial as
// in a claim, and a bare keyword test read both the same way: "this role is not
// on-site" registered as onsite, "we are not a hybrid team" as hybrid, and "we
// are not open to sponsorship" as an OFFER of sponsorship — that last one to a
// candidate who needs a visa.
{
  for (const [text, want] of [
    ['this role is 100% in-office', true],
    ['fully on-site in denver', true],
    ['no remote option', true],
    ['remote is not offered for this position', true],
    ['this role is not on-site', false],
    ['this is not an on-site role', false],
    ['we are not in-person', false],
  ]) {
    ok(isOnsiteOnly(text) === want, `isOnsiteOnly(${JSON.stringify(text)}) === ${want}`);
  }

  for (const [text, want] of [
    ['hybrid: 3 days onsite', true],
    ['hybrid role in denver', true],
    ['this is not a hybrid team', false],
    ['we are not hybrid', false],
  ]) {
    ok(isHybrid(text) === want, `isHybrid(${JSON.stringify(text)}) === ${want}`);
  }

  const needs = { needs_sponsorship: true };
  const notOpen = preferenceSignals({ haystack: '', fullText: 'we are not open to sponsorship', prefs: needs });
  ok(!signalsOf(notOpen).includes('pref_sponsorship_offered'),
    '"not open to sponsorship" is never read as an OFFER of sponsorship');
  ok(signalsOf(notOpen).includes('pref_sponsorship_unstated') && notOpen.drop === null,
    'and since it is not one of the phrasings the refusal gate recognizes, it stays unstated rather than becoming a silent drop');

  // "no remote" is itself a negation that ASSERTS onsite, which is why it is
  // kept out of the guarded pattern — the guard would suppress it.
  ok(isOnsiteOnly('no remote work available'), '"no remote" still means onsite, despite containing a negation');

  // The guard stops at a sentence boundary, so an unrelated earlier negation
  // cannot reach forward and suppress a real match.
  ok(matchesUnnegated(/onsite/, 'we are not a startup. this role is onsite.'),
    'a negation in a PREVIOUS sentence does not suppress a later match');
}

// ── relocation ─────────────────────────────────────────────────────────────
{
  const wont = { willing_to_relocate: 'No' };
  const far = preferenceSignals({ haystack: 'austin, tx', prefs: wont, local: false, remote: false, elsewhere: true });
  ok(signalsOf(far).includes('pref_relocation_required'), 'not willing to relocate + a role elsewhere = penalty');

  const remoteRole = preferenceSignals({ haystack: 'remote', prefs: wont, remote: true, elsewhere: true });
  ok(!signalsOf(remoteRole).includes('pref_relocation_required'), 'a remote role requires no relocation');

  const localRole = preferenceSignals({ haystack: 'denver', prefs: wont, local: true, elsewhere: false });
  ok(!signalsOf(localRole).includes('pref_relocation_required'), 'nor does a local one');

  const depends = preferenceSignals({
    haystack: 'austin, tx', prefs: { willing_to_relocate: 'Depends on the role' }, elsewhere: true,
  });
  ok(depends.signals.length === 0,
    "'Depends on the role' is deliberately inert — it is an invitation to be asked, not a rule");
}

// ── travel signal ──────────────────────────────────────────────────────────
{
  const p = { willing_to_travel_pct: '10-25%' };
  const over = preferenceSignals({ haystack: '', fullText: 'up to 50% travel required', prefs: p });
  ok(signalsOf(over).includes('pref_travel_exceeds'), 'a posting demanding more travel than tolerated is penalized');
  const within = preferenceSignals({ haystack: '', fullText: 'up to 25% travel', prefs: p });
  ok(!signalsOf(within).includes('pref_travel_exceeds'), 'exactly the tolerated ceiling is not a conflict');
}

// ── no preferences at all ──────────────────────────────────────────────────
{
  const none = preferenceSignals({ haystack: 'anything', fullText: 'we will not sponsor', prefs: null });
  ok(none.signals.length === 0 && none.drop === null, 'no preferences configured = no signals and no gate');
}

// ═══════════════════════════════════════════════════════════════════════════
// scoreFind integration — the London bug, and that nothing else moved.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nDiscovery node — scoreFind honours the location tiers');

const RANK = {
  local_terms: ['Denver', 'Boulder'],
  remote_us_terms: ['United States', 'USA'],
  weights: {
    title_primary: 25, title_secondary: 12, seniority: 15, local: 20, remote_us: 15,
    authorized_location: 12, sponsor_required_location: 6, comp_at_or_above_floor: 15,
    fresh_3d: 8, fresh_14d: 4, ats_direct: 5, tracked_company: 5, stack_match_max: 15,
    pref_work_location_match: 8, pref_sponsorship_offered: 8, pref_sponsorship_unstated: 0,
  },
  penalties: {
    non_us_only: -25, entry_or_intern: -40, stale_45d: -10, trust_flagged: -15,
    pref_work_location_mismatch: -20, pref_relocation_required: -15, pref_travel_exceeds: -10,
  },
};
const londonRow = { url: 'https://jobs.lever.co/acme/1', company: 'Acme', title: 'Senior Platform Engineer', location: 'London, United Kingdom', comp: null, posted: null, trust: null };

{
  // BEFORE: no tiers configured — the historical behaviour, unchanged.
  const before = scoreFind(londonRow, { criteria: { titleFilter: {}, targetRoles: {} }, rank: RANK });
  ok(reasonsOf(before).includes('non_us_only'),
    'with no tiers configured a London posting still takes the non_us_only penalty — backward compatible');

  // AFTER: London declared sponsor_required — the penalty must not fire.
  const policy = { primary: ['Denver'], authorized: ['United States'], sponsorRequired: ['London', 'Amsterdam'] };
  const after = scoreFind(londonRow, {
    criteria: { titleFilter: {}, targetRoles: {}, locationPolicy: policy }, rank: RANK,
  });
  ok(!reasonsOf(after).includes('non_us_only'),
    'a sponsor_required city no longer collects the non_us_only penalty');
  ok(reasonsOf(after).includes('sponsor_required_location'), 'it is labelled sponsor_required_location instead');
  ok(after.score > before.score, `and scores higher than before (${before.score} -> ${after.score})`);

  // An authorized (no-sponsor-needed) location ranks above a sponsor_required one.
  const dublinRow = { ...londonRow, location: 'Dublin, Ireland' };
  const authorized = scoreFind(dublinRow, {
    criteria: { titleFilter: {}, targetRoles: {}, locationPolicy: { primary: [], authorized: ['Ireland'], sponsorRequired: ['London'] } },
    rank: RANK,
  });
  ok(reasonsOf(authorized).includes('authorized_location'), 'an authorized location is labelled authorized_location');
  ok(authorized.score > after.score, 'and outranks a sponsor_required one');
}

{
  // location_filter.primary reaches the node's `local` boost without anyone
  // editing config/discovery-node.yml on the box.
  const austinRow = { url: 'https://jobs.lever.co/acme/2', company: 'Acme', title: 'Platform Engineer', location: 'Austin, TX', comp: null, posted: null, trust: null };
  const without = scoreFind(austinRow, { criteria: { titleFilter: {}, targetRoles: {} }, rank: RANK });
  ok(!reasonsOf(without).includes('local'), 'Austin is not local to a Denver-configured node');
  const with_ = scoreFind(austinRow, {
    criteria: { titleFilter: {}, targetRoles: {}, locationPolicy: { primary: ['Austin'], authorized: [], sponsorRequired: [] } },
    rank: RANK,
  });
  ok(reasonsOf(with_).includes('local'), "adding Austin to location_filter.primary makes it local — the node's own local_terms were not touched");
}

{
  // The preference gate reaches scoreFind's drop path.
  const dropped = scoreFind(londonRow, {
    criteria: {
      titleFilter: {}, targetRoles: {},
      locationPolicy: { primary: [], authorized: [], sponsorRequired: ['London'] },
      preferences: { needs_sponsorship: true },
    },
    rank: RANK,
    jdText: 'Great role. Please note we are unable to sponsor visas for this position.',
  });
  ok(dropped.drop_reason === 'no_sponsorship_offered',
    'a posting that refuses to sponsor a candidate who needs it is dropped by scoreFind');

  const kept = scoreFind(londonRow, {
    criteria: {
      titleFilter: {}, targetRoles: {},
      locationPolicy: { primary: [], authorized: [], sponsorRequired: ['London'] },
      preferences: { needs_sponsorship: true },
    },
    rank: RANK,
    jdText: 'Great role building distributed systems. Apply within.',
  });
  ok(kept.drop_reason === null, 'and a posting that says nothing about it is kept');
}

{
  // `location_filter.authorized` is the targeting choice; profile.yml's
  // `location.authorized_in` is the legal fact. A candidate authorized in the
  // UK should get authorized_location on a London posting even when nobody
  // added the UK to the Targeting card — otherwise a stated Profile fact
  // changes nothing, which is the whole complaint this work started from.
  const ukRow = { url: 'https://jobs.lever.co/acme/9', company: 'Acme', title: 'Platform Engineer', location: 'London, United Kingdom', comp: null, posted: null, trust: null };
  const emptyPolicy = { primary: [], authorized: [], sponsorRequired: [] };

  const noFact = scoreFind(ukRow, { criteria: { titleFilter: {}, targetRoles: {}, locationPolicy: emptyPolicy }, rank: RANK });
  ok(!reasonsOf(noFact).includes('authorized_location'), 'with neither source naming the UK, no authorized_location');

  const viaProfile = scoreFind(ukRow, {
    criteria: {
      titleFilter: {}, targetRoles: {}, locationPolicy: emptyPolicy,
      preferences: { authorized_in: ['United Kingdom'] },
    },
    rank: RANK,
  });
  ok(reasonsOf(viaProfile).includes('authorized_location'),
    "config/profile.yml's authorized_in alone earns authorized_location — the legal fact is unioned with the targeting choice");
  ok(!reasonsOf(viaProfile).includes('non_us_only'),
    'and it suppresses the non_us_only penalty the same way the targeting tier does');
}

{
  // AN ACCIDENTAL LOCAL MATCH MUST NOT HIDE A VISA REQUIREMENT.
  //
  // local_terms are city names and nine of the sixteen shipped ones are a whole
  // word somewhere else — word-boundary matching does not help, because they
  // genuinely ARE whole words there. Most are harmless mis-rankings of a US
  // posting. One is not: "Westminster, London, UK" matched `Westminster`, took
  // the local branch at +20 (the highest location tier), and never reached
  // sponsor_required — so a role needing a visa read as the home metro and the
  // sponsorship question silently never came up.
  const RANK_WM = {
    local_terms: ['Denver', 'Westminster', 'Lakewood', 'Louisville'],
    remote_us_terms: ['United States', 'USA'],
    weights: { local: 20, remote_us: 15, authorized_location: 12, sponsor_required_location: 6 },
    penalties: { non_us_only: -25 },
  };
  const POLICY_WM = { primary: [], authorized: ['United States'], sponsorRequired: ['United Kingdom', 'London', 'Ireland'] };
  const at = (location) => scoreFind(
    { url: 'https://jobs.lever.co/x/1', company: 'X', title: 'Platform Engineer', location, comp: null, posted: null, trust: null },
    { criteria: { titleFilter: {}, targetRoles: {}, locationPolicy: POLICY_WM }, rank: RANK_WM },
  );

  const wmLondon = at('Westminster, London, UK');
  ok(!reasonsOf(wmLondon).includes('local'),
    '"Westminster, London, UK" is NOT scored as the home metro just because Westminster is a local term');
  ok(reasonsOf(wmLondon).includes('sponsor_required_location'),
    'it reaches sponsor_required_location instead, so the visa question is actually asked');

  // And the genuine local is untouched — the fix must not cost the real thing.
  ok(reasonsOf(at('Westminster, CO')).includes('local'), '"Westminster, CO" is still local');
  ok(reasonsOf(at('Denver, CO')).includes('local'), 'and so is Denver');
  ok(reasonsOf(at('Lakewood, CO')).includes('local'), 'and Lakewood, CO');

  // A domestic false positive stays a mis-rank, which is the accepted residual:
  // there is no international signal to override it, and the cost is +20 rather
  // than +15 on a US posting — not a hidden visa requirement.
  ok(reasonsOf(at('Louisville, KY')).includes('local'),
    'a US-domestic false positive is left as a mis-rank — the guard is about international signals, not city disambiguation');

  ok(reasonsOf(at('Remote - United States')).includes('remote_us'), 'remote-US is unaffected');
  ok(reasonsOf(at('Bengaluru, India')).includes('non_us_only'), 'and an unwanted location still takes the penalty');
}

// ═══════════════════════════════════════════════════════════════════════════
// mergeBoards — the hub's own job_boards used to be silently discarded.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nDiscovery node — job_boards merge');

{
  const nodeBoards = [
    { name: 'Jobicy', provider: 'jobicy' },
    { name: 'LinkedIn guest search', provider: 'linkedin-guest', pages: 3, searches: [{ keywords: 'platform engineer' }] },
  ];
  const hubBoards = [
    { name: 'Himalayas', provider: 'himalayas' },
    { name: 'LinkedIn', provider: 'linkedin-guest', pages: 2, searches: [{ keywords: 'devops' }] },
    { name: 'Portfolio A', provider: 'getro', getro_collection: 'aaa' },
    { name: 'Portfolio B', provider: 'getro', getro_collection: 'bbb' },
  ];
  const merged = mergeBoards(nodeBoards, hubBoards, []);
  const names = merged.map((b) => b.name);
  ok(names.includes('Himalayas'), "the hub's own boards are carried through — they used to be discarded wholesale");
  ok(merged.filter((b) => b.provider === 'linkedin-guest').length === 1,
    'only ONE linkedin-guest entry survives — two would double a source that 429s when hit too fast');
  ok(merged.find((b) => b.provider === 'linkedin-guest').pages === 3,
    "and it is the NODE's own tuned entry that wins, not the hub's");
  ok(merged.filter((b) => b.provider === 'getro').length === 2,
    'but a provider the node does not name keeps every one of its distinct collections');

  const withDiscovered = mergeBoards(nodeBoards, hubBoards, [
    { name: 'Acme careers', provider: 'generic-careers', careers_url: 'https://acme.com/careers' },
    { name: 'Acme dup', provider: 'generic-careers', careers_url: 'https://acme.com/careers/' },
  ]);
  ok(withDiscovered.filter((b) => b.provider === 'generic-careers').length === 1,
    'a discovered board deduped on its URL, trailing slash and all');
}

{
  ok(boardKey({ name: 'A', provider: 'remoteok' }) === boardKey({ name: 'Different label', provider: 'remoteok' }),
    'two entries for one board under different labels collapse — name is not identity');
  ok(boardKey({ provider: 'getro', getro_collection: 'a' }) !== boardKey({ provider: 'getro', getro_collection: 'b' }),
    'but a provider-specific distinguishing field keeps siblings apart');
  ok(boardKey({ name: 'X', provider: 'p', enabled: false }) === boardKey({ name: 'X', provider: 'p', enabled: true }),
    'enabled is bookkeeping, not identity');
  ok(boardKey(null) === '' && boardKey({}) === '', 'an unusable entry yields an empty key rather than throwing');
}

{
  // The whole render, end to end.
  const hubYml = [
    'tracked_companies:',
    '  - name: Existing Co',
    'job_boards:',
    '  - name: Himalayas',
    '    provider: himalayas',
    'title_filter:',
    '  positive: [engineer]',
  ].join('\n');
  const out = renderPortalsYml(hubYml, [{ name: 'Jobicy', provider: 'jobicy' }], [{ name: 'New Co', careers_url: 'https://x' }], [{ name: 'Bespoke', provider: 'generic-careers', careers_url: 'https://b.example/careers' }]);
  ok(out.includes('himalayas') && out.includes('jobicy') && out.includes('generic-careers'),
    'renderPortalsYml carries hub boards, node boards and discovered boards together');
  ok(out.includes('Existing Co') && out.includes('New Co'), 'and unions tracked_companies as before');
  ok(out.startsWith('# MACHINE-WRITTEN'), 'the machine-written header survives');
}

console.log('\ndiscovery-preferences checks complete.');
