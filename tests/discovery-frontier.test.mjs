// tests/discovery-frontier.test.mjs — autopilot/lib/discovery-frontier.mjs.
// Every function under test is pure or a thin IO helper with an explicit
// `path` seam, so this suite touches no real repo file — only os.tmpdir().
import { pass, fail } from './helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\ndiscovery-frontier — pure logic + IO-seam tests');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const eq = (actual, expected, msg) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) pass(msg);
  else fail(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
};

const {
  FRONTIER_VERSION, emptyFrontier, frontierKey, addCandidates, dueCandidates,
  RESOLVE_BACKOFF_DAYS, recordResolution, reviveCandidate, resolvedEntries,
  frontierStats, pruneFrontier, readFrontier, writeFrontier,
} = await import('../autopilot/lib/discovery-frontier.mjs');

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────
// emptyFrontier / frontierKey
// ─────────────────────────────────────────────────────────────────────────
{
  eq(emptyFrontier(), { version: FRONTIER_VERSION, updated_at: null, companies: {} }, 'emptyFrontier() shape');
  ok(frontierKey('Acme Robotics, Inc.') === frontierKey('ACME ROBOTICS INC'), 'frontierKey folds punctuation/case like normalizeCompany');
  ok(frontierKey('') === '' && frontierKey(null) === '' && frontierKey(undefined) === '' && frontierKey('!!!') === '', 'frontierKey(\'\') for unusable input');
}

// ─────────────────────────────────────────────────────────────────────────
// addCandidates
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  const r1 = addCandidates(f, [{ name: 'Prime Intellect', website: 'https://primeintellect.ai', source: 'techcrunch' }], { now: T0 });
  eq(r1, { added: 1, updated: 0, skipped: 0, revived: 0 }, 'first seed of a new company: added:1');
  const key = frontierKey('Prime Intellect');
  const e1 = f.companies[key];
  ok(e1 && e1.state === 'new' && e1.hits === 1 && e1.website === 'https://primeintellect.ai' && e1.sources.length === 1 && e1.sources[0] === 'techcrunch', 'new entry shape after first seed');
  ok(e1.first_seen === e1.last_seen, 'new entry stamps first_seen === last_seen');

  // Re-seed same company later, with a DIFFERENT website and a new source —
  // must bump hits/last_seen, union the source, and NEVER overwrite the
  // website an earlier seed already confirmed.
  const r2 = addCandidates(f, [{ name: 'prime intellect', website: 'https://impostor.example', source: 'vc:accel', discovered_at: '2020-01-01T00:00:00.000Z' }], { now: T0 + DAY });
  eq(r2, { added: 0, updated: 1, skipped: 0, revived: 0 }, 're-seed of an existing key: updated:1');
  const e2 = f.companies[key];
  ok(e2.hits === 2, 're-seed bumps hits');
  ok(e2.website === 'https://primeintellect.ai', 're-seed does NOT overwrite an existing website');
  ok(new Date(e2.last_seen).getTime() === T0 + DAY, 're-seed advances last_seen to the call\'s now, ignoring discovered_at');
  ok(e2.first_seen === e1.first_seen, 're-seed leaves first_seen alone');
  ok(e2.sources.length === 2 && e2.sources.includes('techcrunch') && e2.sources.includes('vc:accel'), 're-seed unions a new source');

  // A candidate with no usable name is skipped, not thrown, not counted as added/updated.
  const r3 = addCandidates(f, [{ name: '   ' }, { name: null }, {}], { now: T0 });
  eq(r3, { added: 0, updated: 0, skipped: 3, revived: 0 }, 'unusable names are all skipped');

  // Filling in a website on an entry that started with none.
  addCandidates(f, [{ name: 'No Site Yet', source: 'a' }], { now: T0 });
  addCandidates(f, [{ name: 'No Site Yet', website: 'https://nositeyet.example', source: 'b' }], { now: T0 });
  ok(f.companies[frontierKey('No Site Yet')].website === 'https://nositeyet.example', 're-seed DOES fill website when entry had none');

  // sources union caps at 6.
  const capF = emptyFrontier();
  for (let i = 0; i < 9; i++) addCandidates(capF, [{ name: 'Capped Co', source: `src${i}` }], { now: T0 });
  ok(capF.companies[frontierKey('Capped Co')].sources.length === 6, 'sources union caps at 6');
}

