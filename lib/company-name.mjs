// company-name.mjs — the one company-name normalizer shared by the tracker-
// matching scripts (scripts/insights/invite-match.mjs) and the scanner
// (scripts/scan/scan.mjs). Split out of invite-match.mjs, which still
// re-exports it so every existing importer keeps working unchanged: the
// scanner, and so the public discovery node, needed this one function and
// not the 900-line invite matcher (and the tracker readers) around it.
// Pure string logic: no filesystem, no network, nothing else imported.

// True legal-entity suffixes, stripped repeatedly (chained) since a name can
// legitimately carry more than one ("Acme Holdings Inc." → "acme holdings").
// These are unambiguous enough that removing several in a row is safe.
const LEGAL_SUFFIXES = [
  'incorporated', 'inc', 'corporation', 'corp', 'company', 'co',
  'limited', 'ltd', 'llc', 'llp', 'lp', 'plc',
];

// Generic business-descriptor words that vary between how a recruiter signs
// an email and how the tracker recorded the company, but are common enough
// as substantive parts of a name (e.g. "Data Solutions" vs "Data Corp") that
// chaining their removal risks collapsing two different companies to the
// same key. Stripped at most once, and only after legal suffixes are gone —
// never chained with each other or with LEGAL_SUFFIXES.
const GENERIC_DESCRIPTORS = [
  'group', 'holdings', 'technologies', 'technology', 'solutions',
  'canada', 'international',
];

/**
 * Normalize a company name for matching: lowercase, strip punctuation and
 * parentheticals, collapse whitespace, chain-strip trailing legal-entity
 * suffixes (so "Acme Technologies Inc." reduces to "acme technologies"),
 * then strip at most one trailing generic descriptor word. Deliberately
 * stricter than scripts/tracker/dedup-tracker.mjs's normalizeCompany (which only lowercases
 * and strips punctuation): invite emails quote company names more loosely
 * than tracker rows quote each other, so matching across the two sources
 * needs the extra suffix-stripping that same-source dedup does not.
 *
 * Generic descriptors are deliberately stripped only once (not chained) and
 * only after legal suffixes, so two distinct companies that happen to both
 * end in a generic word (e.g. "Data Solutions" vs "Data Corp") don't
 * collapse to the same "data" key — see issue discussion on PR #1497.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompanyName(name) {
  let key = String(name ?? '')
    // NFKC before folding so full-width and half-width spellings of the same
    // name compare equal, matching the shared normalizeTextKey() contract.
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    // Letters and digits of ANY script, not just [a-z0-9]: the Latin-only
    // class DELETED every non-Latin name, so アクメ株式会社 and Яндекс both
    // produced '' — and matchInvite() bails on an empty key, so pasting an
    // invite from any company in the ja/ko/zh/zh-TW/ru/ua/ar/hi markets that
    // modes/ ships returned ZERO candidates even when the row was right
    // there. Combining marks are kept for the same reason normalizeTextKey
    // keeps them: Indic matras have no precomposed form (#2517).
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const re = new RegExp(`\\s${suffix}$`);
      if (re.test(key)) {
        key = key.replace(re, '').trim();
        changed = true;
      }
    }
  }

  for (const word of GENERIC_DESCRIPTORS) {
    const re = new RegExp(`\\s${word}$`);
    if (re.test(key)) {
      key = key.replace(re, '').trim();
      break;
    }
  }

  return key;
}
