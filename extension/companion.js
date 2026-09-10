// Career-Ops Companion — content script. Injected into EVERY frame of the tab
// (ATS forms often live inside embeds); the panel renders only in the top
// frame, the fill engine runs everywhere, and the background SW relays
// messages between them.
//
// Compatibility ladder (all one surface — the panel checklist):
//   A. known-ATS auto-fill  (selector packs ported from autopilot/lib/apply/*)
//   B. generic auto-fill    (label-heuristic matching, any plain-DOM form)
//   C. assisted insert      (user clicks the field, we set the value)
//   D. copy                 (works everywhere the user can paste)
// Auto-fill just pre-completes checklist rows; anything it missed stays one
// click from done. NOTHING here ever clicks Submit.
(() => {
  if (window.__careerOpsCompanion) return;
  window.__careerOpsCompanion = true;
  const IS_TOP = window.top === window;
  // One random tag per frame per page load — namespaces harvestForm()'s
  // live-fill element ids so they stay globally unique when both the harvest
  // and the apply-time broadcast fan out across every frame (see harvestForm).
  const FRAME_TAG = Math.random().toString(36).slice(2, 8);

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el && el.offsetParent !== null && !el.disabled;

  // ── frame trust ───────────────────────────────────────────────────────────
  // The engine is injected into EVERY frame, which on a real careers page
  // includes third-party embeds (support chat, feedback widgets, analytics) —
  // and some of those carry their own file inputs. Bulk fills therefore only
  // act in frames plausibly belonging to the application: the top frame, a
  // known ATS host, or the same registrable domain as the page. The per-row
  // escape hatches (Insert, Copy, the resume Attach button) stay ungated —
  // there the candidate has picked the target themselves.
  const ATS_HOST_RE = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|jobvite\.com|icims\.com|bamboohr\.com|workable\.com|workablecdn\.com|recruitee\.com|teamtailor\.com|breezy\.hr|applytojob\.com|jazz\.co|pinpointhq\.com|dover\.com|rippling\.com|ripplinghq\.com|gem\.com)$/i;
  const registrable = (h) => String(h || '').toLowerCase().split('.').slice(-2).join('.');
  function frameTrusted(topHost) {
    if (IS_TOP) return true;
    if (ATS_HOST_RE.test(location.hostname)) return true;
    return Boolean(topHost) && registrable(location.hostname) === registrable(topHost);
  }

  // ── focus tracking ────────────────────────────────────────────────────────
  // Panel buttons prevent default on mousedown so clicking them never blurs
  // the page's field — but we also remember the last focused editable as a
  // backstop for anything that does steal focus.
  let lastEditable = null;
  const isEditable = (el) => Boolean(el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
    && !(el.tagName === 'INPUT' && /^(file|submit|button|image|reset|hidden)$/.test(el.type)));
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.id === 'career-ops-companion-host') return;
    if (isEditable(e.target)) lastEditable = e.target;
  }, true);

  // ── value actuation ───────────────────────────────────────────────────────
  // React and friends track input values through the native setter — calling
  // it directly (instead of `el.value = x`) then dispatching input/change is
  // what makes frameworks accept programmatic values. Same trick password
  // managers use; more reliable than synthetic typing.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // react-select listens on mousedown, native widgets on click — fire the trio.
  function fireMouse(el) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  // Is this control already carrying an answer? Every control type needs its
  // own test, and getting this wrong is destructive: fills happen seconds to
  // minutes after a control was inspected (a draft round-trips through a local
  // model), and a replay can land on a form the candidate has since edited by
  // hand. 'already' is the state that protects their typing, so it has to
  // cover selects, choices and rich-text boxes — not just plain inputs.
  function alreadyAnswered(el) {
    if (el.tagName === 'SELECT') return el.selectedIndex > 0 && el.value !== '';
    if (el.type === 'radio') {
      // A radio group is answered if ANY member is checked — including one the
      // candidate switched to after we filled it.
      if (el.checked) return true;
      if (!el.name) return false;
      try {
        return [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)].some((r) => r.checked);
      } catch { return false; }
    }
    if (el.type === 'checkbox') return el.checked;
    if (el.isContentEditable) return Boolean(clean(el.textContent));
    return Boolean(el.value);
  }

  // Workday validates through React's onChange and ignores a value that arrived
  // via the native setter — the field LOOKS filled and Save still says
  // "required" (modes/apply.md, "Workday — set-value doesn't register"). The
  // fix is a real editing command: execCommand('insertText') goes through the
  // browser's own input pipeline and fires a trusted `input` event with
  // inputType 'insertText', which is what React actually listens for. No
  // extra permission needed (chrome.debugger would give true key events but
  // paints a "being debugged" bar on every tab).
  const IS_WORKDAY = /myworkdayjobs\.com$/i.test(location.hostname);
  function typeInto(el, value) {
    el.focus();
    try { el.select?.(); } catch { /* not selectable */ }
    let ok = false;
    try { ok = document.execCommand('insertText', false, String(value)); } catch { ok = false; }
    if (!ok || el.value !== String(value)) setNativeValue(el, String(value));
    else {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
    return el.value === String(value);
  }

  // Custom dropdown triggers: react-select's input, a role=combobox, or a
  // Workday/react-aria <button aria-haspopup="listbox">. None of these take a
  // typed value — they get the open → match option text → click path.
  const isComboLike = (el) => Boolean(el && (
    el.getAttribute('role') === 'combobox'
    || el.getAttribute('aria-haspopup') === 'listbox'
    || el.closest('[class*="select" i][class*="container" i]')
  ));

  // ── best-guess selection (items #1/#2) ────────────────────────────────────
  // A ranked ladder from exact match down to "nothing close enough", shared by
  // every control type that offers a closed set of options: <select>
  // (fillControl), a combobox's rendered option list (fillCombobox), and a
  // radio/checkbox group (fillChoice). A non-exact pick is always reported as
  // 'guessed' — a distinct dot in the panel, excluded from what field-memory
  // learns (see collectFinalValues) — never silently treated as an exact fill.
  const US_STATES = [
    ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'], ['California', 'CA'],
    ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'], ['Florida', 'FL'], ['Georgia', 'GA'],
    ['Hawaii', 'HI'], ['Idaho', 'ID'], ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'],
    ['Kansas', 'KS'], ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
    ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'], ['Missouri', 'MO'],
    ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'], ['New Hampshire', 'NH'], ['New Jersey', 'NJ'],
    ['New Mexico', 'NM'], ['New York', 'NY'], ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'],
    ['Oklahoma', 'OK'], ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
    ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'], ['Vermont', 'VT'],
    ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'], ['Wisconsin', 'WI'], ['Wyoming', 'WY'],
  ];
  // Kept out of the hand-written groups below so a future country's
  // states/provinces is a one-array addition, not a hand-listed sprawl.
  const SYNONYM_GROUPS = [
    ['yes', 'true'], ['no', 'false'],
    ['decline to self-identify', 'prefer not to say', "i don't wish to answer", 'choose not to disclose', 'decline to answer'],
    ['i am not a protected veteran', 'not a protected veteran', 'no'],
    ['i identify as one or more of the classifications of a protected veteran', 'protected veteran', 'yes'],
    ['yes, i have a disability', 'i have a disability', 'yes'],
    ['no, i do not have a disability', 'i do not have a disability', 'no'],
    ['hispanic or latino', 'hispanic/latino', 'hispanic', 'latino'],
    ['not hispanic or latino', 'not hispanic/latino'],
    ['he/him', 'he/him/his', 'he'], ['she/her', 'she/her/hers', 'she'], ['they/them', 'they/them/theirs', 'they'],
    ["bachelor's", "bachelor's degree", 'ba', 'bs', "bachelor's (ba/bs)"],
    ["master's", "master's degree", 'ma', 'ms', "master's (ma/ms)"],
    ['united states', 'usa', 'us', 'u.s.', 'u.s.a.'],
    ['united kingdom', 'uk', 'u.k.'],
    ...US_STATES.map(([name, code]) => [name.toLowerCase(), code.toLowerCase()]),
  ];

  /** Standard bigram Sørensen-Dice on whitespace-joined lowercase strings. */
  function diceCoefficient(a, b) {
    const bigrams = (s) => { const out = []; for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2)); return out; };
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.length || !B.length) return a === b ? 1 : 0;
    const bag = new Map();
    for (const g of B) bag.set(g, (bag.get(g) || 0) + 1);
    let hits = 0;
    for (const g of A) {
      const n = bag.get(g) || 0;
      if (n > 0) { hits += 1; bag.set(g, n - 1); }
    }
    return (2 * hits) / (A.length + B.length);
  }

  function pickOption(options, answer, { question = '' } = {}) {
    if (!options || !options.length || answer == null) return null;
    const norm = (s) => clean(s).toLowerCase();
    const stripPunct = (s) => norm(s).replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const target = norm(answer);

    // 1. exact (case/whitespace-insensitive)
    let hit = options.find((o) => norm(o) === target);
    if (hit) return { value: hit, exact: true };

    // 2. normalized equality after stripping punctuation/parentheticals
    const targetStripped = stripPunct(String(answer).replace(/\([^)]*\)/g, ''));
    hit = options.find((o) => stripPunct(String(o).replace(/\([^)]*\)/g, '')) === targetStripped);
    if (hit) return { value: hit, exact: true };

    // 3. synonym groups
    for (const group of SYNONYM_GROUPS) {
      if (group.some((s) => norm(s) === target)) {
        hit = options.find((o) => group.some((s) => norm(s) === norm(o)));
        if (hit) return { value: hit, exact: false };
      }
    }

    // 4. token Dice coefficient >= 0.5
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const score = diceCoefficient(target, norm(o));
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best && bestScore >= 0.5) return { value: best, exact: false };

    // 5. "how did you hear" ranked default — only when the QUESTION itself
    // looks like that ask, never as a general fallback for every unmatched
    // select (a wrong guess on an unrelated question is worse than leaving it
    // for the candidate).
    if (/how did you (hear|find)|where did you hear/i.test(question)) {
      const ranked = [answer, 'linkedin', 'job board', 'company website', 'other'];
      for (const want of ranked) {
        hit = options.find((o) => norm(o).includes(norm(want)));
        if (hit) return { value: hit, exact: false };
      }
    }
    return null;
  }

  // Mirrors lib/apply/common.mjs fillControl: verify the value took; never
  // overwrite something already filled ('already'); refuse comboboxes (they
  // get their own interactive path).
  function fillControl(el, value) {
    if (value == null || String(value).trim() === '' || !el) return false;
    try {
      if (alreadyAnswered(el)) return 'already';
      // Comboboxes get their own interactive path (fillCombobox).
      if (isComboLike(el) || el.tagName === 'BUTTON') return false;
      if (el.tagName === 'SELECT') {
        const target = clean(value).toLowerCase();
        const option = [...el.options].find((o) => clean(o.textContent).toLowerCase() === target)
          || [...el.options].find((o) => clean(o.textContent).toLowerCase().includes(target))
          || [...el.options].find((o) => String(o.value).toLowerCase() === target);
        if (option) { setNativeValue(el, option.value); return el.value !== ''; }
        // Nothing matched by text/value — item #1's best-guess ladder, so an
        // unusual option wording (a leveled title, a paraphrased Yes/No) does
        // not leave the control silently unfilled.
        const texts = [...el.options].map((o) => clean(o.textContent)).filter(Boolean);
        const guess = pickOption(texts, value, { question: labelFor(el) });
        if (!guess) return false;
        const guessedOpt = [...el.options].find((o) => clean(o.textContent) === guess.value);
        if (!guessedOpt) return false;
        setNativeValue(el, guessedOpt.value);
        return el.value === '' ? false : (guess.exact ? true : 'guessed');
      }
      if (el.type === 'checkbox' || el.type === 'radio') {
        fireMouse(el);
        return el.checked;
      }
      if (el.isContentEditable) {
        el.focus();
        document.execCommand('selectAll', false, null);
        if (!document.execCommand('insertText', false, String(value))) el.textContent = String(value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return true;
      }
      if (IS_WORKDAY && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return typeInto(el, value);
      setNativeValue(el, String(value));
      return el.value === String(value) || el.value !== '';
    } catch {
      return false;
    }
  }

  // Insert into whatever field the user last focused in THIS frame. Only the
  // frame that actually holds focus responds — in the top frame, focus sitting
  // on an <iframe> element correctly fails the isEditable check.
  function insertIntoFocused(text) {
    const el = document.activeElement && isEditable(document.activeElement)
      ? document.activeElement
      : (lastEditable && lastEditable.isConnected && document.hasFocus() ? lastEditable : null);
    if (!el) return null;
    if (el.isContentEditable) {
      el.focus();
      if (!document.execCommand('insertText', false, text)) el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      setNativeValue(el, text);
    }
    return labelFor(el) || el.name || el.id || 'the focused field';
  }

  function attachFile(input, { bytes, filename, mime }) {
    try {
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], filename, { type: mime }));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.files.length > 0;
    } catch {
      return false;
    }
  }

  // ── label resolution ──────────────────────────────────────────────────────
  // Same cascade as the mirror's readFocusedQuestion: explicit label →
  // aria-label(ledby) → wrapping label → nearest ancestor block text →
  // placeholder.
  function labelFor(el) {
    if (!el) return '';
    let text = '';
    if (el.labels && el.labels.length) text = clean(el.labels[0].textContent);
    if (!text) text = clean(el.getAttribute && el.getAttribute('aria-label'));
    if (!text && el.getAttribute) {
      const ids = el.getAttribute('aria-labelledby');
      if (ids) text = clean(ids.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' '));
    }
    if (!text && el.id) {
      try { text = clean(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent); } catch { /* bad id */ }
    }
    if (!text) text = clean(el.closest('label')?.textContent);
    if (!text) {
      const own = clean('value' in el ? el.value : el.textContent);
      let node = el.closest('div,fieldset,li,section') || el.parentElement;
      for (let hops = 0; node && hops < 3 && !text; hops += 1, node = node.parentElement) {
        const t = clean(node.innerText || '');
        const stripped = own ? t.replace(own, ' ').replace(/\s+/g, ' ').trim() : t;
        if (stripped.length >= 8 && stripped.length <= 600) text = stripped;
      }
    }
    if (!text) text = clean(el.getAttribute && el.getAttribute('placeholder'));
    return (text || '').slice(0, 400);
  }

  function readFocusedQuestion() {
    const el = document.activeElement;
    return isEditable(el) ? labelFor(el) : '';
  }

  // button[aria-haspopup="listbox"] is how Workday (and react-aria) render
  // every dropdown — Yes/No work-authorization questions included. Without it
  // those controls were invisible to the label matcher and never got filled.
  const collectControls = () => [...document.querySelectorAll('input, textarea, select, [role="combobox"], button[aria-haspopup="listbox"], [contenteditable="true"]')]
    .filter((el) => !(el.tagName === 'INPUT' && /^(submit|button|image|reset|hidden)$/.test(el.type)))
    .map((el) => ({ el, label: labelFor(el) }));

  // ── field memory: the taxonomy ────────────────────────────────────────────
  // A hand-mirror of autopilot/lib/field-taxonomy.mjs — a content script has no
  // module system, so the table is duplicated and
  // tests/companion-field-memory.test.mjs asserts the two never drift.
  //
  // This list IS the safety model. It is a positive allowlist: a control whose
  // label does not canonicalize to one of these ids is dropped before its value
  // is ever read, so a password, a card number or a question nobody anticipated
  // cannot be captured by our having failed to denylist it.
  const TAXONOMY = [
    { id: 'first_name', match: /\b(first|given)\s*name\b|\bforename\b/i },
    { id: 'last_name', match: /\b(last|family|sur)\s*name\b|\bsurname\b/i },
    { id: 'full_name', match: /\b(full|legal|your)\s*name\b|^name\b/i },
    { id: 'email', match: /\be-?mail\b/i },
    { id: 'phone', match: /\b(phone|mobile|cell|telephone|tel)\b/i },
    { id: 'address_line_2', match: /\b(address\s*(line\s*)?2|apt|apartment|suite|unit\b|floor)\b/i },
    { id: 'street_address', match: /\b(street\s*address|address\s*(line\s*)?1|street|mailing address)\b/i },
    { id: 'postal_code', match: /\b(zip|postal\s*code|postcode|post code)\b/i },
    { id: 'city', match: /\b(city|town|municipality)\b/i },
    { id: 'state', match: /\b(state|province|region|county)\b/i },
    { id: 'country', match: /\bcountry\b/i },
    { id: 'full_address', match: /\baddress\b/i },
    { id: 'location', match: /\b(location|where are you based|current location)\b/i },
    { id: 'linkedin', match: /\blinked\s*in\b/i },
    { id: 'github', match: /\bgit\s*hub\b/i },
    { id: 'website', match: /\b(website|portfolio|personal site|personal website|web site)\b/i },
    { id: 'current_company', match: /\b(current|present|most recent)\s*(employer|company|organization)\b/i },
    { id: 'current_title', match: /\b(current|present|most recent)\s*(title|position|job title|role)\b/i },
    { id: 'notice_period', match: /\bnotice\s*period\b/i },
    { id: 'earliest_start_date', match: /\b(earliest\s*(start|available)|start date|available to start|availability date)\b/i },
  ];
  const SENSITIVE_RE = new RegExp([
    'password', 'passwort', 'mot de passe', 'passphrase', '\\botp\\b', 'security question',
    'social security', '\\bssn\\b', 'national insurance', 'tax id', '\\bitin\\b',
    'passport', 'driver.?s licen[cs]e', 'sozialversicherung', 'num[ée]ro de s[ée]curit[ée]',
    'national id', 'identity number', 'aadhaar', '\\bnino\\b',
    'card number', 'credit card', 'cvv', 'cvc', 'routing number', 'account number',
    'sort code', '\\biban\\b', '\\bbic\\b', 'bank account', 'kontonummer',
    'date of birth', '\\bdob\\b', 'birth ?date', 'geburtsdatum', 'date de naissance',
    'mother.?s maiden',
    'salary', 'compensation', 'desired pay', 'expected pay', 'gehalt', 'r[ée]mun[ée]ration',
  ].join('|'), 'i');
  const THIRD_PARTY_RE = /\b(emergency contact|next of kin|reference|referee|spouse|beneficiary|guardian|supervisor.s (name|phone|email)|manager.s (name|phone|email)|who referred|referrer)\b/i;

  // A hand-mirror of field-taxonomy.mjs's HOME_ADDRESS_IDS/WORK_LOCATION_LABEL_RE
  // and profile-questions.mjs's SENSITIVE_QUESTION_LABEL_RE — same reason as
  // TAXONOMY above (no module system here). tests/companion-extension.test.mjs
  // asserts byte parity with the real exports.
  const HOME_ADDRESS_IDS = ['street_address', 'address_line_2', 'city', 'state', 'postal_code', 'country', 'location'];
  const WORK_LOCATION_LABEL_RE = /preferred (work )?location|which (office|location)|work (arrangement|location|model)|remote.{0,3}hybrid.{0,5}on.{0,1}site|office location|site preference/i;
  // The wider sensitive-topic net live-fill's harvestForm() applies ALONGSIDE
  // (never instead of) SENSITIVE_RE above — SENSITIVE_RE only knows
  // "credentials, gov id, payment, DOB, salary/compensation" and has no idea a
  // demographic/EEO question, a criminal-history textarea, or a reference's
  // contact field exists. Every profile-questions.mjs entry with
  // `sensitive: true` folds into this one regex on the server; this literal is
  // its mirror, generated from the same source and pinned by a parity test.
  const SENSITIVE_QUESTION_LABEL_RE = /\b(?:citizenship|citizen of|security clearance|clearance level|desired salary|expected salary|salary expectation|salary range minimum|minimum salary|salary floor|salary range maximum|maximum salary|salary ceiling|salary currency|compensation currency|pay currency|hourly rate|rate per hour|salary negotiable|is your salary negotiable|compensation negotiable|criminal conviction|have you been convicted|criminal history|driver's license|drivers license|valid license|reference 1 name|reference name|reference 1 email|reference email|reference 1 phone|reference phone|reference 1 relationship|relationship to reference|reference 2 name|reference 2 email|reference 2 phone|reference 2 relationship|reference 3 name|reference 3 email|reference 3 phone|reference 3 relationship|gender|sex|hispanic|latino|race|ethnicity|veteran|disability|disabilities|sexual orientation|transgender|age range|ethnicity detail)\b/i;

  function canonicalize(label) {
    const text = clean(label);
    if (!text || text.length > 200) return null;
    if (SENSITIVE_RE.test(text)) return null;
    for (const entry of TAXONOMY) if (entry.match.test(text)) return entry.id;
    return null;
  }

  function classifyFormat(key, value) {
    const text = String(value || '');
    if (key !== 'phone') return 'plain';
    if (/^\+/.test(text)) return /[ .-]/.test(text.slice(1)) ? 'intl-spaced' : 'intl-compact';
    if (/^\(\d{3}\)/.test(text)) return 'paren-dash';
    if (/^\d+$/.test(text)) return 'digits';
    if (/-/.test(text)) return 'dashed';
    if (/\./.test(text)) return 'dotted';
    return 'plain';
  }

  // ── field memory: what may be read, and about whom ────────────────────────
  // Capture trust is deliberately NARROWER than fill trust. frameTrusted lets a
  // known-ATS frame act even under an unfamiliar top page, which is fine for
  // writing into a form the candidate already chose to fill — but harvesting
  // new personal facts out of a frame whose parent we do not recognise is a
  // different risk, so capture requires the top frame or the same site as it.
  function frameTrustedForCapture(topHost) {
    if (IS_TOP) return true;
    return Boolean(topHost) && registrable(location.hostname) === registrable(topHost);
  }

  const SENSITIVE_AUTOCOMPLETE_RE = /^(cc-|current-password|new-password|one-time-code)/i;
  function isSensitive(el) {
    if (!el) return true;
    if (el.tagName === 'INPUT' && /^(password|file|hidden|submit|button|image|reset)$/.test(el.type)) return true;
    if (SENSITIVE_AUTOCOMPLETE_RE.test(el.getAttribute?.('autocomplete') || '')) return true;
    return SENSITIVE_RE.test(`${el.name || ''} ${el.id || ''} ${labelFor(el)}`);
  }

  // "Phone" under an <legend>Emergency Contact</legend> canonicalizes to `phone`
  // perfectly well — and learning it would overwrite the candidate's own number
  // with their next of kin's. Field labels alone cannot see that; the enclosing
  // block can.
  function ownedByApplicant(el) {
    let node = el.closest('fieldset, section, div');
    for (let hops = 0; node && hops < 4; hops += 1, node = node.parentElement) {
      const heading = node.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4');
      if (heading && THIRD_PARTY_RE.test(clean(heading.textContent))) return false;
    }
    return !THIRD_PARTY_RE.test(labelFor(el));
  }

  // The value a human would say is in this control — the selected option's
  // TEXT, not its value attribute, because that is what we replay onto the next
  // form. Choice controls return '' deliberately: radio/checkbox answers are
  // screening questions, which belong to the canned-answers path, not here.
  function readControlValue(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return el.selectedIndex > 0 && opt ? clean(opt.textContent) : '';
    }
    if (el.tagName === 'INPUT' && /^(radio|checkbox)$/.test(el.type)) return '';
    if (el.tagName === 'BUTTON' || el.getAttribute('aria-haspopup') === 'listbox') {
      const text = clean(el.textContent);
      return /^(select|choose|--|select one)/i.test(text) ? '' : text;
    }
    if (el.isContentEditable) return clean(el.textContent);
    return clean(el.value);
  }

  /** The canonical keys this form asks for — the context a rule is conditioned on. */
  function formKeysOf(controls) {
    const keys = new Set();
    for (const { el, label } of controls) {
      if (isSensitive(el)) continue;
      const key = canonicalize(label);
      if (key) keys.add(key);
    }
    return [...keys].sort();
  }

  // Which stored format belongs in THIS box. HTML constraints are treated as
  // hard filters because they are the page telling us outright what it accepts;
  // everything after that is a hint.
  function pickVariant(el, variants) {
    let pool = variants.slice();
    const pattern = el.getAttribute?.('pattern');
    if (pattern) {
      try {
        const re = new RegExp(`^(?:${pattern})$`);
        const fit = pool.filter((v) => re.test(v.text));
        if (fit.length) pool = fit;
      } catch { /* the page's own pattern is malformed — ignore it */ }
    }
    const max = Number(el.maxLength);
    if (max > 0) {
      const fit = pool.filter((v) => v.text.length <= max);
      if (fit.length) pool = fit;
    }
    // "(___) ___-____" tells us the box wants (303) 520-2666 and not +13035202666.
    const punct = (text) => String(text || '').replace(/[^()+.\- ]/g, '').replace(/\s+/g, ' ').trim();
    const skeleton = punct(el.getAttribute?.('placeholder'));
    const wantsDigits = /numeric/i.test(el.getAttribute?.('inputmode') || '');
    const score = (v) => {
      let s = 0;
      if (skeleton && punct(v.text) === skeleton) s += 4;
      if (wantsDigits && v.format === 'digits') s += 2;
      if (/tel/i.test(el.getAttribute?.('autocomplete') || '') && v.format === 'intl-spaced') s += 1;
      return s;
    };
    pool.sort((a, b) => score(b) - score(a) || (b.evidence - a.evidence));
    return pool[0] || null;
  }

  /** Same underlying fact, possibly written differently (phone folds on digits). */
  function sameFact(key, a, b) {
    if (key !== 'phone') return clean(a).toLowerCase() === clean(b).toLowerCase();
    const digits = (t) => {
      const d = String(t || '').replace(/\D+/g, '');
      return d.length === 10 ? `1${d}` : d.replace(/^00/, '');
    };
    return digits(a) === digits(b);
  }

  /** Which branch of a learned rule this form falls on — null means abstain. */
  function branchFor(rule, keys) {
    const ids = (rule && rule.predictor_ids) || [];
    if (!ids.length) return null;
    const present = ids.filter((id) => keys.includes(id)).length;
    if (present === ids.length) return 'present';
    if (present === 0) return 'absent';
    return null;
  }

  /** The learned text for one key on THIS form, honouring its context rule. */
  function resolveLearned(entry, keys, el) {
    if (!entry || !entry.variants || !entry.variants.length) return null;
    const byId = new Map(entry.variants.map((v) => [v.id, v]));
    const branch = entry.rule ? branchFor(entry.rule, keys) : null;
    // A rule that abstains on this form shape is not a licence to guess — fall
    // through to plain ranking exactly as if there were no rule at all.
    if (branch) {
      const ruled = byId.get(entry.rule[branch]);
      if (ruled) {
        // The rule chose the FACT; the element still chooses the format, so a
        // ruled phone number can arrive dashed here and bare on the next form.
        const siblings = entry.variants.filter((v) => sameFact(entry.key, v.text, ruled.text));
        return (pickVariant(el, siblings.length ? siblings : [ruled]) || ruled).text;
      }
    }
    return (pickVariant(el, entry.variants) || entry.variants[0]).text;
  }

  // ── page capture (for "Process this page") ────────────────────────────────
  // What the server gets to read when it cannot fetch the posting itself: the
  // job description as rendered in THIS tab, plus the visible form's questions.
  // Job-description input only — it never carries candidate facts.
  const CAPTURE_MAX = 24000;
  const JD_CONTAINERS = [
    '[data-automation-id="jobPostingDescription"]', '[data-automation-id="jobPostingPage"]',
    '#job-description', '.job-description', '[class*="job-description" i]', '[class*="jobDescription" i]',
    '[class*="posting" i]', 'article', 'main', '[role="main"]', '#content',
  ];
  function extractJdText({ containerOnly = false } = {}) {
    let best = '';
    for (const sel of JD_CONTAINERS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el || el.id === 'career-ops-companion-host') continue;
        const t = String(el.innerText || '').trim();
        if (t.length > best.length) best = t;
      }
    }
    const body = String(document.body ? document.body.innerText : '').trim();
    // A container that holds most of the page is the description; a thin one
    // (a sidebar that merely matched a class) is not — fall back to the body.
    const thin = best.length < 400 || best.length < body.length * 0.25;
    // `containerOnly` refuses that body fallback. "Process this page" WANTS
    // it — the whole page is the posting it is asking the server to evaluate,
    // and the candidate pressed a button that says so. Live fill does not: it
    // runs on the APPLICATION form, where document.body.innerText is the
    // candidate's own half-typed answers and, on a review step, their
    // references' names and phone numbers. Scraping that into a model prompt
    // to answer "why do you want this role" is not a trade worth making, so an
    // unidentifiable page contributes no job context at all.
    if (thin) {
      if (containerOnly) return '';
      best = body;
    }
    return best.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, CAPTURE_MAX);
  }
  function extractVisibleQuestions() {
    const out = [];
    const seen = new Set();
    for (const { el, label } of collectControls()) {
      if (!visible(el) || !label || label.length < 6) continue;
      const key = label.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      const options = el.tagName === 'SELECT'
        ? [...el.options].map((o) => clean(o.textContent)).filter((t) => t && !/^(select|choose|--)/i.test(t)).slice(0, 60)
        : [];
      const type = el.tagName === 'SELECT' || isComboLike(el) ? 'multi_value_single_select'
        : el.type === 'radio' || el.type === 'checkbox' ? 'multi_value_single_select'
          : el.tagName === 'TEXTAREA' || el.isContentEditable ? 'textarea' : 'input_text';
      out.push({ label: label.slice(0, 400), type, options, required: Boolean(el.required || el.getAttribute('aria-required') === 'true') });
      if (out.length >= 40) break;
    }
    return out;
  }
  // Workday and other SPAs paint the description well after `load`; wait for
  // real text before capturing rather than shipping an empty shell.
  async function capturePage(maxWaitMs = 6000) {
    const t0 = Date.now();
    let text = extractJdText();
    while (text.length < 400 && Date.now() - t0 < maxWaitMs) {
      await sleep(500);
      text = extractJdText();
    }
    const h1 = clean(document.querySelector('h1')?.innerText || '');
    const siteName = clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '');
    return {
      text,
      title: (h1 || clean(document.title)).slice(0, 200),
      company: siteName.slice(0, 120),
      location: '',
      questions: extractVisibleQuestions(),
    };
  }

  // \b-anchored alternation — the fix for item #4's real root cause at the
  // MATCHING layer (fill-plan.mjs's own fix removes 'city' from `location`'s
  // keys, but an unanchored regex would still let a bare 'city'/'state'/'race'
  // key fire inside "capacity"/"statement"/"embrace"). Mirrors how
  // field-taxonomy.mjs's own TAXONOMY[].match regexes already use \b — every
  // regex this file builds from a keys/match array goes through this one
  // constructor, never a hand-rolled `new RegExp(...)` alternation.
  function labelMatcher(alternatives) {
    return new RegExp(`\\b(?:${(alternatives || []).map(escRe).join('|')})\\b`, 'i');
  }

  // `excludeRe`, when given, drops any control whose label ALSO matches it —
  // the client-side half of item #4's home-address-vs-work-location guard:
  // a HOME_ADDRESS_IDS field/learned key must never claim a control whose
  // label reads as a work-location question ("Which city would you like to
  // work in?" contains the bare word "city" too) even though the plan's own
  // `keys` already keep the two id sets disjoint server-side.
  function findByLabel(controls, pattern, { excludeRe = null } = {}) {
    const re = pattern instanceof RegExp ? pattern : labelMatcher([pattern]);
    return controls
      .filter(({ label }) => label && re.test(label) && !(excludeRe && excludeRe.test(label)))
      .map(({ el }) => el);
  }

  // ── ATS selector packs (ported from autopilot/lib/apply/{greenhouse,lever,ashby}.mjs) ──
  const ATS_PACKS = [
    {
      name: 'greenhouse',
      host: /greenhouse\.io$/,
      profile: {
        first_name: ['#first_name', 'input[name="job_application[first_name]"]'],
        last_name: ['#last_name', 'input[name="job_application[last_name]"]'],
        full_name: ['input[name="name"]'],
        email: ['#email', 'input[name="job_application[email]"]'],
        phone: ['#phone', 'input[name="job_application[phone]"]'],
        location: ['#job_application_location', 'input[name*="location"]'],
        linkedin: ['input[name*="linkedin"]'],
        website: ['input[name*="website"]', 'input[name*="portfolio"]'],
        github: ['input[name*="github"]'],
      },
      resume: ['#resume', 'input[name="job_application[resume]"]'],
      cover: ['#cover_letter', 'textarea[name*="cover_letter"]'],
      // A dedicated cover-letter FILE input, distinct from the textarea above
      // (`cover`) — some Greenhouse boards offer both a text box and an
      // attachment. Lever/Ashby have no common dedicated cover-letter file
      // input, so they omit this key and fall through to findCoverLetterInput's
      // generic (label/accept/nearby-text) path.
      coverFile: ['#cover_letter_file', 'input[name="job_application[cover_letter_file]"]'],
    },
    {
      name: 'lever',
      host: /lever\.co$/,
      profile: {
        full_name: ['input[name="name"]'],
        email: ['input[name="email"]'],
        phone: ['input[name="phone"]'],
        location: ['input[name="location"]'],
        linkedin: ['input[name="urls[LinkedIn]"]', 'input[name*="linkedin" i]'],
        website: ['input[name="urls[Portfolio]"]', 'input[name*="portfolio" i]'],
        github: ['input[name="urls[GitHub]"]', 'input[name*="github" i]'],
      },
      resume: ['input[name="resume"]', '.resume-upload-input'],
      cover: ['textarea[name*="comments"]', 'textarea[name*="cover" i]'],
    },
    {
      name: 'ashby',
      host: /ashbyhq\.com$/,
      profile: {
        full_name: ['input[name="_systemfield_name"]', 'input[name*="name" i]'],
        email: ['input[name="_systemfield_email"]', 'input[type="email"]'],
        phone: ['input[name="_systemfield_phone"]', 'input[type="tel"]'],
        location: ['input[name*="location" i]'],
        linkedin: ['input[name*="linkedin" i]'],
        website: ['input[name*="website" i]', 'input[name*="portfolio" i]'],
        github: ['input[name*="github" i]'],
      },
      resume: ['input[name="_systemfield_resume"]', 'input[accept*=".pdf"]'],
      cover: ['textarea[name*="cover" i]'],
    },
  ];
  const atsPack = () => ATS_PACKS.find((p) => p.host.test(location.hostname)) || null;

  // ── combobox (react-select etc.) ──────────────────────────────────────────
  // Type-to-filter then click a matching visible option. Best effort — a miss
  // just leaves the row for assisted/copy mode.
  async function fillCombobox(el, value) {
    try {
      const input = el.tagName === 'INPUT' ? el : el.querySelector('input') || el;
      if (alreadyAnswered(input)) return 'already';
      // A Workday dropdown button shows its current choice as text, not value.
      if (input.tagName === 'BUTTON' && clean(input.textContent) && !/^(select|choose|--|select one)/i.test(clean(input.textContent))) return 'already';
      input.focus();
      fireMouse(input);
      if (input.tagName === 'INPUT') setNativeValue(input, String(value));
      await sleep(700);
      // Options are matched by their TEXT, never by position — Workday varies
      // Yes/No order per question, so a positional pick can invert an answer.
      const options = [...document.querySelectorAll('[role="option"], [role="listbox"] li')].filter(visible);
      const target = clean(value).toLowerCase();
      let match = options.find((o) => clean(o.textContent).toLowerCase() === target)
        || options.find((o) => clean(o.textContent).toLowerCase().includes(target));
      let guessed = false;
      if (!match) {
        // Item #1's best-guess ladder, over the options actually rendered by
        // this open dropdown.
        const texts = options.map((o) => clean(o.textContent));
        const guess = pickOption(texts, value, { question: labelFor(input) });
        if (guess) { match = options.find((o) => clean(o.textContent) === guess.value); guessed = !guess.exact; }
      }
      if (!match) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }
      fireMouse(match);
      await sleep(200);
      return guessed ? 'guessed' : true;
    } catch {
      return false;
    }
  }

  // Radio/checkbox groups: click the option whose own label matches the
  // answer exactly, scoped (when possible) to a container mentioning the
  // question. When nothing matches EXACTLY — the common case for EEO/
  // demographic radio groups, whose option wording rarely matches the
  // profile's stored answer character-for-character ("I am not a protected
  // veteran" vs "No") — fall back to pickOption's best-guess ladder over the
  // group's own option labels (items #1/#2's fix reaching radio groups, not
  // just <select>).
  function fillChoice(question, answer) {
    const answerRe = new RegExp(`^\\s*${escRe(clean(answer))}\\s*$`, 'i');
    const all = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    let candidates = all.filter((el) => answerRe.test(labelFor(el)) || answerRe.test(clean(el.closest('label')?.textContent)));
    let guessed = false;
    if (!candidates.length) {
      const qNorm = clean(question).toLowerCase().slice(0, 60);
      const anchor = all.find((el) => {
        const box = el.closest('fieldset, [role="group"]');
        return box && clean(box.innerText).toLowerCase().includes(qNorm.slice(0, 30));
      });
      const group = anchor && anchor.closest('fieldset, [role="group"]');
      const pool = group ? [...group.querySelectorAll('input[type="radio"], input[type="checkbox"]')] : all;
      const labels = pool.map((el) => clean(labelFor(el) || el.closest('label')?.textContent));
      const guess = pickOption(labels, answer, { question });
      if (guess) {
        candidates = pool.filter((el, i) => labels[i] === guess.value);
        guessed = !guess.exact;
      }
    }
    if (!candidates.length) return false;
    // Whoever answered this group first wins — including the candidate
    // switching an option after an earlier fill.
    if (candidates.some(alreadyAnswered)) return 'already';
    const qNorm = clean(question).toLowerCase().slice(0, 60);
    const scoped = candidates.find((el) => {
      const box = el.closest('fieldset, [role="group"], div');
      return box && clean(box.innerText).toLowerCase().includes(qNorm.slice(0, 30));
    });
    const pick = scoped || (candidates.length === 1 ? candidates[0] : null);
    if (!pick) return false;
    if (!pick.checked) fireMouse(pick);
    return pick.checked ? (guessed ? 'guessed' : true) : false;
  }

  // Live fill's own radio/checkbox apply (item #11, step 4): resolve WITHIN
  // el's own group — inputs sharing el.name, or el itself — never
  // fillChoice's page-wide label search. harvestForm() stamps a stable id
  // onto one SPECIFIC radio/checkbox per harvested field, and applyLiveFill
  // resolves that id back to el precisely; calling fillChoice(labelFor(el),
  // value) throws that precision away and re-searches the WHOLE document
  // for any radio/checkbox whose own label matches the answer text — which
  // lands on the first such control in DOM order, a DIFFERENT question's
  // radio whenever two Yes/No-style groups share the same option wording
  // (the blocker this replaced; background_legal alone has 8 such groups).
  // Scoping to el.name keeps the click inside el's own question no matter
  // how many other same-labelled groups exist elsewhere on the page.
  // Returns { result, target }: `result` is fillChoice's own vocabulary
  // (true/'guessed'/false — 'already' is the caller's job, via
  // alreadyAnswered(el) before this is even invoked), and `target` is
  // whichever control was ACTUALLY mutated, for filledValues/guessedValues
  // bookkeeping — always a member of el's own group, never a stranger's.
  function applyLiveFillChoice(el, value) {
    const answerRe = new RegExp(`^\\s*${escRe(clean(value))}\\s*$`, 'i');
    let candidates = [el];
    if (el.name) {
      try {
        candidates = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"], input[type="checkbox"][name="${CSS.escape(el.name)}"]`)];
      } catch { candidates = [el]; }
      if (!candidates.length) candidates = [el];
    }
    // 1. Exact label match within the group.
    let match = candidates.find((c) => answerRe.test(labelFor(c)) || answerRe.test(clean(c.closest('label')?.textContent)));
    // 2. el's own label already equals the answer — the harvested control
    // IS the one to click (the common single-checkbox case).
    if (!match && (answerRe.test(labelFor(el)) || answerRe.test(clean(el.closest('label')?.textContent)))) match = el;
    let guessed = false;
    // 3. pickOption's best-guess ladder over the GROUP's own option labels —
    // the same fallback fillChoice used, scoped to el's group instead of the
    // whole page.
    if (!match) {
      const labels = candidates.map((c) => clean(labelFor(c) || c.closest('label')?.textContent));
      const guess = pickOption(labels, value, { question: groupHeadingOf(el) || labelFor(el) });
      if (guess) {
        match = candidates.find((c, i) => labels[i] === guess.value);
        guessed = !guess.exact;
      }
    }
    if (!match) return { result: false, target: el };
    if (!match.checked) fireMouse(match);
    return { result: match.checked ? (guessed ? 'guessed' : true) : false, target: match };
  }

  // A control's own fieldset/[role=group] ancestor's legend/heading text —
  // EEO/demographic radio groups are almost always labeled on the GROUP
  // ('Gender' as a <legend>), not on each individual <input> (labeled just
  // 'Male'/'Female'/'Non-binary'), so labelFor(el) alone never surfaces the
  // topic word for any per-control check. Shared by findGroupLabel (below,
  // canned-answer scoping) and harvestForm's sensitivity gate — both need to
  // see the exact same heading a fieldset-style demographic block carries.
  function groupHeadingOf(el) {
    const group = el && el.closest && el.closest('fieldset, [role="group"]');
    if (!group) return '';
    const heading = group.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4');
    return clean(heading ? heading.textContent : '');
  }

  // A fieldset/[role=group]'s own legend/heading text, when it matches one of
  // a canned answer's `match` phrases — EEO/demographic radio groups are
  // usually labeled on the GROUP, not on each individual <input>, so the
  // per-control findByLabel pass the canned loop tries first never finds
  // them. Falls back to the canned entry's own first match phrase as a scope
  // hint so fillChoice still has a `question` to anchor on even when no
  // group heading was found.
  function findGroupLabel(controls, re, fallback = null) {
    for (const { el } of controls) {
      const text = groupHeadingOf(el);
      if (text && re.test(text)) return text;
    }
    return fallback;
  }

  // Many ATSes mount the form lazily (SPA route, an Apply button that reveals
  // it). Rather than fill against an empty DOM, poll briefly until controls
  // exist — auto-run passes a longer window than a manual click.
  async function waitForControls(maxMs = 0) {
    let controls = collectControls();
    const t0 = Date.now();
    while (!controls.length && Date.now() - t0 < maxMs) {
      await sleep(400);
      controls = collectControls();
    }
    return controls;
  }

  // Open-ended questions the plan did not cover: visible, empty free-text
  // controls with a meaningful label. Feeds auto-draft.
  function collectOpenQuestions() {
    const out = [];
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
      if (!visible(el)) continue;
      if (clean(el.tagName === 'TEXTAREA' ? el.value : el.textContent)) continue;
      const label = labelFor(el);
      if (!label || label.length < 12) continue;
      if (/cover letter|resume|\bcv\b/i.test(label)) continue;
      out.push(label);
      if (out.length >= 8) break;
    }
    return out;
  }

  // ── live fill: harvest (item #11) ──────────────────────────────────────
  // What Live fill sends the model: every visible, EMPTY, non-sensitive,
  // applicant-owned control the deterministic fill left untouched (it always
  // runs first — see fillLive in the panel section — so anything already
  // 'already'/'filled' is excluded here for free by the alreadyAnswered
  // check). Two independent sensitive-topic nets apply, not one: legacy
  // SENSITIVE_RE/isSensitive (credentials, gov id, payment, DOB, salary) AND
  // the wider SENSITIVE_QUESTION_LABEL_RE (demographics, criminal history,
  // references, security clearance — none of which SENSITIVE_RE ever knew
  // about). File inputs are never touched. Each harvested control gets a
  // stable per-run id stamped onto its own dataset — never re-matched by
  // label when the server's answer comes back, which protects against a
  // mid-call DOM re-render swapping in a DIFFERENT control under the same
  // label.
  //
  // The label-only check alone misses a standard EEO/demographic radio or
  // checkbox GROUP: a fieldset legend of 'Gender' above per-option labels
  // that just read 'Male'/'Female'/'Non-binary' never restate the topic
  // word, so SENSITIVE_QUESTION_LABEL_RE against labelFor(el) alone never
  // fires. groupHeadingOf(el) is the same fieldset/[role=group] legend
  // lookup fillChoice's findGroupLabel() already relies on for the
  // deterministic canned-answer path — applying both nets to it here closes
  // the same blind spot for the model-bound harvest.
  function harvestForm() {
    const out = [];
    let n = 0;
    for (const { el, label } of collectControls()) {
      if (n >= 80) break;
      if (!visible(el) || isSensitive(el) || !ownedByApplicant(el)) continue;
      if (SENSITIVE_QUESTION_LABEL_RE.test(label)) continue;
      const groupHeading = groupHeadingOf(el);
      if (groupHeading && (SENSITIVE_QUESTION_LABEL_RE.test(groupHeading) || SENSITIVE_RE.test(groupHeading))) continue;
      if (el.type === 'file') continue;
      if (alreadyAnswered(el)) continue;
      // FRAME_TAG (module-scope, one random value per frame per page load) —
      // never a plain per-frame counter — is what keeps ids globally unique
      // when the harvest and the apply-time broadcast both fan out across
      // every frame: two different frames each starting their own count at 0
      // would otherwise stamp the SAME id onto two DIFFERENT controls, and
      // the apply step (`[data-co-live-fill-id="ID"]`) would resolve to
      // whichever frame's querySelector ran first.
      const id = `${FRAME_TAG}_lf${n}`;
      el.dataset.coLiveFillId = id;
      const type = el.tagName === 'SELECT' || isComboLike(el) ? 'select'
        : el.type === 'radio' || el.type === 'checkbox' ? 'choice'
          : el.tagName === 'TEXTAREA' || el.isContentEditable ? 'textarea' : 'text';
      const options = (el.tagName === 'SELECT'
        ? [...el.options].map((o) => clean(o.textContent)).filter((t) => t && !/^(select|choose|--)/i.test(t))
        : type === 'choice' && el.name
          ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)].map((r) => clean(labelFor(r) || r.closest('label')?.textContent))
          : []).slice(0, 40);
      out.push({
        id,
        label: label.slice(0, 200),
        type,
        options,
        required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
        section: clean(el.closest('fieldset,section')?.querySelector(':scope > legend, :scope > h2, :scope > h3')?.textContent || '').slice(0, 80),
        placeholder: clean((el.getAttribute && el.getAttribute('placeholder')) || '').slice(0, 100),
        maxlength: Number(el.maxLength) > 0 ? Number(el.maxLength) : null,
        value_now: '',
      });
      n += 1;
    }
    return out;
  }

  // What this frame wrote, and what it found already written, keyed by the
  // element itself. WeakMaps so a re-rendered SPA form drops its old entries
  // instead of pinning detached nodes for the life of the tab. Read once, at
  // submit time, to tell three things apart: the value we wrote and the
  // candidate left alone, the value we wrote and they CORRECTED, and the value
  // that was already there before we touched anything.
  const filledValues = new WeakMap();
  const prefilledValues = new WeakMap();
  // Elements whose last WRITTEN value came from pickOption's non-exact rungs
  // (a best guess, not an exact match) — read by collectFinalValues so a
  // guess the candidate never reviewed can never be silently promoted into
  // field-memory as a "confirmed" fact (§5.7).
  const guessedValues = new WeakMap();

  // ── fill engine ───────────────────────────────────────────────────────────
  // Returns [{key, label, status: 'filled'|'already'|'guessed'|'failed'|'notfound'}]
  // so the panel can pre-complete its checklist. Runs in every frame; the
  // panel merges (filled in any frame wins).
  async function runFill(plan, { waitMs = 1500, strict = false, topHost = '' } = {}) {
    const results = [];
    if (strict && !frameTrusted(topHost)) return results;
    // A frame we are willing to fill for a known queue item is also a frame
    // whose Submit click is worth watching for. Untrusted frames returned above
    // and never arm.
    // Arm even without a queue item: on an unseen page there is no tracker row
    // to move, but the candidate's own typing is still the thing worth learning
    // from. A null item means "observe only, report nothing".
    armSubmitWatch((plan && plan.item && plan.item.id) || null);
    captureTopHost = topHost || captureTopHost;
    const pack = atsPack();
    const controls = await waitForControls(waitMs);
    // `value` is what was ACTUALLY written, which can differ from the plan's
    // context-free default once a learned rule resolves — the panel repaints
    // from this so a row never shows Denver while Littleton was typed.
    const push = (key, label, status, value = null) => results.push({ key, label, status, value });
    // 'guessed' is a real terminal state, distinct from 'filled' — a
    // non-exact pickOption pick is applied but always flagged for review.
    const state = (r) => (r === 'already' ? 'already' : r === 'guessed' ? 'guessed' : 'filled');
    // Canonical keys this run has already satisfied — a learned value must
    // never compete with the profile-sourced one for the same field.
    const filledKeys = new Set();
    const noteFilled = (el, key, value, result) => {
      filledKeys.add(key);
      // Only remember what WE wrote. An 'already' means the candidate or the
      // browser put it there — that is a prefill to learn from, not a value to
      // diff a later edit against.
      if (result === 'already') prefilledValues.set(el, { key, value: readControlValue(el) });
      else {
        filledValues.set(el, { key, value: String(value) });
        if (result === 'guessed') guessedValues.set(el, true);
      }
    };

    for (const field of plan.fields || []) {
      let done = false;
      for (const sel of (pack && pack.profile[field.id]) || []) {
        const el = document.querySelector(sel);
        if (el) { const r = fillControl(el, field.value); if (r) { noteFilled(el, field.id, field.value, r); push(`field:${field.id}`, field.id, state(r)); done = true; break; } }
      }
      if (!done) {
        // A HOME_ADDRESS_IDS field must never claim a control whose label
        // ALSO reads as a work-location question — item #4's fix (removing
        // 'city' from `location`'s own keys, fill-plan.mjs) is reinforced
        // here so a label like "Which city would you like to work in?"
        // cannot be claimed by the home `city` field via loose substring
        // matching.
        const excludeRe = HOME_ADDRESS_IDS.includes(field.id) ? WORK_LOCATION_LABEL_RE : null;
        for (const key of field.keys) {
          for (const el of findByLabel(controls, key, { excludeRe })) {
            const r = fillControl(el, field.value);
            if (r) { noteFilled(el, field.id, field.value, r); push(`field:${field.id}`, field.id, state(r)); done = true; break; }
          }
          if (done) break;
        }
      }
      if (!done && controls.length) push(`field:${field.id}`, field.id, 'notfound');
    }

    // Learned fields. These are the ones the profile has no slot for at all —
    // street address, city, postal code — plus context-resolved versions of the
    // ones it does. Everything the plan already filled above is skipped, so a
    // configured profile value always beats a learned one.
    const pageKeys = formKeysOf(controls);
    for (const entry of plan.learned || []) {
      if (filledKeys.has(entry.key)) continue;
      let done = false;
      const excludeRe = HOME_ADDRESS_IDS.includes(entry.key) ? WORK_LOCATION_LABEL_RE : null;
      for (const key of entry.keys || []) {
        for (const el of findByLabel(controls, key, { excludeRe })) {
          if (isSensitive(el) || !ownedByApplicant(el)) continue;
          const value = resolveLearned(entry, pageKeys, el);
          if (!value) continue;
          const r = fillControl(el, value);
          if (r) { noteFilled(el, entry.key, value, r); push(`learned:${entry.key}`, entry.key, state(r), value); done = true; break; }
        }
        if (done) break;
      }
      if (!done && controls.length) push(`learned:${entry.key}`, entry.key, 'notfound');
    }

    for (const [i, answer] of (plan.answers || []).entries()) {
      if (answer.answer == null) continue;
      const key = `answer:${i}`;
      const short = clean(answer.question).replace(/\brequired\b\s*$/i, '').split(' ').slice(0, 8).join(' ');
      let ok = false;
      const labelled = findByLabel(controls, short.slice(0, 60));
      for (const el of labelled) {
        const r = fillControl(el, answer.answer);
        if (r) { ok = r; break; }
      }
      if (!ok && answer.options && answer.options.length) {
        ok = fillChoice(answer.question, answer.answer);
        if (!ok) {
          const combo = labelled.find((el) => isComboLike(el) || el.closest('[class*="select" i]'));
          if (combo) ok = await fillCombobox(combo, answer.answer);
        }
      }
      if (ok) push(key, short, state(ok));
      else if (labelled.length || controls.length) push(key, short, labelled.length ? 'failed' : 'notfound');
    }

    if (plan.cover_letter) {
      let ok = false;
      for (const sel of (pack && pack.cover) || []) {
        const el = document.querySelector(sel);
        if (el) { const r = fillControl(el, plan.cover_letter); if (r) { ok = r; break; } }
      }
      if (!ok) {
        for (const el of findByLabel(controls, 'cover letter')) {
          const r = fillControl(el, plan.cover_letter);
          if (r) { ok = r; break; }
        }
      }
      push('cover', 'cover letter', ok ? state(ok) : 'notfound');
    }

    for (const canned of plan.canned || []) {
      const key = `canned:${canned.id}`;
      const re = labelMatcher(canned.match || []);
      let ok = false;
      for (const el of findByLabel(controls, re)) {
        const r = fillControl(el, canned.answer);
        if (r) { ok = r; break; }
        if (isComboLike(el) || el.closest('[class*="select" i]')) {
          const c = await fillCombobox(el, canned.answer);
          if (c) { ok = c; break; }
        }
      }
      if (!ok) {
        // Item #2's real fix: EEO/demographic radio groups are usually
        // labeled on the <fieldset>/<legend>, not on each <input>, so the
        // per-control pass above never finds them — findGroupLabel scopes the
        // search to a container whose own heading matches one of this
        // canned entry's phrases, then fillChoice/pickOption picks among its
        // radios. (Canned entries are never learned via collectFinalValues —
        // their ids never canonicalize through field-taxonomy.mjs's
        // TAXONOMY — so a 'guessed' canned pick needs no guessedValues
        // tracking here; the panel dot alone is enough for review.)
        const groupLabel = findGroupLabel(controls, re, (canned.match || [])[0] || null);
        if (groupLabel) ok = fillChoice(groupLabel, canned.answer);
      }
      if (ok) push(key, canned.id, state(ok));
    }

    return results;
  }

  // The pre-cover-letter-exclusion resume lookup — findCoverLetterInput's
  // generic fallback (rule 3, below) needs this to know which file input the
  // OLD unguarded logic would have picked, so it never claims that same
  // input as the cover letter. Kept private so the two functions can each
  // call the other's "raw" half without recursing into one another.
  function findResumeInputRaw() {
    const pack = atsPack();
    for (const sel of (pack && pack.resume) || []) {
      const el = document.querySelector(sel);
      if (el && el.type === 'file') return el;
    }
    return document.querySelector('input[type="file"]');
  }

  // Item #3's actual fix: a real file attachment, not just the text-area
  // insert `runFill`'s cover-letter block already does unconditionally. Three
  // rungs: a pack's own dedicated selector, a label/accept/nearby-text match,
  // then "whichever file input findResumeInput did NOT claim" — a page with
  // exactly two file inputs and no other signal is almost always resume +
  // cover letter, in some order.
  const COVER_LETTER_RE = /cover\s*letter|letter of interest|motivation letter/i;
  function findCoverLetterInput() {
    const pack = atsPack();
    for (const sel of (pack && pack.coverFile) || []) {
      const el = document.querySelector(sel);
      if (el && el.type === 'file') return el;
    }
    const fileInputs = [...document.querySelectorAll('input[type="file"]')].filter(visible);
    for (const el of fileInputs) {
      const context = `${labelFor(el)} ${el.getAttribute('accept') || ''} ${clean(el.closest('div,fieldset')?.innerText || '').slice(0, 200)}`;
      if (COVER_LETTER_RE.test(context)) return el;
    }
    const resumeInput = findResumeInputRaw();
    return fileInputs.find((el) => el !== resumeInput) || null;
  }

  // findResumeInput now excludes whatever findCoverLetterInput claims, so the
  // two rows in the panel never fight over the same input (a page with one
  // dedicated cover-letter file input and one plain "upload a file" resume
  // input used to have BOTH resolve to the generic input, whichever ran
  // first).
  function findResumeInput() {
    const cover = findCoverLetterInput();
    const pack = atsPack();
    for (const sel of (pack && pack.resume) || []) {
      const el = document.querySelector(sel);
      if (el && el.type === 'file' && el !== cover) return el;
    }
    return [...document.querySelectorAll('input[type="file"]')].find((el) => el !== cover) || null;
  }

  // ── submission detection ──────────────────────────────────────────────────
  // The extension never submits — the CANDIDATE does, from the form's own
  // button. Noticing that is what lets the tracker move itself to Applied.
  //
  // Two signals are required, never one: an INTENT (a real submit event, or a
  // click on a submit-looking control) and then CONFIRMATION (the page says
  // the application was received). A click on its own is not evidence — forms
  // reject, validate, and re-render — and a tracker row that reads Applied for
  // an application that never went out is worse than no automation at all, so
  // this is deliberately tuned for precision over recall. Everything it misses
  // is one click on the dashboard's "Mark as applied" button.
  //
  // Keep CONFIRM_RE identical to the copy in sw.js (that one probes the page
  // the browser lands on when submitting navigates away). A test asserts it.
  // Note what is NOT in here: "application is received", "complete your
  // application", "we received your resume". Those are instructions, and a
  // failed submit leaves them on screen — matching one would file an
  // application that never went out.
  const CONFIRM_RE = /(thank you for (your interest|applying|your application|submitting)|thanks for applying|application (has been |was )?(received|submitted|successful)|application complete|we('ve| have) received your application|your application (has been |was )?(sent|received|submitted)|successfully (submitted|applied)|submission (was )?successful|you have (successfully )?(applied|submitted))/i;
  const SUBMIT_LABEL_RE = /^(submit|submit application|apply|apply now|send application|complete application|finish( and submit)?)$/i;

  let watchedItem = null; // queue item this frame would report a submit for
  let submitArmed = false;
  let confirmPoll = null;
  let captureTopHost = ''; // top-frame host, for the narrower capture-trust test
  let observedThisSubmit = false;

  // ── field memory: capture ─────────────────────────────────────────────────
  // Read back every control we are ALLOWED to learn from and classify it
  // against what we wrote. This is the only place values leave the page.
  //
  // The classification is the whole point of the feature: a field we filled and
  // the candidate left alone confirms what we knew; a field we filled and they
  // then CHANGED is a correction, and the strongest signal there is; a field
  // that was already populated before we arrived is the browser's or the ATS's
  // guess, not the candidate's word; and a field we never filled at all, that
  // now has a value, is them teaching us something new.
  function collectFinalValues() {
    const controls = collectControls();
    const keys = formKeysOf(controls);
    const source_id = `form:${registrable(location.hostname)}|${keys.join(',')}`;
    const out = [];
    const seen = new Set();
    for (const { el, label } of controls) {
      if (isSensitive(el) || !ownedByApplicant(el)) continue;
      const key = canonicalize(label);
      if (!key || seen.has(key)) continue;
      const value = readControlValue(el);
      if (!value || value.length > 300) continue;
      const wrote = filledValues.get(el);
      const pre = prefilledValues.get(el);
      const source = wrote && wrote.value === value ? 'confirmed_unchanged'
        : wrote ? 'confirmed_edit'
          : pre ? 'prefill' : 'typed';
      // A control whose last-written value came from a best GUESS (pickOption's
      // non-exact rungs) is excluded from learning unless the candidate
      // demonstrably edited it afterward — an unreviewed guess promoted to
      // "confirmed" would turn a one-time, visibly-flagged mistake into a
      // durable, invisible one every future form replays (§5.7).
      if (guessedValues.has(el) && source !== 'confirmed_edit') continue;
      seen.add(key);
      out.push({
        key,
        label: clean(label).slice(0, 80),
        value,
        source,
        filled_value: wrote ? wrote.value : null,
        form_keys: keys,
        source_id,
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  // Off by default, and the toggle is checked BEFORE anything reads the DOM —
  // opting out means we never look at the candidate's values at all, not merely
  // that we look and then discard.
  async function sendObservations() {
    if (observedThisSubmit || !frameTrustedForCapture(captureTopHost)) return;
    let settings = null;
    try { settings = await chrome.runtime.sendMessage({ type: 'companion:getSettings' }); } catch { return; }
    if (!settings || !settings.learnFields) return;
    const observations = collectFinalValues();
    if (!observations.length) return;
    observedThisSubmit = true;
    chrome.runtime.sendMessage({
      type: 'companion:observe', item: watchedItem || null, url: location.href, observations,
    }).catch(() => {});
  }

  function looksLikeSubmit(el) {
    if (!el || el.id === 'career-ops-companion-host') return false;
    if (el.tagName === 'INPUT' && el.type === 'submit') return true;
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    if (el.type === 'submit') return true;
    return SUBMIT_LABEL_RE.test(clean(el.value || el.textContent || el.getAttribute('aria-label')));
  }

  function armSubmitWatch(itemId) {
    // A later profile-only fill must not erase the queue item an earlier fill
    // matched — that item is what moves the tracker row to Applied.
    watchedItem = itemId || watchedItem;
    if (submitArmed) return;
    submitArmed = true;
    // Capture phase, listeners only. Nothing here invokes a click or a form
    // submission, and nothing here cancels or reroutes the event — it observes
    // the candidate's own action and gets out of the way. A test enforces that
    // by scanning this function, so keep the forbidden call names out of the
    // prose too.
    document.addEventListener('submit', () => noteSubmitIntent('form submitted'), true);
    document.addEventListener('click', (e) => {
      const el = e.target && e.target.closest
        ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (looksLikeSubmit(el)) {
        noteSubmitIntent(`clicked "${clean(el.value || el.textContent).slice(0, 40)}"`);
      }
    }, true);
  }

  function noteSubmitIntent(evidence) {
    // Learn from the form first, and unconditionally: this fires whether or not
    // there is a queue item behind the page, because an unseen posting the
    // candidate found themselves is exactly the case worth learning from. The
    // read is synchronous-ish and must happen before a navigating submit tears
    // this document down.
    sendObservations();
    if (!watchedItem) return;
    // Tell the worker next: if this submit navigates the page away, this
    // document (and the poll below) dies, and the worker's own post-navigation
    // probe becomes the only thing left that can confirm.
    chrome.runtime.sendMessage({
      type: 'companion:submitIntent', item: watchedItem, url: location.href, evidence,
    }).catch(() => {});
    if (confirmPoll) return;
    const deadline = Date.now() + 30000;
    confirmPoll = setInterval(() => {
      if (!watchedItem || Date.now() > deadline) {
        clearInterval(confirmPoll);
        confirmPoll = null;
        return;
      }
      const text = clean(document.body ? document.body.innerText : '').slice(0, 20000);
      const hit = text.match(CONFIRM_RE);
      if (!hit) return;
      clearInterval(confirmPoll);
      confirmPoll = null;
      chrome.runtime.sendMessage({
        type: 'companion:submitConfirmed',
        item: watchedItem,
        url: location.href,
        evidence: `page says "${clean(hit[0]).slice(0, 80)}"`,
      }).catch(() => {});
      watchedItem = null; // report once per frame
    }, 1000);
  }

  // ── messaging (every frame) ───────────────────────────────────────────────
  const toTop = (payload) => chrome.runtime.sendMessage({ type: 'companion:toTop', payload }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'companion:toggle':
        if (IS_TOP) togglePanel();
        sendResponse({ ok: true });
        break;
      case 'companion:runFill':
        runFill(msg.plan, { waitMs: msg.waitMs || 1500, strict: msg.strict, topHost: msg.topHost }).then((results) => {
          if (results.length) toTop({ type: 'companion:fillResults', results, frame: location.hostname });
        });
        sendResponse({ ok: true });
        break;
      case 'companion:collectQuestions':
        (async () => {
          if (msg.strict && !frameTrusted(msg.topHost)) return;
          await waitForControls(msg.waitMs || 0);
          const questions = collectOpenQuestions();
          if (questions.length) toTop({ type: 'companion:questionsFound', questions, frame: location.hostname });
        })();
        sendResponse({ ok: true });
        break;
      case 'companion:fillByLabel': {
        (async () => {
          if (msg.strict && !frameTrusted(msg.topHost)) return;
          const controls = collectControls();
          const short = clean(msg.question).split(' ').slice(0, 8).join(' ');
          let status = null;
          // fillControl re-tests emptiness HERE, not when the question was
          // harvested — a draft can be minutes old and the candidate may have
          // answered it themselves in the meantime.
          for (const el of findByLabel(controls, short.slice(0, 60))) {
            const r = fillControl(el, msg.text);
            if (r) { status = r === 'already' ? 'already' : 'filled'; break; }
          }
          if (!status && controls.length) status = 'notfound';
          if (status) toTop({ type: 'companion:fillResults', results: [{ key: msg.key, label: short, status }], frame: location.hostname });
        })();
        sendResponse({ ok: true });
        break;
      }
      case 'companion:insert': {
        const label = insertIntoFocused(msg.text);
        if (label) toTop({ type: 'companion:inserted', label, nonce: msg.nonce });
        sendResponse({ ok: true });
        break;
      }
      case 'companion:probeFocused': {
        const question = document.hasFocus() ? readFocusedQuestion() : '';
        if (question) toTop({ type: 'companion:focusedQuestion', question });
        sendResponse({ ok: true });
        break;
      }
      case 'companion:attachResume': {
        (async () => {
          // Automatic attaches only fire in frames that plausibly belong to
          // the application. findResumeInput's last resort is "any file input
          // in this frame", and a careers page's third-party chat widget can
          // own one — an unattended resume upload to a stranger is not a
          // recoverable mistake.
          if (msg.strict && !frameTrusted(msg.topHost)) return;
          // Same lazy-mount problem as the form itself — wait for the file
          // input if the caller allows it.
          let input = findResumeInput();
          const t0 = Date.now();
          while (!input && Date.now() - t0 < (msg.waitMs || 0)) {
            await sleep(400);
            input = findResumeInput();
          }
          if (!input) return;
          const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
          const ok = attachFile(input, { bytes, filename: msg.filename, mime: msg.mime });
          toTop({ type: 'companion:resumeAttached', ok, frame: location.hostname });
        })();
        sendResponse({ ok: true });
        break;
      }
      // Item #3's file attachment — the same shape as attachResume, using
      // findCoverLetterInput instead.
      case 'companion:attachCoverLetter': {
        (async () => {
          if (msg.strict && !frameTrusted(msg.topHost)) return;
          let input = findCoverLetterInput();
          const t0 = Date.now();
          while (!input && Date.now() - t0 < (msg.waitMs || 0)) {
            await sleep(400);
            input = findCoverLetterInput();
          }
          if (!input) return;
          const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
          const ok = attachFile(input, { bytes, filename: msg.filename, mime: msg.mime });
          toTop({ type: 'companion:coverLetterAttached', ok, frame: location.hostname });
        })();
        sendResponse({ ok: true });
        break;
      }
      // Live fill (item #11), step 2: harvest this frame's own remaining
      // empty/non-sensitive/applicant-owned controls. Gated behind the same
      // frame-trust rule as every other automatic bulk read — a third-party
      // embed's own form fields are never harvested for the model.
      case 'companion:harvest': {
        (async () => {
          if (msg.strict && !frameTrusted(msg.topHost)) return;
          await waitForControls(msg.waitMs || 0);
          const fields = harvestForm();
          if (fields.length) toTop({ type: 'companion:harvested', fields, frame: location.hostname });
        })();
        sendResponse({ ok: true });
        break;
      }
      // Live fill, step 4: apply the server's answers. Resolved by the exact
      // stable id harvestForm() stamped — never re-matched by label, which
      // protects against a mid-call DOM re-render swapping in a different
      // control under the same label. A field the candidate has since
      // answered (alreadyAnswered) is skipped, not overwritten.
      case 'companion:applyLiveFill': {
        (async () => {
          if (msg.strict && !frameTrusted(msg.topHost)) return;
          const results = [];
          for (const f of msg.fills || []) {
            const el = document.querySelector(`[data-co-live-fill-id="${CSS.escape(f.id)}"]`);
            if (!el) continue; // not this frame's field, or the DOM re-rendered
            if (f.value == null) { results.push({ id: f.id, status: 'skipped' }); continue; }
            if (alreadyAnswered(el)) { results.push({ id: f.id, status: 'skipped', reason: 'field changed' }); continue; }
            let r;
            let target = el;
            if (el.type === 'radio' || el.type === 'checkbox') {
              const choice = applyLiveFillChoice(el, f.value);
              r = choice.result;
              target = choice.target;
            } else if (el.tagName === 'SELECT' || isComboLike(el)) r = fillControl(el, f.value) || await fillCombobox(el, f.value);
            else r = fillControl(el, f.value);
            const status = r === 'already' ? 'already' : r ? (f.confidence === 'high' || f.source === 'deterministic' ? 'filled' : 'guessed') : 'skipped';
            if (r && r !== 'already') {
              filledValues.set(target, { key: `livefill:${f.id}`, value: String(f.value) });
              if (status === 'guessed') guessedValues.set(target, true);
            }
            results.push({ id: f.id, status, value: f.value });
          }
          if (results.length) toTop({ type: 'companion:liveFillApplied', results, frame: location.hostname });
        })();
        sendResponse({ ok: true });
        break;
      }
      default:
        if (IS_TOP && msg.type && msg.type.startsWith('companion:') && panelBus[msg.type]) {
          panelBus[msg.type](msg);
          sendResponse({ ok: true });
        }
    }
    return false;
  });

  // ── message capture (for "Generate message") ─────────────────────────────
  // What the server gets to write a reply from: the candidate's text selection
  // when there is one (the precise read — a single message in a thread), else
  // the messaging surface this tab shows, else the page. Input to a draft only;
  // it never carries candidate facts, and nothing here sends anything.
  const MESSAGE_MAX = 8000;
  const MESSAGE_CONTAINERS = [
    '.msg-s-message-list-content', '.msg-s-message-list', '[data-testid="messaging-thread"]', '.msg-thread',
    '[role="log"]', '[aria-label="Message body"]', '.a3s', '[role="article"]', 'article', 'main', '[role="main"]',
  ];
  function extractMessageText() {
    let best = '';
    for (const sel of MESSAGE_CONTAINERS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el || el.id === 'career-ops-companion-host' || !visible(el)) continue;
        const t = String(el.innerText || '').trim();
        if (t.length > best.length) best = t;
      }
      if (best.length >= 200) break; // the first surface that reads like a thread wins
    }
    if (best.length < 80) best = String(document.body ? document.body.innerText : '').trim();
    return best.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, MESSAGE_MAX);
  }
  function captureMessageContext() {
    let selection = '';
    try { selection = clean(String(window.getSelection ? window.getSelection().toString() : '')); } catch { /* no selection API */ }
    const siteName = clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '');
    return {
      selection: selection.slice(0, MESSAGE_MAX),
      text: selection ? '' : extractMessageText(),
      title: clean(document.title).slice(0, 200),
      url: location.href.slice(0, 500),
      company: siteName.slice(0, 120),
    };
  }

  // ── panel (top frame only) ────────────────────────────────────────────────
  const panelBus = {}; // engine → panel message handlers, filled in below
  if (!IS_TOP) return;

  let host = null;
  let root = null;
  let plan = null;
  let resumeCache = null; // { bytes b64, filename, mime }
  let coverLetterCache = null; // { bytes b64, filename, mime }
  const rowStatus = new Map();
  const rowValue = new Map(); // key -> the text a frame actually wrote (learned rows)
  let insertNonce = 0;
  let pendingInsert = null;
  let draftRows = []; // [{key, question, answer}] — auto-drafted free-text answers
  let questionGather = null; // in-flight collectQuestions gather window
  let liveFillGather = null; // in-flight harvest() gather window
  let liveFillRows = []; // [{id, label, status, value, note}] — the last Live-fill run's own results
  let activeTab = 'fill'; // 'fill' | 'ai' | 'message' — the panel body shows one at a time; only Fill auto-runs
  let messageDraft = { context: '', out: '', key: null }; // survives tab switches

  const send = (msg) => chrome.runtime.sendMessage(msg);
  // No frameId → every frame. A frameId targets one (the late-form replay).
  const broadcast = (payload, frameId = null) =>
    send({ type: 'companion:broadcast', payload, ...(frameId != null ? { frameId } : {}) });
  // Stamped onto every automatic message so engines in third-party frames can
  // recognise that they are not part of this application and stand down.
  const autoScope = { strict: true, topHost: location.hostname };
  let running = false; // fillEverything reentrancy guard

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  // Item #7's fix: the header is a drag handle, clamped to the viewport.
  function clampToViewport(top, left) {
    const maxTop = Math.max(0, window.innerHeight - 40);
    const maxLeft = Math.max(0, window.innerWidth - 60);
    return { top: Math.min(Math.max(0, top), maxTop), left: Math.min(Math.max(0, left), maxLeft) };
  }

  function closePanel() {
    if (!host) return;
    host.remove();
    host = null;
    send({ type: 'companion:setPanelOpen', open: false });
  }

  function togglePanel() {
    if (host) { closePanel(); return; }
    buildPanel();
    send({ type: 'companion:setPanelOpen', open: true });
    loadPlan();
  }

  function setStatusLine(text, isError = false) {
    const el = root.getElementById('co-status');
    if (el) { el.textContent = text; el.style.color = isError ? 'var(--co-danger)' : 'var(--co-dim)'; }
  }

  // A quick, synchronous read of the page's own title/h1/site-name — sent as
  // hints so the plan route's rankCandidates() can offer a `suggested` match
  // when the URL alone does not resolve one (item #8). Deliberately NOT the
  // full capturePage() (which waits up to 6s for an SPA to paint) — a plan
  // load should feel instant.
  function quickPageHints() {
    const h1 = clean(document.querySelector('h1')?.innerText || '');
    const siteName = clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '');
    return { title: clean(document.title).slice(0, 200), h1: h1.slice(0, 200), company: siteName.slice(0, 120) };
  }

  function paintLinked() {
    const el = root.getElementById('co-linked');
    if (!el) return;
    if (plan && plan.mode === 'item' && plan.item) {
      el.hidden = false;
      el.innerHTML = `Linked: ${escHtml(plan.item.company)} — ${escHtml(plan.item.role)} <button class="co-btn" id="co-unlink">Unlink</button>`;
      el.querySelector('#co-unlink').addEventListener('mousedown', (e) => e.preventDefault());
      el.querySelector('#co-unlink').addEventListener('click', async () => {
        await send({ type: 'companion:clearTabLink' });
        setStatusLine('Unlinked — pick another application below, or keep filling from your profile.');
        await loadPlan(null);
      });
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  async function loadPlan(itemId = null) {
    setStatusLine('Loading fill plan…');
    const hints = itemId ? {} : quickPageHints();
    const res = await send({ type: 'companion:getPlan', url: location.href, item: itemId, ...hints });
    if (!res || !res.ok) {
      setStatusLine(res && res.error ? res.error : 'could not load the plan', true);
      renderRows();
      return;
    }
    plan = res;
    rowStatus.clear();
    rowValue.clear();
    draftRows = [];
    liveFillRows = [];
    resumeCache = null;
    coverLetterCache = null;
    paintLinked();
    setStatusLine(plan.mode === 'item'
      ? `Matched: ${plan.item.company} — ${plan.item.role}`
      : 'No pipeline match — profile-only plan (pick an application below if one applies).');
    // Establishing (or re-confirming) the tab link is what closes most of
    // item 8's "re-link on every Continue page" pain — see sw.js's
    // maybeAutoRun relink path, which reads this back on later navigations.
    if (plan.mode === 'item' && plan.item) {
      send({ type: 'companion:setTabLink', item: plan.item.id, host: location.hostname });
    }
    if (activeTab === 'ai') renderAiTab();
    else renderRows();
    // The header's Process button lives outside both tab bodies, so it needs
    // its own gate call regardless of which tab is showing (paintFeatureGates
    // is a no-op for AI-tab-only elements when that tab isn't rendered).
    paintFeatureGates();
  }

  const fillSummary = (suffix = '') => {
    const vals = [...rowStatus.values()];
    const done = vals.filter((s) => s === 'filled' || s === 'already').length;
    return `Auto-fill: ${done} done, ${vals.length - done} left for you — review before submitting.${suffix ? ` ${suffix}` : ''}`;
  };

  // Engine → panel
  panelBus['companion:fillResults'] = ({ results }) => {
    for (const r of results) {
      // Repaint a learned row from what was ACTUALLY written. The plan can only
      // carry the context-free default, so without this the panel would show
      // "Denver" on a form where the rule correctly typed "Littleton".
      if (r.value != null) rowValue.set(r.key, r.value);
      const prev = rowStatus.get(r.key);
      // filled in any frame wins over failed/notfound reported by another
      if (prev === 'filled' || prev === 'already') continue;
      rowStatus.set(r.key, r.status);
    }
    paintStatuses();
    setStatusLine(fillSummary());
  };
  panelBus['companion:questionsFound'] = ({ questions }) => {
    if (!questionGather) return;
    for (const q of questions || []) questionGather.found.add(q);
    clearTimeout(questionGather.settle);
    questionGather.settle = setTimeout(questionGather.finish, 1500);
  };
  // Auto-run entry: the service worker matched this page to a queue item.
  // `relink` (items 6/8): a tab already linked to an item navigated to a
  // Continue/next-step page — sw.js's maybeAutoRun re-fetched THAT item's
  // plan and asks for the deterministic fill only, never live-fill (the
  // deliberate-AI rule holds across every navigation, not just the first
  // load). `reopen` says whether the panel was visibly open before this
  // navigation (chrome.storage.session's panelOpen) — when it was not, the
  // panel is built (so plan/fill state exists) but stays OFF-SCREEN rather
  // than popping open uninvited; the candidate can still open it any time and
  // find the fill already done.
  panelBus['companion:autorun'] = async (msg = {}) => {
    if (running) return;
    if (msg.relink) {
      if (!host) buildPanel({ show: Boolean(msg.reopen) });
      await loadPlan(msg.item);
      if (plan && plan.mode === 'item') fillEverything({ auto: true });
      return;
    }
    if (!host) buildPanel();
    await loadPlan();
    if (plan && plan.mode === 'item') fillEverything({ auto: true });
  };
  // A form frame appeared after the fill ran (Greenhouse embeds, Apply-button
  // reveals) — replay the fill into THAT frame only. Broadcasting to every
  // frame would re-run the plan over forms the candidate has since edited;
  // the 'already' guards are the second line of defence, not the first.
  panelBus['companion:frameAdded'] = ({ frameId }) => {
    if (!plan || !rowStatus.size || frameId == null) return;
    broadcast({ type: 'companion:runFill', plan, waitMs: 4000, ...autoScope }, frameId);
    if (resumeCache && rowStatus.get('resume') !== 'filled') {
      broadcast({ type: 'companion:attachResume', b64: resumeCache.b64, filename: resumeCache.filename, mime: resumeCache.mime, waitMs: 4000, ...autoScope }, frameId);
    }
    if (coverLetterCache && rowStatus.get('cover_letter_file') !== 'filled') {
      broadcast({ type: 'companion:attachCoverLetter', b64: coverLetterCache.b64, filename: coverLetterCache.filename, mime: coverLetterCache.mime, waitMs: 4000, ...autoScope }, frameId);
    }
  };
  panelBus['companion:inserted'] = ({ label, nonce }) => {
    if (pendingInsert && pendingInsert.nonce === nonce) {
      clearTimeout(pendingInsert.timer);
      pendingInsert = null;
    }
    setStatusLine(`Inserted into: ${label.slice(0, 120)}`);
  };
  panelBus['companion:focusedQuestion'] = ({ question }) => {
    const box = root.getElementById('co-assist-q');
    if (box) { box.value = question; setStatusLine('Question read from the focused field.'); }
  };
  // The worker confirmed the candidate's own submit and told the server. Say
  // exactly what moved — "recorded" and "your row was already further along"
  // are different outcomes and the candidate should not have to guess which.
  panelBus['companion:appliedRecorded'] = ({ tracker, already_submitted: already }) => {
    if (!host || !root) return;
    const where = !tracker ? 'tracker unchanged'
      : tracker.updated ? `tracker #${tracker.num} → Applied`
        : tracker.reason === 'already' ? `tracker #${tracker.num} was already Applied`
          : tracker.reason === 'ahead' ? `tracker #${tracker.num} left at ${tracker.from} — further along already`
            : 'no matching tracker row — set that one by hand';
    setStatusLine(`Submitted ✔ ${already ? 'already recorded' : 'recorded'} — ${where}.`);
  };
  // The submit WAS detected, and the server would not take it. Saying nothing
  // here is indistinguishable from the detector never firing — and the two have
  // different fixes — so name which one happened and where the fallback is.
  panelBus['companion:appliedFailed'] = ({ error, will_retry: willRetry }) => {
    if (!host || !root) return;
    setStatusLine(
      `Submit detected but NOT recorded — ${String(error || 'the server refused it').slice(0, 160)}. `
      + (willRetry
        ? 'Retrying when this tab reloads or you come back to it; if it stays red, mark it applied from the dashboard.'
        : 'Mark it applied from the CareerOps dashboard.'),
      true,
    );
  };
  panelBus['companion:resumeAttached'] = ({ ok }) => {
    rowStatus.set('resume', ok ? 'filled' : 'failed');
    paintStatuses();
    setStatusLine(ok ? 'Resume attached — verify the file name shows on the form.' : 'Could not attach — use Download and add it manually.', !ok);
  };
  panelBus['companion:coverLetterAttached'] = ({ ok }) => {
    rowStatus.set('cover_letter_file', ok ? 'filled' : 'failed');
    paintStatuses();
    setStatusLine(ok ? 'Cover letter attached — verify the file name shows on the form.' : 'Could not attach — use Download and add it manually.', !ok);
  };
  // A frame's harvestForm() results — gathered the same way collectQuestions
  // gathers open questions (a settle window across every frame that answers).
  panelBus['companion:harvested'] = ({ fields }) => {
    if (!liveFillGather) return;
    liveFillGather.found.push(...(fields || []));
    clearTimeout(liveFillGather.settle);
    liveFillGather.settle = setTimeout(liveFillGather.finish, 1200);
  };
  // A frame's applyLiveFill results — merged into liveFillRows for the AI
  // tab's review list. Filled in any frame wins over a status a different
  // frame could not resolve (the field simply is not in that other frame).
  panelBus['companion:liveFillApplied'] = ({ results }) => {
    for (const r of results) {
      const row = liveFillRows.find((x) => x.id === r.id);
      if (row) { row.status = r.status; if (r.value != null) row.value = r.value; }
    }
    if (activeTab === 'ai') renderAiTab();
  };

  // Insert with the clipboard as an always-on backstop: if no frame claims the
  // insert within 600ms, the text is already in the clipboard and we say so.
  async function insertText(text) {
    await copyText(text);
    insertNonce += 1;
    const nonce = insertNonce;
    pendingInsert = {
      nonce,
      timer: setTimeout(() => {
        pendingInsert = null;
        setStatusLine('No field focused — copied to clipboard instead. Click the field and paste.', true);
      }, 600),
    };
    broadcast({ type: 'companion:insert', text, nonce });
  }

  async function getResume() {
    if (resumeCache) return resumeCache;
    setStatusLine('Fetching resume…');
    const res = await send({ type: 'companion:getResume', item: plan && plan.item ? plan.item.id : null });
    if (!res || !res.ok) {
      setStatusLine(res && res.error ? res.error : 'resume fetch failed', true);
      return null;
    }
    resumeCache = res;
    return res;
  }

  // Item #3's real fix, fetch half: a real PDF for the item's cover letter
  // text (GET /api/companion/cover-letter), cached the same way getResume()
  // caches the resume bytes.
  async function getCoverLetterFile() {
    if (coverLetterCache) return coverLetterCache;
    setStatusLine('Fetching cover letter…');
    const res = await send({ type: 'companion:getCoverLetter', item: plan && plan.item ? plan.item.id : null });
    if (!res || !res.ok) {
      setStatusLine(res && res.error ? res.error : 'cover letter fetch failed', true);
      return null;
    }
    coverLetterCache = res;
    return res;
  }

  // Ask every frame for its open free-text questions; frames wait for lazy
  // forms up to waitMs, so the gather window extends past that. Resolves with
  // whatever arrived once responses settle (1.5s of quiet) or the deadline.
  function collectPageQuestions(waitMs) {
    return new Promise((resolve) => {
      const state = {
        found: new Set(),
        settle: null,
        deadline: null,
        finish: () => {
          clearTimeout(state.settle);
          clearTimeout(state.deadline);
          if (questionGather === state) questionGather = null;
          resolve([...state.found]);
        },
      };
      questionGather = state;
      state.deadline = setTimeout(state.finish, waitMs + 5000);
      state.settle = setTimeout(state.finish, waitMs + 1500);
      broadcast({ type: 'companion:collectQuestions', waitMs, ...autoScope });
    });
  }

  // Item #11's harvest step: ask every trusted frame for its own harvestForm()
  // output, the same gather-with-settle-window shape collectPageQuestions
  // already uses. Resolves once every frame has answered (or the deadline).
  function harvestPage(waitMs) {
    return new Promise((resolve) => {
      const state = {
        found: [],
        settle: null,
        deadline: null,
        finish: () => {
          clearTimeout(state.settle);
          clearTimeout(state.deadline);
          if (liveFillGather === state) liveFillGather = null;
          resolve(state.found);
        },
      };
      liveFillGather = state;
      state.deadline = setTimeout(state.finish, waitMs + 5000);
      state.settle = setTimeout(state.finish, waitMs + 1500);
      broadcast({ type: 'companion:harvest', waitMs, ...autoScope });
    });
  }

  // Live fill (item #11) — the ONLY thing this file ever runs without an
  // explicit click on THIS button (see the deliberate-AI rule: the AI tab is
  // the sole place inference can be triggered from). Order: (1) the
  // deterministic fill first, so the model only ever sees what a profile
  // answer/canned entry/learned value could not already resolve; (2) harvest
  // what is left; (3) one model call; (4) apply, honouring alreadyAnswered so
  // a field the candidate typed into while the call was running is never
  // overwritten.
  async function fillLive() {
    if (!plan) return;
    if (!plan.features || !plan.features.live_fill) {
      setStatusLine('Live fill is a paid-plan feature — ask the admin to upgrade your tier.', true);
      return;
    }
    if (plan.usage && plan.usage.live_fills && plan.usage.live_fills.remaining === 0) {
      setStatusLine("Today's live-fill limit reached — resets at midnight.", true);
      return;
    }
    setStatusLine('Filling what your profile already answers…');
    await fillEverything({ auto: false });
    setStatusLine('Reading the rest of this page for live fill…');
    const form = (await harvestPage(2500)).slice(0, 80);
    if (!form.length) { setStatusLine('Nothing left to live-fill on this page — everything was already answered.'); return; }
    setStatusLine(`Live-filling ${form.length} field${form.length > 1 ? 's' : ''}… (fleet model — this can take a minute)`);
    const res = await send({
      type: 'companion:liveFill',
      item: plan.item ? plan.item.id : null,
      url: location.href,
      // jd_excerpt was hardcoded '' here, so every "why do you want this role"
      // answer was written with no knowledge of the posting — while the route
      // budgeted 3000 chars for exactly this and "Process this page" already
      // used the same extractor two tabs over. `containerOnly` is what makes
      // that safe here: this runs on the application FORM, so without it the
      // body fallback would ship the candidate's own entered answers (and, on
      // a review step, their references' contact details) to the model. An
      // unrecognisable page sends no context rather than the wrong context.
      // Untrusted page content either way — the prompt's own notice covers
      // <job_context> verbatim, and the delimiters are enforced server-side.
      page: {
        title: clean(document.title).slice(0, 200),
        company: (plan.item && plan.item.company) || '',
        jd_excerpt: extractJdText({ containerOnly: true }).slice(0, 3000),
      },
      form,
    });
    if (!res || !res.ok) {
      setStatusLine((res && res.message) || (res && res.error) || 'Live fill failed.', true);
      return;
    }
    // liveFillRows carries the label/type from the harvest (the /live-fill
    // response never repeats those) so the review list can show more than a
    // bare id.
    const byId = new Map(form.map((f) => [f.id, f]));
    liveFillRows = [...(res.fills || []), ...(res.skipped || [])].map((f) => ({
      id: f.id, label: (byId.get(f.id) || {}).label || f.id,
      status: f.value === undefined ? 'skipped' : f.value == null ? 'skipped'
        : f.confidence === 'high' || f.source === 'deterministic' ? 'filled' : 'guessed',
      value: f.value != null ? f.value : null, note: f.note || f.reason || null,
    }));
    // autoScope-gated like every other automatic bulk write (runFill,
    // attachResume/attachCoverLetter) — a third-party embed frame must not
    // apply model-sourced answers just because it happens to also contain a
    // control that harvestForm() stamped an id onto in a DIFFERENT, trusted
    // frame (ids are FRAME_TAG-namespaced so that never collides, but the
    // frame-trust gate is the actual safety boundary, not the id scheme).
    broadcast({ type: 'companion:applyLiveFill', fills: res.fills || [], ...autoScope });
    if (plan.usage) plan.usage.live_fills = { used: res.used, limit: res.limit, remaining: res.remaining };
    setStatusLine(`Live fill: ${(res.fills || []).length} answered, ${(res.skipped || []).length} left for you — review every value before submitting.`);
    if (activeTab === 'ai') renderAiTab();
  }

  // Draft answers for everything still open: evaluation questions that never
  // got an answer, plus free-text questions found on the page itself. Drafts
  // come from the user's own server/model under the same source-of-truth
  // boundary as the rest of career-ops. Filled where found, listed either way.
  async function autoDraftOpenQuestions({ waitMs = 3000 } = {}) {
    setStatusLine('Scanning the page for open questions…');
    const pageQs = await collectPageQuestions(waitMs);
    const norm = (s) => clean(s).toLowerCase().slice(0, 80);
    const seen = new Set();
    for (const a of plan.answers || []) if (a.answer != null) seen.add(norm(a.question));
    for (const d of draftRows) seen.add(norm(d.question));
    const wanted = [];
    for (const a of plan.answers || []) {
      if (a.answer == null && !(a.options && a.options.length) && !seen.has(norm(a.question))) {
        seen.add(norm(a.question));
        wanted.push(a.question);
      }
    }
    for (const q of pageQs) {
      if (seen.has(norm(q))) continue;
      seen.add(norm(q));
      wanted.push(q);
    }
    const questions = wanted.slice(0, 6); // the draft route clamps at 6
    if (!questions.length) { setStatusLine(fillSummary('No open questions needed drafting.')); return; }
    setStatusLine(`Drafting ${questions.length} answer${questions.length > 1 ? 's' : ''}… (local model — this can take a few minutes)`);
    const res = await send({
      type: 'companion:getDraft', questions, item: plan.item ? plan.item.id : null, ...draftJobHints(),
    });
    if (!res || !res.ok || !Array.isArray(res.answers)) {
      setStatusLine((res && res.error) || 'Drafting failed — use AI assist below, one question at a time.', true);
      return;
    }
    for (const ans of res.answers) {
      if (!ans || ans.answer == null) continue;
      const key = `draft:${draftRows.length}`;
      draftRows.push({ key, question: String(ans.question || ''), answer: String(ans.answer) });
      broadcast({ type: 'companion:fillByLabel', key, question: String(ans.question || ''), text: String(ans.answer), ...autoScope });
    }
    renderRows();
    setStatusLine('Drafts inserted where their fields were found — review every answer, then submit yourself.');
  }

  // Who and what this page is about, for the /draft route's own grounding.
  // A linked pipeline item wins; otherwise the page itself is all we have,
  // and without it "why are you interested in {Company}?" reached the model
  // with a blank company name and no posting text — so the only honest
  // answer it could give was none at all.
  //
  // `containerOnly` on the extractor is the same safety live fill relies on:
  // this runs on the application FORM, so the body fallback would otherwise
  // ship the candidate's own typed answers (and, on a review step, their
  // referees' contact details) to the model. An unrecognisable page sends no
  // context rather than the wrong context. Untrusted page text either way —
  // the answers prompt fences and labels it server-side.
  // An h1 that is the page's chrome rather than the job's title — "Apply for
  // this job", "Careers", "Job Application". Sending one as the role costs a
  // research cache hit (the key is company+role) and puts nonsense in the
  // question the service is asked, so an unusable h1 sends nothing instead.
  const GENERIC_H1 = /^(?:apply|apply now|apply for this job|application|job application|submit(?: your)? application|careers?|jobs?|open (?:roles|positions)|join us|work with us|we're hiring|current openings)\b/i;

  function draftJobHints() {
    const hints = quickPageHints();
    const h1 = GENERIC_H1.test(hints.h1) ? '' : hints.h1;
    return {
      company: (plan && plan.item && plan.item.company) || hints.company || '',
      role: (plan && plan.item && plan.item.role) || h1 || '',
      jd_excerpt: extractJdText({ containerOnly: true }).slice(0, 3000),
    };
  }

  // The one-click DETERMINISTIC path: fill fields + answers, attach the
  // resume and cover letter. Auto-run calls this on a URL match, the
  // multi-page relink calls it on every later Continue page, and the ⚡
  // button is the manual trigger — all three run the exact same flow.
  // Deliberately calls no model: drafting open questions is now the AI tab's
  // own "Draft open questions" button, one explicit click, never bundled in
  // here — no inference call may fire without the candidate having asked for
  // it. Nothing here submits.
  async function fillEverything({ auto = false } = {}) {
    if (!plan || running) return;
    running = true;
    try {
      setStatusLine(auto ? `Matched ${plan.item ? plan.item.company : 'this page'} — auto-filling…` : 'Filling…');
      broadcast({ type: 'companion:runFill', plan, waitMs: auto ? 8000 : 2500, ...autoScope });
      if (plan.resume && plan.resume.available) {
        const r = await getResume();
        if (r) broadcast({ type: 'companion:attachResume', b64: r.b64, filename: r.filename, mime: r.mime, waitMs: auto ? 10000 : 4000, ...autoScope });
      }
      if (plan.cover_letter_file && plan.cover_letter_file.available) {
        const r = await getCoverLetterFile();
        if (r) broadcast({ type: 'companion:attachCoverLetter', b64: r.b64, filename: r.filename, mime: r.mime, waitMs: auto ? 10000 : 4000, ...autoScope });
      }
    } finally {
      running = false;
    }
  }

  // Hand this posting to the pipeline for a full evaluation — the case the
  // scanners never found it: a referral link, a newsletter, an untracked board.
  //
  // Deliberately fire-and-forget. The server queues the URL and evaluates it
  // when a cycle frees up (minutes, sometimes longer), and the packaged
  // application shows up in the dashboard. Nothing depends on this tab staying
  // open, which is the entire point — so the status line's job is to say
  // clearly that the page can now be closed.
  //
  // The page title goes along as a label for the pending row only. It is NOT
  // used as the role: `document.title` is usually "Role - Company | Careers",
  // and the fetcher treats an expected title as a hard guard (a page that does
  // not contain it is refused as a board shell). The evaluation reads the real
  // company and role off the JD.
  //
  // Two ways to use it, and the panel supports both: close the tab and pick the
  // result up in the dashboard, or STAY — the panel polls until the package
  // exists, loads that item's plan, attaches the tailored PDF and fills the
  // form. The page content goes along as `capture` so postings the server
  // cannot fetch (custom career sites, JS shells) still evaluate. Nothing here
  // submits.
  const POLL_MS = 2500;
  const POLL_MAX_MS = 20 * 60 * 1000; // local models: evaluate + tailor + PDF + letter
  let processWatch = null; // request id currently being polled

  async function processThisPage() {
    const btn = root.getElementById('co-process');
    if (btn) btn.disabled = true;
    setStatusLine('Reading this page…');
    try {
      // Always send, even when the page reads thin: the server's own fetcher
      // (Greenhouse/Lever/Workday/… APIs) gets first go and does not need the
      // capture at all. The capture is its fallback, and the server is the one
      // that decides whether it is usable.
      const capture = await capturePage();
      const thin = capture.text.length < 400;
      setStatusLine(thin
        ? 'Little text on this page yet — sending anyway; the server will fetch the posting itself.'
        : 'Sending this page for evaluation…');
      const res = await send({
        type: 'companion:processPage',
        url: location.href,
        title: clean(document.title).slice(0, 200),
        capture,
      });
      if (!res || !res.ok) {
        setStatusLine((res && res.error) || 'Could not queue this page.', true);
        return;
      }
      if (res.duplicate) {
        // Already in the pipeline — go straight to its plan if it is a queue item.
        setStatusLine(res.message || 'Already in your pipeline.');
        if (res.duplicate === 'queue' && res.item) { await loadPlan(res.item); if (plan && plan.mode === 'item') fillEverything({ auto: true }); }
        return;
      }
      setStatusLine(res.message || 'Queued — you can close this page.');
      if (res.request && res.request.id) watchRequest(res.request.id);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function watchRequest(id) {
    processWatch = id;
    const t0 = Date.now();
    let dots = 0;
    while (host && processWatch === id && Date.now() - t0 < POLL_MAX_MS) {
      await sleep(POLL_MS);
      if (!host || processWatch !== id) return;
      const res = await send({ type: 'companion:getRequest', id });
      if (!res || !res.ok || !res.request) continue; // server blip — keep polling
      const r = res.request;
      if (r.status === 'queued' || r.status === 'running') {
        dots = (dots + 1) % 4;
        const secs = Math.round((Date.now() - t0) / 1000);
        setStatusLine(`${r.status === 'running' ? 'Evaluating and tailoring your resume' : 'Waiting for the server'}${'.'.repeat(dots + 1)} (${secs}s — you can close this page; the result lands in the dashboard)`);
        continue;
      }
      processWatch = null;
      if (r.status === 'failed') {
        setStatusLine(`Could not process this page — ${r.note || 'unknown error'}`, true);
        return;
      }
      if (!r.queue_id) {
        setStatusLine(`Done: ${r.note || 'evaluated'} — no package to fill from (score below the packaging floor). See the dashboard.`);
        return;
      }
      await loadPlan(r.queue_id);
      if (plan && plan.mode === 'item') {
        setStatusLine(`Ready: ${plan.item.company} — ${plan.item.role}. Attaching resume and filling…`);
        await fillEverything({ auto: true });
      }
      return;
    }
    if (processWatch === id) {
      processWatch = null;
      if (host) setStatusLine('Still processing — check the CareerOps dashboard, then press ⟳ here to load the plan.');
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  // 'guessed' (a non-exact pickOption pick, applied but flagged) is its own
  // colour, distinct from both a clean fill and a failure — item #1/#2's
  // "review, never silently trust" rule made visible. 'skipped' is live
  // fill's own outcome for a field it deliberately left blank (sensitive,
  // unclear, or the model declined).
  const DOT = {
    filled: '#26a269', already: '#26a269', guessed: '#5b53c7',
    failed: '#e5a50a', notfound: '#e5a50a', skipped: '#6b6b76',
  };

  function rowEl(key, label, value, { multiline = false } = {}) {
    const row = document.createElement('div');
    row.className = 'co-row';
    row.dataset.key = key;
    const preview = clean(value).slice(0, multiline ? 90 : 46) + (clean(value).length > (multiline ? 90 : 46) ? '…' : '');
    row.innerHTML = `
      <span class="co-dot" title="pending"></span>
      <span class="co-lab" title="${escHtml(label)}">${escHtml(label.slice(0, 42))}</span>
      <span class="co-val" title="Full value is inserted/copied — this is a preview">${escHtml(preview)}</span>
      <button class="co-btn co-ins" title="Click into the field on the page, then press this — types the value into it">Insert</button>
      <button class="co-btn co-cp" title="Copy to clipboard">Copy</button>`;
    // mousedown preventDefault: keep the page field focused while clicking us.
    for (const btn of row.querySelectorAll('button')) {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
    }
    row.querySelector('.co-ins').addEventListener('click', () => insertText(String(value)));
    row.querySelector('.co-cp').addEventListener('click', async () => {
      setStatusLine((await copyText(String(value))) ? `Copied: ${label.slice(0, 60)}` : 'Copy failed', false);
    });
    return row;
  }

  // Contact fields the server's promote route can write into the stored
  // profile — the same six PUT /api/profile already accepts. Everything else
  // stays in field memory, where it still fills forms.
  const PROMOTABLE = ['full_name', 'email', 'phone', 'location', 'linkedin', 'website'];

  function learnedRowEl(entry) {
    const key = `learned:${entry.key}`;
    const best = entry.variants[0] ? entry.variants[0].text : '';
    const row = document.createElement('div');
    row.className = 'co-row';
    row.dataset.key = key;
    const badge = entry.rule ? ' ⧉' : '';
    row.innerHTML = `
      <span class="co-dot" title="pending"></span>
      <span class="co-lab" title="${escHtml(entry.key.replace(/_/g, ' '))}${entry.rule ? ' — value depends on which other fields this form has' : ''}">${escHtml(entry.key.replace(/_/g, ' '))}${badge}</span>
      <span class="co-val" title="Learned from forms you filled in">${escHtml(clean(best).slice(0, 46))}</span>
      ${PROMOTABLE.includes(entry.key) ? '<button class="co-btn co-save" title="Save this into your stored profile">Save</button>' : ''}
      <button class="co-btn co-forget" title="Forget this — it will stop being filled in">🗑</button>`;
    for (const btn of row.querySelectorAll('button')) btn.addEventListener('mousedown', (e) => e.preventDefault());
    row.querySelector('.co-save')?.addEventListener('click', async () => {
      const res = await send({ type: 'companion:promoteField', key: entry.key });
      setStatusLine(res && res.ok
        ? `Saved ${entry.key.replace(/_/g, ' ')} to your profile.`
        : (res && res.error) || 'Could not save to your profile.', !(res && res.ok));
    });
    row.querySelector('.co-forget').addEventListener('click', async () => {
      const res = await send({ type: 'companion:forgetLearned', key: entry.key });
      if (res && res.ok) {
        plan.learned = (plan.learned || []).filter((e) => e.key !== entry.key);
        rowValue.delete(key);
        renderRows();
        setStatusLine(`Forgot ${entry.key.replace(/_/g, ' ')}.`);
      } else {
        setStatusLine((res && res.error) || 'Could not forget that.', true);
      }
    });
    return row;
  }

  function paintStatuses() {
    for (const row of root.querySelectorAll('.co-row')) {
      // A learned row shows what was actually typed, which a context rule may
      // have made different from the plan's default.
      const written = rowValue.get(row.dataset.key);
      if (written != null) {
        const val = row.querySelector('.co-val');
        const text = clean(written);
        if (val) val.textContent = text.slice(0, 46) + (text.length > 46 ? '…' : '');
      }
      const status = rowStatus.get(row.dataset.key);
      const dot = row.querySelector('.co-dot');
      if (!dot) continue;
      dot.style.background = status ? (DOT[status] || 'transparent') : 'var(--co-border)';
      const guessedText = clean(written).slice(0, 60);
      dot.title = status === 'filled' ? 'auto-filled' : status === 'already' ? 'was already filled'
        : status === 'guessed' ? `best guess${guessedText ? `: "${guessedText}"` : ''} — please verify`
          : status === 'failed' ? 'auto-fill failed — use Insert or Copy'
            : status === 'notfound' ? 'field not found on this page — use Insert or Copy'
              : status === 'skipped' ? 'left for you — sensitive, unclear, or the model declined' : 'pending';
    }
  }

  // The exact label the dashboard shows for a candidate row — plan.candidates
  // already carries a server-derived `label` (queue.mjs's candidateLabel(),
  // item #10's "keep the label text derivation in ONE server-side place");
  // this is only a defensive fallback for an older/stub plan shape.
  const candidateLabel = (c) => c.label || `${clean(c.company)} — ${clean(c.role)}`;

  function renderRows() {
    if (activeTab !== 'fill') return; // the AI/message tabs own the body right now
    const body = root.getElementById('co-body');
    body.textContent = '';
    if (!plan) return;

    // Item #10's fix: a searchable, preselecting picker, never a plain
    // <select> — the membership/order are already correct server-side
    // (COMPANION_REVIEW_STATUSES/listItems' own order, unchanged — see
    // fill-plan.mjs), the pain was finding the right row quickly by hand.
    if (plan.mode === 'profile' && plan.candidates && plan.candidates.length) {
      const wrap = document.createElement('div');
      wrap.className = 'co-candidates';
      if (plan.suggested && plan.suggested.score >= 0.6) {
        const match = plan.candidates.find((c) => c.id === plan.suggested.id);
        if (match) {
          const banner = document.createElement('div');
          banner.className = 'co-hint co-suggest';
          banner.innerHTML = `This looks like <strong>${escHtml(candidateLabel(match))}</strong>. `
            + '<button class="co-btn co-primary" id="co-suggest-link">Link</button> '
            + '<button class="co-btn" id="co-suggest-not">Not this one</button>';
          for (const btn of banner.querySelectorAll('button')) btn.addEventListener('mousedown', (e) => e.preventDefault());
          banner.querySelector('#co-suggest-link').addEventListener('click', async () => {
            await send({ type: 'companion:link', item: match.id, url: location.href });
            await loadPlan(match.id);
          });
          // Dismisses for this page load only — never a persisted "stop
          // suggesting", since the same page could genuinely be a different
          // posting next time the plan reloads.
          banner.querySelector('#co-suggest-not').addEventListener('click', () => banner.remove());
          wrap.appendChild(banner);
        }
      }
      const filter = document.createElement('input');
      filter.type = 'text';
      filter.className = 'co-pick-filter';
      filter.placeholder = 'Filter by company or role — or link this page to a pipeline item';
      wrap.appendChild(filter);
      const list = document.createElement('div');
      list.className = 'co-pick-list';
      wrap.appendChild(list);
      const paintList = () => {
        const q = clean(filter.value).toLowerCase();
        list.textContent = '';
        for (const c of plan.candidates) {
          const label = candidateLabel(c);
          if (q && !label.toLowerCase().includes(q)) continue;
          const closed = c.liveness && c.liveness.status === 'expired';
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'co-btn co-pick-row';
          row.textContent = `${label}${closed ? ' (closed)' : ''}`;
          row.addEventListener('mousedown', (e) => e.preventDefault());
          row.addEventListener('click', () => loadPlan(c.id));
          list.appendChild(row);
        }
      };
      filter.addEventListener('input', paintList);
      paintList();
      body.appendChild(wrap);
    }

    const section = (title) => {
      const h = document.createElement('div');
      h.className = 'co-sec';
      h.textContent = title;
      body.appendChild(h);
    };

    if (plan.fields && plan.fields.length) {
      section('Contact');
      for (const f of plan.fields) body.appendChild(rowEl(`field:${f.id}`, f.id.replace(/_/g, ' '), f.value));
    }
    if (plan.learned && plan.learned.length) {
      const det = document.createElement('details');
      det.className = 'co-det';
      det.innerHTML = `<summary>Learned from forms you filled (${plan.learned.length})</summary>`;
      for (const entry of plan.learned) det.appendChild(learnedRowEl(entry));
      body.appendChild(det);
    }
    if (plan.answers && plan.answers.length) {
      section('Screening answers');
      plan.answers.forEach((a, i) => {
        if (a.answer != null) body.appendChild(rowEl(`answer:${i}`, clean(a.question), a.answer, { multiline: true }));
      });
    }
    if (draftRows.length) {
      section('Drafted answers');
      for (const d of draftRows) body.appendChild(rowEl(d.key, clean(d.question), d.answer, { multiline: true }));
    }
    if (plan.cover_letter) {
      section('Cover letter');
      body.appendChild(rowEl('cover', 'cover letter', plan.cover_letter, { multiline: true }));
    }
    if (plan.resume && plan.resume.available) {
      section('Resume');
      const row = document.createElement('div');
      row.className = 'co-row';
      row.dataset.key = 'resume';
      row.innerHTML = `
        <span class="co-dot"></span>
        <span class="co-lab">${escHtml(plan.resume.filename)}</span>
        <span class="co-val">${plan.resume.tailored ? 'tailored PDF' : 'profile resume'}</span>
        <button class="co-btn co-att" title="Attach to the form's file input">Attach</button>
        <button class="co-btn co-dl" title="Download to this device">⬇</button>`;
      for (const btn of row.querySelectorAll('button')) btn.addEventListener('mousedown', (e) => e.preventDefault());
      row.querySelector('.co-att').addEventListener('click', async () => {
        const r = await getResume();
        if (r) broadcast({ type: 'companion:attachResume', b64: r.b64, filename: r.filename, mime: r.mime });
      });
      row.querySelector('.co-dl').addEventListener('click', async () => {
        const r = await getResume();
        if (!r) return;
        const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = r.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatusLine(`Downloaded ${r.filename}`);
      });
      body.appendChild(row);
    }
    // Item #3's real fix: an actual file attachment row, parallel to Résumé —
    // the unconditional text-area fill above (`plan.cover_letter`) stays too,
    // since some ATSes want both.
    if (plan.cover_letter_file && plan.cover_letter_file.available) {
      if (!plan.cover_letter) section('Cover letter');
      const row = document.createElement('div');
      row.className = 'co-row';
      row.dataset.key = 'cover_letter_file';
      row.innerHTML = `
        <span class="co-dot"></span>
        <span class="co-lab">${escHtml(plan.cover_letter_file.filename)}</span>
        <span class="co-val">cover letter PDF</span>
        <button class="co-btn co-att" title="Attach to the form's cover-letter file input">Attach</button>
        <button class="co-btn co-dl" title="Download to this device">⬇</button>`;
      for (const btn of row.querySelectorAll('button')) btn.addEventListener('mousedown', (e) => e.preventDefault());
      row.querySelector('.co-att').addEventListener('click', async () => {
        const r = await getCoverLetterFile();
        if (r) broadcast({ type: 'companion:attachCoverLetter', b64: r.b64, filename: r.filename, mime: r.mime });
      });
      row.querySelector('.co-dl').addEventListener('click', async () => {
        const r = await getCoverLetterFile();
        if (!r) return;
        const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = r.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatusLine(`Downloaded ${r.filename}`);
      });
      body.appendChild(row);
    }
    if (plan.canned && plan.canned.length) {
      const det = document.createElement('details');
      det.className = 'co-det';
      det.innerHTML = '<summary>Self-ID / EEO answers</summary>';
      for (const c of plan.canned) det.appendChild(rowEl(`canned:${c.id}`, c.id.replace(/_/g, ' '), c.answer));
      body.appendChild(det);
    }

    paintStatuses();
  }

  // ── "Generate message" tab ────────────────────────────────────────────────
  // Reads the message on screen (or the selection) plus anything typed below,
  // and asks the server for a friendly reply or first message: a short
  // professional introduction and interest in whatever opportunity was
  // mentioned. The tab is shown to every caller (the panel has no way to know
  // in advance who is signed in), but the route behind it is admin-only today
  // — a guest's Generate press comes back with a clear "admin-only" error
  // rather than a draft, so the copy here stays generic rather than promising
  // what only the fleet owner's own run actually returns (their key + tour
  // link block; see autopilot/lib/fleet-demo.mjs, admin-only in
  // autopilot/server.mjs). Drafted only: Insert puts it in the field the
  // candidate focused, Copy copies. Nothing here clicks Send.
  function showTab(name) {
    activeTab = name;
    root.querySelectorAll('.co-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    const actions = root.getElementById('co-actions');
    if (actions) actions.hidden = name !== 'fill';
    if (name === 'message') renderMessageTab();
    else if (name === 'ai') renderAiTab();
    else renderRows();
  }

  // ── "AI" tab — the ONLY place any inference call can be triggered ─────────
  // (second late clarification, binding): Fill is deterministic-only and is
  // the only tab that auto-runs; every button here costs one model call and
  // says so in its own tooltip, and is disabled with a stated reason when the
  // tier or the daily cap says no — `paintFeatureGates()` (below) is what
  // enforces that at render time, the route-level check is what actually
  // enforces it server-side.
  async function renderAiTab() {
    const body = root.getElementById('co-body');
    body.textContent = '';
    if (!plan) return;
    const wrap = document.createElement('div');
    wrap.className = 'co-ai';
    const lf = plan.usage && plan.usage.live_fills;
    const dr = plan.usage && plan.usage.drafts;
    const tierLine = plan.features && (plan.features.live_fill || plan.features.generate_message) ? 'Paid plan'
      : plan.features ? 'Free plan' : '';
    const lfLine = lf ? `${lf.remaining == null ? 'unlimited' : lf.remaining} live fills left today` : '';
    const drLine = dr ? `${dr.remaining == null ? 'unlimited' : dr.remaining} drafts left today` : '';
    wrap.innerHTML = `
      <div class="co-hint" id="co-ai-status">${escHtml([tierLine, lfLine, drLine].filter(Boolean).join(' · '))}</div>
      <button class="co-btn co-primary" id="co-livefill">✨ Live fill</button>
      <label class="co-check"><input type="checkbox" id="co-live-next"> Also live-fill the next steps of this application (this tab only)</label>
      <div id="co-livefill-results"></div>
      <div class="co-sec">Open questions</div>
      <button class="co-btn" id="co-draftq">Draft open questions</button>
      <div class="co-sec">Single question</div>
      <div class="co-hint">Click into an unanswered question on the page, then Read — or type the question. Drafts come from your CV/profile; review before inserting.</div>
      <div class="co-assist-btns">
        <button class="co-btn" id="co-assist-read" title="Read the question from the focused field">Read focused</button>
        <button class="co-btn" id="co-assist-draft">Draft answer</button>
      </div>
      <textarea id="co-assist-q" rows="2" placeholder="Question"></textarea>
      <textarea id="co-assist-a" rows="5" placeholder="Draft appears here — edit freely" hidden></textarea>
      <div class="co-assist-btns" id="co-assist-out" hidden>
        <button class="co-btn co-primary" id="co-assist-ins">Insert into focused field</button>
        <button class="co-btn" id="co-assist-cp">Copy</button>
      </div>`;
    body.appendChild(wrap);
    for (const btn of wrap.querySelectorAll('button')) btn.addEventListener('mousedown', (e) => e.preventDefault());

    const results = root.getElementById('co-livefill-results');
    const paintLiveFillResults = () => {
      results.textContent = '';
      if (!liveFillRows.length) return;
      const det = document.createElement('details');
      det.open = true;
      det.className = 'co-det';
      det.innerHTML = `<summary>Live fill (${liveFillRows.length})</summary>`;
      for (const r of liveFillRows) {
        const row = document.createElement('div');
        row.className = 'co-row';
        const dot = DOT[r.status] || 'transparent';
        row.innerHTML = `
          <span class="co-dot" style="background:${dot}" title="${escHtml(r.status === 'guessed' ? 'best guess — please verify' : r.status === 'skipped' ? (r.note || 'left for you') : 'filled')}"></span>
          <span class="co-lab" title="${escHtml(r.label)}">${escHtml(r.label.slice(0, 42))}</span>
          <span class="co-val">${escHtml(clean(r.value || '').slice(0, 46))}</span>`;
        det.appendChild(row);
      }
      results.appendChild(det);
    };
    paintLiveFillResults();

    root.getElementById('co-livefill').addEventListener('click', () => fillLive());
    const nextTick = root.getElementById('co-live-next');
    send({ type: 'companion:getLiveFillNextSteps' }).then((r) => { if (r) nextTick.checked = Boolean(r.value); });
    nextTick.addEventListener('change', () => send({ type: 'companion:setLiveFillNextSteps', value: nextTick.checked }));

    root.getElementById('co-draftq').addEventListener('click', () => autoDraftOpenQuestions({ waitMs: 3000 }));

    const q = root.getElementById('co-assist-q');
    const a = root.getElementById('co-assist-a');
    root.getElementById('co-assist-read').addEventListener('click', () => broadcast({ type: 'companion:probeFocused' }));
    root.getElementById('co-assist-draft').addEventListener('click', async () => {
      const question = clean(q.value);
      if (!question) { setStatusLine('Type or Read a question first.', true); return; }
      setStatusLine('Drafting… (local model, can take a minute)');
      const res = await send({
        type: 'companion:getDraft', questions: [question], item: plan.item ? plan.item.id : null, ...draftJobHints(),
      });
      const draft = res && res.ok && res.answers && res.answers[0] && res.answers[0].answer;
      if (draft) {
        a.value = draft;
        a.hidden = false;
        root.getElementById('co-assist-out').hidden = false;
        // Say when the company half of the answer came off the web rather
        // than out of the candidate's own files — it is the half they most
        // need to fact-check before sending.
        const r = res.research;
        setStatusLine(r && r.used
          ? `Draft ready (grounded in web research${r.sources ? `, ${r.sources} source${r.sources > 1 ? 's' : ''}` : ''}${r.cached ? ', cached' : ''}) — check the company details before inserting.`
          : 'Draft ready — review and edit before inserting.');
      } else {
        setStatusLine((res && res.error) || 'No usable draft came back — rephrase and retry.', true);
      }
    });
    root.getElementById('co-assist-ins').addEventListener('click', () => { if (clean(a.value)) insertText(a.value.trim()); });
    root.getElementById('co-assist-cp').addEventListener('click', async () => {
      if (clean(a.value)) setStatusLine((await copyText(a.value.trim())) ? 'Draft copied.' : 'Copy failed', false);
    });

    paintFeatureGates();
    // The admin-only "KB context: on/off" line — sourced from its OWN route
    // (kb-status), never from `plan` itself: the autopilot has no visibility
    // into whether ChunkyLink's AMA index actually exists, so a plan-level
    // flag could only ever mean "this is the admin," never "an index is
    // there." features.generate_message is true only for the admin (a paid
    // guest gets false — fleet-demo keys are the admin's own), so it doubles
    // as the client-side admin signal that gates fetching this at all.
    if (plan.features && plan.features.generate_message) {
      const kb = await send({ type: 'companion:getKbStatus' });
      const statusEl = root.getElementById('co-ai-status');
      if (statusEl && kb) statusEl.textContent += statusEl.textContent ? ` · KB context: ${kb.available ? 'on' : 'off'}` : `KB context: ${kb.available ? 'on' : 'off'}`;
    }
  }

  // Buttons whose availability depends on tier/cap — disabled, never hidden,
  // always with a stated reason (second late clarification: "disabled with a
  // reason when the tier or the daily cap says no").
  function paintFeatureGates() {
    const proc = root.getElementById('co-process');
    if (proc) {
      const allowed = !plan || !plan.features || plan.features.process_page !== false;
      proc.disabled = !allowed;
      proc.title = allowed
        ? 'Evaluate this posting from what is on screen: report, score, tailored CV and cover letter on your server. Stay on the page and the panel attaches the resume and fills the form when it is ready — or close it and check the dashboard.'
        : 'Process this page is a paid-plan feature — ask the admin to upgrade your access.';
    }
    const live = root.getElementById('co-livefill');
    if (live) {
      const allowed = Boolean(plan && plan.features && plan.features.live_fill);
      const remaining = plan && plan.usage && plan.usage.live_fills && plan.usage.live_fills.remaining;
      const capped = allowed && remaining === 0;
      live.disabled = !allowed || capped;
      live.title = !allowed ? 'Live fill is a paid-plan feature — ask the admin to upgrade your tier.'
        : capped ? "Today's live-fill limit reached — resets at midnight."
          : `Reads every open question on this page and fills a best answer using your fleet model — one call for up to 60 questions.${remaining != null ? ` ${remaining} left today.` : ''}`;
    }
    const draft = root.getElementById('co-draftq');
    if (draft) {
      const remaining = plan && plan.usage && plan.usage.drafts && plan.usage.drafts.remaining;
      const capped = remaining === 0;
      draft.disabled = capped;
      draft.title = capped ? "Today's draft limit reached — resets at midnight."
        : `Drafts an answer for every open free-text question — one call for up to 6 questions.${remaining != null ? ` ${remaining} left today.` : ''}`;
    }
  }

  function renderMessageTab() {
    const body = root.getElementById('co-body');
    body.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'co-assist co-msg';
    wrap.innerHTML = `
      <div class="co-hint">Reads the message or posting on this page (select the text first for a precise read), adds anything you type below, and drafts a friendly reply or first message from your CV. Review, then Insert or Copy. It never sends.</div>
      <textarea id="co-msg-ctx" rows="3" placeholder="Optional context — who they are, what you want to say, a role to mention"></textarea>
      <div class="co-assist-btns">
        <button class="co-btn co-primary" id="co-msg-gen">Generate message</button>
        <button class="co-btn" id="co-msg-clear" title="Start over">Clear</button>
      </div>
      <textarea id="co-msg-out" rows="12" placeholder="Your message appears here — edit freely" hidden></textarea>
      <div class="co-assist-btns" id="co-msg-outbtns" hidden>
        <button class="co-btn co-primary" id="co-msg-ins">Insert into focused field</button>
        <button class="co-btn" id="co-msg-cp">Copy</button>
      </div>
      <div class="co-hint" id="co-msg-key"></div>`;
    body.appendChild(wrap);
    const ctx = root.getElementById('co-msg-ctx');
    const out = root.getElementById('co-msg-out');
    const outBtns = root.getElementById('co-msg-outbtns');
    const keyLine = root.getElementById('co-msg-key');
    ctx.value = messageDraft.context;
    ctx.addEventListener('input', () => { messageDraft.context = ctx.value; });
    const paintOut = () => {
      if (messageDraft.out) { out.value = messageDraft.out; out.hidden = false; outBtns.hidden = false; }
      const k = messageDraft.key;
      keyLine.textContent = k
        ? `Key ${k.key_prefix}… · ${k.model_name || k.model || ''} · expires ${k.expires_date || k.expires_at || '?'} · ref ${k.ref || ''}`
        : '';
    };
    paintOut();
    out.addEventListener('input', () => { messageDraft.out = out.value; });
    const gen = root.getElementById('co-msg-gen');
    // mousedown is NOT prevented here on purpose: the candidate's selection
    // must survive the click, and a textarea focus is fine to lose.
    gen.addEventListener('click', async () => {
      gen.disabled = true;
      setStatusLine('Reading the page and drafting… (local model, can take a minute)');
      try {
        const capture = captureMessageContext();
        const res = await send({ type: 'companion:generateMessage', context: clean(ctx.value), capture });
        if (!res || !res.ok || !res.message) {
          setStatusLine((res && res.error) || 'No message came back — add some context and retry.', true);
          return;
        }
        messageDraft = { context: ctx.value, out: res.message, key: res.key ? { ...res.key, ref: res.ref } : null };
        paintOut();
        setStatusLine(`Draft ready (from ${res.used === 'selection' ? 'your selection' : res.used === 'page' ? 'the page' : 'your context'}) — review, then Insert or Copy.`);
      } finally {
        gen.disabled = false;
      }
    });
    root.getElementById('co-msg-clear').addEventListener('click', () => {
      messageDraft = { context: '', out: '', key: null };
      renderMessageTab();
    });
    root.getElementById('co-msg-ins').addEventListener('mousedown', (e) => e.preventDefault());
    root.getElementById('co-msg-ins').addEventListener('click', () => { if (clean(out.value)) insertText(out.value.trim()); });
    root.getElementById('co-msg-cp').addEventListener('click', async () => {
      if (clean(out.value)) setStatusLine((await copyText(out.value.trim())) ? 'Message copied.' : 'Copy failed', false);
    });
  }

  // Item #7's fix: the header is a drag handle (pointer events, clamped to
  // the viewport), the position persisted per-origin through sw.js (content
  // scripts cannot touch chrome.storage directly), and a collapse-to-pill
  // button so the page is never permanently obstructed. `show` (item 6/8's
  // relink path) builds the panel WITHOUT appending it to the page, so a
  // deterministic re-fill on a Continue page the candidate never had open
  // still has somewhere to keep its state, but nothing pops open uninvited.
  function buildPanel({ show = true } = {}) {
    activeTab = 'fill'; // a rebuilt panel always opens on Fill (its markup marks that tab on)
    host = document.createElement('div');
    host.id = 'career-ops-companion-host';
    // Shadow root isolates our styles from the page's (and vice versa).
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
        .co-panel {
          --co-bg: #ffffff; --co-fg: #1a1a1e; --co-dim: #6b6b76; --co-border: #d8d8e0;
          --co-accent: #5b53c7; --co-danger: #c01c28; --co-surface: #f4f4f8;
          position: fixed; top: 12px; right: 12px; width: 344px; max-height: calc(100vh - 24px);
          display: flex; flex-direction: column; z-index: 2147483646;
          background: var(--co-bg); color: var(--co-fg);
          border: 1px solid var(--co-border); border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.25); font-size: 12.5px;
        }
        @media (prefers-color-scheme: dark) {
          .co-panel { --co-bg: #1e1e24; --co-fg: #ececf1; --co-dim: #9a9aa6; --co-border: #3a3a44; --co-surface: #2a2a32; }
        }
        .co-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--co-border);
          cursor: grab; touch-action: none; }
        .co-head strong { flex: 1; font-size: 13px; }
        .co-actions { display: flex; gap: 6px; padding: 8px 12px; }
        .co-status { padding: 0 12px 6px; color: var(--co-dim); min-height: 16px; line-height: 1.35; }
        .co-body { overflow-y: auto; padding: 4px 12px 10px; flex: 1; }
        .co-sec { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--co-dim); margin: 10px 0 4px; }
        .co-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
        .co-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--co-border); flex: none; }
        .co-lab { flex: none; width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .co-val { flex: 1; color: var(--co-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .co-btn { flex: none; border: 1px solid var(--co-border); background: var(--co-surface); color: var(--co-fg);
          border-radius: 6px; padding: 2px 8px; font-size: 11.5px; cursor: pointer; }
        .co-btn:hover { border-color: var(--co-accent); }
        .co-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .co-primary { border-color: #26a269; }
        .co-pick { width: 100%; margin: 6px 0; padding: 4px; background: var(--co-surface); color: var(--co-fg);
          border: 1px solid var(--co-border); border-radius: 6px; }
        .co-det summary { cursor: pointer; color: var(--co-dim); margin: 8px 0 4px; }
        .co-assist textarea, .co-ai textarea { width: 100%; margin-top: 6px; padding: 6px; background: var(--co-surface); color: var(--co-fg);
          border: 1px solid var(--co-border); border-radius: 6px; resize: vertical; font-size: 12px; }
        .co-assist-btns { display: flex; gap: 6px; margin-top: 6px; }
        .co-hint { color: var(--co-dim); line-height: 1.35; margin-top: 4px; }
        .co-foot { padding: 6px 12px 9px; border-top: 1px solid var(--co-border); color: var(--co-dim); font-size: 11px; }
        .co-tabs { display: flex; gap: 0; padding: 0 12px; border-bottom: 1px solid var(--co-border); }
        .co-tab { flex: 1; border: 0; background: transparent; color: var(--co-dim); padding: 7px 4px; font-size: 12px; cursor: pointer;
          border-bottom: 2px solid transparent; }
        .co-tab.on { color: var(--co-fg); border-bottom-color: var(--co-accent); font-weight: 600; }
        .co-msg textarea { min-height: 48px; }
        .co-linked { padding: 6px 12px; background: var(--co-surface); border-bottom: 1px solid var(--co-border); }
        .co-candidates { padding: 2px 0 8px; }
        .co-pick-filter { width: 100%; margin: 4px 0 6px; padding: 5px 7px; background: var(--co-surface); color: var(--co-fg);
          border: 1px solid var(--co-border); border-radius: 6px; font-size: 12px; }
        .co-pick-list { display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto; }
        .co-pick-row { text-align: left; width: 100%; }
        .co-suggest { background: var(--co-surface); border-radius: 6px; padding: 6px 8px; margin-bottom: 6px; }
        .co-check { display: flex; align-items: center; gap: 6px; margin: 8px 0; color: var(--co-dim); font-size: 12px; }
        .co-ai { display: flex; flex-direction: column; }
        .co-ai .co-btn { margin-top: 4px; }
        .co-panel.collapsed { width: 40px; height: 40px; overflow: hidden; border-radius: 50%; }
        .co-panel.collapsed .co-tabs, .co-panel.collapsed .co-linked, .co-panel.collapsed .co-actions,
        .co-panel.collapsed .co-status, .co-panel.collapsed .co-body, .co-panel.collapsed .co-foot { display: none; }
        .co-panel.collapsed .co-head { padding: 0; height: 40px; border: 0; justify-content: center; cursor: pointer; }
        .co-panel.collapsed .co-head strong, .co-panel.collapsed #co-refresh, .co-panel.collapsed #co-close { display: none; }
        .co-panel.collapsed #co-collapse { width: 100%; height: 100%; border: 0; border-radius: 50%; font-size: 16px; }
      </style>
      <div class="co-panel">
        <div class="co-head">
          <strong>⚡ Career-Ops</strong>
          <button class="co-btn" id="co-collapse" title="Collapse to a small pill — the panel keeps working, out of the way">⤢</button>
          <button class="co-btn" id="co-refresh" title="Reload the fill plan">⟳</button>
          <button class="co-btn" id="co-close" title="Close">✕</button>
        </div>
        <div class="co-tabs">
          <button class="co-tab on" data-tab="fill" title="Fill this application form from your pipeline — the only tab that runs by itself">Fill</button>
          <button class="co-tab" data-tab="ai" title="AI-assisted actions — every one is a deliberate click, never automatic">AI</button>
          <button class="co-tab" data-tab="message" title="Draft a reply or first message from your CV">Generate message</button>
        </div>
        <div class="co-linked" id="co-linked" hidden></div>
        <div class="co-actions" id="co-actions">
          <button class="co-btn co-primary" id="co-autofill" title="Fill contact fields and answers, attach the resume and cover letter — whatever fails stays in the list below. Never submits.">⚡ Fill everything</button>
          <button class="co-btn" id="co-process" title="Evaluate this posting from what is on screen: report, score, tailored CV and cover letter on your server. Stay on the page and the panel attaches the resume and fills the form when it is ready — or close it and check the dashboard.">＋ Process this page</button>
        </div>
        <div class="co-status" id="co-status"></div>
        <div class="co-body" id="co-body"></div>
        <div class="co-foot">Never submits — review every field, then click the form's own Submit.</div>
      </div>`;
    root.getElementById('co-close').addEventListener('mousedown', (e) => e.preventDefault());
    root.getElementById('co-close').addEventListener('click', () => closePanel());
    root.getElementById('co-refresh').addEventListener('mousedown', (e) => e.preventDefault());
    root.getElementById('co-refresh').addEventListener('click', () => loadPlan(plan && plan.item ? plan.item.id : null));
    root.getElementById('co-autofill').addEventListener('mousedown', (e) => e.preventDefault());
    root.getElementById('co-autofill').addEventListener('click', () => { if (plan) fillEverything(); });
    root.getElementById('co-process').addEventListener('mousedown', (e) => e.preventDefault());
    root.getElementById('co-process').addEventListener('click', () => processThisPage());
    root.querySelectorAll('.co-tab').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => showTab(b.dataset.tab));
    });

    // ── drag + collapse (item #7) ──────────────────────────────────────────
    const panelEl = root.querySelector('.co-panel');
    const headEl = root.querySelector('.co-head');
    let dragging = null;
    headEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // header buttons stay clickable
      const rect = panelEl.getBoundingClientRect();
      dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      headEl.setPointerCapture(e.pointerId);
    });
    headEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const { top, left } = clampToViewport(e.clientY - dragging.dy, e.clientX - dragging.dx);
      panelEl.style.top = `${top}px`;
      panelEl.style.left = `${left}px`;
      panelEl.style.right = 'auto';
    });
    headEl.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = null;
      const rect = panelEl.getBoundingClientRect();
      send({ type: 'companion:setPanelPos', origin: location.origin, top: rect.top, left: rect.left });
    });
    headEl.addEventListener('dblclick', () => {
      panelEl.style.top = '12px';
      panelEl.style.left = '';
      panelEl.style.right = '12px';
      send({ type: 'companion:resetPanelPos', origin: location.origin });
    });
    root.getElementById('co-collapse').addEventListener('mousedown', (e) => e.preventDefault());
    root.getElementById('co-collapse').addEventListener('click', () => {
      const collapsed = panelEl.classList.toggle('collapsed');
      send({ type: 'companion:setPanelCollapsed', origin: location.origin, collapsed });
    });
    (async () => {
      const posRes = await send({ type: 'companion:getPanelPos', origin: location.origin });
      if (posRes && posRes.pos) {
        const { top, left } = clampToViewport(posRes.pos.top, posRes.pos.left);
        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
      }
      const colRes = await send({ type: 'companion:getPanelCollapsed', origin: location.origin });
      if (colRes && colRes.collapsed) panelEl.classList.add('collapsed');
    })();

    if (show) document.documentElement.appendChild(host);
  }
})();