// ─────────────────────────────────────────────────────────────────────────
// dueCandidates: deterministic ordering + next_attempt_at gating
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  // A: no website, many hits, seen last (should still lose to any website-holder).
  addCandidates(f, [{ name: 'A No Site', source: 's' }], { now: T0 });
  addCandidates(f, [{ name: 'A No Site', source: 's2' }], { now: T0 });
  addCandidates(f, [{ name: 'A No Site', source: 's3' }], { now: T0 }); // hits: 3
  // B: has a website, fewer hits.
  addCandidates(f, [{ name: 'B Has Site', website: 'https://b.example', source: 's' }], { now: T0 + 1 }); // hits: 1
  // C: has a website, more hits than B.
  addCandidates(f, [{ name: 'C Has Site', website: 'https://c.example', source: 's' }], { now: T0 + 2 });
  addCandidates(f, [{ name: 'C Has Site', source: 's2' }], { now: T0 + 2 }); // hits: 2

  const due = dueCandidates(f, { now: T0 + 5 });
  const order = due.map((e) => e.name);
  eq(order, ['C Has Site', 'B Has Site', 'A No Site'], 'website-holders sort first, then by hits desc');

  // Gate: an entry with a future next_attempt_at is excluded.
  recordResolution(f, frontierKey('B Has Site'), { status: 'unresolved', reason: 'timeout' }, { now: T0 });
  const dueAfter = dueCandidates(f, { now: T0 + 1, states: ['unresolved'] });
  ok(dueAfter.length === 0, 'an unresolved entry inside its backoff window is excluded');
  const dueOnceDue = dueCandidates(f, { now: T0 + RESOLVE_BACKOFF_DAYS[0] * DAY, states: ['unresolved'] });
  ok(dueOnceDue.length === 1 && dueOnceDue[0].name === 'B Has Site', 'the same entry becomes due once its backoff window elapses');

  // limit is respected.
  ok(dueCandidates(f, { now: T0 + 5, limit: 1 }).length === 1, 'limit caps the returned array');
}

