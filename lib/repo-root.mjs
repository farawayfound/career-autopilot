/**
 * repo-root.mjs — the one place that knows where the repository root is.
 *
 * Before the 2.0.0 layout reorganization every script sat at the repository
 * root and could take `dirname(fileURLToPath(import.meta.url))` as "the repo".
 * Sixty-two of them did, in five spellings. Once the scripts moved into
 * `scripts/<domain>/` and `lib/`, that idiom silently pointed one or two
 * directories too deep — the class of bug that reads `data/applications.md`
 * from the wrong place and reports an empty tracker instead of failing.
 *
 * `lib/` is always exactly one level below the root, so the root is one `..`
 * from this file. Deliberately no search upward, no marker file, no
 * environment variable: a test that copies the repo (or a subset that includes
 * `lib/`) into a sandbox gets the sandbox as its root, which is what the
 * sandbox wants. `CAREER_OPS_ROOT` — the *data* root override — is a different
 * concept and lives in `lib/path-resolver.mjs`.
 *
 * Usage:
 *   import { REPO_ROOT } from '../../lib/repo-root.mjs';
 *   const tracker = join(REPO_ROOT, 'data', 'applications.md');
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/** Absolute path of the repository root (the directory holding package.json). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
