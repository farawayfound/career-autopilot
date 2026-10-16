// tests/discovery-node-control.test.mjs — autopilot/lib/discovery-node-control.mjs,
// the one validator for a discovery node's runtime controls (admin dashboard
// and the node's own local dashboard both write through it).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ndiscovery-node-control — pause and per-job overrides');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const {
  NODE_JOB_NAMES, sanitizeJobOverride, sanitizeControl, patchControl, effectiveJobs, isPaused,
} = await import(pathToFileURL(join(ROOT, 'autopilot', 'lib', 'discovery-node-control.mjs')).href);
const { SCANNER_JOB_ORDER } = await import(pathToFileURL(join(ROOT, 'autopilot', 'lib', 'discovery-node.mjs')).href);

ok(JSON.stringify([...NODE_JOB_NAMES].sort()) === JSON.stringify([...SCANNER_JOB_ORDER, 'validate'].sort()),
  'every scheduled job (plus validate) is controllable, and nothing else is');

{
  const r = sanitizeJobOverride('tracked', { enabled: false, every_minutes: '90', start_at: '6:30', max_minutes: 30 });
  ok(r.errors.length === 0 && r.value.enabled === false && r.value.every_minutes === 90 && r.value.start_at === '06:30' && r.value.max_minutes === 30,
    'valid fields survive, numeric strings and H:MM are normalized');
  const bad = sanitizeJobOverride('tracked', { every_minutes: 1, start_at: '25:00', hub_url: 'http://x', enabled: 'yes' });
  ok(Object.keys(bad.value).length === 0 && bad.errors.length === 4, 'out-of-range, malformed and uncontrollable keys are all dropped and named');
  ok(sanitizeJobOverride('aggregators', { max_minutes: 10 }).errors.length === 1, 'max_minutes is refused on an in-process job');
  ok(sanitizeJobOverride('ats_full', { ats: 'greenhouse,lever' }).value.ats === 'greenhouse,lever'
    && sanitizeJobOverride('ats_full', { ats: 'greenhouse;rm -rf' }).errors.length === 1,
  'ats_full.ats accepts an id list and nothing shell-shaped');
  ok(sanitizeJobOverride('nope', { enabled: true }).errors.length === 1, 'an unknown job is refused');
  ok(sanitizeJobOverride('tracked', { start_at: '' }).value.start_at === '', 'an empty start_at is kept: it clears a configured start time');
  ok(sanitizeJobOverride('validate', { start_at: '06:00' }).errors.length === 1, 'validate refuses a start time it would never honour');
  const day30h = sanitizeJobOverride('tracked', { start_at: '06:00', every_minutes: 30 * 60 });
  ok(day30h.errors.length === 1 && day30h.value.every_minutes === undefined, 'a start time with a 30h interval is refused (slots count whole days)');
  ok(sanitizeJobOverride('tracked', { start_at: '06:00', every_minutes: 48 * 60 }).errors.length === 0, 'a start time with a whole-day interval is fine');
}

{
  const r = sanitizeControl({ paused: true, jobs: { tracked: { enabled: false }, bogus: { enabled: true } }, token: 'x' });
  ok(r.value.paused === true && r.value.jobs.tracked.enabled === false && !r.value.jobs.bogus && !('token' in r.value),
    'a control document keeps pause and known jobs only');
  ok(sanitizeControl(null).value.paused === undefined && sanitizeControl(null).errors.length === 0, 'no control is an empty control');
}

{
  const cur = { paused: true, jobs: { tracked: { enabled: false, every_minutes: 60 }, boards: { start_at: '06:00' } } };
  const r = patchControl(cur, { paused: null, jobs: { tracked: { enabled: null, start_at: '07:00' }, boards: null } });
  ok(r.value.paused === undefined, 'a null pause removes the override');
  ok(r.value.jobs.tracked.enabled === undefined && r.value.jobs.tracked.every_minutes === 60 && r.value.jobs.tracked.start_at === '07:00',
    'a null field removes just that field, others are kept, new ones set');
  ok(!r.value.jobs.boards, 'a null job removes all of its overrides');
  ok(cur.jobs.tracked.enabled === false, 'the stored control is not mutated');
}