// ─────────────────────────────────────────────────────────────────────────
// recordResolution: backoff schedule walk, then exhaustion -> dead
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  addCandidates(f, [{ name: 'Flaky Co' }], { now: T0 });
  const key = frontierKey('Flaky Co');

  let t = T0;
  for (let i = 0; i < RESOLVE_BACKOFF_DAYS.length; i++) {
    const entry = recordResolution(f, key, { status: 'unresolved', reason: `try${i}` }, { now: t });
    ok(entry.state === 'unresolved', `attempt ${i + 1}/${RESOLVE_BACKOFF_DAYS.length} stays 'unresolved'`);
    ok(entry.attempts === i + 1, `attempt ${i + 1} increments attempts to ${i + 1}`);
    const expectedNext = t + RESOLVE_BACKOFF_DAYS[i] * DAY;
    ok(new Date(entry.next_attempt_at).getTime() === expectedNext, `attempt ${i + 1} sets next_attempt_at from schedule[${i}] = ${RESOLVE_BACKOFF_DAYS[i]}d`);
    t = expectedNext; // simulate resolving exactly when it becomes due
  }
  // One more, past the end of the schedule: exhaustion -> dead.
  const finalEntry = recordResolution(f, key, { status: 'unresolved', reason: 'still nothing' }, { now: t });
  ok(finalEntry.state === 'dead', 'exceeding the schedule length flips state to dead');
  ok(finalEntry.reason === 'exhausted: still nothing', 'exhaustion reason is "exhausted: <reason>"');
  ok(finalEntry.next_attempt_at === null, 'a dead-by-exhaustion entry has no next_attempt_at');

  // 'resolved' clears the backoff clock and stamps `resolved`.
  const f2 = emptyFrontier();
  addCandidates(f2, [{ name: 'Winner Co' }], { now: T0 });
  const k2 = frontierKey('Winner Co');
  recordResolution(f2, k2, { status: 'unresolved', reason: 'flaky' }, { now: T0 });
  const resolvedEntry = recordResolution(f2, k2, {
    status: 'resolved',
    entry: { name: 'Winner Co', careers_url: 'https://winner.example/careers', provider: 'greenhouse' },
  }, { now: T0 + DAY });
  ok(resolvedEntry.state === 'resolved', 'resolved status sets state');
  ok(resolvedEntry.attempts === 0 && resolvedEntry.next_attempt_at === null, 'resolved clears attempts/next_attempt_at');
  ok(resolvedEntry.resolved.careers_url === 'https://winner.example/careers' && resolvedEntry.resolved.provider === 'greenhouse', 'resolved stores the given entry details');
  ok(typeof resolvedEntry.resolved.at === 'string' && resolvedEntry.resolved.at.length > 0, 'resolved.at is stamped');

  // Definitive absence: immediate dead, no attempts increment.
  const f3 = emptyFrontier();
  addCandidates(f3, [{ name: 'Gone Co' }], { now: T0 });
  const k3 = frontierKey('Gone Co');
  const deadEntry = recordResolution(f3, k3, { status: 'dead', reason: 'http 404' }, { now: T0 });
  ok(deadEntry.state === 'dead' && deadEntry.attempts === 0 && deadEntry.reason === 'http 404', 'a definitive dead result sets state immediately with no backoff');

  // Unknown key -> null.
  ok(recordResolution(f3, frontierKey('Nonexistent Co'), { status: 'dead' }) === null, 'recordResolution on an unknown key returns null');

  // Unrecognized status fails loud.
  let threw = false;
  try { recordResolution(f3, k3, { status: 'bogus' }); } catch { threw = true; }
  ok(threw, 'an unrecognized result.status throws rather than silently guessing');

  // website is recorded regardless of status.
  const f4 = emptyFrontier();
  addCandidates(f4, [{ name: 'Website Feedback Co' }], { now: T0 });
  const k4 = frontierKey('Website Feedback Co');
  const fedBack = recordResolution(f4, k4, { status: 'unresolved', reason: 'ambiguous', website: 'https://found-it.example' }, { now: T0 });
  ok(fedBack.website === 'https://found-it.example', 'result.website is recorded even on an unresolved attempt');
}

// ─────────────────────────────────────────────────────────────────────────
// reviveCandidate: dead + same website never revives, dead + new website does
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  addCandidates(f, [{ name: 'Zombie Co', website: 'https://old.example' }], { now: T0 });
  const key = frontierKey('Zombie Co');
  recordResolution(f, key, { status: 'dead', reason: 'http 410' }, { now: T0 });
  ok(f.companies[key].state === 'dead', 'sanity: entry is dead before revival attempts');

  ok(reviveCandidate(f, key, { website: 'https://old.example' }) === false, 'same website does NOT revive a dead entry');
  ok(f.companies[key].state === 'dead', 'state stays dead after a same-website revive attempt');

  ok(reviveCandidate(f, key, { website: undefined }) === false, 'no website at all does NOT revive a dead entry');
  ok(reviveCandidate(f, key, {}) === false, 'missing options does NOT revive a dead entry');

  ok(reviveCandidate(f, key, { website: 'https://new-domain.example' }) === true, 'a NEW website DOES revive a dead entry');
  const revived = f.companies[key];
  ok(revived.state === 'unresolved' && revived.attempts === 0 && revived.next_attempt_at === null, 'revival resets to unresolved with a clean backoff slate');
  ok(revived.website === 'https://new-domain.example', 'revival records the new website');

  // Reviving a non-dead entry is a no-op.
  const f2 = emptyFrontier();
  addCandidates(f2, [{ name: 'Alive Co' }], { now: T0 });
  ok(reviveCandidate(f2, frontierKey('Alive Co'), { website: 'https://anything.example' }) === false, 'reviveCandidate on a non-dead (new) entry returns false');

  // Unknown key.
  ok(reviveCandidate(f, frontierKey('Nope'), { website: 'https://x.example' }) === false, 'reviveCandidate on an unknown key returns false');
}

