// tests/slot-schedule.test.mjs — lib/slot-schedule.mjs, the "start at HH:MM,
// then every N" arithmetic shared by the Jobs tab and the discovery node.
//
// Every date below is built with LOCAL-time constructors, so the assertions
// hold in whatever time zone the suite runs in.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nslot-schedule — start time + interval');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const {
  parseHHMM, normalizeHHMM, lastSlotAtOrBefore, nextSlotAfter, slotsBetween, slotDue, HOUR_MS, DAY_MS,
} = await import(pathToFileURL(join(ROOT, 'lib', 'slot-schedule.mjs')).href);

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const hm = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

{
  ok(parseHHMM('6:05')?.h === 6 && parseHHMM('6:05')?.m === 5, 'parseHHMM reads H:MM');
  ok(parseHHMM('24:00') === null && parseHHMM('12:60') === null && parseHHMM('noon') === null && parseHHMM('') === null,
    'parseHHMM rejects out-of-range and non-times');
  ok(normalizeHHMM('6:05') === '06:05' && normalizeHHMM('bad') === null, 'normalizeHHMM pads and refuses junk');
}

{
  const spec = { start_at: '06:00', every_ms: 4 * HOUR_MS };
  const now = local(2026, 9, 2, 11, 30);
  ok(hm(lastSlotAtOrBefore(spec, now)) === '10:00', '06:00 every 4h: the last slot before 11:30 is 10:00');
  ok(hm(nextSlotAfter(spec, now)) === '14:00', '06:00 every 4h: the next slot after 11:30 is 14:00');
  const early = local(2026, 9, 2, 3, 0);
  const prev = lastSlotAtOrBefore(spec, early);
  ok(hm(prev) === '02:00' && prev.getDate() === 2, 'the grid runs round the clock: before 03:00 the last slot is 02:00');
  ok(hm(nextSlotAfter(spec, early)) === '06:00', 'after 02:00 the next slot is today\'s 06:00');
  ok(hm(nextSlotAfter(spec, local(2026, 9, 2, 22, 0))) === '02:00', 'a slot boundary is not "after" itself');
}

{
  const spec = { start_at: '06:00', every_ms: 5 * HOUR_MS };
  const slots = slotsBetween(spec, local(2026, 9, 2, 5, 0), local(2026, 9, 3, 7, 0)).map(hm);
  ok(slots.join(',') === '06:00,11:00,16:00,21:00,02:00,06:00',
    'an interval that does not divide 24h restarts at start_at each day instead of drifting');
}

{
  const spec = { start_at: '23:00', every_ms: 24 * HOUR_MS };
  ok(hm(nextSlotAfter(spec, local(2026, 9, 2, 23, 30))) === '23:00'
    && nextSlotAfter(spec, local(2026, 9, 2, 23, 30)).getDate() === 3, 'daily: one slot a day at start_at');
}

{
  const spec = { start_at: '09:30', every_ms: 2 * DAY_MS };
  const a = nextSlotAfter(spec, local(2026, 9, 2, 12, 0));
  const b = nextSlotAfter(spec, a);
  ok(hm(a) === '09:30' && Math.round((b - a) / DAY_MS) === 2, 'every 2 days lands on every other day at start_at');
  const again = nextSlotAfter(spec, local(2026, 9, 2, 12, 0));
  ok(again.getTime() === a.getTime(), 'a multi-day grid is anchored to a fixed date, not to when it was asked');
}

{
  const spec = { start_at: '06:00', every_ms: 4 * HOUR_MS };
  const now = local(2026, 9, 2, 11, 30);
  const first = slotDue(spec, { now });
  ok(first.due && hm(first.slot) === '10:00', 'never run: the most recent slot is due');
  ok(!slotDue(spec, { now, last_slot_at: first.slot }).due, 'a slot already served is not due again');
  const late = slotDue(spec, { now, last_slot_at: local(2026, 9, 2, 6, 0), max_late_ms: HOUR_MS });
  ok(!late.due && late.missed, 'a slot missed by more than max_late_ms is reported missed, not run late');
  ok(slotDue(spec, { now, last_slot_at: local(2026, 9, 2, 6, 0), max_late_ms: 2 * HOUR_MS }).due,
    'a slot within max_late_ms is still due');
}

{
  ok(lastSlotAtOrBefore({ start_at: 'x', every_ms: HOUR_MS }) === null
    && nextSlotAfter({ start_at: '06:00', every_ms: 0 }) === null
    && !slotDue({ start_at: '06:00', every_ms: 1000 }).due,
  'an unusable spec (bad time, interval under a minute) never schedules anything');
}
