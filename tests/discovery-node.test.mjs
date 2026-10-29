// tests/discovery-node.test.mjs — the discovery node's pure logic
// (autopilot/lib/discovery-node.mjs). Every function here is pure or a thin
// IO helper with a test seam (loadNodeConfig's paths, buildScannerCommand's
// `paths`), so this suite runs with no network, no child process, and no
// touch to the real repo's config/portals.yml/pipeline.md.
//
// See DISCOVERY_NODE_SPEC.md §2/§4 for the contract under test.
import { pass, fail } from './helpers.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\ndiscovery-node — pure logic + IO-seam tests');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const eq = (actual, expected, msg) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) pass(msg);
  else fail(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
};

const lib = await import('../autopilot/lib/discovery-node.mjs');
const {
  loadNodeConfig, MissingNodeConfigError, parsePipelineRows, parseCompensation,
  scoreFind, decideFind, cvSkillsFromMarkdown, planNextJob, buildScannerCommand,
  renderPortalsYml, renderBoardsPortalsYml, renderProfileYml, foldIngestResponse,
  markPipelineRow, buildHeartbeatStatus, pruneState, SCANNER_JOB_ORDER, atsCheckpointResumable,
} = lib;

const yaml = await import('js-yaml');

// ─────────────────────────────────────────────────────────────────────────
// parsePipelineRows
// ─────────────────────────────────────────────────────────────────────────
{
  const bare = '- [ ] https://boards.greenhouse.io/acme/jobs/1';
  const [row1] = parsePipelineRows(bare);
  ok(row1 && row1.url === 'https://boards.greenhouse.io/acme/jobs/1' && row1.company === '' && row1.title === '' && row1.location === '' && row1.comp === null && row1.posted === null && row1.trust === null && row1.note === null, 'bare-URL row parses with empty fields');

  const threeCol = '- [ ] https://x.example.com/j/2 | Acme | Senior Eng';
  const [row2] = parsePipelineRows(threeCol);
  ok(row2.company === 'Acme' && row2.title === 'Senior Eng' && row2.location === '' && row2.comp === null, '3-column row: company/title only');

  const fourCol = '- [ ] https://x.example.com/j/3 | Acme | Senior Eng | Denver, CO';
  const [row3] = parsePipelineRows(fourCol);
  ok(row3.location === 'Denver, CO' && row3.comp === null, '4-column row: location, no comp');

  const fiveCol = '- [ ] https://x.example.com/j/4 | Acme | Senior Eng | Denver, CO | 150000-200000 USD';
  const [row4] = parsePipelineRows(fiveCol);
  eq(row4.comp, { min: 150000, max: 200000, currency: 'USD', period: 'annual' }, '5-column row: comp cell parsed via parseCompensation');

  const full = '- [ ] https://x.example.com/j/5 | Acme | Senior Eng | Denver, CO | 150000-200000 USD | posted: 2026-09-01 | trust: 80 flagged1,flagged2 | note: node:home-box 82/100 — reasons';
  const [row5] = parsePipelineRows(full);
  ok(row5.posted === '2026-09-01', 'labeled posted: cell parsed');
  eq(row5.trust, { score: 80, flags: ['flagged1', 'flagged2'] }, 'labeled trust: cell parsed (score + flags)');
  ok(row5.note === 'node:home-box 82/100 — reasons', 'labeled note: cell parsed verbatim');
  ok(row5.location === 'Denver, CO', 'positional cells still correct alongside labeled ones');

  const noteOnly = '- [ ] https://x.example.com/j/6 | Acme | Senior Eng | note: hello world';
  const [row6] = parsePipelineRows(noteOnly);
  ok(row6.location === '' && row6.note === 'hello world', 'a labeled cell right after title (no location/comp) does not get read as location');

  const processed = '- [x] https://x.example.com/j/7 | Acme | Senior Eng — node: shipped';
  eq(parsePipelineRows(processed), [], 'a checked-off (processed) row is never returned');

  const crlf = '- [ ] https://x.example.com/j/8 | A | B\r\n- [ ] https://x.example.com/j/9 | C | D\r\n';
  eq(parsePipelineRows(crlf).map((r) => r.url), ['https://x.example.com/j/8', 'https://x.example.com/j/9'], 'CRLF line endings are tolerated');

  eq(parsePipelineRows(''), [], 'empty text yields no rows');
  eq(parsePipelineRows('# Pipeline\n\n## Pending\n\n## Processed\n'), [], 'a pipeline with no rows yields no rows');
}

// ─────────────────────────────────────────────────────────────────────────
// parseCompensation
// ─────────────────────────────────────────────────────────────────────────
{
  const cases = [
    ['$150,000 - $200,000', { min: 150000, max: 200000, currency: 'USD', period: 'annual' }],
    ['$150k–$200k', { min: 150000, max: 200000, currency: 'USD', period: 'annual' }], // en dash
    ['150K-200K USD', { min: 150000, max: 200000, currency: 'USD', period: 'annual' }],
    ['USD 150,000', { min: 150000, max: 150000, currency: 'USD', period: 'annual' }],
    ['$85/hr', { min: 176800, max: 176800, currency: 'USD', period: 'hourly' }],
    ['$85 - $95 per hour', { min: 176800, max: 197600, currency: 'USD', period: 'hourly' }],
    ['120000-160000 USD', { min: 120000, max: 160000, currency: 'USD', period: 'annual' }],
    ['120000-160000', { min: 120000, max: 160000, currency: 'USD', period: 'annual' }],
    ['150000', { min: 150000, max: 150000, currency: 'USD', period: 'annual' }],
  ];
  for (const [input, expected] of cases) {
    eq(parseCompensation(input), expected, `parseCompensation(${JSON.stringify(input)})`);
  }
  ok(parseCompensation('$15,000 signing bonus') === null, 'below the 20K plausibility floor -> null');
  ok(parseCompensation('$2,500,000') === null, 'above the 1M plausibility ceiling -> null');
  ok(parseCompensation('') === null, 'empty string -> null');
  ok(parseCompensation('no numbers here at all') === null, 'no digits -> null');
  ok(parseCompensation(null) === null, 'null input -> null (never throws)');
}

// ─────────────────────────────────────────────────────────────────────────
// scoreFind / decideFind
// ─────────────────────────────────────────────────────────────────────────
const RANK = {
  // Mirrors config/discovery-node.example.yml's lists after the 2026-09-14 review:
  // no bare state code, no bare "US" — both matched the wrong words as whole
  // words ("Acme Co.", "about us") once matching became boundary-aware.
  local_terms: ['Denver', 'Colorado', 'Aurora', 'CO,'],
  remote_us_terms: ['United States', 'USA', 'U.S.', 'US-', 'Americas', 'North America'],
  floor_usd: null,
  weights: { title_primary: 25, title_secondary: 12, seniority: 15, local: 20, remote_us: 15, comp_at_or_above_floor: 15, fresh_3d: 8, fresh_14d: 4, ats_direct: 5, tracked_company: 5, stack_match_max: 15 },
  penalties: { non_us_only: -25, entry_or_intern: -40, stale_45d: -10, trust_flagged: -15, comp_below_floor: -20 },
};
const baseRow = () => ({ url: 'https://example.com/careers/1', company: '', title: '', location: '', comp: null, posted: null, trust: null });

{
  // Denver senior platform role, comp 180-220K, fresh posting -> ships.
  const row = { ...baseRow(), title: 'Senior Platform Engineer', location: 'Denver, CO', comp: { min: 180000, max: 220000, currency: 'USD' }, posted: '2026-09-13' };
  const ctx = {
    criteria: { titleFilter: {}, targetRoles: { primary: ['Senior AI Platform Engineer', 'Platform Engineer'], archetypeNames: [] }, floorUsd: 150000 },
    rank: RANK,
    now: Date.parse('2026-09-14T00:00:00Z'),
  };
  const scored = scoreFind(row, ctx);
  ok(scored.score >= 70, `Denver senior platform + comp 180-220K + fresh scores >= 70 (got ${scored.score})`);
  ok(scored.drop_reason === null, 'Denver senior platform role is not dropped');
  eq(decideFind(scored, 40).decision, 'ship', 'Denver senior platform role ships at ship_min_score=40');
}

{
  // Remote-US mid role -> holds at a high threshold, ships at a low one.
  const row = { ...baseRow(), title: 'Platform Engineer', location: 'Remote, United States' };
  const ctx = {
    criteria: { titleFilter: { positive: ['platform engineer'] }, targetRoles: { primary: ['Chief Financial Officer'], archetypeNames: [] }, floorUsd: 150000 },
    rank: RANK,
  };
  const scored = scoreFind(row, ctx);
  ok(scored.reasons.includes('title_secondary'), 'remote-US mid role: title_secondary (not primary)');
  ok(scored.reasons.includes('remote_us'), 'remote-US mid role: remote_us reason present');
  ok(!scored.reasons.includes('seniority'), 'remote-US mid role: no seniority bonus (mid tier)');
  eq(decideFind(scored, 40).decision, 'hold', 'remote-US mid role holds at ship_min_score=40');
  eq(decideFind(scored, 20).decision, 'ship', 'the SAME score ships at a lower ship_min_score=20');
}

{
  // Non-US-only role: penalised, never dropped.
  const row = { ...baseRow(), title: 'Backend Engineer', location: 'Bangalore, India' };
  const ctx = { criteria: { titleFilter: {}, targetRoles: { primary: [], archetypeNames: [] }, floorUsd: 150000 }, rank: RANK };
  const scored = scoreFind(row, ctx);
  ok(scored.reasons.includes('non_us_only'), 'a posting naming a non-US city with no remote/US term gets the non_us_only reason');
  ok(scored.drop_reason === null, 'non_us_only never sets a drop_reason');
  ok(decideFind(scored, 40).decision !== 'drop', 'a non-US-only role never decides to drop');
}

