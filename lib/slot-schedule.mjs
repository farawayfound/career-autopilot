// lib/slot-schedule.mjs — "start at HH:MM, then every N" schedule arithmetic.
//
// One pure module shared by the autopilot's own timers (the Jobs tab's admin
// cycle, guest cycles, the guest cascade, the email agent, the liveness sweep) and the
// discovery node's scheduler, so the Jobs tab's forecast and the runtime that
// actually fires can never disagree about when a slot is. No IO, no imports.
//
// Semantics, chosen so the common case reads the way a person says it:
//
//   - every <= 24h: the slots restart at `start_at` every local day —
//     start_at, start_at + every, ... while still before the NEXT day's
//     start_at. "06:00 every 4h" is 06,10,14,18,22,02 — round the clock,
//     anchored at 06:00. An interval that does not divide 24h leaves one
//     shorter gap before the next day's first slot ("06:00 every 5h" is
//     06,11,16,21,02, then 06 again) rather than drifting.
//   - every > 24h: whole days (rounded), at start_at, on every Nth local day
//     counted from a fixed reference date — so "every 2 days" is stable across
//     restarts instead of depending on when the process happened to start.
//
// All slot times are built with local-time setters (setHours), never by adding
// milliseconds across midnight, so a DST change moves no slot by an hour.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// The fixed day multi-day intervals count from. Any local date works; this one
// only has to never change.
const REFERENCE_DAY = Date.UTC(2026, 0, 1) / DAY_MS;

/** "H:MM" or "HH:MM" (00:00..23:59) → {h, m}, anything else → null. */
export function parseHHMM(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** A canonical "HH:MM" for a valid value, else null. */
export function normalizeHHMM(value) {
  const t = parseHHMM(value);
  return t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : null;
}

function atLocal(day, t) {
  const d = new Date(day);
  d.setHours(t.h, t.m, 0, 0);
  return d;
}

function addLocalDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const localDayNumber = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;

/**
 * Every slot that begins on the local day `day` (any Date within that day).
 * @param {Date} day
 * @param {{h:number,m:number}} t
 * @param {number} everyMs
 * @returns {Date[]}
 */
function slotsOnDay(day, t, everyMs) {
  const first = atLocal(day, t);
  if (everyMs > DAY_MS) {
    const n = Math.max(1, Math.round(everyMs / DAY_MS));
    const offset = localDayNumber(first) - REFERENCE_DAY;
    return ((offset % n) + n) % n === 0 ? [first] : [];
  }
  const nextDayFirst = atLocal(addLocalDays(first, 1), t);
  const out = [];
  for (let k = 0; ; k++) {
    // Hours/minutes from the day's first slot via local setters: the k-th slot
    // is first + k*every of wall-clock time, so a DST night still yields the
    // same wall-clock slots.
    const slot = new Date(first);
    slot.setMinutes(slot.getMinutes() + Math.round((k * everyMs) / MINUTE_MS));
    if (slot >= nextDayFirst || k > 24 * 60) break;
    out.push(slot);
  }
  return out;
}

function plan(spec) {
  const t = parseHHMM(spec?.start_at);
  const everyMs = Number(spec?.every_ms);
  if (!t || !Number.isFinite(everyMs) || everyMs < MINUTE_MS) return null;
  return { t, everyMs };
}

/**
 * The most recent slot at or before `now`, or null for an unusable spec.
 * @param {{start_at: string, every_ms: number}} spec
 * @param {Date|number} [now]
 */
export function lastSlotAtOrBefore(spec, now = new Date()) {
  const p = plan(spec);
  if (!p) return null;
  const at = new Date(now);
  const lookback = p.everyMs > DAY_MS ? Math.max(1, Math.round(p.everyMs / DAY_MS)) + 1 : 2;
  for (let back = 0; back <= lookback; back++) {
    const slots = slotsOnDay(addLocalDays(at, -back), p.t, p.everyMs).filter((s) => s <= at);
    if (slots.length) return slots[slots.length - 1];
  }
  return null;
}

/**
 * The first slot strictly after `now`, or null for an unusable spec.
 * @param {{start_at: string, every_ms: number}} spec
 * @param {Date|number} [now]
 */
export function nextSlotAfter(spec, now = new Date()) {
  const p = plan(spec);
  if (!p) return null;
  const at = new Date(now);
  const lookahead = p.everyMs > DAY_MS ? Math.max(1, Math.round(p.everyMs / DAY_MS)) + 1 : 2;
  // Start one day back: the previous day's slots run until today's start_at.
  for (let fwd = -1; fwd <= lookahead; fwd++) {
    const slot = slotsOnDay(addLocalDays(at, fwd), p.t, p.everyMs).find((s) => s > at);
    if (slot) return slot;
  }
  return null;
}

/**
 * The next `count` slots strictly after `now` and before `until` (a forecast).
 * @param {{start_at: string, every_ms: number}} spec
 * @param {Date|number} now
 * @param {Date|number} until
 * @param {number} [count]
 * @returns {Date[]}
 */
export function slotsBetween(spec, now, until, count = 200) {
  const out = [];
  let cursor = new Date(now);
  const end = new Date(until);
  while (out.length < count) {
    const next = nextSlotAfter(spec, cursor);
    if (!next || next >= end) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Whether a slot-scheduled job should run now: the latest slot at or before
 * `now` is newer than the slot it last ran for. `last_slot_at` is the SLOT the
 * job last ran for (not its finish time), so a run that takes longer than the
 * interval never makes the following slot look already-served.
 *
 * `max_late_ms` bounds catch-up: a slot missed by more than that (a box that
 * was off) is skipped rather than run hours late. Omitted, the most recent
 * missed slot runs once, however late.
 *
 * @param {{start_at: string, every_ms: number}} spec
 * @param {{now?: Date|number, last_slot_at?: string|number|Date|null, max_late_ms?: number}} [opts]
 * @returns {{due: boolean, slot: Date|null, missed: boolean}}
 */
export function slotDue(spec, { now = new Date(), last_slot_at = null, max_late_ms } = {}) {
  const slot = lastSlotAtOrBefore(spec, now);
  if (!slot) return { due: false, slot: null, missed: false };
  const last = last_slot_at == null ? NaN : new Date(last_slot_at).getTime();
  if (Number.isFinite(last) && slot.getTime() <= last) return { due: false, slot, missed: false };
  if (Number.isFinite(max_late_ms) && new Date(now).getTime() - slot.getTime() > max_late_ms) {
    return { due: false, slot, missed: true };
  }
  return { due: true, slot, missed: false };
}