{
  // The whole-day rule joins start_at and every_minutes, which can arrive in two saves. Each alone is valid;
  // stored together they used to be accepted ("ok", errors []) and then discarded by every reader.
  const stored = patchControl({}, { jobs: { tracked: { start_at: '06:00' } } });
  ok(stored.errors.length === 0 && stored.value.jobs.tracked.start_at === '06:00', 'a start time on its own is stored');
  const interval = patchControl(stored.value, { jobs: { tracked: { every_minutes: 2000 } } });
  ok(interval.errors.length === 1 && /whole days/.test(interval.errors[0]), 'an interval over a day that is not whole days is refused against the STORED start time');
  ok(JSON.stringify(interval.value.jobs.tracked) === JSON.stringify({ start_at: '06:00' }), 'and the job keeps exactly the override it had');
  ok(patchControl(stored.value, { jobs: { tracked: { every_minutes: 2880 } } }).value.jobs.tracked.every_minutes === 2880, 'a whole-day interval is fine beside the stored start time');
  // …the other way round
  const intervalFirst = patchControl({}, { jobs: { boards: { every_minutes: 2000 } } });
  ok(intervalFirst.errors.length === 0 && intervalFirst.value.jobs.boards.every_minutes === 2000, 'an interval over a day on its own is stored');
  const startAfter = patchControl(intervalFirst.value, { jobs: { boards: { start_at: '07:30' } } });
  ok(startAfter.errors.length === 1 && JSON.stringify(startAfter.value.jobs.boards) === JSON.stringify({ every_minutes: 2000 }), 'a start time is refused against the STORED interval, which is kept (the save does not eat it)');
  ok(patchControl(intervalFirst.value, { jobs: { boards: { start_at: '07:30', every_minutes: 1440 * 2 } } }).errors.length === 0, 'changing both in one save to a valid pair works');
  const cleared = patchControl(stored.value, { jobs: { tracked: { start_at: '', every_minutes: 2000 } } });
  ok(cleared.errors.length === 0 && cleared.value.jobs.tracked.every_minutes === 2000 && cleared.value.jobs.tracked.start_at === '', 'clearing the start time in the same save allows the long interval');
  const refused = patchControl({}, { jobs: { tracked: { start_at: '06:00', every_minutes: 2000 } }, paused: true });
  ok(refused.errors.length === 1 && refused.value.paused === true && JSON.stringify(refused.value.jobs.tracked) === JSON.stringify({ start_at: '06:00' }), 'both in one save: the interval alone is refused (reported once) and the rest of the save stands');
  ok(patchControl({}, { jobs: { nope: { enabled: true } } }).errors.length === 1, 'an unknown job is still reported once');
}

{
  const base = { tracked: { enabled: true, every_minutes: 120, max_minutes: 60 }, boards: { enabled: true, every_minutes: 180 } };
  const { jobs, sources } = effectiveJobs(base, [
    { name: 'hub', control: { jobs: { tracked: { every_minutes: 30 }, seeds: { enabled: true } } } },
    { name: 'local', control: { jobs: { tracked: { enabled: false } } } },
  ]);
  ok(jobs.tracked.every_minutes === 30 && jobs.tracked.enabled === false && jobs.tracked.max_minutes === 60,
    'layers overlay in order, untouched keys pass through');
  ok(sources.tracked.every_minutes === 'hub' && sources.tracked.enabled === 'local' && sources.tracked.max_minutes === 'config',
    'every controllable value records where it came from');
  ok(!jobs.seeds, 'a control never conjures a job the config file has no block for');
  ok(base.tracked.every_minutes === 120, 'the config file\'s jobs are not mutated');
  ok(isPaused([{ name: 'hub', control: null }, { name: 'local', control: { paused: true } }]) && !isPaused([]), 'any pausing layer pauses');
}