{
  // Comp max below floor -> a PENALTY, never a drop (2026-10-29): the row keeps
  // scoring on everything else and the evaluation weighs the whole package.
  const row = { ...baseRow(), title: 'Software Engineer', location: 'Denver, CO', comp: { min: 50000, max: 80000, currency: 'USD' } };
  const ctx = { criteria: { titleFilter: {}, targetRoles: { primary: [], archetypeNames: [] }, floorUsd: 150000 }, rank: RANK };
  const scored = scoreFind(row, ctx);
  ok(scored.reasons.includes('comp_below_floor'), 'comp.max below the floor is recorded as comp_below_floor');
  eq(scored.drop_reason, null, 'and is not a drop reason');
  const same = scoreFind({ ...row, comp: null }, ctx);
  eq(scored.score, Math.max(0, same.score + RANK.penalties.comp_below_floor), 'it costs exactly penalties.comp_below_floor against the same row with no pay stated');
  ok(decideFind(scored, 40).decision !== 'drop', 'decideFind never drops on pay alone');
  const noPenalty = scoreFind(row, { ...ctx, rank: { ...RANK, penalties: { ...RANK.penalties, comp_below_floor: 0 } } });
  eq(noPenalty.score, same.score, 'a node whose config lacks the key (reads as 0) is unchanged from an unstated band');
}

{
  // A single-bound comp below floor*0.9 is penalised too; between 0.9x and floor is a straddle (no penalty, no points).
  const floor = 150000;
  const dropRow = { ...baseRow(), comp: { min: 100000 } }; // 100000 < 150000*0.9
  const dropped = scoreFind(dropRow, { criteria: { targetRoles: {}, floorUsd: floor }, rank: RANK });
  ok(dropped.reasons.includes('comp_below_floor') && dropped.drop_reason === null, 'a lone comp bound under floor*0.9 is penalised, not dropped');

  const straddleRow = { ...baseRow(), comp: { min: 100000, max: 200000 } }; // min < floor <= max
  const straddled = scoreFind(straddleRow, { criteria: { targetRoles: {}, floorUsd: floor }, rank: RANK });
  ok(straddled.reasons.includes('comp-straddles-floor') && straddled.drop_reason === null, 'a comp range straddling the floor is neither dropped nor scored');
}

{
  // Liveness expired -> drop, regardless of everything else scoring well.
  const row = { ...baseRow(), title: 'Senior Platform Engineer', location: 'Denver, CO', comp: { min: 200000, max: 250000, currency: 'USD' } };
  const ctx = {
    criteria: { titleFilter: {}, targetRoles: { primary: ['Senior Platform Engineer'], archetypeNames: [] }, floorUsd: 150000 },
    rank: RANK,
    liveness: 'expired',
  };
  const scored = scoreFind(row, ctx);
  eq(scored.drop_reason, 'expired', 'an expired posting drops even with an otherwise strong score');
}

{
  // Entry/intern -> penalised, not necessarily dropped.
  const row = { ...baseRow(), title: 'Software Engineer Intern' };
  const ctx = { criteria: { titleFilter: {}, targetRoles: { primary: [], archetypeNames: [] }, floorUsd: null }, rank: RANK };
  const scored = scoreFind(row, ctx);
  ok(scored.reasons.includes('entry_or_intern'), 'an intern title gets the entry_or_intern penalty reason');
  ok(scored.drop_reason === null, 'entry_or_intern is a penalty, not a drop condition');
}

{
  // Title negative -> drop, the safety net.
  const row = { ...baseRow(), title: 'Senior Sales Engineer' };
  const ctx = { criteria: { titleFilter: { negative: ['sales'] }, targetRoles: { primary: [], archetypeNames: [] }, floorUsd: null }, rank: RANK };
  const scored = scoreFind(row, ctx);
  eq(scored.drop_reason, 'title_negative', 'a title_filter.negative keyword drops the row regardless of other signal');
}

{
  // Score clamping and reason-set sanity for a totally empty ctx.
  const scored = scoreFind(baseRow(), {});
  ok(scored.score >= 0 && scored.score <= 100, 'score is always clamped to 0..100');
  ok(Array.isArray(scored.reasons), 'reasons is always an array, even with an empty ctx');
}

// ─────────────────────────────────────────────────────────────────────────
// cvSkillsFromMarkdown
// ─────────────────────────────────────────────────────────────────────────
{
  const cv = [
    '# CV',
    '',
    '## Technical Skills',
    'Python, Golang, Kubernetes',
    '- Docker',
    '- AWS/GCP',
    '',
    '## Experience',
    'Should not leak into skills: Rust, TypeScript',
  ].join('\n');
  const skills = cvSkillsFromMarkdown(cv);
  for (const want of ['python', 'golang', 'kubernetes', 'docker', 'aws', 'gcp']) {
    ok(skills.includes(want), `cvSkillsFromMarkdown includes "${want}"`);
  }
  ok(!skills.includes('rust') && !skills.includes('typescript'), 'cvSkillsFromMarkdown stops at the next ## heading');
  // The <3-char floor is deliberate (spec: "lowercase skill tokens (>=3 chars)")
  // — a 2-letter token like "go" is exactly the kind of thing that would
  // false-positive as a whole-word match against unrelated JD prose.
  ok(!cvSkillsFromMarkdown('## Technical Skills\nGo, C, R\n').includes('go'), '2-character tokens are filtered out (the >=3 char floor)');
  eq(cvSkillsFromMarkdown('# CV\n\n## Experience\nonly'), [], 'no Technical Skills section -> empty array');
}