// ─────────────────────────────────────────────────────────────────────────
// resolvedEntries: portals-shaped, optional keys omitted when absent
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  addCandidates(f, [{ name: 'Full Co' }, { name: 'Bare Co' }, { name: 'Still New Co' }, { name: 'Dead Co' }], { now: T0 });
  recordResolution(f, frontierKey('Full Co'), {
    status: 'resolved',
    entry: { name: 'Full Co', careers_url: 'https://full.example/careers', api: 'https://full.example/api', provider: 'ashby' },
  }, { now: T0 });
  recordResolution(f, frontierKey('Bare Co'), {
    status: 'resolved',
    entry: { name: 'Bare Co', careers_url: 'https://bare.example/careers' },
  }, { now: T0 });
  recordResolution(f, frontierKey('Dead Co'), { status: 'dead', reason: 'http 404' }, { now: T0 });
  // 'Still New Co' is left in state 'new' — never resolved.

  const entries = resolvedEntries(f);
  eq(entries.length, 2, 'resolvedEntries returns only resolved candidates');
  const full = entries.find((e) => e.name === 'Full Co');
  const bare = entries.find((e) => e.name === 'Bare Co');
  ok(full && full.careers_url === 'https://full.example/careers' && full.api === 'https://full.example/api' && full.provider === 'ashby' && full.enabled === true, 'a fully-resolved entry carries api/provider');
  ok(bare && bare.careers_url === 'https://bare.example/careers' && bare.enabled === true, 'a bare-resolved entry has careers_url + enabled');
  ok(!('api' in bare) && !('provider' in bare), 'resolvedEntries OMITS api/provider keys when absent, rather than emitting them as undefined');
}

// ─────────────────────────────────────────────────────────────────────────
// frontierStats
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  addCandidates(f, [{ name: 'S New', website: 'https://s.example' }, { name: 'S New No Site' }], { now: T0 });
  addCandidates(f, [{ name: 'S Resolved' }], { now: T0 });
  recordResolution(f, frontierKey('S Resolved'), { status: 'resolved', entry: { name: 'S Resolved', careers_url: 'https://x.example' } }, { now: T0 });
  addCandidates(f, [{ name: 'S Unresolved' }], { now: T0 });
  recordResolution(f, frontierKey('S Unresolved'), { status: 'unresolved', reason: 'x' }, { now: T0 });
  addCandidates(f, [{ name: 'S Dead' }], { now: T0 });
  recordResolution(f, frontierKey('S Dead'), { status: 'dead', reason: 'http 404' }, { now: T0 });

  const stats = frontierStats(f, { now: T0 });
  eq(stats.total, 5, 'frontierStats.total counts every entry');
  eq(stats.new, 2, 'frontierStats.new');
  eq(stats.resolved, 1, 'frontierStats.resolved');
  eq(stats.unresolved, 1, 'frontierStats.unresolved');
  eq(stats.dead, 1, 'frontierStats.dead');
  eq(stats.with_website, 1, 'frontierStats.with_website');
  // due: the 2 new entries are due; the unresolved one is inside its backoff window (not due); dead/resolved never due.
  eq(stats.due, 2, 'frontierStats.due excludes a freshly-backed-off unresolved entry and dead/resolved entries');
}

