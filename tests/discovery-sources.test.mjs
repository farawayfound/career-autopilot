// tests/discovery-sources.test.mjs — the job that gives the discovery node names
// nobody configured.
//
// The property worth protecting here is a cost one, and it is easy to lose in a
// later edit: the `vc` source must stay OFF by default. The node already runs a
// `seeds` job that walks the same Y Combinator and a16z catalogues every 12
// hours (~250 sequential requests for YC alone), so a default that turned `vc`
// on would give one box two independent full walks of the same public data on
// overlapping schedules — for the same names.
//
// Everything is driven through the injected `impl` seam so no test here touches
// the network, matching how every other parser in this repo is tested.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';
import {
  runSources, fundingCandidates, vcCandidates, pipelineCandidates,
  defaultSources, summarizeSources, SOURCE_CATALOG,
} from '../autopilot/lib/discovery-sources.mjs';
import { readFrontier } from '../autopilot/lib/discovery-frontier.mjs';

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const KEY = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const NOW = Date.parse('2026-09-18T12:00:00Z');

console.log('\nDiscovery node — sources (the frontier\'s only writer of new names)');

// ── the default source list is a cost decision ─────────────────────────────
{
  const d = defaultSources();
  ok(d.includes('funding'), 'funding is on by default — it is the source this repo had code for and never once called');
  ok(d.includes('pipeline'), 'pipeline is on by default — it costs no network at all');
  ok(!d.includes('vc'), 'vc is OFF by default — the node\'s own `seeds` job already walks YC and a16z');
  ok(SOURCE_CATALOG.vc.defaultOn === false && /seeds/.test(SOURCE_CATALOG.vc.note),
    'and the catalog says why, so the next person to flip it sees the reason first');
}

// ── funding: names, never invented websites ────────────────────────────────
{
  const fake = async () => ({
    companies: [
      { company: 'Acme AI', funding: { sources: [{ source: 'techcrunch' }] } },
      { company: 'Beta Labs', funding: { sources: [{ source: 'hacker_news' }] } },
      { company: '   ', funding: { sources: [] } },
      { company: 'Gamma', funding: {} },
    ],
    diagnostics: [{ source: 'techcrunch', status: 'ok', candidate_count: 2 }],
  });
  const { candidates, diagnostics } = await fundingCandidates({ discover: fake });
  ok(candidates.length === 3, 'a blank company name is skipped, the rest are kept');
  ok(candidates.every((c) => c.website === null),
    'NO website is ever invented — company-funded.mjs returns names only, and guessing {slug}.com is the mistake toPortalEntry makes');
  ok(candidates[0].source === 'crawl:techcrunch' && candidates[1].source === 'crawl:hacker_news',
    'the per-evidence channel is carried through as crawl:<vendor>, so a later join can say which channel found a company');
  ok(candidates[2].source === 'crawl:funding', 'a candidate with no named channel falls back to crawl:funding');
  ok(diagnostics.length === 1, 'the source\'s own diagnostics are passed through');
}

// ── vc: these DO carry a website, which is what unlocks the fingerprinter ──
{
  const fake = {
    yc: { fetch: async () => [{ name: 'Startup One', url: 'https://one.example', source: 'yc' }, { name: 'No Site', url: '' }] },
    a16z: { fetch: async () => { throw new Error('portfolio page 503'); } },
  };
  const { candidates, diagnostics } = await vcCandidates({ fetchers: fake });
  ok(candidates.length === 2, 'both YC companies are kept');
  ok(candidates[0].website === 'https://one.example', 'a website comes through — this is the source that can skip straight to the site fingerprint');
  ok(candidates[1].website === null, "an empty url is an expected partial match (a16z's second parse strategy), recorded as null rather than treated as a failure");
  const bad = diagnostics.find((d) => d.source === 'a16z');
  ok(bad && bad.status === 'error', 'one dead source is a diagnostic, not a thrown pass');
  ok(candidates.some((c) => c.name === 'Startup One'), 'and the healthy source still landed');
}

// ── pipeline: free, and skips what is already tracked ──────────────────────
{
  const { candidates } = pipelineCandidates({
    rows: [{ company: 'Seen Co' }, { company: 'Tracked Inc' }, { company: 'Seen Co' }, { company: '' }],
    trackedKeys: new Set(['trackedinc']),
    keyFn: KEY,
  });
  ok(candidates.length === 1 && candidates[0].name === 'Seen Co', 'already-tracked and duplicate names are skipped');
  ok(candidates[0].source === 'crawl:pipeline', 'tagged with its own channel');
}

// ── runSources: folds everything into one frontier ─────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'co-sources-'));
  const fp = join(dir, 'frontier.json');
  try {
    const r = await runSources({
      frontierPath: fp,
      sources: ['funding', 'pipeline'],
      now: NOW,
      keyFn: KEY,
      trackedKeys: new Set(['knowninc']),
      pipelineRows: [{ company: 'Acme AI' }, { company: 'Gamma Corp' }, { company: 'Known Inc' }],
      impl: {
        funding: async () => ({
          companies: [{ company: 'Acme AI', funding: { sources: [{ source: 'techcrunch' }] } }],
          diagnostics: [],
        }),
      },
    });
    ok(r.added === 2, 'two distinct companies added (Acme AI, Gamma Corp)');
    ok(r.updated === 1, 'Acme AI arrived from two channels and was folded once, not duplicated');

    const f = readFrontier(fp);
    ok(!Object.keys(f.companies).includes(KEY('Known Inc')), 'an already-tracked company never enters the frontier');
    const acme = f.companies[KEY('Acme AI')];
    ok(acme && acme.sources.length === 2, 'and the company seen twice records both channels');
    ok(r.stats.total === 2 && r.stats.due === 2, 'the returned stats describe the ledger after the fold');
    ok(/2 new, 1 seen again/.test(summarizeSources(r)), 'the daemon log line reports both counts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── a broken source never costs the pass ───────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'co-sources-err-'));
  const fp = join(dir, 'frontier.json');
  try {
    const r = await runSources({
      frontierPath: fp,
      sources: ['funding', 'pipeline', 'nonsense'],
      now: NOW,
      keyFn: KEY,
      pipelineRows: [{ company: 'Still Landed' }],
      impl: { funding: async () => { throw new Error('every RSS host is down'); } },
    });
    ok(r.added === 1, 'the healthy source still landed its candidate');
    const failed = r.diagnostics.filter((d) => d.status === 'error').map((d) => d.source).sort();
    ok(failed.join(',') === 'funding,nonsense', 'both the throwing source and the unknown name are recorded as diagnostics');
    ok(/failed: /.test(summarizeSources(r)), 'and the log line names them rather than reading as a clean run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── --dry-run writes nothing ───────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'co-sources-dry-'));
  const fp = join(dir, 'frontier.json');
  try {
    const r = await runSources({
      frontierPath: fp, sources: ['pipeline'], now: NOW, keyFn: KEY,
      pipelineRows: [{ company: 'Would Have Landed' }],
      dryRun: true,
    });
    ok(r.added === 1 && r.dry_run === true, 'a dry run still REPORTS what would change');
    const after = readFrontier(fp);
    ok(Object.keys(after.companies).length === 0,
      'but the ledger on disk is untouched — --dry-run is documented as "no pipeline writes", and the frontier is this job\'s pipeline write');
    ok(/^dry-run: /.test(summarizeSources(r)), 'and the log line says so rather than reading like a real run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\ndiscovery-sources checks complete.');
