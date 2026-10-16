// url-normalize.mjs — the two URL helpers the review queue, the lead ledger
// and the SSRF guard (url-guard.mjs) all share. Split out of
// companion-queue.mjs, which still re-exports both so every existing importer
// keeps working unchanged: url-guard.mjs needed isProcessableUrl, and pulling
// in the whole request ledger (and its disk paths) for a ten-line scheme check
// would also have dragged that ledger into the public discovery node.
// Pure string logic: nothing imported, nothing read or written.

// Tracking junk is the difference between "already queued" and a second
// evaluation of the same job: the same posting arrives as ?utm_source=... from
// a newsletter and bare from the board.
const STRIP_PARAMS = /^(utm_|gh_|ref$|source$|src$|mc_|fbclid$|gclid$|trk$|trkEmail$|trackingid$|lever-source)/i;

/** Comparison key for "is this the same posting?" — never shown to anyone. */
export function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  let url;
  try { url = new URL(text); } catch { return text.toLowerCase(); }
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (STRIP_PARAMS.test(name)) url.searchParams.delete(name);
  }
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export const isProcessableUrl = (raw) => {
  try {
    const url = new URL(String(raw || ''));
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch { return false; }
};