// ─────────────────────────────────────────────────────────────────────────
// pruneFrontier: never drops resolved; TTL then value-order eviction
// ─────────────────────────────────────────────────────────────────────────
{
  // Never drops resolved, even when it is the ONLY thing over the cap.
  const f = emptyFrontier();
  for (let i = 0; i < 5; i++) {
    addCandidates(f, [{ name: `Res ${i}` }], { now: T0 });
    recordResolution(f, frontierKey(`Res ${i}`), { status: 'resolved', entry: { name: `Res ${i}`, careers_url: `https://r${i}.example` } }, { now: T0 });
  }
  const { removed } = pruneFrontier(f, { maxEntries: 1, now: T0 });
  eq(removed, 0, 'pruneFrontier removes nothing when every entry is resolved, however small maxEntries is');
  eq(Object.keys(f.companies).length, 5, 'all 5 resolved entries survive an undersized maxEntries');

  // TTL eviction of old dead entries.
  const f2 = emptyFrontier();
  addCandidates(f2, [{ name: 'Old Dead' }], { now: T0 });
  recordResolution(f2, frontierKey('Old Dead'), { status: 'dead', reason: 'http 404' }, { now: T0 });
  addCandidates(f2, [{ name: 'Fresh Dead' }], { now: T0 });
  recordResolution(f2, frontierKey('Fresh Dead'), { status: 'dead', reason: 'http 404' }, { now: T0 + 200 * DAY });
  const laterNow = T0 + 200 * DAY;
  const r2 = pruneFrontier(f2, { deadTtlDays: 180, maxEntries: 20_000, now: laterNow });
  eq(r2.removed, 1, 'pruneFrontier TTL-evicts exactly the dead entry older than deadTtlDays');
  ok(!(frontierKey('Old Dead') in f2.companies), 'the old dead entry is gone');
  ok(frontierKey('Fresh Dead') in f2.companies, 'the recently-dead entry survives the TTL pass');

  // maxEntries value-order eviction: dead first, then unresolved by most attempts, then fewest hits.
  const f3 = emptyFrontier();
  addCandidates(f3, [{ name: 'Keep Resolved' }], { now: T0 });
  recordResolution(f3, frontierKey('Keep Resolved'), { status: 'resolved', entry: { name: 'Keep Resolved', careers_url: 'https://k.example' } }, { now: T0 });
  addCandidates(f3, [{ name: 'Will Die' }], { now: T0 });
  recordResolution(f3, frontierKey('Will Die'), { status: 'dead', reason: 'http 404' }, { now: T0 });
  addCandidates(f3, [{ name: 'Many Attempts' }], { now: T0 });
  recordResolution(f3, frontierKey('Many Attempts'), { status: 'unresolved', reason: 'x' }, { now: T0 });
  recordResolution(f3, frontierKey('Many Attempts'), { status: 'unresolved', reason: 'x' }, { now: T0 + RESOLVE_BACKOFF_DAYS[0] * DAY });
  addCandidates(f3, [{ name: 'Few Attempts' }], { now: T0 });
  recordResolution(f3, frontierKey('Few Attempts'), { status: 'unresolved', reason: 'x' }, { now: T0 });
  addCandidates(f3, [{ name: 'Brand New' }], { now: T0 });
  addCandidates(f3, [{ name: 'Also Brand New' }], { now: T0 });
  // 5 non-resolved entries + 1 resolved = 6 total; cap at 5 => drop exactly 1, the lowest-value one (Will Die, the only dead one).
  const r3 = pruneFrontier(f3, { maxEntries: 5, deadTtlDays: 999_999, now: T0 });
  eq(r3.removed, 1, 'value-order prune drops exactly one entry to reach maxEntries');
  ok(!(frontierKey('Will Die') in f3.companies), 'the dead entry is evicted before any unresolved/new one');
  ok(frontierKey('Keep Resolved') in f3.companies, 'resolved survives value-order eviction too');
  ok(frontierKey('Many Attempts') in f3.companies && frontierKey('Few Attempts') in f3.companies && frontierKey('Brand New') in f3.companies, 'non-dead entries all survive when one dead entry alone satisfies the cap');
}

