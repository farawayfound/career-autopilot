// autopilot/lib/discovery-node-control.mjs — the ONE validator for a discovery
// node's runtime controls: pause, and per-job enabled / interval / start time.
//
// Two writers produce these controls and both go through here:
//   - the admin dashboard, for the admin's own node (stored on the autopilot
//     host, delivered to the node in its heartbeat response), and
//   - the node's own local dashboard (stored next to the node's state).
// The node runs them through the same function again on receipt, so a value
// that is junk on the wire is dropped there too rather than trusted.
//
// Pure: no IO, and no import beyond the shared slot arithmetic, so this file
// can ship in the public discovery-node package as-is.

import { normalizeHHMM } from '../../lib/slot-schedule.mjs';

// Every job a control may name. tests/discovery-node-jobs.test.mjs pins this
// against SCANNER_JOB_ORDER plus 'validate' (the one non-scanner job with a
// config block), so a new job cannot be scheduled yet uncontrollable.
export const NODE_JOB_NAMES = Object.freeze([
  'tracked', 'aggregators', 'sources', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full', 'validate',
]);

// Child-process jobs: the only ones a max_minutes kill timer applies to.
export const CHILD_JOB_NAMES = Object.freeze(['tracked', 'boards', 'resolve', 'local_employers', 'seeds', 'ats_full']);

// Jobs the scanner slot schedules (planNextJob) — the only ones a start time
// applies to.
export const SLOT_JOB_NAMES = Object.freeze(NODE_JOB_NAMES.filter((n) => n !== 'validate'));

export const EVERY_MINUTES_MIN = 5;
export const EVERY_MINUTES_MAX = 7 * 24 * 60;
export const MAX_MINUTES_MIN = 1;
export const MAX_MINUTES_MAX = 24 * 60;
const ATS_LIST_RE = /^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$/;

const intIn = (v, lo, hi) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};

/**
 * One job's override. `start_at: ''` is a deliberate value — "no start time,
 * plain interval" — so an override can clear a start time the node's own
 * config file sets. Absent keys inherit.
 *
 * @param {string} name
 * @param {unknown} raw
 * @returns {{value: Record<string, unknown>, errors: string[]}}
 */
