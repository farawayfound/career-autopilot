// config-staleness.mjs — "has the running daemon re-read its config?" Split out
// of the self-hosted deployment's config sync script, which still re-exports configStaleness so every
// existing importer keeps working unchanged: autopilot/discovery-node.mjs's
// --status needs this one check, and the config patcher around it is
// deploy-only code that has no business in the public discovery-node package.
import { statSync } from 'fs';

/**
 * Has the running daemon actually re-read this file?
 *
 * A config the daemon has not re-read is indistinguishable from one it has —
 * /health, --status and the log all look completely normal. On 2026-09-18 a
 * deployed node's config sat correct on disk for 73 minutes while the daemon ran the
 * previous one, because the restart had silently no-op'd. The only reliable
 * proof is that the process started AFTER the file was last written.
 *
 * @param {string} configPath
 * @param {string|null} startedAt - The daemon's `state.started_at`.
 * @returns {{stale: boolean, configMtime: string, startedAt: string|null}}
 */
export function configStaleness(configPath, startedAt) {
  let configMtime = null;
  try { configMtime = statSync(configPath).mtime.toISOString(); } catch { configMtime = null; }
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const written = configMtime ? Date.parse(configMtime) : NaN;
  const stale = Number.isFinite(started) && Number.isFinite(written) && written > started;
  return { stale, configMtime, startedAt: startedAt || null };
}