// ─────────────────────────────────────────────────────────────────────────
// readFrontier: never throws, folds every bad-input case to emptyFrontier()
// ─────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'careerops-discovery-frontier-'));
  try {
    // 1. Absent file.
    eq(readFrontier(join(dir, 'nope.json')), emptyFrontier(), 'readFrontier() on a missing file returns emptyFrontier()');

    // 2. Unreadable "file" — a directory at that path, portable across OSes
    //    without relying on chmod (which doesn't restrict an owner on Windows).
    const dirAsFilePath = join(dir, 'a-directory.json');
    mkdirSync(dirAsFilePath);
    eq(readFrontier(dirAsFilePath), emptyFrontier(), 'readFrontier() on an unreadable path (a directory) returns emptyFrontier()');

    // 3. Malformed JSON.
    const malformedPath = join(dir, 'malformed.json');
    writeFileSync(malformedPath, '{ this is not json', 'utf-8');
    eq(readFrontier(malformedPath), emptyFrontier(), 'readFrontier() on malformed JSON returns emptyFrontier()');

    // 4. Wrong/unsupported version.
    const wrongVersionPath = join(dir, 'wrong-version.json');
    writeFileSync(wrongVersionPath, JSON.stringify({ version: 999, updated_at: null, companies: { x: {} } }), 'utf-8');
    eq(readFrontier(wrongVersionPath), emptyFrontier(), 'readFrontier() on an unrecognized version returns emptyFrontier()');

    // Also: companies not an object.
    const badCompaniesPath = join(dir, 'bad-companies.json');
    writeFileSync(badCompaniesPath, JSON.stringify({ version: FRONTIER_VERSION, updated_at: null, companies: [] }), 'utf-8');
    eq(readFrontier(badCompaniesPath), emptyFrontier(), 'readFrontier() with a non-object companies field returns emptyFrontier()');

    // ───────────────────────────────────────────────────────────────────
    // Round-trip: writeFrontier() then readFrontier() preserves the ledger.
    // ───────────────────────────────────────────────────────────────────
    const roundTripPath = join(dir, 'nested', 'frontier.json');
    const f = emptyFrontier();
    addCandidates(f, [{ name: 'Round Trip Co', website: 'https://rt.example', source: 'techcrunch' }], { now: T0 });
    recordResolution(f, frontierKey('Round Trip Co'), {
      status: 'resolved',
      entry: { name: 'Round Trip Co', careers_url: 'https://rt.example/careers', provider: 'greenhouse' },
    }, { now: T0 });
    writeFrontier(roundTripPath, f);
    ok(typeof f.updated_at === 'string' && f.updated_at.length > 0, 'writeFrontier() stamps updated_at on the caller\'s own object');

    const reloaded = readFrontier(roundTripPath);
    eq(reloaded, f, 'a round trip through writeFrontier/readFrontier preserves the ledger exactly');
    ok(reloaded.companies[frontierKey('Round Trip Co')].resolved.careers_url === 'https://rt.example/careers', 'round-tripped resolved details survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// ─────────────────────────────────────────────────────────────────────────
// Revival happens through addCandidates, which is the only place a new
// website for a dead company can arrive. Before this was wired, the website
// was stored, the state stayed `dead`, dueCandidates never returned it, and
// the one piece of new evidence sat in the ledger unused forever.
// ─────────────────────────────────────────────────────────────────────────
{
  const f = emptyFrontier();
  addCandidates(f, [{ name: 'Ghost Co', source: 'crawl:funding' }], { now: T0 });
  const key = frontierKey('Ghost Co');
  recordResolution(f, key, { status: 'dead', reason: 'no board found' }, { now: T0 });
  ok(f.companies[key].state === 'dead', 'setup: the candidate is dead');
  ok(dueCandidates(f, { now: T0 + 999 * DAY }).length === 0, 'setup: a dead candidate is never due');

  // Re-seeded from the SAME (absent) evidence: nothing changes.
  const same = addCandidates(f, [{ name: 'Ghost Co', source: 'crawl:pipeline' }], { now: T0 + DAY });
  ok(same.revived === 0 && f.companies[key].state === 'dead',
    'a re-seed carrying no website leaves a dead candidate dead');

  // Re-seeded WITH a website it never had: revived and due again.
  const r = addCandidates(f, [{ name: 'Ghost Co', website: 'https://ghost.example', source: 'crawl:yc' }], { now: T0 + 2 * DAY });
  ok(r.revived === 1, 'a seed carrying a new website revives it, and addCandidates reports the count');
  ok(f.companies[key].state === 'unresolved' && f.companies[key].attempts === 0,
    'the revived candidate is unresolved with its attempt count reset');
  ok(f.companies[key].website === 'https://ghost.example', 'and it now carries the website that revived it');
  ok(dueCandidates(f, { now: T0 + 2 * DAY }).some((c) => c.key === key), 'so it is due for a resolve attempt again');

  // The same website a second time is not new evidence.
  const again = addCandidates(f, [{ name: 'Ghost Co', website: 'https://ghost.example' }], { now: T0 + 3 * DAY });
  ok(again.revived === 0, 'the same website arriving again revives nothing');
}


console.log('\ndiscovery-frontier tests complete.');