export function sanitizeJobOverride(name, raw) {
  const errors = [];
  const value = {};
  if (!NODE_JOB_NAMES.includes(name)) return { value, errors: [`unknown job "${String(name).slice(0, 40)}"`] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value, errors: [`${name}: not an object`] };
  for (const [key, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (key === 'enabled') {
      if (typeof v === 'boolean') value.enabled = v;
      else errors.push(`${name}.enabled must be true or false`);
    } else if (key === 'every_minutes') {
      const n = intIn(v, EVERY_MINUTES_MIN, EVERY_MINUTES_MAX);
      if (n !== undefined) value.every_minutes = n;
      else errors.push(`${name}.every_minutes must be a whole number ${EVERY_MINUTES_MIN}..${EVERY_MINUTES_MAX}`);
    } else if (key === 'start_at') {
      // validate is ticked on its own interval outside the scanner slot, so a
      // start time there would be accepted and then silently ignored.
      if (!SLOT_JOB_NAMES.includes(name)) errors.push(`${name}.start_at is not supported: it runs on its interval only`);
      else if (v === '' || v === null) value.start_at = '';
      else {
        const t = normalizeHHMM(v);
        if (t) value.start_at = t;
        else errors.push(`${name}.start_at must be HH:MM or empty`);
      }
    } else if (key === 'max_minutes' && CHILD_JOB_NAMES.includes(name)) {
      const n = intIn(v, MAX_MINUTES_MIN, MAX_MINUTES_MAX);
      if (n !== undefined) value.max_minutes = n;
      else errors.push(`${name}.max_minutes must be a whole number ${MAX_MINUTES_MIN}..${MAX_MINUTES_MAX}`);
    } else if (key === 'ats' && name === 'ats_full') {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (s.length <= 200 && ATS_LIST_RE.test(s)) value.ats = s;
      else errors.push('ats_full.ats must be a comma-separated list of ATS ids');
    } else {
      errors.push(`${name}.${String(key).slice(0, 40)} is not controllable`);
    }
  }
  // lib/slot-schedule.mjs counts an interval over a day in WHOLE days, so a
  // start time with "every 30h" would really run daily: refuse it rather than
  // display one interval and honour another.
  if (value.start_at && value.every_minutes > 24 * 60 && value.every_minutes % (24 * 60) !== 0) {
    errors.push(`${name}.every_minutes over a day must be whole days when a start time is set`);
    delete value.every_minutes;
  }
  return { value, errors };
}

/**
 * A whole control document: `{paused?, jobs?: {name: override}}`. Unknown
 * keys and invalid values are dropped and named in `errors`; what survives is
 * safe to store, send and merge.
 *
 * @param {unknown} raw
 * @returns {{value: {paused?: boolean, jobs: Record<string, Record<string, unknown>>}, errors: string[]}}
 */
export function sanitizeControl(raw) {
  const errors = [];
  const value = { jobs: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value, errors: raw == null ? [] : ['control: not an object'] };
  if (raw.paused !== undefined) {
    if (typeof raw.paused === 'boolean') value.paused = raw.paused;
    else errors.push('paused must be true or false');
  }
  const jobs = raw.jobs;
  if (jobs !== undefined && (!jobs || typeof jobs !== 'object' || Array.isArray(jobs))) errors.push('jobs: not an object');
  else if (jobs) {
    for (const [name, override] of Object.entries(jobs)) {
      const r = sanitizeJobOverride(name, override);
      errors.push(...r.errors);
      if (Object.keys(r.value).length) value.jobs[name] = r.value;
    }
  }
  return { value, errors };
}

/**
 * Apply a merge-patch to a stored control: a `null` job or field removes that
 * override (back to inheriting), anything else replaces it. The patch is
 * sanitized first; the result is a fresh object.
 *
 * @param {{paused?: boolean, jobs?: Record<string, Record<string, unknown>>}} current
 * @param {unknown} patch
 * @returns {{value: {paused?: boolean, jobs: Record<string, Record<string, unknown>>}, errors: string[]}}
 */
export function patchControl(current, patch) {
  const base = sanitizeControl(current).value;
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { value: base, errors: ['patch: not an object'] };
  if (patch.paused === null) delete base.paused;
  const clean = sanitizeControl({ ...patch, paused: patch.paused ?? undefined, jobs: undefined });
  errors.push(...clean.errors);
  if (clean.value.paused !== undefined) base.paused = clean.value.paused;
  const jobs = patch.jobs;
  if (jobs !== undefined && (!jobs || typeof jobs !== 'object' || Array.isArray(jobs))) errors.push('jobs: not an object');
  else if (jobs) {
    for (const [name, fields] of Object.entries(jobs)) {
      if (fields === null) { delete base.jobs[name]; continue; }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { errors.push(`${name}: not an object`); continue; }
      const kept = { ...(base.jobs[name] || {}) };
      const set = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === null && k !== 'start_at') delete kept[k];
        else set[k] = v;
      }
      const r = sanitizeJobOverride(name, set);
      errors.push(...r.errors);
      const merged = { ...kept, ...r.value };
      // The whole-day rule looks at start_at and every_minutes TOGETHER, and the
      // two can arrive in different patches (a start time now, a 2000-minute
      // interval next week). Checked on the new fields alone, each passes, the
      // pair is stored, and every reader then discards the interval while the
      // save said ok. So the merged override is judged as a whole, and a change
      // that would make it contradictory leaves this job's stored override as it was.
      const whole = sanitizeJobOverride(name, merged);
      if (whole.errors.length) {
        errors.push(...whole.errors.filter((e) => !errors.includes(e)));
        continue;
      }
      if (Object.keys(merged).length) base.jobs[name] = merged;
      else delete base.jobs[name];
    }
  }
  return { value: base, errors };
}

/**
 * The node's effective job config: the config file's `jobs`, then each control
 * layer on top in order (later wins), plus where every controllable value came
 * from, for the dashboards to show. Only controllable keys are overlaid; every
 * other key in a job's config block passes through untouched.
 *
 * @param {Record<string, Record<string, unknown>>} baseJobs
 * @param {Array<{name: string, control: {jobs?: Record<string, Record<string, unknown>>}|null|undefined}>} layers
 * @returns {{jobs: Record<string, Record<string, unknown>>, sources: Record<string, Record<string, string>>}}
 */
export function effectiveJobs(baseJobs = {}, layers = []) {
  const jobs = {};
  const sources = {};
  for (const [name, cfg] of Object.entries(baseJobs || {})) {
    jobs[name] = { ...(cfg || {}) };
    sources[name] = {};
    for (const k of ['enabled', 'every_minutes', 'start_at', 'max_minutes', 'ats']) {
      if (cfg && cfg[k] !== undefined) sources[name][k] = 'config';
    }
  }
  for (const { name: layer, control } of layers) {
    const clean = sanitizeControl(control).value;
    for (const [job, override] of Object.entries(clean.jobs)) {
      // A control never conjures a job the config file has no block for: such
      // a job has none of its other settings (boards, limits) to run with.
      if (!jobs[job]) continue;
      Object.assign(jobs[job], override);
      for (const k of Object.keys(override)) sources[job][k] = layer;
    }
  }
  return { jobs, sources };
}

/** True when any layer pauses the node. */
export function isPaused(layers = []) {
  return layers.some(({ control }) => sanitizeControl(control).value.paused === true);
}
