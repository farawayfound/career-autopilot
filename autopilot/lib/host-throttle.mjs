// host-throttle.mjs — the per-host politeness gap. Split out of
// liveness-sweep.mjs, which still re-exports hostThrottle and
// _resetHostThrottle so every existing importer keeps working unchanged (and,
// being one module-level slot map, the sweep and the discovery node's
// validate job still share one set of host slots in a process that runs
// both). The discovery node needed exactly this and not the sweep's tracker,
// queue and user-store readers. Nothing imported.

const HOST_THROTTLE_MS = 1_500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── per-host throttle + jitter ────────────────────────────────────────────
const nextHostSlot = new Map();
export async function hostThrottle(host, { baseMs = HOST_THROTTLE_MS, jitterMs = 500 } = {}) {
  const now = Date.now();
  const earliest = Math.max(now, nextHostSlot.get(host) ?? 0);
  const wait = earliest - now;
  nextHostSlot.set(host, earliest + baseMs + Math.floor(Math.random() * jitterMs));
  if (wait > 0) await sleep(wait);
  return wait;
}
/** Test-only: forget every host's throttle slot between suites. */
export const _resetHostThrottle = () => nextHostSlot.clear();