// ─────────────────────────────────────────────────────────────────────────
// planNextJob
// ─────────────────────────────────────────────────────────────────────────
{
  const jobsConfig = {
    tracked: { enabled: true, every_minutes: 120 },
    ats_full: { enabled: true, every_minutes: 360 },
    seeds: { enabled: false, every_minutes: 10 }, // disabled — never picked
    boards: { enabled: true, every_minutes: 180 },
  };
  const now = Date.parse('2026-09-14T12:00:00Z');
  eq(planNextJob(jobsConfig, { jobs: {} }, now), 'tracked', 'never-run jobs are picked in SCANNER_JOB_ORDER, first one wins');

  const state1 = { jobs: { tracked: { last_run_at: new Date(now).toISOString() } } };
  eq(planNextJob(jobsConfig, state1, now), 'boards', 'once "tracked" has run, the next never-run ENABLED job in order is picked over it (aggregators is not configured here, seeds is disabled)');
  const state1b = { jobs: { tracked: { last_run_at: new Date(now).toISOString() }, boards: { last_run_at: new Date(now).toISOString() } } };
  eq(planNextJob(jobsConfig, state1b, now), 'ats_full', 'the multi-hour ats_full sweep is the LAST never-run job to be started');

  // Everything has run; ats_full is far more overdue than boards.
  const state2 = {
    jobs: {
      tracked: { last_run_at: new Date(now - 30 * 60_000).toISOString() },       // due in 90 more min
      ats_full: { last_run_at: new Date(now - 400 * 60_000).toISOString() },      // 40 min overdue
      boards: { last_run_at: new Date(now - 185 * 60_000).toISOString() },        // 5 min overdue
    },
  };
  eq(planNextJob(jobsConfig, state2, now), 'ats_full', 'the MOST overdue enabled job wins, not just the oldest last_run_at');

  const state3 = { jobs: { tracked: { last_run_at: new Date(now).toISOString() }, ats_full: { last_run_at: new Date(now).toISOString() }, boards: { last_run_at: new Date(now).toISOString() } } };
  eq(planNextJob(jobsConfig, state3, now), null, 'nothing overdue and nothing never-run -> null');

  eq(planNextJob({}, {}, now), null, 'an empty jobs config -> null');
  eq(SCANNER_JOB_ORDER, ['tracked', 'aggregators', 'sources', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full'], 'SCANNER_JOB_ORDER is the documented fixed priority order: quick sources first, ats_full last');
  eq(SCANNER_JOB_ORDER[SCANNER_JOB_ORDER.length - 1], 'ats_full', 'the multi-hour sweep never starts before the quick sources on a fresh node');
  // `sources` fills the frontier, `resolve` drains it. On a fresh node the
  // never-run jobs start in exactly this array order, so reversing these two
  // would have the node's first resolve pass read an empty ledger, record a
  // run, and not come round again for its own every_minutes.
  ok(SCANNER_JOB_ORDER.indexOf('sources') < SCANNER_JOB_ORDER.indexOf('resolve'), 'sources is scheduled before resolve on a fresh node');
}

// ─────────────────────────────────────────────────────────────────────────
// buildScannerCommand
// ─────────────────────────────────────────────────────────────────────────
{
  const tracked = buildScannerCommand('tracked', {}, {});
  eq(tracked.file, 'scripts/scan/scan.mjs', 'tracked runs scripts/scan/scan.mjs');
  eq(tracked.args, [], 'tracked takes no extra args');
  ok(!('CAREER_OPS_PORTALS' in tracked.env), 'tracked strips any ambient CAREER_OPS_PORTALS');

  const atsFull = buildScannerCommand('ats_full', { since_days: 5, ats: 'greenhouse,lever', resume: true }, { atsCheckpointExists: true });
  eq(atsFull.file, 'scripts/scan/scan-ats-full.mjs', 'ats_full runs scan-ats-full.mjs');
  eq(atsFull.args, ['--since', '5', '--ats', 'greenhouse,lever', '--resume'], 'ats_full args: since/ats/resume when the checkpoint exists');

  const atsFullNoCheckpoint = buildScannerCommand('ats_full', { since_days: 5, ats: 'greenhouse', resume: true }, { atsCheckpointExists: false });
  ok(!atsFullNoCheckpoint.args.includes('--resume'), 'ats_full omits --resume when no checkpoint file exists, even if cfg.resume is true');

  // include_undated: opt-in, strictly boolean, and it is the scanner's own flag.
  const undated = buildScannerCommand('ats_full', { since_days: 5, ats: 'greenhouse,smartrecruiters', include_undated: true, resume: true }, { atsCheckpointExists: true });
  eq(undated.args, ['--since', '5', '--ats', 'greenhouse,smartrecruiters', '--include-undated', '--resume'], 'include_undated: true adds --include-undated (before --resume)');
  for (const off of [{}, { include_undated: false }, { include_undated: 'true' }, { include_undated: 1 }, { include_undated: null }]) {
    ok(!buildScannerCommand('ats_full', { since_days: 5, ...off }, {}).args.includes('--include-undated'), `${JSON.stringify(off)} does not add --include-undated (default false, only a real true opts in)`);
  }
  ok(!buildScannerCommand('seeds', { seeds: 'yc', include_undated: true }, {}).args.includes('--include-undated'), 'the seeds job takes no such option');
  const scanSrc = (await import('node:fs')).readFileSync(new URL('../scripts/scan/scan-ats-full.mjs', import.meta.url), 'utf-8');
  ok(/const KNOWN_FLAGS = \[[^\]]*'--include-undated'/.test(scanSrc), 'and --include-undated is a flag scan-ats-full.mjs knows (an unknown flag would fail every run)');

  // A saved sweep is only resumable under the undated policy it was written with.
  // (The fixture has the shape scan-ats-full.mjs really writes: its --ats list and --limit too.)
  const FIVE = ['greenhouse', 'lever', 'ashby', 'workday', 'icims'];
  const cp = (extra = {}) => ({ version: 1, includeUndated: false, limit: null, ats: FIVE, ...extra });
  ok(atsCheckpointResumable(cp(), {}) && atsCheckpointResumable(cp(), { include_undated: false }) && atsCheckpointResumable(cp({ includeUndated: true }), { include_undated: true }), 'a checkpoint written under the same undated policy is resumable');
  ok(!atsCheckpointResumable(cp(), { include_undated: true }) && !atsCheckpointResumable(cp({ includeUndated: true }), {}), 'one written under the other policy is not (the scanner would exit 1 on every run)');
  ok(!atsCheckpointResumable(null, {}) && !atsCheckpointResumable({}, {}) && !atsCheckpointResumable(cp({ version: 2 }), {}) && !atsCheckpointResumable('x', {}), 'no checkpoint, an unversioned one or junk is not resumable');
  // …and only under the `ats` list it was written with: editing jobs.ats_full.ats (the config file or the
  // dashboard's control) while a killed sweep's checkpoint is on disk made the scanner exit 1 on every run.
  ok(!atsCheckpointResumable(cp(), { ats: 'greenhouse,lever' }), 'a checkpoint written for the default five is not resumable once ats_full.ats names fewer');
  ok(!atsCheckpointResumable(cp(), { ats: 'greenhouse,lever,ashby,workday,icims,workable' }), 'nor when ats_full.ats names more');
  ok(!atsCheckpointResumable(cp(), { ats: 'lever,greenhouse,ashby,workday,icims' }), 'nor when the same sources are merely reordered (the scanner compares the arrays as written)');
  ok(atsCheckpointResumable(cp({ ats: ['greenhouse', 'lever'] }), { ats: ' Greenhouse , LEVER ,' }), 'the list is compared the way the scanner parses it (trimmed, lower-cased, empties dropped)');
  ok(atsCheckpointResumable(cp(), { ats: '' }) && atsCheckpointResumable(cp(), { ats: null }), 'an empty ats means the scanner default, which is what the checkpoint holds');
  ok(!atsCheckpointResumable(cp({ ats: undefined }), {}) && !atsCheckpointResumable(cp({ limit: 200 }), {}), 'a checkpoint with no ats list, or one from a --limit run, is not resumable either');
  const scanAts = await import('../scripts/scan/scan-ats-full.mjs');
  ok(atsCheckpointResumable({ version: 1, includeUndated: false, limit: null, ats: scanAts.DEFAULT_ATS }, {}), "the node's default ats list IS scan-ats-full.mjs's DEFAULT_ATS (so a default sweep resumes)");
  ok(buildScannerCommand('ats_full', {}, {}).args.includes(scanAts.DEFAULT_ATS.join(',')), 'and the command line it builds with no ats names exactly that list');

  const seeds = buildScannerCommand('seeds', { seeds: 'yc,a16z', since_days: 7 }, {});
  eq(seeds.args, ['--seeds', 'yc,a16z', '--since', '7'], 'seeds args: --seeds then --since');

  const boards = buildScannerCommand('boards', {}, { boardsPortals: '/abs/portals-boards.yml' });
  eq(boards.env.CAREER_OPS_PORTALS, '/abs/portals-boards.yml', 'boards sets CAREER_OPS_PORTALS to the boards-only file');
  const boardsDefault = buildScannerCommand('boards', {}, {});
  eq(boardsDefault.env.CAREER_OPS_PORTALS, 'data/discovery-node/portals-boards.yml', 'boards defaults CAREER_OPS_PORTALS to the documented relative path');

  const localEmployers = buildScannerCommand('local_employers', {}, { localEmployersInput: '/abs/input.yml' });
  eq(localEmployers.args, ['--in', '/abs/input.yml'], 'local_employers passes --in <file>, preview mode only (never --write)');
  ok(!localEmployers.args.includes('--write'), 'local_employers never passes --write');

  ok(buildScannerCommand('aggregators', {}, {}) === null, 'aggregators is not a child-process command (runs in-process)');
  ok(buildScannerCommand('validate', {}, {}) === null, 'validate is not a scanner-child job');
  ok(buildScannerCommand('ship', {}, {}) === null, 'ship is not a scanner-child job');
  ok(buildScannerCommand('bogus', {}, {}) === null, 'an unknown job name returns null');

  const envSeam = buildScannerCommand('tracked', {}, { env: { CAREER_OPS_PORTALS: 'stale', KEEP_ME: 'x' } });
  ok(!('CAREER_OPS_PORTALS' in envSeam.env) && envSeam.env.KEEP_ME === 'x', 'an injected env is copied minus CAREER_OPS_PORTALS, other vars untouched');
}

// ─────────────────────────────────────────────────────────────────────────
// renderPortalsYml / renderBoardsPortalsYml / renderProfileYml
// ─────────────────────────────────────────────────────────────────────────
{
  const hubText = yaml.dump({
    title_filter: { positive: ['AI'] },
    tracked_companies: [{ name: 'Acme', careers_url: 'https://acme.example.com/careers', enabled: true }],
  });
  const boards = [{ name: 'Jobicy', provider: 'jobicy' }];
  const local = [
    { name: 'Ibotta', careers_url: 'https://ibotta.example.com/careers', enabled: true },
    { name: 'acme', careers_url: 'https://dup.example.com', enabled: true }, // dup of existing "Acme", case-insensitive
  ];
  const rendered = renderPortalsYml(hubText, boards, local);
  ok(rendered.startsWith('# MACHINE-WRITTEN'), 'renderPortalsYml prefixes the machine-written header comment');
  const parsed = yaml.load(rendered);
  eq(parsed.job_boards, boards, 'job_boards is replaced with the node\'s own boards config');
  eq(parsed.tracked_companies.map((c) => c.name), ['Acme', 'Ibotta'], 'local employers are appended, duplicates (case-insensitive) skipped');
  eq(parsed.title_filter, { positive: ['AI'] }, 'the hub\'s other filter keys survive untouched');

  const rendered2 = renderPortalsYml(hubText, boards, local);
  eq(rendered, rendered2, 'renderPortalsYml is idempotent for identical inputs');

  const boardsOnly = renderBoardsPortalsYml(hubText, boards);
  const parsedBoardsOnly = yaml.load(boardsOnly);
  eq(parsedBoardsOnly.tracked_companies, [], 'renderBoardsPortalsYml always carries tracked_companies: []');
  eq(parsedBoardsOnly.job_boards, boards, 'renderBoardsPortalsYml carries the node\'s own boards');
  eq(parsedBoardsOnly.title_filter, { positive: ['AI'] }, 'renderBoardsPortalsYml copies over an allowlisted filter key');
  ok(!('tracked_companies' in yaml.load(hubText)) || parsedBoardsOnly.tracked_companies.length === 0, 'renderBoardsPortalsYml never carries the hub\'s tracked_companies');

  const profile = {
    location: { country: 'United States', state: 'CO', city: 'Denver', timezone: 'America/Denver' },
    compensation: { minimum: '$150K', minimum_usd: 150000, target_range: '$170K-$300K', currency: 'USD' },
    target_roles: { primary: ['Senior AI Platform Engineer'], archetypes: [{ name: 'Platform Engineer', level: 'Senior', fit: 'primary' }] },
  };
  const profileYml = renderProfileYml(profile);
  ok(profileYml.startsWith('# MACHINE-WRITTEN'), 'renderProfileYml also carries the machine-written header');
  const parsedProfile = yaml.load(profileYml);
  eq(parsedProfile.candidate, { location: 'Denver, CO' }, 'renderProfileYml derives candidate.location, and carries NO other candidate fields (no contact info)');
  eq(parsedProfile.location.city, 'Denver', 'renderProfileYml carries location.city');
  eq(parsedProfile.compensation.minimum_usd, 150000, 'renderProfileYml carries compensation through');
  eq(parsedProfile.target_roles.primary, ['Senior AI Platform Engineer'], 'renderProfileYml carries target_roles through');
}

// ─────────────────────────────────────────────────────────────────────────
// foldIngestResponse
// ─────────────────────────────────────────────────────────────────────────
{
  const freshState = () => ({ shipped: {}, held: {}, dropped: {}, to_ship: [] });

  const s1 = freshState();
  const batch1 = [
    { key: 'gh:acme:1', url: 'https://a.example.com/1', score: 80 },
    { key: 'gh:acme:2', url: 'https://a.example.com/2', score: 50 },
  ];
  s1.to_ship = [...batch1];
  foldIngestResponse(s1, batch1, { ok: true, status: 202, json: { accepted_urls: ['https://a.example.com/1'], duplicate_urls: ['https://a.example.com/2'] } });
  eq(s1.to_ship, [], '202 success empties to_ship for the whole batch');
  eq(s1.shipped['gh:acme:1'].hub, 'accepted', 'an accepted URL is recorded with hub: accepted');
  eq(s1.shipped['gh:acme:2'].hub, 'duplicate', 'a duplicate URL is recorded with hub: duplicate');

  const s2 = freshState();
  const batch2 = [{ key: 'gh:acme:3', url: 'https://a.example.com/3', score: 60 }];
  s2.to_ship = [...batch2];
  foldIngestResponse(s2, batch2, { ok: true, status: 202, json: { accepted_urls: [], duplicate_urls: [] } });
  eq(s2.to_ship, [], 'an item named in neither list is still removed from to_ship');
  eq(s2.dropped['gh:acme:3'].reason, 'hub_rejected', 'an unnamed item on a 202 is dropped with reason hub_rejected');

  for (const failResponse of [{ ok: false, status: 401 }, { ok: false, status: 403 }, { ok: false, status: 500 }, { ok: false, status: null, networkError: true }]) {
    const s = freshState();
    const batch = [{ key: 'k', url: 'https://a.example.com/x', score: 10 }];
    s.to_ship = [...batch];
    foldIngestResponse(s, batch, failResponse);
    eq(s.to_ship, batch, `a ${JSON.stringify(failResponse)} response leaves to_ship untouched for retry`);
  }

  const s3 = freshState();
  const batch3 = [{ key: 'k2', url: 'https://a.example.com/y', score: 10 }];
  s3.to_ship = [...batch3];
  foldIngestResponse(s3, batch3, { ok: false, status: 400 });
  eq(s3.to_ship, [], 'a non-retryable 4xx clears the batch from to_ship');
  eq(s3.dropped.k2.reason, 'hub_rejected_400', 'a non-retryable 4xx drops with a status-specific reason');
}

// ─────────────────────────────────────────────────────────────────────────
// markPipelineRow
// ─────────────────────────────────────────────────────────────────────────
{
  const text = [
    '- [ ] https://a.example.com/1 | Acme | Senior Eng',
    '- [ ] https://a.example.com/2 | Beta | Staff Eng',
    '- [x] https://a.example.com/3 | Gamma | Mid Eng — node: shipped',
  ].join('\n');
  const updated = markPipelineRow(text, 'https://a.example.com/2', 'node: shipped');
  const lines = updated.split('\n');
  eq(lines[0], text.split('\n')[0], 'a non-matching row is left completely untouched');
  eq(lines[1], '- [x] https://a.example.com/2 | Beta | Staff Eng — node: shipped', 'the matching row is checked off with the note appended');
  eq(lines[2], text.split('\n')[2], 'an already-processed row is left untouched');
}

// ─────────────────────────────────────────────────────────────────────────
// pruneState
// ─────────────────────────────────────────────────────────────────────────
{
  const state = { shipped: {}, held: {}, dropped: {} };
  for (let i = 0; i < 5; i++) state.shipped[`k${i}`] = { at: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z` };
  pruneState(state, { maxEntries: 3 });
  eq(Object.keys(state.shipped).sort(), ['k2', 'k3', 'k4'], 'pruneState keeps only the newest N entries by .at, oldest dropped first');

  const small = { shipped: { a: { at: '2026-01-01' } }, held: {}, dropped: {} };
  pruneState(small, { maxEntries: 3 });
  eq(Object.keys(small.shipped), ['a'], 'pruneState is a no-op when already under the cap');
}

// ─────────────────────────────────────────────────────────────────────────
// buildHeartbeatStatus
// ─────────────────────────────────────────────────────────────────────────
{
  const state = {
    started_at: '2026-09-01T00:00:00Z',
    jobs: { tracked: { last_run_at: '2026-09-14T00:00:00Z', last_ok: true, runs: 3, errors: 0, last_summary: 'ok' } },
    shipped: { a: { at: '2026-09-14T01:00:00Z' } },
    held: { b: {} },
    dropped: {},
    to_ship: [{ key: 'x' }, { key: 'y' }],
  };
  const jobsConfig = { tracked: { enabled: true, every_minutes: 120 } };
  const status = buildHeartbeatStatus(state, jobsConfig, { version: 'abc123', pending_local: 4 });
  eq(status.to_ship, 2, 'buildHeartbeatStatus counts to_ship');
  eq(status.shipped_total, 1, 'buildHeartbeatStatus counts shipped_total');
  eq(status.held_total, 1, 'buildHeartbeatStatus counts held_total');
  eq(status.last_ship_at, '2026-09-14T01:00:00Z', 'buildHeartbeatStatus reports the newest shipped .at');
  eq(status.jobs.tracked.runs, 3, 'buildHeartbeatStatus folds per-job records from state.jobs');
  eq(status.jobs.tracked.next_run_at, '2026-09-14T02:00:00.000Z', 'buildHeartbeatStatus derives next_run_at from last_run_at + every_minutes');
  eq(status.pending_local, 4, 'buildHeartbeatStatus carries through the live-only pending_local');
}

// ─────────────────────────────────────────────────────────────────────────
// loadNodeConfig — merge precedence, env override, missing file, no token leak
// ─────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'careerops-discovery-node-cfg-'));
  try {
    const configPath = join(dir, 'discovery-node.yml');
    const localConfigPath = join(dir, 'discovery-node.local.yml');
    writeFileSync(configPath, yaml.dump({
      node: { name: 'home-box' },
      hub: { url: 'http://example.com:8378', ship_min_score: 40 },
      scheduler: { tick_seconds: 30 },
    }));
    writeFileSync(localConfigPath, yaml.dump({
      hub: { token: 'overlay-supplied-token' },
    }));

    const cfg1 = loadNodeConfig({ configPath, localConfigPath, env: {} });
    eq(cfg1.hub.url, 'http://example.com:8378', 'loadNodeConfig: base yml values survive when the local overlay only adds a sibling key');
    eq(cfg1.hub.ship_min_score, 40, 'loadNodeConfig: deep merge preserves a sibling key the local overlay does not mention');
    eq(cfg1.hub.token, 'overlay-supplied-token', 'loadNodeConfig: the local overlay supplies hub.token');
    eq(cfg1.node.name, 'home-box', 'loadNodeConfig: the base config\'s node.name is preserved');

    const cfg2 = loadNodeConfig({ configPath, localConfigPath, env: { CAREER_OPS_NODE_TOKEN: 'ENV-TOKEN-VALUE', CAREER_OPS_URL: 'http://env-hub.example.com' } });
    eq(cfg2.hub.token, 'ENV-TOKEN-VALUE', 'CAREER_OPS_NODE_TOKEN overrides hub.token, taking precedence over the local overlay');
    eq(cfg2.hub.url, 'http://env-hub.example.com', 'CAREER_OPS_URL overrides hub.url, taking precedence over the base yml');

    const cfg3 = loadNodeConfig({ configPath, localConfigPath: join(dir, 'does-not-exist.yml'), env: {} });
    ok(cfg3.hub.token === undefined, 'loadNodeConfig: an absent local overlay is fine, no token set');

    // Missing required config file.
    let threw = null;
    try { loadNodeConfig({ configPath: join(dir, 'nope.yml'), localConfigPath, env: {} }); }
    catch (err) { threw = err; }
    ok(threw instanceof MissingNodeConfigError && threw.code === 'ENOCONFIG', 'loadNodeConfig throws MissingNodeConfigError when the config file is absent');
    ok(String(threw.message).includes('cp config/discovery-node.example.yml'), 'the error message names the copy command to run');

    // The token must never reach a log line this module emits.
    const SECRET = 'zz-super-secret-token-should-never-be-logged-zz';
    writeFileSync(localConfigPath, yaml.dump({ hub: { token: SECRET } }));
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const captured = [];
    console.log = (...a) => captured.push(a.join(' '));
    console.error = (...a) => captured.push(a.join(' '));
    console.warn = (...a) => captured.push(a.join(' '));
    let cfg4;
    try {
      cfg4 = loadNodeConfig({ configPath, localConfigPath, env: { CAREER_OPS_NODE_TOKEN: SECRET } });
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
    eq(cfg4.hub.token, SECRET, 'sanity: the token really was loaded');
    ok(!captured.some((line) => line.includes(SECRET)), 'loadNodeConfig never emits the hub token to console.log/error/warn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Review fixes, 2026-09-14 (the adversarial pass before the first deploy)
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  parseCompensation over real JD prose');
  const prose = 'Location: Denver, CO 80202. We offer a 401(k) match and a $5,000 signing bonus. '
    + 'The base salary range for this role is $165,000 - $195,000 plus up to 15% bonus. Req ID 88214.';
  const c = parseCompensation(prose);
  ok(c && c.min === 165000 && c.max === 195000, `prose: the real range wins over the zip code, 401(k), the bonus and the req id (got ${JSON.stringify(c)})`);
  ok(parseCompensation('Denver, CO — hybrid. Req 80202. Team of 45.') === null, 'prose: a zip code / req id / headcount with no $, k or comma is not a salary');
  ok(parseCompensation('Compensation: $85 - $95 per hour, W2.')?.min === 85 * 2080, 'prose: hourly is annualized when the hourly marker is next to the number');
  const notHourly = parseCompensation('Base $180,000. We run hourly standups and weekly demos.');
  ok(notHourly && notHourly.min === 180000 && notHourly.period === 'annual', 'prose: "hourly" far from the number does not annualize it');
  ok(parseCompensation('150000-200000 USD')?.max === 200000, 'comp cell: the scanner\'s bare-number range still parses');
  ok(parseCompensation('150000')?.min === 150000, 'comp cell: a bare single bound still parses');
  ok(parseCompensation('Posted 2026-09-14, apply by 2026-10-01. $170k-$210k.')?.min === 170000, 'prose: a date is never read as a range');
  ok(parseCompensation('Salary: 150,000 to 180,000 USD annually')?.max === 180000, 'prose: "to" ranges with thousands separators parse');
}

{
  console.log('\n  boundary-aware location matching');
  const ctx = (extra = {}) => ({ criteria: { titleFilter: {}, targetRoles: { primary: [], archetypeNames: [] }, floorUsd: 150000 }, rank: RANK, ...extra });
  const bogota = scoreFind({ ...baseRow(), title: 'Backend Engineer', location: 'Bogotá, Colombia' }, ctx());
  ok(!bogota.reasons.includes('local'), '"Colombia" is not a local hit for "CO"');
  const cofounder = scoreFind({ ...baseRow(), title: 'Co-Founder & CTO', location: 'Remote' }, ctx());
  ok(!cofounder.reasons.includes('local'), '"Co-Founder" is not a local hit');
  const parker = scoreFind({ ...baseRow(), title: 'Platform Engineer', location: 'Parker, CO' }, ctx());
  ok(parker.reasons.includes('local'), '"Parker, CO" (a town not in local_terms) is local via the built-in state-code rule');
  const aboutUs = scoreFind({ ...baseRow(), title: 'Platform Engineer', location: 'Remote' }, ctx({ jdText: 'About us: we are a leading company in Berlin, Germany. Join us.' }));
  ok(!aboutUs.reasons.includes('remote_us'), 'the pronoun "us" in "about us" is not a US signal (Berlin posting gets no remote_us)');
  const usBased = scoreFind({ ...baseRow(), title: 'Platform Engineer', location: 'Remote' }, ctx({ jdText: 'This role is remote, US based, in US time zones.' }));
  ok(usBased.reasons.includes('remote_us'), '"US based" phrasing is a US signal');
  const indiana = scoreFind({ ...baseRow(), title: 'Platform Engineer', location: 'Indianapolis, Indiana' }, ctx());
  ok(!indiana.reasons.includes('non_us_only'), '"Indiana" is not an India hint');
}

{
  console.log('\n  bare-country location = nationwide remote-US (2026-09-17)');
  const { isBareUsCountry } = lib;
  for (const bare of ['United States', 'USA', 'U.S.', ' united states ']) {
    ok(isBareUsCountry(bare), `isBareUsCountry(${JSON.stringify(bare)}) is true`);
  }
  for (const notBare of [
    'United States - California - Sylmar', 'Boston, MA, United States', '2 Locations', '',
    'United States - California', // 2-segment: country + state, still no bare match
    'US Bank', // starts with the "US" alternative but is not the whole string
  ]) {
    ok(!isBareUsCountry(notBare), `isBareUsCountry(${JSON.stringify(notBare)}) is false`);
  }

  const ctx = (extra = {}) => ({ criteria: { titleFilter: {}, targetRoles: { primary: [], archetypeNames: [] }, floorUsd: 150000 }, rank: RANK, ...extra });
  const bareCountry = scoreFind({ ...baseRow(), title: 'Cloud Engineer', location: 'United States' }, ctx());
  const explicitRemote = scoreFind({ ...baseRow(), title: 'Cloud Engineer', location: 'Remote, United States' }, ctx());
  ok(bareCountry.reasons.includes('remote_us'), 'a bare "United States" location scores remote_us');
  eq(bareCountry.score, explicitRemote.score, 'bare-country and "Remote, United States" score identically');

  for (const bare of ['USA', 'U.S.', ' united states ']) {
    const scored = scoreFind({ ...baseRow(), title: 'Cloud Engineer', location: bare }, ctx());
    ok(scored.reasons.includes('remote_us'), `location ${JSON.stringify(bare)} scores remote_us`);
  }

  const sylmar = scoreFind({ ...baseRow(), title: 'Cloud Engineer', location: 'United States - California - Sylmar' }, ctx());
  ok(!sylmar.reasons.includes('remote_us'), 'a state/city-qualified "United States" location does not gain remote_us via the bare-country rule');
  const boston = scoreFind({ ...baseRow(), title: 'Cloud Engineer', location: 'Boston, MA, United States' }, ctx());
  ok(!boston.reasons.includes('remote_us'), 'a city+state prefix before "United States" does not gain remote_us via the bare-country rule');

  const twoLocations = scoreFind({ ...baseRow(), title: 'Cloud Engineer', location: '2 Locations' }, ctx());
  ok(!twoLocations.reasons.includes('local') && !twoLocations.reasons.includes('remote_us') && !twoLocations.reasons.includes('non_us_only'), '"2 Locations" gets no location reason at all');
}

{
  console.log('\n  one-directional primary title match');
  const primary = ['Senior Software Engineer', 'Senior Platform Engineer'];
  const ctx = { criteria: { titleFilter: { positive: ['software engineer', 'platform engineer'] }, targetRoles: { primary, archetypeNames: [] }, floorUsd: 150000 }, rank: RANK };
  const plain = scoreFind({ ...baseRow(), title: 'Software Engineer', location: 'Remote, United States' }, ctx);
  ok(plain.reasons.includes('title_secondary') && !plain.reasons.includes('title_primary'), 'a bare "Software Engineer" is secondary, not primary, against "Senior Software Engineer"');
  eq(decideFind(plain, 40).decision, 'hold', 'a bare remote "Software Engineer" with unknown comp no longer ships on title + remote alone');
  const senior = scoreFind({ ...baseRow(), title: 'Senior Software Engineer II, Platform', location: 'Remote, United States' }, ctx);
  ok(senior.reasons.includes('title_primary') && senior.reasons.includes('seniority'), 'a title that CONTAINS the primary role is primary (and senior)');
  eq(decideFind(senior, 40).decision, 'ship', 'the senior remote role ships');
}

{
  console.log('\n  cvSkillsFromMarkdown on the real cv.md format');
  const cv = '# CV\n\n## Technical Skills\n\n- **Cloud/DevOps:** AWS, Azure, GitLab, GitHub, Terraform, Kubernetes, Docker, Rancher\n'
    + '- **Languages/Frameworks:** C#, .NET, Java, SQL, Python, PyTorch, PowerShell, Bash, JavaScript\n'
    + '- **Tools & Platforms:** SSMS, MongoDB, Claude Code, VS/Code, Ollama/LM Studio, Linux, Splunk, Jira\n\n## Other\n';
  const skills = cvSkillsFromMarkdown(cv);
  for (const want of ['aws', 'c#', '.net', 'ssms', 'kubernetes', 'terraform', 'lm studio', 'python']) ok(skills.includes(want), `keeps "${want}"`);
  for (const junk of ['devops:** aws', 'cloud', 'code', 'tools & platforms:** ssms', 'net', 'languages', 'frameworks']) ok(!skills.includes(junk), `drops junk token "${junk}"`);
  const scored = scoreFind({ ...baseRow(), title: 'Senior Platform Engineer', location: 'Denver, CO' }, {
    criteria: { titleFilter: {}, targetRoles: { primary: ['Senior Platform Engineer'], archetypeNames: [] }, floorUsd: 150000 },
    rank: RANK, cvSkills: new Set(skills), jdText: 'You will build services in C# and .NET on AWS with Terraform and Kubernetes.',
  });
  ok(scored.reasons.includes('stack_match'), '.NET / C# / AWS / Terraform / Kubernetes in a JD count as stack matches (explicit boundaries, not \\b)');
}


// ─────────────────────────────────────────────────────────────────────────
// Second verification round, 2026-09-14
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  comp candidates: marked beats bare comma numbers');
  const sqft = parseCompensation('Our new office spans 50,000 sq ft with room to grow. Salary range: $150,000 - $200,000 per year.');
  ok(sqft && sqft.min === 150000 && sqft.max === 200000, `"50,000 sq ft" does not shadow the real $ range (got ${JSON.stringify(sqft)})`);
  const heads = parseCompensation('We have grown to 25,000 employees worldwide. The base salary for this role is $140,000 - $170,000.');
  ok(heads && heads.min === 140000, '"25,000 employees" does not shadow the real $ range');
  ok(parseCompensation('Serving 40,000 customers across 3 continents.') === null, 'a bare comma number with no salary word before it is not pay');
  ok(parseCompensation('Compensation: 165,000 - 190,000 USD')?.max === 190000, 'a bare comma range led by "Compensation:" is pay');
}

{
  console.log('\n  archetypeRoleNames: level-prefixed, primary fit only');
  const { archetypeRoleNames } = lib;
  eq(archetypeRoleNames([
    { name: 'AI/ML Engineer', level: 'Senior/Staff', fit: 'primary' },
    { name: 'Solutions Architect', level: 'Senior', fit: 'secondary' },
    { name: 'Nameless', fit: 'primary' },
    { name: 'DevOps / Platform Engineer', level: 'Senior/Staff', fit: 'primary' },
  ]), ['Senior AI/ML Engineer', 'Staff AI/ML Engineer', 'Senior DevOps / Platform Engineer', 'Staff DevOps / Platform Engineer'],
  'fans a "Senior/Staff" level out, drops secondary-fit and level-less archetypes');
  const ctx = { criteria: { titleFilter: { positive: ['ai/ml engineer'] }, targetRoles: { primary: [], archetypeNames: archetypeRoleNames([{ name: 'AI/ML Engineer', level: 'Senior/Staff', fit: 'primary' }]) }, floorUsd: 150000 }, rank: RANK };
  const bare = scoreFind({ ...baseRow(), title: 'AI/ML Engineer', location: 'Remote, United States' }, ctx);
  ok(!bare.reasons.includes('title_primary'), 'a bare archetype-named title is not a primary match');
  eq(decideFind(bare, 40).decision, 'hold', 'a bare archetype-named remote role with unknown comp holds');
  const senior = scoreFind({ ...baseRow(), title: 'Staff AI/ML Engineer', location: 'Remote, United States' }, ctx);
  ok(senior.reasons.includes('title_primary'), 'the level-prefixed title is a primary match');
}

{
  console.log('\n  seniority weight: a Staff-titled positive-keyword remote role ships on its own');
  const ctx = { criteria: { titleFilter: { positive: ['platform engineer'] }, targetRoles: { primary: ['Senior Software Engineer'], archetypeNames: [] }, floorUsd: 150000 }, rank: RANK };
  const staff = scoreFind({ ...baseRow(), title: 'Staff Platform Engineer', location: 'Remote - United States' }, ctx);
  ok(staff.reasons.includes('title_secondary') && staff.reasons.includes('seniority') && staff.reasons.includes('remote_us'), 'Staff Platform Engineer: secondary + seniority + remote_us');
  eq(decideFind(staff, 40).decision, 'ship', `Staff Platform Engineer (remote-US, unknown comp) ships at 40 (score ${staff.score})`);
  const mid = scoreFind({ ...baseRow(), title: 'Platform Engineer', location: 'Remote - United States' }, ctx);
  eq(decideFind(mid, 40).decision, 'hold', 'the same title without a seniority signal still holds');
}


{
  console.log('\n  decideFind: a title alone never ships');
  const ctx = { criteria: { titleFilter: { positive: ['platform engineer'] }, targetRoles: { primary: ['Senior Platform Engineer'], archetypeNames: [] }, floorUsd: 150000 }, rank: RANK };
  const bareTitle = scoreFind({ ...baseRow(), url: 'https://example.com/careers/9', title: 'Senior Platform Engineer', location: '' }, ctx);
  ok(bareTitle.score >= 40, `title_primary + seniority alone reach the threshold (score ${bareTitle.score})`);
  const d = decideFind(bareTitle, 40);
  eq(d.decision, 'hold', 'but with no location/comp/date/source/stack signal the row is held');
  eq(d.hold_reason, 'title-only', 'and the hold says why');
  const onAts = scoreFind({ ...baseRow(), url: 'https://boards.greenhouse.io/acme/jobs/9', title: 'Senior Platform Engineer', location: '' }, ctx);
  eq(decideFind(onAts, 40).decision, 'ship', 'the same title from an ATS board (ats_direct) ships');
  const dated = scoreFind({ ...baseRow(), url: 'https://example.com/careers/9', title: 'Senior Platform Engineer', location: '', posted: new Date().toISOString().slice(0, 10) }, ctx);
  eq(decideFind(dated, 40).decision, 'ship', 'the same title with a fresh posting date ships');
}

// ─────────────────────────────────────────────────────────────────────────
// Daemon source pins (autopilot/discovery-node.mjs) — the regressions the
// first night on a real box exposed. The daemon is IO-heavy and not imported
// here; these pin the exact shapes that were wrong.
// ─────────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../autopilot/discovery-node.mjs', import.meta.url), 'utf-8');
  ok(src.includes('const logPath = join(paths.logsDir, `${jobName}.log`);'), 'per-job scanner log path is join()ed onto the absolute logsDir');
  ok(!src.includes('p(paths.logsDir'), 'and never routed through p(), which roots an absolute path under ROOT again (invalid on Windows, swallowed silently)');
  const seenAt = src.indexOf("'/api/discovery/node/seen'");
  const capAt = src.indexOf('validateCfg.max_per_run');
  ok(seenAt > 0 && capAt > seenAt, 'validate: the hub seen-check covers every undecided row BEFORE max_per_run caps the expensive step');
  ok(!src.includes('parsePipelineRows(text).slice(0, validateCfg.max_per_run'), 'and the pending rows are no longer capped as they are parsed');
  ok(src.includes('checked ${undecided}: ${knownCount} known to hub'), 'the validate summary reports known-to-hub vs validated counts');
  // The dispatch was a single ternary until the crawler added a second
  // in-process job; it is a lookup now. What the pin is actually protecting is
  // unchanged: the job is STARTED, not awaited, so a six-hour sweep can't
  // freeze validate/ship/criteria behind it.
  ok(src.includes('const job = inProcess[next] ? inProcess[next](cfg) : runScannerJob(next, cfg, false);'), 'scheduler: a scanner job is started detached from the tick');
  ok(!src.includes('await runScannerJob(next, cfg, false)'), 'and the tick never awaits it');
  ok(/const inProcess = \{[^}]*aggregators: runAggregatorsJob[^}]*sources: runSourcesJob[^}]*\}/.test(src),
    'both in-process jobs are dispatched through the lookup — a name missing from it falls into runScannerJob and silently no-ops');
  ok(!src.includes('await runScannerJob(next, cfg, false)'), 'and never awaited inside it (a six-hour ats_full sweep would freeze validate/ship/criteria)');
  ok(src.includes('.finally(() => { currentJob = null; running = false; })'), 'the one-job-at-a-time guard is released when the detached job settles');
  ok(src.includes('logInfo(`${next}: started`)'), 'each scanner job logs a started line');
  ok(src.includes('logInfo(`${jobName}: ok in ${secs}s — ${rec.last_summary'), 'and recordJobResult logs one outcome line per finished job');
}

// ─────────────────────────────────────────────────────────────────────────
// parseCompensation — three confirmed bugs (#2951, the queue-filters spec):
// each was run against the pre-fix parser and OBSERVED to fail before this
// block was written — see the fixes' comments on COMP_RANGE_RE/PERIOD_SUFFIX/
// PAREN_PERIOD_AFTER_RE for what each producer actually emits.
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  parseCompensation: the three fixed bugs');

  // Bug 1: a per-period unit ("/yr") sits between the first number and the
  // range dash (LinkedIn-style). Pre-fix this returned {min:140000,max:140000}
  // — the range never formed, and the mismarked candidate range collapsed to
  // its first bound alone.
  eq(
    parseCompensation('Base pay range\n\n$140,000.00/yr - $250,000.00/yr'),
    { min: 140000, max: 250000, currency: 'USD', period: 'annual' },
    'bug 1: a "/yr" unit between the first number and the dash still forms the range (LinkedIn)',
  );

  // Bug 2: Workable/SmartRecruiters emit `[currency,min,max,period].join(' ')`
  // — a whitespace-joined range with no dash at all. Pre-fix: {min:150000,max:150000}.
  eq(
    parseCompensation('USD 150000 200000 yearly'),
    { min: 150000, max: 200000, currency: 'USD', period: 'annual' },
    'bug 2: a currency-marked, whitespace-only-joined pair forms a range (Workable/SmartRecruiters)',
  );

  // Bug 3: a parenthetical period marker after the range. Pre-fix,
  // HOURLY_AFTER_RE's leading class doesn't include "(", so " (hour)" is
  // invisible to it, the value reads as annual, fails the 20K floor, and the
  // whole thing is discarded to null.
  eq(
    parseCompensation('USD $85-$95 (hour)'),
    { min: 176800, max: 197600, currency: 'USD', period: 'hourly' },
    'bug 3: a parenthetical "(hour)" marker after the range is recognised as hourly',
  );

  // The whitespace-join guard rail: prose with a real word between two marked
  // numbers must never be read as a range. This is the case the spec calls
  // out by name as the riskiest of the three fixes.
  ok(
    parseCompensation('$5,000 signing bonus 150,000 base') === null,
    'whitespace-join guard: "$5,000 signing bonus 150,000 base" is not a range (real words, not bare whitespace, sit between the numbers)',
  );

  // A whitespace-joined pair where only the SECOND number (or the tail of the
  // match) is marked, never the first, must not pass as a range either — the
  // spec requires the FIRST number's own mark, not a borrowed one.
  ok(
    parseCompensation('5000 150000 USD') === null,
    'whitespace-join guard: a trailing currency code alone does not mark the FIRST number of a whitespace-joined pair',
  );

  // A single number with an inline unit must still work post-fix — this is
  // the regression PERIOD_SUFFIX's nesting inside the range group exists to
  // prevent (a naive "suffix right after NUM" rule would swallow "/hr" into
  // the match and hide it from the existing after-the-match hourly check).
  eq(
    parseCompensation('$85/hr'),
    { min: 176800, max: 176800, currency: 'USD', period: 'hourly' },
    'a single hourly bound with no range still annualizes ($85/hr)',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// parseCompensation — bare-whitespace join, tightened (#2971): a "$"/"k" on
// the FIRST number alone is not enough to trust an adjacent unrelated
// number as its range partner. Each of these pre-fix (bug 2's whitespace
// join with no distinction between a currency-code lead and a "$"/"k"
// lead) manufactured a bogus bound from a 401(k) mention, an equity grant,
// square footage, a headcount, or a second "$"-marked bonus figure — or, in
// the last two cases, discarded a real known salary to null outright.
// Watched fail before the currencyLeadMarked fix: every one of the six
// below returned something other than {min:150000,max:150000}.
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  parseCompensation: bare-whitespace join requires a CURRENCY-CODE lead, not just "$"/"k" on the first number');
  const onlyFirst150k = { min: 150000, max: 150000, currency: 'USD', period: 'annual' };
  eq(parseCompensation('$150,000 401k match available'), onlyFirst150k,
    '"401k" (its own k-suffix) does not become the salary ceiling');
  eq(parseCompensation('This role pays $150,000 750k equity grant over 4 years'), onlyFirst150k,
    'an equity grant figure does not become the salary ceiling');
  eq(parseCompensation('$150,000 30000 sq ft office space'), onlyFirst150k,
    'office square footage does not become the salary floor');
  eq(parseCompensation('$150,000 50000 employees worldwide'), onlyFirst150k,
    'a headcount does not become the salary floor');
  eq(parseCompensation('Salary $150,000 $10,000 relocation bonus'), onlyFirst150k,
    'a second, independently "$"-marked relocation-bonus figure does not turn a real salary into an implausible (and then null) "range"');
  eq(parseCompensation('$150,000 $10,000'), onlyFirst150k,
    'same shape with no trailing words: the known $150,000 salary is never dropped to null');
  // The legitimate motivating case (#2951 bug 2) still works: a currency
  // code immediately before the pair IS trusted.
  eq(parseCompensation('USD 150000 200000 yearly'), { min: 150000, max: 200000, currency: 'USD', period: 'annual' },
    'a genuine currency-code-led whitespace join (Workable/SmartRecruiters) still forms the range');
}

// ─────────────────────────────────────────────────────────────────────────
// parseCompensation — monthly/weekly annualisation (added alongside the
// three bug fixes; multipliers mirror providers/ashby.mjs's
// INTERVAL_MULTIPLIERS '1 MONTH'/'1 WEEK' values, not new numbers)
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  parseCompensation: monthly/weekly annualisation');
  eq(
    parseCompensation('$12,000/mo'),
    { min: 144000, max: 144000, currency: 'USD', period: 'monthly' },
    'a monthly bound annualizes ×12',
  );
  eq(
    parseCompensation('$10,000 - $14,000 per month'),
    { min: 120000, max: 168000, currency: 'USD', period: 'monthly' },
    'a monthly range annualizes ×12',
  );
  eq(
    parseCompensation('USD 160,000-220,000 (per-year-salary)'),
    { min: 160000, max: 220000, currency: 'USD', period: 'annual' },
    'a "(per-year-salary)" parenthetical marker reads as annual (live-data shape named in the spec)',
  );
  eq(
    parseCompensation('$2,500/wk'),
    { min: 130000, max: 130000, currency: 'USD', period: 'weekly' },
    'a weekly bound annualizes ×52',
  );
  ok(
    parseCompensation('$50/mo') === null,
    'a monthly figure below the monthly plausibility floor is discarded, not misread as a tiny annual salary',
  );
  ok(
    parseCompensation('$999,999/wk') === null,
    'a weekly figure far above the weekly plausibility ceiling is discarded',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Start-time ("slot") scheduling in planNextJob / jobNextRunAt
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  planNextJob: jobs with a start time');
  const { jobNextRunAt, slotSpec } = lib;
  // Local-time constructors on purpose: slots are "06:00 where the user lives".
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m, 0, 0);
  const slotIso = (d, h, m = 0) => at(d, h, m).toISOString();
  const cfg = { tracked: { enabled: true, every_minutes: 1440, start_at: '06:00' } };

  eq(slotSpec({ start_at: '6:00', every_minutes: 60 }), { start_at: '06:00', every_ms: 3_600_000 }, 'slotSpec normalizes H:MM and reads the interval');
  ok(slotSpec({ every_minutes: 60 }) === null && slotSpec({ start_at: '', every_minutes: 60 }) === null && slotSpec({ start_at: 'later', every_minutes: 60 }) === null,
    'no, empty or unreadable start_at means a plain interval job');

  eq(planNextJob(cfg, { jobs: {} }, at(14, 5).getTime()), 'tracked', 'a slot job that has never run is due at once, like any never-run job');
  eq(planNextJob(cfg, { jobs: { tracked: { last_slot_at: slotIso(13, 6), last_run_at: slotIso(13, 6) } } }, at(14, 5).getTime()), null,
    'once it has served yesterday\'s 06:00 slot it waits for today\'s');
  eq(planNextJob(cfg, { jobs: { tracked: { last_slot_at: slotIso(13, 6), last_run_at: slotIso(13, 6) } } }, at(14, 6, 30).getTime()), 'tracked',
    'after 06:00 the new slot is due');
  eq(planNextJob(cfg, { jobs: { tracked: { last_slot_at: slotIso(14, 6), last_run_at: slotIso(14, 6, 40) } } }, at(14, 23).getTime()), null,
    'a run that finished after its slot does not make the NEXT slot look served or due early');
  // The slot is compared with the slot last served, never the finish time.
  eq(planNextJob({ tracked: { enabled: true, every_minutes: 240, start_at: '06:00' } },
    { jobs: { tracked: { last_slot_at: slotIso(14, 6), last_run_at: slotIso(14, 11) } } }, at(14, 11, 30).getTime()), 'tracked',
  'a run that took longer than the interval still leaves the following slot due');

  // A start time added to a job that already ran: the last run counts for the slot it fell in.
  eq(planNextJob(cfg, { jobs: { tracked: { last_run_at: slotIso(14, 8, 30) } } }, at(14, 11, 30).getTime()), null,
    'adding a start time does not re-run a job that ran after the latest slot');
  eq(planNextJob(cfg, { jobs: { tracked: { last_run_at: slotIso(14, 5) } } }, at(14, 11, 30).getTime()), 'tracked',
    'but one whose last run predates the latest slot catches up once');

  // Mixed: a never-run interval job goes first; among due jobs the most overdue wins.
  const mixed = { tracked: { enabled: true, every_minutes: 1440, start_at: '06:00' }, boards: { enabled: true, every_minutes: 60 } };
  eq(planNextJob(mixed, { jobs: { tracked: { last_slot_at: slotIso(13, 6) } } }, at(14, 7).getTime()), 'boards',
    'never-run precedence applies to interval jobs only: a never-run boards goes before a due slot job');
  const ran = (ms) => ({ last_run_at: new Date(ms).toISOString() });
  const now = at(14, 7).getTime();
  eq(planNextJob(mixed, { jobs: { tracked: { last_slot_at: slotIso(13, 6) }, boards: ran(now - 90 * 60_000) } }, now), 'tracked',
    'a slot job due for an hour beats an interval job due for half of one');
  eq(planNextJob(mixed, { jobs: { tracked: { last_slot_at: slotIso(13, 6) }, boards: ran(now - 5 * 3_600_000) } }, now), 'boards',
    'and the other way round when the interval job is the more overdue');
  eq(planNextJob({ tracked: { enabled: false, every_minutes: 1440, start_at: '06:00' } }, { jobs: {} }, now), null, 'a disabled slot job is never picked');
  eq(planNextJob({ tracked: { enabled: true, every_minutes: 120, start_at: '' } }, { jobs: { tracked: ran(now - 60_000) } }, now), null,
    'an empty start_at is an ordinary interval job');

  // jobNextRunAt
  eq(jobNextRunAt(cfg.tracked, { last_slot_at: slotIso(13, 6) }, at(14, 5).getTime()), slotIso(14, 6), 'a slot job\'s next run is its next slot');
  eq(jobNextRunAt(cfg.tracked, { last_slot_at: slotIso(13, 6) }, at(14, 7).getTime()), slotIso(14, 6), 'a due slot reports the slot that is waiting (already past)');
  eq(jobNextRunAt(cfg.tracked, { last_slot_at: slotIso(14, 6) }, at(14, 7).getTime()), slotIso(15, 6), 'and the next one once it has been served');
  eq(jobNextRunAt({ every_minutes: 120 }, { last_run_at: '2026-09-14T00:00:00.000Z' }, 0), '2026-09-14T02:00:00.000Z', 'an interval job\'s next run is last run + interval');
  ok(jobNextRunAt({ every_minutes: 120 }, {}, 0) === null, 'and unknown before it has ever run');
}

// ─────────────────────────────────────────────────────────────────────────
// buildHeartbeatStatus: control fields and the size guard
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  buildHeartbeatStatus: what the hub is told');
  const state = { jobs: { tracked: { last_run_at: '2026-09-14T00:00:00Z', last_ok: true, runs: 1, errors: 0, last_summary: 'ok' } }, command_acks: ['c1', 'c2'], control_revision: 4 };
  const jobsConfig = { tracked: { enabled: true, every_minutes: 120, start_at: '06:00', max_minutes: 45 } };
  const s = buildHeartbeatStatus(state, jobsConfig, {
    paused: true, dashboard: { enabled: true, port: 8390 }, sources: { tracked: { every_minutes: 'hub', enabled: 'config' } }, now: Date.UTC(2026, 8, 14, 12),
  });
  ok(s.paused === true && s.control_revision === 4 && s.dashboard.port === 8390, 'paused, control_revision and dashboard are reported');
  eq(s.command_acks, ['c1', 'c2'], 'and the command acknowledgements (from state by default)');
  ok(s.jobs.tracked.every_minutes === 120 && s.jobs.tracked.start_at === '06:00' && s.jobs.tracked.max_minutes === 45, 'each job carries every_minutes, start_at and max_minutes');
  eq(s.jobs.tracked.source, { every_minutes: 'hub', enabled: 'config' }, 'and where its controllable values came from');
  const plain = buildHeartbeatStatus({}, { tracked: { enabled: true } }, {});
  ok(plain.paused === false && plain.control_revision === null && plain.dashboard === null && plain.command_acks.length === 0 && plain.jobs.tracked.start_at === null && !('source' in plain.jobs.tracked),
    'with nothing to report the new fields are false/null/empty, and no source map');
  ok(buildHeartbeatStatus({ command_acks: Array.from({ length: 50 }, (_, i) => `c${i}`) }, {}, {}).command_acks.length === 20, 'acknowledgements are capped at 20');

  // The 7 KB guard.
  const names = ['tracked', 'aggregators', 'sources', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full', 'validate'];
  const big = { jobs: {} };
  const cfgs = {};
  const sources = {};
  for (const n of names) {
    big.jobs[n] = { last_run_at: '2026-09-14T00:00:00Z', last_ok: true, runs: 9, errors: 0, last_summary: '\u{1F600}'.repeat(100) };
    cfgs[n] = { enabled: true, every_minutes: 60, start_at: '06:00', max_minutes: 45 };
    sources[n] = { enabled: 'config', every_minutes: 'hub', start_at: 'local', max_minutes: 'config' };
  }
  const roomy = buildHeartbeatStatus(big, cfgs, { sources });
  ok(Buffer.byteLength(JSON.stringify(roomy)) <= 7 * 1024 && names.every((n) => roomy.jobs[n].source), 'a normal status fits and keeps its source maps');
  const huge = buildHeartbeatStatus(big, cfgs, { sources, last_error: { message: 'e'.repeat(4000) } });
  const hugeBytes = Buffer.byteLength(JSON.stringify(huge));
  ok(hugeBytes <= 7 * 1024, `an oversized status is shed down to under 7 KB (${hugeBytes} bytes)`);
  ok(names.every((n) => !('source' in huge.jobs[n])), 'the per-job source maps go first');
  ok(names.every((n) => huge.jobs[n].every_minutes === 60 && huge.jobs[n].enabled === true), 'while the schedule itself is never shed');
}

// ─────────────────────────────────────────────────────────────────────────
// foldIngestResponse: rate limits, a capped batch, recent finds
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  foldIngestResponse: 429, capped, recent finds');
  const mk = () => ({ shipped: {}, held: {}, dropped: {}, to_ship: [] });
  const batch = [1, 2, 3].map((n) => ({ key: `k${n}`, url: `https://a.example.com/${n}`, company: `Co ${n}`, title: `Role ${n}`, score: 50 }));

  const s429 = mk(); s429.to_ship = [...batch];
  foldIngestResponse(s429, batch, { ok: false, status: 429, json: { error: 'daily_cap' } });
  ok(s429.to_ship.length === 3 && Object.keys(s429.dropped).length === 0, 'a 429 leaves every find queued and drops nothing');

  const capped = mk(); capped.to_ship = [...batch];
  foldIngestResponse(capped, batch, { ok: true, status: 202, json: { capped: true, accepted_urls: [batch[0].url], duplicate_urls: [], deferred_urls: [batch[1].url, batch[2].url] } });
  eq(capped.to_ship.map((f) => f.key), ['k2', 'k3'], 'a capped 202 keeps the deferred finds queued');
  ok(capped.shipped.k1.hub === 'accepted' && !capped.dropped.k2 && !capped.dropped.k3, 'and does not call them rejected');

  const cappedNoList = mk(); cappedNoList.to_ship = [...batch];
  foldIngestResponse(cappedNoList, batch, { ok: true, status: 202, json: { capped: true, accepted_urls: [batch[0].url], duplicate_urls: [] } });
  eq(cappedNoList.to_ship.map((f) => f.key), ['k2', 'k3'], 'with no deferred_urls list, whatever the hub did not account for stays queued');

  const cappedReject = mk(); cappedReject.to_ship = [...batch];
  foldIngestResponse(cappedReject, batch, { ok: true, status: 202, json: { capped: true, accepted_urls: [batch[0].url], duplicate_urls: [], deferred_urls: [batch[1].url] } });
  eq(cappedReject.to_ship.map((f) => f.key), ['k2'], 'with a deferred list, a find it names neither accepted nor deferred is a real rejection');
  ok(cappedReject.dropped.k3?.reason === 'hub_rejected', 'and is dropped as such');

  const plain = mk(); plain.to_ship = [...batch];
  foldIngestResponse(plain, batch, { ok: true, status: 202, json: { accepted_urls: [batch[0].url], duplicate_urls: [batch[1].url] } });
  ok(plain.dropped.k3?.reason === 'hub_rejected' && plain.to_ship.length === 0, 'an uncapped 202 behaves exactly as before');

  eq(plain.recent_shipped.map((e) => e.url), [batch[0].url], 'recent_shipped records accepted finds only');
  ok(plain.recent_shipped[0].company === 'Co 1' && plain.recent_shipped[0].title === 'Role 1' && typeof plain.recent_shipped[0].at === 'string', 'with company, title and time');
  const ring = mk();
  for (let i = 0; i < 30; i++) lib.recordRecentShipped(ring, { url: `https://a.example.com/${i}`, company: 'C', title: 'T' });
  ok(ring.recent_shipped.length === 20 && ring.recent_shipped[0].url.endsWith('/29'), 'the ring keeps the newest 20, newest first');
  lib.recordRecentShipped(ring, { url: 'https://a.example.com/29', company: 'C', title: 'T2' });
  ok(ring.recent_shipped.length === 20 && ring.recent_shipped.filter((e) => e.url.endsWith('/29')).length === 1, 'and does not list one URL twice');
  const long = lib.recordRecentShipped({}, { url: 'https://a.example.com/x', company: 'c'.repeat(500), title: 't'.repeat(500) }).recent_shipped[0];
  ok(long.company.length <= 120 && long.title.length <= 200, 'scraped strings are bounded');
}

// ─────────────────────────────────────────────────────────────────────────
// hubFetch: redirects are errors, Retry-After is read
// ─────────────────────────────────────────────────────────────────────────
{
  console.log('\n  hubFetch: no redirects, Retry-After');
  const { createServer } = await import('http');
  const { hubFetch } = lib;
  const seenAtTarget = [];
  const target = createServer((req, res) => { seenAtTarget.push(req.headers.authorization || null); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetUrl = `http://127.0.0.1:${target.address().port}/followed`;
  const hub = createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: targetUrl }); res.end(); return; }
    if (req.url === '/limited') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' }); res.end('{"error":"daily_cap"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  const marker = 'cot_redirect-test-marker';
  const hubCfg = { url: `http://127.0.0.1:${hub.address().port}`, token: marker };
  let threw = null;
  try { await hubFetch(hubCfg, '/redir'); } catch (err) { threw = err; }
  ok(threw !== null, 'a redirect from the hub is an error, not followed');
  ok(seenAtTarget.length === 0, 'so the bearer token never reaches the redirect target');
  ok(!String(threw?.message || '').includes(marker) && !String(threw?.cause?.message || '').includes(marker), 'and the error does not carry the token');
  const limited = await hubFetch(hubCfg, '/limited');
  ok(limited.status === 429 && limited.retryAfter === 120 && limited.json.error === 'daily_cap', 'a 429 comes back with its Retry-After in seconds');
  const fine = await hubFetch(hubCfg, '/fine');
  ok(fine.ok && fine.retryAfter === null, 'and a response without one reports null');
  hub.closeAllConnections?.(); target.closeAllConnections?.();
  await new Promise((r) => hub.close(r));
  await new Promise((r) => target.close(r));
}

// ─────────────────────────────────────────────────────────────────────────
// Daemon wiring pins for this change (the daemon is exercised for real in
// tests/discovery-node-daemon.test.mjs; these pin the shapes it depends on)
// ─────────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../autopilot/discovery-node.mjs', import.meta.url), 'utf-8');
  const exitCall = new RegExp('process\\.' + 'exit\\s*\\(');
  for (const route of ['criteria', 'seen', 'ingest', 'heartbeat']) {
    ok(src.includes(`'/api/discovery/node/${route}'`) && src.includes(`'/api/companion/discovery/${route}'`), `both routes for "${route}" are literals in the daemon`);
  }
  ok(src.indexOf("callHub(cfg.hub, 'seen'") > 0 && src.indexOf("callHub(cfg.hub, 'seen'") < src.indexOf('validateCfg.max_per_run'),
    'validate asks the hub which rows it knows BEFORE max_per_run caps the expensive step (through callHub now)');
  ok(src.includes('if (!companionMode) applyControlFromHub(cfg, res.json?.control);'), 'a hosted hub\'s control is never applied');
  ok(src.includes('state.started_at = STARTED_AT.toISOString();'), 'the daemon stamps its start time so --status\'s config-staleness check is truthful');
  ok(src.includes('configStaleness(paths.nodeConfig, state.started_at)'), 'and --status still compares against it');
  ok(src.includes("takeRunNow(state, (name) => name !== 'validate')") && src.includes("takeRunNow(state, (name) => name === 'validate')"), 'run-now: scanner jobs and validate are taken separately');
  ok(src.includes('await runValidate(cfg, false)'), 'validate runs through runValidate (which records the run)');
  ok(src.includes('state.jobs[next].last_slot_at = lastSlotAtOrBefore(spec, now)'), 'a job that starts on its schedule stamps the slot it is serving');
  ok(src.includes('cfg.health?.enabled === false'), 'health.enabled: false switches the health server off');
  ok(/export async function runDaemon\(/.test(src) && /export class DaemonRefusal/.test(src), 'runDaemon and DaemonRefusal are exported');
  const body = src.slice(src.indexOf('export async function runDaemon('), src.indexOf('// ── CLI ──'));
  ok(body.length > 200 && !exitCall.test(body) && !body.includes('requireConfig('), 'runDaemon neither exits the process nor reads the config itself');
}

// ─────────────────────────────────────────────────────────────────────────
// One node per checkout: the lock file (acquireInstanceLock)
// ─────────────────────────────────────────────────────────────────────────
{
  const { acquireInstanceLock, instanceRefusalMessage, pidIsAlive } = lib;
  const { existsSync, utimesSync } = await import('fs');
  const dir = mkdtempSync(join(tmpdir(), 'node-lock-'));
  try {
    const file = join(dir, 'data', 'discovery-node', 'daemon.lock');
    const first = acquireInstanceLock(file, { pid: 1111, now: () => '2026-10-15T10:00:00.000Z' });
    ok(first.ok && existsSync(file) && JSON.parse(readFileSync(file, 'utf-8')).pid === 1111, 'the first launch takes the lock (the folders are created) and records its pid');
    const alive = (pid) => pid === 1111;
    // The machine booted before the holder started, so a live pid means a live node.
    const bootedAt = () => Date.parse('2026-10-15T08:00:00.000Z');
    const second = acquireInstanceLock(file, { pid: 2222, isAlive: alive, bootedAt });
    ok(!second.ok && second.holder.pid === 1111 && second.holder.started_at === '2026-10-15T10:00:00.000Z' && second.holder.dashboard_port === null,
      'a second launch while the first is alive is refused, and told who holds it');
    first.update({ dashboard_port: 8391 });
    ok(acquireInstanceLock(file, { pid: 2222, isAlive: alive, bootedAt }).holder.dashboard_port === 8391, 'the holder\'s dashboard port can be added to the lock');

    // A reboot since the lock was written: its pid now belongs to some other
    // process (alive, or EPERM), yet the lock cannot be a running node's.
    const rebooted = acquireInstanceLock(file, { pid: 2222, isAlive: () => true, bootedAt: () => Date.parse('2026-10-15T11:00:00.000Z') });
    ok(rebooted.ok && JSON.parse(readFileSync(file, 'utf-8')).pid === 2222, 'a lock written before the last boot is stale even when its pid is alive again');
    rebooted.release();
    writeFileSync(file, JSON.stringify({ pid: 1111, started_at: '2026-10-15T10:00:00.000Z', dashboard_port: 8391 }));
    ok(JSON.parse(readFileSync(file, 'utf-8')).pid === 1111 && !('key' in JSON.parse(readFileSync(file, 'utf-8'))), 'and the record holds only the pid, start time and port');

    // A holder that has died: stale, taken over (the file is replaced, not appended to).
    const takeover = acquireInstanceLock(file, { pid: 3333, isAlive: () => false });
    ok(takeover.ok && JSON.parse(readFileSync(file, 'utf-8')).pid === 3333, 'a lock whose process is gone is taken over');
    // …and the old owner's late release or update must not disturb the new owner's lock.
    first.update({ dashboard_port: 9999 });
    first.release();
    ok(existsSync(file) && JSON.parse(readFileSync(file, 'utf-8')).pid === 3333 && JSON.parse(readFileSync(file, 'utf-8')).dashboard_port === null, 'a release or update from a process that no longer holds the lock changes nothing');
    takeover.release();
    ok(!existsSync(file), 'the holder\'s release removes the file');
    takeover.release();
    ok(!existsSync(file), 'and releasing twice is harmless');

    // Our own pid in an old file (a crash, then the same pid again) is not "another copy".
    writeFileSync(file, JSON.stringify({ pid: 4444, started_at: '2026-10-15T09:00:00.000Z' }));
    ok(acquireInstanceLock(file, { pid: 4444, isAlive: () => true }).ok, 'a lock naming this very process is not a reason to refuse');
    rmSync(file, { force: true });

    // A lock nobody can read: left by a crash when old, another launcher mid-write when young.
    for (const junk of ['', '{"pid": ', '{"pid": "x"}', '[]', '{"pid": -4}']) {
      writeFileSync(file, junk);
      const old = new Date(Date.now() - 60_000);
      utimesSync(file, old, old);
      ok(acquireInstanceLock(file, { pid: 5555 }).ok, `an old unreadable lock (${JSON.stringify(junk)}) is taken over`);
      rmSync(file, { force: true });
    }
    writeFileSync(file, '');
    const young = acquireInstanceLock(file, { pid: 5555 });
    ok(!young.ok && young.holder === null, 'an unreadable lock only moments old is another launcher mid-write: not taken');
    ok(/already starting|starting right now/.test(instanceRefusalMessage(null)), 'and the message for that says so');
    rmSync(file, { force: true });

    // The message: how to get out, never an access key.
    const msg = instanceRefusalMessage({ pid: 4242, started_at: '2026-10-15T10:00:00.000Z', dashboard_port: 8390 });
    ok(/process 4242/.test(msg) && msg.includes('http://127.0.0.1:8390/') && /delete data\/discovery-node\/daemon\.lock/.test(msg) && !/#k=/.test(msg), 'the refusal names the process and the dashboard address, and how to clear a stale lock');
    ok(pidIsAlive(process.pid) && !pidIsAlive(0) && !pidIsAlive(-1) && !pidIsAlive(1.5) && !pidIsAlive('12'), 'pidIsAlive: this process yes, junk no');
    writeFileSync(join(dir, 'blocker'), 'a file where a folder should be');
    ok(throwsCode(() => acquireInstanceLock(join(dir, 'blocker', 'daemon.lock'))), 'an unexpected filesystem error is raised, not turned into "stale"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function throwsCode(fn) { try { fn(); return false; } catch (err) { return Boolean(err?.code); } }
