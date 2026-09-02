#!/usr/bin/env node
// tests/run.mjs — this repository's test entry point.
//
//   node tests/run.mjs
//
// Replicates the discover → import-in-process → finish() pattern the private
// career-ops monorepo's tests/test-all.mjs uses for its own auto-discovered
// suites: walk tests/**/*.test.mjs, dynamically import each one so they share
// tests/helpers.mjs's pass/fail counters, then print one summary and set the
// process exit code. None of the *.test.mjs files here call process.exit() or
// print their own verdict — that is deliberate, and it is this file's job,
// not theirs. A naive runner that spawns each file separately and checks its
// exit code would report success on every failure: these suites use plain
// pass()/fail() calls against shared counters, not thrown errors or a
// nonzero exit, so a file that runs to completion always exits 0 on its own
// regardless of how many assertions inside it failed.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail, finish } from './helpers.mjs';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Every `*.test.mjs` under `dir`, recursively, sorted lexicographically at
 * each level so the run order (and therefore the output) is deterministic
 * across machines and OSes.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function discoverTests(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discoverTests(full));
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const files = discoverTests(TESTS_DIR);
if (files.length === 0) {
  // A missing suite must never read as a green run — fail hard rather than
  // print an empty, all-passing summary.
  console.log('  ❌ no test files found under tests/ — the export is incomplete');
  process.exit(1);
}

for (const file of files) {
  const rel = file.slice(TESTS_DIR.length + 1);
  try {
    // eslint-disable-next-line no-await-in-loop -- suites share module-level
    // counters in helpers.mjs and must run one at a time, in order.
    await import(pathToFileURL(file).href);
  } catch (err) {
    // A suite that throws on import must not take the whole run down with
    // it (and silently skip every suite that would have sorted after it) —
    // contain it as one failure and keep going, same as test-all.mjs does.
    fail(`${rel} — suite threw and was contained (${err?.code ?? err?.name ?? 'Error'}): ${err?.message ?? err}`);
  }
}

finish();
