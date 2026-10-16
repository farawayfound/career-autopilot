// lead-keys.mjs — the two functions that turn a posting URL into the key and
// the stored form every lead/pipeline/seen comparison uses. Split out of
// leads.mjs, which still re-exports both so every existing importer keeps
// working unchanged: the discovery node (including the public package) needs
// exactly these two to dedup what it finds against what the pipeline has
// seen, and not the email-lead ledger, the queue and the tracker readers that
// the rest of leads.mjs pulls in.
import { parseAtsUrl } from './jd.mjs';
import { normalizeUrl } from './url-normalize.mjs';

// The dedup key that matters: two URLs for the same posting on a recognized
// ATS (a digest's three tracking-differentiated anchors, chief example) must
// collide even though normalizeUrl's param-stripping doesn't strip every
// tracking param every board uses (trkEmail/refId/lipi/midToken/midSig/eid/
// otpToken all survive it on LinkedIn). parseAtsUrl already extracts the
// stable (ats, org, id) triple that identifies a posting regardless of which
// tracking params rode along — reuse it as the key, falling back to
// normalizeUrl only for a URL no known ATS pattern matches.
export function canonicalLeadKey(url) {
  let ref = null;
  try { ref = parseAtsUrl(url); } catch { ref = null; }
  if (ref) return `${ref.ats}:${ref.org || ''}:${ref.id}`;
  return normalizeUrl(url);
}

// The canonical, bare, tracking-param-free URL for an ATS ref — the form a
// lead is STORED under (see ingestLeads below), as opposed to
// canonicalLeadKey's dedup key. Generalizes the LinkedIn-only collapse
// (three digest-anchor tracking variants → one /jobs/view/{id}/ URL) to any
// ATS that carries no org slug and whose email-link shape differs from its
// canonical page (WhatJobs: jbe__cpl__{id} bouncer link → gfj/{id} page).
// Any other ats (or no ref at all) has nothing to collapse to — null tells
// the caller to keep the already-resolved URL.
export function canonicalUrlForRef(ref) {
  if (!ref) return null;
  if (ref.ats === 'linkedin') return `https://www.linkedin.com/jobs/view/${ref.id}/`;
  if (ref.ats === 'whatjobs') return `https://www.whatjobs.com/gfj/${ref.id}`;
  return null;
}
