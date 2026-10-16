// tests/companion-extension.test.mjs — browser-extension companion guards.
//
// The companion fills real job applications in the candidate's own browser, so
// two classes of bug are unacceptable and both were shipped once already:
//   1. Overwriting an answer the candidate typed themselves. Fills land seconds
//      to minutes after a control was inspected (a draft round-trips through a
//      local model), so "was it empty when we looked?" is not the same question
//      as "is it empty now?".
//   2. Acting inside a frame that is not part of the application. The engine is
//      injected into every frame, and a careers page's third-party support
//      widget can own a file input — an automatic resume upload to a stranger
//      is not recoverable.
//
// No framework and no jsdom, matching the rest of the suite: the guard
// functions are extracted from the SHIPPED source (never a copy) and evaluated
// against hand-built stubs, the same technique tests/edge-worker.test.mjs uses
// to load a Worker without wrangler.
import { pass, fail, warn, ROOT } from './helpers.mjs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ncompanion extension — fill guards and frame trust');

const COMPANION = readFileSync(join(ROOT, 'extension', 'companion.js'), 'utf8');
const SW = readFileSync(join(ROOT, 'extension', 'sw.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));

/** Slice a `function name(...) { ... }` declaration out of source by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in source`);
  // Walk the parameter list out first. A destructured signature —
  // `runFill(plan, { waitMs = 1500, ... })` — puts braces before the body, and
  // counting from the first `{` would "extract" the signature and nothing else.
  let parens = 0;
  let i = source.indexOf('(', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  for (let j = source.indexOf('{', i); j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** Slice a single-line `const name = ...;` declaration out of source. */
function extractConst(source, name) {
  const re = new RegExp(`^\\s*const ${name} = .*;$`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`const ${name} not found in source`);
  return m[0].trim();
}

/**
 * Slice a (possibly multi-line) `const name = <array or object literal>;`
 * out of source by bracket-depth matching — extractConst's single-line regex
 * cannot see past the first newline, which every array/object literal this
 * file needs to extract (US_STATES, SYNONYM_GROUPS, ATS_PACKS) spans.
 */
function extractMultilineConst(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`const ${name} not found in source`);
  let depth = 0;
  let i = start + marker.length;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if ('[{('.includes(c)) depth += 1;
    else if ('}])'.includes(c)) depth -= 1;
    else if (c === ';' && depth <= 0) break;
  }
  return source.slice(start, i + 1);
}

// ── stub DOM ────────────────────────────────────────────────────────────────
// Only what the extracted guards touch: a radio registry for group lookups,
// CSS.escape, and mutable location/IS_TOP bindings.
const harnessSource = `
let IS_TOP = true;
let radios = [];
let hostname = '';
const CSS = { escape: (s) => String(s).replace(/["\\\\]/g, '\\\\$&') };
const location = { get hostname() { return hostname; } };
const document = {
  querySelectorAll(sel) {
    const m = sel.match(/name="(.*)"\\]$/);
    if (!m) return [];
    const want = m[1].replace(/\\\\(.)/g, '$1');
    return radios.filter((r) => r.name === want);
  },
};
export const setEnv = (env) => {
  if ('IS_TOP' in env) IS_TOP = env.IS_TOP;
  if ('radios' in env) radios = env.radios;
  if ('hostname' in env) hostname = env.hostname;
};
${extractConst(COMPANION, 'clean')}
${extractConst(COMPANION, 'registrable')}
${extractConst(COMPANION, 'ATS_HOST_RE')}
${extractConst(COMPANION, 'CONFIRM_RE')}
${extractConst(COMPANION, 'SUBMIT_LABEL_RE')}
${extractFunction(COMPANION, 'alreadyAnswered')}
${extractFunction(COMPANION, 'frameTrusted')}
${extractFunction(COMPANION, 'looksLikeSubmit')}
export { alreadyAnswered, frameTrusted, looksLikeSubmit, ATS_HOST_RE, CONFIRM_RE };
`;

const { setEnv, alreadyAnswered, frameTrusted, looksLikeSubmit, ATS_HOST_RE, CONFIRM_RE } =
  await import(`data:text/javascript;base64,${Buffer.from(harnessSource, 'utf8').toString('base64')}`);

// ── alreadyAnswered: the candidate's own input always wins ──────────────────
{
  const textInput = { tagName: 'INPUT', type: 'text', value: '' };
  ok(alreadyAnswered(textInput) === false, 'alreadyAnswered: empty text input is fillable');
  ok(alreadyAnswered({ ...textInput, value: 'David' }) === true, 'alreadyAnswered: text input the candidate typed into is protected');

  const textarea = { tagName: 'TEXTAREA', value: '' };
  ok(alreadyAnswered(textarea) === false, 'alreadyAnswered: empty textarea is fillable');
  ok(alreadyAnswered({ tagName: 'TEXTAREA', value: 'my own answer' }) === true, 'alreadyAnswered: textarea the candidate typed into is protected');

  // The regression: a rich-text answer box reported "fillable" forever, so a
  // draft returning minutes later select-all-replaced whatever was typed.
  const rich = { tagName: 'DIV', isContentEditable: true, textContent: '' };
  ok(alreadyAnswered(rich) === false, 'alreadyAnswered: empty contenteditable is fillable');
  ok(alreadyAnswered({ ...rich, textContent: 'my own answer' }) === true,
    'alreadyAnswered: contenteditable the candidate typed into is protected (was the shipped bug)');
  ok(alreadyAnswered({ ...rich, textContent: '   \n  ' }) === false,
    'alreadyAnswered: whitespace-only contenteditable still counts as empty');

  const select = { tagName: 'SELECT', selectedIndex: 0, value: '' };
  ok(alreadyAnswered(select) === false, 'alreadyAnswered: select still on its placeholder option is fillable');
  ok(alreadyAnswered({ tagName: 'SELECT', selectedIndex: 2, value: 'yes' }) === true,
    'alreadyAnswered: select the candidate chose is protected');

  ok(alreadyAnswered({ tagName: 'INPUT', type: 'checkbox', checked: false }) === false, 'alreadyAnswered: unchecked checkbox is fillable');
  ok(alreadyAnswered({ tagName: 'INPUT', type: 'checkbox', checked: true }) === true, 'alreadyAnswered: checked checkbox is protected');
}

// ── alreadyAnswered: radio groups answer as a group, not per-button ─────────
{
  const yes = { tagName: 'INPUT', type: 'radio', name: 'sponsorship', checked: false };
  const no = { tagName: 'INPUT', type: 'radio', name: 'sponsorship', checked: false };
  setEnv({ radios: [yes, no] });
  ok(alreadyAnswered(yes) === false, 'alreadyAnswered: untouched radio group is fillable');

  // The candidate picked "no" themselves; a replay must not flip them to "yes".
  no.checked = true;
  ok(alreadyAnswered(yes) === true,
    'alreadyAnswered: radio group answered via a SIBLING is protected (blocks replay flipping the choice)');
  ok(alreadyAnswered(no) === true, 'alreadyAnswered: the checked radio itself is protected');

  const orphan = { tagName: 'INPUT', type: 'radio', name: '', checked: false };
  setEnv({ radios: [] });
  ok(alreadyAnswered(orphan) === false, 'alreadyAnswered: nameless unchecked radio is fillable');
}

// ── frameTrusted: automatic paths stay inside the application ───────────────
{
  setEnv({ IS_TOP: true, hostname: 'anything.example' });
  ok(frameTrusted('anything.example') === true, 'frameTrusted: the top frame is always trusted');

  setEnv({ IS_TOP: false, hostname: 'boards.greenhouse.io' });
  ok(frameTrusted('acme-corp.com') === true, 'frameTrusted: a Greenhouse embed on a company page is trusted');

  setEnv({ IS_TOP: false, hostname: 'jobs.lever.co' });
  ok(frameTrusted('acme-corp.com') === true, 'frameTrusted: a Lever embed is trusted');

  setEnv({ IS_TOP: false, hostname: 'careers.acme-corp.com' });
  ok(frameTrusted('acme-corp.com') === true, 'frameTrusted: a same-domain subframe is trusted');

  // The exfiltration case: a support-chat widget with its own file input.
  setEnv({ IS_TOP: false, hostname: 'widget.intercom.io' });
  ok(frameTrusted('acme-corp.com') === false,
    'frameTrusted: a third-party widget frame is NOT trusted (blocks automatic resume upload to a stranger)');

  setEnv({ IS_TOP: false, hostname: 'www.facebook.com' });
  ok(frameTrusted('acme-corp.com') === false, 'frameTrusted: a tracking-pixel frame is not trusted');

  setEnv({ IS_TOP: false, hostname: 'evil.example' });
  ok(frameTrusted('') === false, 'frameTrusted: an unknown frame with no top host is not trusted');
}

// ── the ATS host list is shared between the two files ───────────────────────
{
  const swList = SW.match(/const ATS_HOST_RE = (\/.*\/i);/);
  const coList = COMPANION.match(/const ATS_HOST_RE = (\/.*\/i);/);
  ok(Boolean(swList && coList) && swList[1] === coList[1],
    'ATS_HOST_RE is identical in sw.js and companion.js (auto-run gate and frame-trust gate agree)');
  for (const host of ['boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'acme.myworkdayjobs.com']) {
    ok(ATS_HOST_RE.test(host), `ATS_HOST_RE matches ${host}`);
  }
  ok(ATS_HOST_RE.test('notgreenhouse.io.evil.com') === false, 'ATS_HOST_RE anchors at the end of the hostname');
}

// ── automatic paths carry the frame-trust scope ─────────────────────────────
{
  // Every broadcast that fills, attaches, or harvests must be scoped unless it
  // is a per-row escape hatch the candidate aimed themselves.
  const scoped = ['companion:runFill', 'companion:collectQuestions', 'companion:fillByLabel', 'companion:harvest', 'companion:applyLiveFill'];
  for (const type of scoped) {
    const sites = [...COMPANION.matchAll(new RegExp(`broadcast\\(\\{ type: '${type}'[^\\n]*`, 'g'))].map((m) => m[0]);
    ok(sites.length > 0 && sites.every((s) => s.includes('autoScope')),
      `${type} is always broadcast with autoScope (${sites.length} call site(s))`);
  }
  const attaches = [...COMPANION.matchAll(/broadcast\(\{ type: 'companion:attachResume'[^\n]*/g)].map((m) => m[0]);
  ok(attaches.length === 3 && attaches.filter((s) => s.includes('autoScope')).length === 2,
    'attachResume: the two automatic call sites are scoped, the manual Attach button stays ungated');
  const coverAttaches = [...COMPANION.matchAll(/broadcast\(\{ type: 'companion:attachCoverLetter'[^\n]*/g)].map((m) => m[0]);
  ok(coverAttaches.length === 3 && coverAttaches.filter((s) => s.includes('autoScope')).length === 2,
    'attachCoverLetter: the same shape as attachResume — two automatic call sites scoped, the manual Attach button ungated');

  ok(/if \(msg\.strict && !frameTrusted\(msg\.topHost\)\) return;/.test(COMPANION),
    'engine honours the strict flag by standing down in untrusted frames');
  ok(/if \(strict && !frameTrusted\(topHost\)\) return results;/.test(COMPANION),
    'runFill returns empty rather than filling an untrusted frame');
}

// ── service-worker state survives an MV3 restart ────────────────────────────
{
  ok(/chrome\.storage\.session/.test(SW),
    'sw.js persists per-tab state in chrome.storage.session (MV3 kills the worker after ~30s idle)');
  ok(/injectedTabs/.test(SW) && !/const injectedTabs = new (Set|Map)\(/.test(SW),
    'injectedTabs is not a bare in-memory Set (a restart would drop late-mounted form iframes)');
  ok(/const autoRan = new Map\(/.test(SW) === false,
    'autoRan is not a bare in-memory Map (a restart would re-fire auto-run over a half-filled form)');

  // The dedup claim has to be synchronous: tabs.onUpdated and
  // onHistoryStateUpdated both fire for one SPA load, and every await between
  // the check and the claim is a window for both to pass it.
  const claim = SW.indexOf('inflight.add(claim)');
  const firstAwait = SW.indexOf('await', SW.indexOf('async function maybeAutoRun'));
  ok(claim > 0 && claim < firstAwait,
    'auto-run claims its dedup key synchronously, before the first await (closes the double-fire race)');
  ok(/if \(!plan \|\| !plan\.ok\) return;/.test(SW),
    'a failed plan fetch is not recorded as auto-run, so a later navigation retries');
}

// ── submission detection: precision over recall ─────────────────────────────
// A false positive here files an application that never went out — the
// candidate stops chasing a role they never applied to. A false negative costs
// one click on the dashboard's "Mark as applied". The asymmetry is the whole
// design, so these tests care far more about what does NOT match.
{
  const confirms = [
    'Thank you for applying to Acme Robotics!',
    'Thanks for applying — we will be in touch.',
    'Your application has been received.',
    'We have received your application.',
    "We've received your application and will review it shortly.",
    'Application submitted',
    'Application Complete',
    'You have successfully applied.',
    'Your application was sent.',
    'Submission successful',
  ];
  for (const text of confirms) {
    ok(CONFIRM_RE.test(text), `CONFIRM_RE accepts a real confirmation: "${text.slice(0, 44)}"`);
  }

  // Every one of these is ordinary copy that sits on an application form — and
  // the poll only runs AFTER a submit click, so a validation failure leaves
  // exactly this text on screen.
  const notConfirms = [
    'Submit your application',
    'Apply now',
    'Complete your application to be considered',
    'Once your application is received we will be in touch',
    'We received your resume',
    'Thank you for your time',
    'Attach your resume to complete this application',
  ];
  for (const text of notConfirms) {
    ok(CONFIRM_RE.test(text) === false, `CONFIRM_RE rejects form copy: "${text.slice(0, 44)}"`);
  }

  const swConfirm = SW.match(/const CONFIRM_RE = (\/.*\/i);/);
  const coConfirm = COMPANION.match(/const CONFIRM_RE = (\/.*\/i);/);
  ok(Boolean(swConfirm && coConfirm) && swConfirm[1] === coConfirm[1],
    'CONFIRM_RE is identical in sw.js and companion.js (in-page watcher and post-navigation probe agree)');

  const urlRe = new RegExp(SW.match(/const CONFIRM_URL_RE = \/(.*)\/i;/)[1], 'i');
  for (const url of ['https://boards.greenhouse.io/acme/jobs/1/confirmation',
    'https://acme.com/careers/thank-you', 'https://acme.com/apply/complete']) {
    ok(urlRe.test(url), `CONFIRM_URL_RE accepts a landing page: ${url.slice(8, 60)}`);
  }
  for (const url of ['https://boards.greenhouse.io/acme/jobs/123/apply',
    'https://jobs.lever.co/acme/abc-123', 'https://acme.com/careers/openings']) {
    ok(urlRe.test(url) === false, `CONFIRM_URL_RE rejects a form URL: ${url.slice(8, 60)}`);
  }
}

// ── submit intent: what counts as the candidate clicking Submit ─────────────
{
  const el = (props) => ({ getAttribute: (k) => (props.attrs || {})[k] ?? null, ...props });
  ok(looksLikeSubmit(el({ tagName: 'INPUT', type: 'submit', value: 'Send' })) === true,
    'looksLikeSubmit: a native submit input counts whatever its label says');
  ok(looksLikeSubmit(el({ tagName: 'BUTTON', textContent: 'Submit Application' })) === true,
    'looksLikeSubmit: a Submit Application button counts');
  ok(looksLikeSubmit(el({ tagName: 'BUTTON', type: 'submit', textContent: 'Send it' })) === true,
    'looksLikeSubmit: a type=submit button counts whatever its label says');
  ok(looksLikeSubmit(el({ tagName: 'DIV', attrs: { role: 'button', 'aria-label': 'Apply now' } })) === true,
    'looksLikeSubmit: an ARIA button labelled Apply now counts');

  ok(looksLikeSubmit(el({ tagName: 'BUTTON', textContent: 'Save draft' })) === false,
    'looksLikeSubmit: Save draft is not a submit');
  ok(looksLikeSubmit(el({ tagName: 'BUTTON', textContent: 'Next' })) === false,
    'looksLikeSubmit: a multi-step Next button is not a submit');
  ok(looksLikeSubmit(el({ tagName: 'A', textContent: 'Submit' })) === false,
    'looksLikeSubmit: a plain link is not a submit control');
  ok(looksLikeSubmit(el({ tagName: 'DIV', id: 'career-ops-companion-host' })) === false,
    "looksLikeSubmit: the panel's own shadow host never counts");
  ok(looksLikeSubmit(null) === false, 'looksLikeSubmit: a click on nothing is not a submit');

  // Intent alone must never be reported as an application. The worker records
  // it and waits; only a confirmation POSTs.
  const intentCase = SW.slice(SW.indexOf("case 'companion:submitIntent'"), SW.indexOf("case 'companion:submitConfirmed'"));
  ok(intentCase.length > 0 && !/\bapi\(/.test(intentCase),
    'a submit intent on its own never calls the server (confirmation is a separate signal)');
  ok(/appliedItems/.test(SW) && /if \(done\[item\]\) \{[^}]*already_reported: true[\s\S]{0,40}\}/.test(SW),
    'a submit is reported once per item (a reloading confirmation page cannot double-post)');
  ok(/pendingSubmit/.test(SW) && /PENDING_TTL_MS/.test(SW),
    'a pending intent expires rather than confirming against an unrelated later page');

  // A submit that was detected and could NOT be recorded used to be dropped on
  // the floor: the pending record was deleted before the POST, so the
  // post-navigation probe returned early forever after, and the only trace was
  // a console.warn in a service worker. That is the "it only sometimes marks
  // them applied" bug — one unreachable moment, one silently lost application.
  const report = extractFunction(SW, 'reportApplied');
  const post = report.indexOf("api('/api/companion/submitted'");
  const clearOnSuccess = report.indexOf('await clearPendingSubmit(tabId);', post);
  ok(post > 0 && clearOnSuccess > post,
    'the pending record is cleared only after the POST lands, so a failed report can still be retried');
  ok(!/^\s*await clearPendingSubmit\(tabId\);\s*$/m.test(report.slice(0, post).split('if (done[item])')[0]),
    'nothing clears the pending record before the POST is attempted');
  ok(/record\.attempts = \(record\.attempts \|\| 0\) \+ 1/.test(report) && /MAX_REPORT_ATTEMPTS/.test(SW),
    'retries are counted and bounded — a server that stays down does not re-POST forever');
  ok(/announceReportFailure\(tabId, error, attempts < MAX_REPORT_ATTEMPTS\)/.test(report),
    'a failed report is announced rather than swallowed');
  ok(/record\.confirmed_evidence = String\(evidence \|\| ''\)/.test(report),
    'a retry reports the confirmation evidence, not the weaker intent evidence it was created with');

  const announce = extractFunction(SW, 'announceReportFailure');
  ok(/setBadgeText\(\{ tabId, text: '!' \}\)/.test(announce) && /color: '#c01c28'/.test(announce),
    'a failed report turns the toolbar badge red instead of leaving the last state on screen');
  ok(/type: 'companion:appliedFailed'/.test(announce),
    'the panel is told the submit was detected but not recorded');
  ok(/panelBus\['companion:appliedFailed'\]/.test(COMPANION),
    'the panel renders that failure (silence there reads as "the detector never fired")');
  ok(/dashboard/i.test(COMPANION.slice(COMPANION.indexOf("panelBus['companion:appliedFailed']"), COMPANION.indexOf("panelBus['companion:resumeAttached']"))),
    'the failure message names the one-click dashboard fallback');
  ok(/setBadgeBackgroundColor\(\{ tabId, color: '#26a269' \}\)/.test(report),
    'a later success clears the red badge rather than leaving the tab looking failed');

  // The second retry trigger must not fire on a bare intent — that is the false
  // Applied the two-signal design exists to prevent.
  const activated = SW.slice(SW.indexOf('chrome.tabs.onActivated.addListener'), SW.indexOf('chrome.tabs.onUpdated.addListener'));
  ok(activated.length > 0, 'returning to the tab is a second retry trigger for a failed report');
  ok(/if \(!record \|\| !record\.attempts\) return;/.test(activated),
    'the retry fires only for a report that already failed, never for an unconfirmed intent');
  ok(/Date\.now\(\) - record\.ts > PENDING_TTL_MS/.test(activated),
    'the retry respects the same expiry as the probe');

  // The watcher observes; it must not participate. No preventDefault (which
  // would break the candidate's own submit), no synthetic clicking.
  const watch = extractFunction(COMPANION, 'armSubmitWatch');
  ok(!/preventDefault|stopPropagation/.test(watch),
    'the submit watcher never cancels the candidate\'s own click');
  ok(!/\.click\s*\(/.test(watch), 'the submit watcher never clicks anything itself');

  // Arming happens behind the same trust gate as filling: a third-party frame
  // is not allowed to report an application on the candidate's behalf.
  const runFill = extractFunction(COMPANION, 'runFill');
  const gate = runFill.indexOf('if (strict && !frameTrusted(topHost)) return results;');
  ok(gate > 0 && runFill.indexOf('armSubmitWatch(') > gate,
    'the submit watcher arms only after the frame-trust gate');
}

// ── "process this page" is fire-and-forget ─────────────────────────────────
// The candidate presses it and closes the tab, so the panel must not make the
// result conditional on the page surviving, and the request must not carry
// anything the server would mistake for a verified role.
{
  ok(/id="co-process"/.test(COMPANION), 'the panel exposes a Process this page button');
  ok(/getElementById\('co-process'\)\.addEventListener\('mousedown'/.test(COMPANION),
    'the Process button suppresses mousedown like every other panel button (never steals field focus)');

  const proc = extractFunction(COMPANION, 'processThisPage');
  ok(/type: 'companion:processPage'/.test(proc), 'the Process button routes through the service worker, not a direct fetch');
  ok(/url: location\.href/.test(proc), 'it sends the page the candidate is actually looking at');
  ok(/close this page/i.test(proc) || /res\.message/.test(proc),
    'the panel reports back that the page can now be closed');

  const swCase = SW.slice(SW.indexOf("case 'companion:processPage'"), SW.indexOf("case 'companion:getRequest'"));
  ok(swCase.includes("/api/companion/process") && swCase.includes("method: 'POST'"),
    'the worker POSTs the request to /api/companion/process with the token attached');

  // The live page is the JD source of last resort: the capture goes along,
  // and a page whose description has not rendered yet is refused rather than
  // shipped as an empty shell.
  ok(/capture,?\s*\n?\s*\}/.test(proc) || /capture:/.test(proc), 'the request carries the page capture');
  ok(/const thin = capture\.text\.length < 400/.test(proc) && !/if \(thin\) return/.test(proc),
    'a thin capture is still sent — the server\'s URL fetcher gets first go and decides');
  const cap = extractFunction(COMPANION, 'capturePage');
  ok(/extractJdText\(\)/.test(cap) && /while \(text\.length < 400/.test(cap),
    'capturePage waits for the SPA to paint the description before reading it');
  ok(/extractVisibleQuestions\(\)/.test(cap), 'capturePage includes the visible form questions');

  // Staying on the page: poll until done, then load THAT item's plan and run
  // the same fill flow the ⚡ button uses (no new attach/fill call sites).
  const watch = extractFunction(COMPANION, 'watchRequest');
  ok(/type: 'companion:getRequest'/.test(watch), 'watchRequest polls through the service worker');
  ok(/loadPlan\(r\.queue_id\)/.test(watch) && /fillEverything\(\{ auto: true \}\)/.test(watch),
    'on done, the panel loads the packaged item by queue id and runs the existing fill flow');
  ok(/r\.status === 'failed'/.test(watch) && /r\.note/.test(watch), 'a failed request surfaces the server note');
  ok(/while \(host && processWatch === id/.test(watch), 'polling stops when the panel is closed or superseded');
  const swGet = SW.slice(SW.indexOf("case 'companion:getRequest'"), SW.indexOf("case 'companion:submitIntent'"));
  ok(swGet.includes('/api/companion/request?id='), 'the worker fetches one request by id');
}

// ── extractVisibleQuestions applies the same sensitive-field gate as capture ─
// extension-privacy.md §3 says the companion "deliberately skips password
// fields" and a set of sensitive topics. collectFinalValues() and harvestForm()
// both gate every control through isSensitive() before reading it; capturePage()
// -> extractVisibleQuestions() (the "Process this page" path) did not, so a
// password input's LABEL text (never its value, but still not nothing) rode
// along in the up-to-40 "questions" sent to the server. Drive the real,
// shipped function against stand-in elements the same way the harness above
// does for alreadyAnswered/frameTrusted.
{
  const evqSource = `
let ELEMENTS = [];
const document = {
  querySelectorAll: () => ELEMENTS,
  getElementById: () => null,
};
const CSS = { escape: (s) => String(s).replace(/["\\\\]/g, '\\\\$&') };
export const setElements = (els) => { ELEMENTS = els; };
${extractConst(COMPANION, 'clean')}
${extractConst(COMPANION, 'visible')}
${extractMultilineConst(COMPANION, 'isComboLike')}
${extractMultilineConst(COMPANION, 'SENSITIVE_RE')}
${extractConst(COMPANION, 'SENSITIVE_AUTOCOMPLETE_RE')}
${extractFunction(COMPANION, 'labelFor')}
${extractFunction(COMPANION, 'isSensitive')}
${extractMultilineConst(COMPANION, 'collectControls')}
${extractFunction(COMPANION, 'extractVisibleQuestions')}
export { extractVisibleQuestions };
`;
  const { setElements, extractVisibleQuestions: extractQuestions } =
    await import(`data:text/javascript;base64,${Buffer.from(evqSource, 'utf8').toString('base64')}`);

  const el = (props) => ({
    tagName: 'INPUT',
    type: 'text',
    labels: [],
    offsetParent: {},
    disabled: false,
    getAttribute: () => null,
    closest: () => null,
    ...props,
  });

  const passwordField = el({ type: 'password', labels: [{ textContent: 'Create a password to track your application' }] });
  const otpField = el({
    labels: [{ textContent: 'Verification code' }],
    getAttribute: (k) => (k === 'autocomplete' ? 'one-time-code' : null),
  });
  const ordinary = el({ labels: [{ textContent: 'What is your notice period?' }] });

  setElements([passwordField, otpField, ordinary]);
  const questions = extractQuestions();
  ok(questions.length === 1 && questions[0].label === 'What is your notice period?',
    'extractVisibleQuestions skips a password input and an autocomplete="one-time-code" field, keeping only the ordinary question (extension-privacy.md §3 gap)');
}

// ── Workday actuation ──────────────────────────────────────────────────────
// Workday's React fields ignore a native-setter value (modes/apply.md), and
// its dropdowns are <button aria-haspopup="listbox">, not <select>. Both are
// handled without a new permission and without touching other hosts.
{
  ok(/const IS_WORKDAY = \/myworkdayjobs\\\.com\$\/i\.test\(location\.hostname\)/.test(COMPANION),
    'Workday actuation is gated on the page host');
  const fill = extractFunction(COMPANION, 'fillControl');
  ok(/if \(IS_WORKDAY && \/\^\(INPUT\|TEXTAREA\)\$\/\.test\(el\.tagName\)\) return typeInto\(el, value\);/.test(fill),
    'fillControl types into Workday text fields instead of setting the value');
  ok(/isComboLike\(el\) \|\| el\.tagName === 'BUTTON'/.test(fill),
    'fillControl refuses buttons/dropdown triggers (they go through fillCombobox)');
  const type = extractFunction(COMPANION, 'typeInto');
  ok(/execCommand\('insertText'/.test(type) && /setNativeValue\(el, String\(value\)\)/.test(type),
    'typeInto uses the browser input pipeline (insertText) and falls back to the native setter');
  ok(/const collectControls = \(\) => \[\.\.\.document\.querySelectorAll\('[^']*button\[aria-haspopup="listbox"\][^']*'\)\]/.test(COMPANION),
    'listbox buttons are part of the fillable-control set');
  const combo = extractFunction(COMPANION, 'fillCombobox');
  ok(/clean\(o\.textContent\)\.toLowerCase\(\) === target/.test(combo), 'dropdown options are matched by text, never by position');
  ok(/if \(input\.tagName === 'INPUT'\) setNativeValue/.test(combo), 'fillCombobox never sets a value on a button trigger');
}

// ── the hard invariant: it never submits ───────────────────────────────────
{
  const submitCalls = [...COMPANION.matchAll(/\.submit\s*\(|requestSubmit\s*\(/g)];
  ok(submitCalls.length === 0, 'companion.js contains no form-submit call (the project-wide never-submit rule)');
  ok(/\/\^\(file\|submit\|button\|image\|reset\|hidden\)\$\//.test(COMPANION.replace(/\\/g, '\\')) || /submit\|button\|image\|reset\|hidden/.test(COMPANION),
    'submit/button inputs are excluded from the fillable-control set');
  ok(MANIFEST.permissions.includes('webNavigation'),
    'manifest declares webNavigation (auto-run and late-frame injection depend on it)');
  ok(!MANIFEST.permissions.includes('tabs'),
    'manifest does not request the broad tabs permission');
}

// ── the extension has a real icon, not Chrome's generic default ────────────
// (This is the manifest wiring that makes chrome://extensions and the
// toolbar button actually use what make-icon.mjs renders, rather than
// Chrome's generic default — and, below, that the files those paths name
// actually exist and are real PNGs. A manifest that references
// icons/icon-48.png with no such file anywhere breaks `Load unpacked` outright
// — Chrome refuses to load the extension at all — and nothing short of
// reading the file catches that: a string comparison against the manifest
// alone would stay green even with the icons directory deleted, which is
// exactly what shipped for a while: extension/icons/*.png were new,
// untracked files, so `git ls-files`-driven export builds silently omitted
// them while every existing check kept reporting success.)
//
// This file is copied verbatim into the exported dist/public tree (see
// deploy/public/career-autopilot.yml), so the check below runs there too —
// deliberately: it is the public repo's OWN test.yml catching the exact same
// class of bug for anyone who clones it. But `scripts/system/export-public.mjs`
// only ever copies `git ls-files`-tracked paths, so a checkout where the PNGs
// exist on disk but were never `git add`-ed builds an export that is missing
// them — that specific "not yet committed" gap already gets its own dedicated
// missing/untracked signal and a hard CI-blocking failure from
// `checkManifestAssets()` in scripts/system/export-public.mjs (see
// tests/public-export.test.mjs), so it is not re-asserted as a hard failure
// here too — `deploy/` only ever exists in the private checkout (never
// exported), which is what tells the two situations apart.
const IN_PRIVATE_REPO = existsSync(join(ROOT, 'deploy'));
{
  ok(/^\d+\.\d+\.\d+$/.test(MANIFEST.version), `manifest version is well-formed semver (${MANIFEST.version})`);
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const size of ['16', '32', '48', '128']) {
    ok(MANIFEST.icons?.[size] === `icons/icon-${size}.png`,
      `manifest.icons["${size}"] points at icons/icon-${size}.png`);
    ok(MANIFEST.action?.default_icon?.[size] === `icons/icon-${size}.png`,
      `manifest.action.default_icon["${size}"] does too — the toolbar button, not just chrome://extensions`);
    const pngPath = join(ROOT, 'extension', 'icons', `icon-${size}.png`);
    if (!existsSync(pngPath)) {
      const msg = `extension/icons/icon-${size}.png does not exist — the manifest references it, but Load unpacked (or this export) has nothing to show`;
      if (IN_PRIVATE_REPO) fail(msg); else warn(msg);
    } else {
      const png = readFileSync(pngPath);
      ok(png.length > 50 && png.subarray(0, 8).equals(PNG_SIGNATURE),
        `extension/icons/icon-${size}.png exists and is a real PNG (${png.length} bytes)`);
    }
  }
}

// ── "Generate message" tab ─────────────────────────────────────────────────
{
  ok(/data-tab="message"/.test(COMPANION) && /data-tab="fill"/.test(COMPANION),
    'the panel has Fill and Generate-message tabs');
  ok(/function renderMessageTab\(\)/.test(COMPANION) && /id="co-msg-gen"/.test(COMPANION) && /id="co-msg-out"/.test(COMPANION),
    'the message tab renders its own context/output controls');
  ok(/if \(activeTab !== 'fill'\) return;/.test(extractFunction(COMPANION, 'renderRows')),
    'renderRows leaves the body alone while the message tab is showing');
  const cap = extractFunction(COMPANION, 'captureMessageContext');
  ok(/getSelection\(\)/.test(cap) && /extractMessageText\(\)/.test(cap),
    'captureMessageContext prefers the selection and falls back to the messaging surface');
  ok(/selection \? '' : extractMessageText\(\)/.test(cap), 'a selection suppresses the page-wide read');
  const tab = extractFunction(COMPANION, 'renderMessageTab');
  ok(/type: 'companion:generateMessage'/.test(tab) && /captureMessageContext\(\)/.test(tab),
    'Generate sends the capture + context to the service worker');
  ok(/insertText\(out\.value\.trim\(\)\)/.test(tab) && /copyText\(out\.value\.trim\(\)\)/.test(tab),
    'the draft is inserted into the focused field or copied — never sent');
  ok(!/\.click\(\)/.test(tab) && !/submit/i.test(tab.replace(/never sends|clicks Send/gi, '')),
    'the message tab clicks nothing on the page');
  ok(/case 'companion:generateMessage':[\s\S]*?api\('\/api\/companion\/generate-message'/.test(SW),
    'sw.js routes generateMessage to POST /api/companion/generate-message');
  ok(/MESSAGE_MAX = 8000/.test(COMPANION), 'message capture is bounded');
}

// ── field memory: harvesting is gated harder than filling ──────────────────
// These are safety invariants, not behaviour: capture reads the candidate's
// real address and phone off arbitrary pages, so each gate is asserted
// structurally rather than trusted to survive a future edit.
{
  const capture = extractFunction(COMPANION, 'frameTrustedForCapture');
  const fill = extractFunction(COMPANION, 'frameTrusted');
  ok(/ATS_HOST_RE/.test(fill), 'frameTrusted still trusts a known ATS host on its own (unchanged fill behaviour)');
  ok(!/ATS_HOST_RE/.test(capture),
    'frameTrustedForCapture is strictly narrower than frameTrusted — an ATS-hosted widget under an unknown top page may be filled, never harvested');
  ok(/registrable\(location\.hostname\) === registrable\(topHost\)/.test(capture),
    'capture trust requires the frame to be the same site as the top page');

  const collect = extractFunction(COMPANION, 'collectFinalValues');
  ok(/isSensitive\(el\)/.test(collect) && /ownedByApplicant\(el\)/.test(collect),
    'collectFinalValues refuses sensitive controls and anything belonging to a third party (emergency contact, reference)');
  ok(/const key = canonicalize\(label\);\s*\n\s*if \(!key/.test(collect),
    'collectFinalValues drops a control whose label does not canonicalize BEFORE reading its value — the allowlist is the gate, not a filter applied afterwards');

  const send = extractFunction(COMPANION, 'sendObservations');
  const gateAt = send.indexOf('learnFields');
  const readAt = send.indexOf('collectFinalValues');
  ok(gateAt > -1 && readAt > -1 && gateAt < readAt,
    'sendObservations checks the learnFields opt-in BEFORE it reads any values — opting out means the DOM is never inspected, not that it is inspected and discarded');
  ok(/observedThisSubmit/.test(send), 'observations are sent once per submit, not once per submit-looking click');

  for (const name of ['collectFinalValues', 'sendObservations', 'readControlValue', 'isSensitive', 'ownedByApplicant', 'frameTrustedForCapture']) {
    const body = extractFunction(COMPANION, name);
    ok(body.length > 0, `${name}() exists in companion.js`);
    ok(!/\.submit\s*\(|requestSubmit\s*\(|\.click\s*\(/.test(body),
      `${name}() observes only — no submit or click`);
  }
}

// ── the extension configures itself from the setup file ────────────────────
// The server URL and token used to be pushed into one profile's storage over
// CDP by setup, which only worked when the extension had been loaded from
// exactly that checkout and a debug instance could start — otherwise the
// panel said "not configured — set the server URL and token in the extension
// options", on two machines. The worker now imports companion.local.json from
// its own directory. The regexes pin the wiring; the stubbed chrome.storage
// and fetch below drive the shipped import logic itself.
{
  const OPTIONS_JS = readFileSync(join(ROOT, 'extension', 'options.js'), 'utf8');
  const OPTIONS_HTML = readFileSync(join(ROOT, 'extension', 'options.html'), 'utf8');

  ok(/const BUNDLED_CONFIG = 'companion\.local\.json';/.test(SW) && /chrome\.runtime\.getURL\(BUNDLED_CONFIG\)/.test(SW),
    'sw.js reads companion.local.json from its own directory through chrome.runtime.getURL()');
  ok(!MANIFEST.web_accessible_resources,
    'the manifest exposes no web-accessible resources — a web page cannot fetch the config file');
  ok(/^importBundledConfig\(\)\.catch/m.test(SW), 'the import runs at every worker start');
  ok(/chrome\.runtime\.onStartup\.addListener\(\(\) => \{ importBundledConfig\(\)/.test(SW)
    && /chrome\.runtime\.onInstalled\.addListener\(\(\) => \{ importBundledConfig\(\)/.test(SW),
    'and on onStartup / onInstalled, so a new browser session or a reload picks the file up even if nothing else wakes the worker');
  const api = extractFunction(SW, 'api');
  ok(/if \(!baseUrl \|\| !token\) \{[\s\S]{0,300}importBundledConfig\(\)/.test(api),
    'api() imports the file before giving up on an empty storage');
  ok(/res\.status === 401 && !retried && \(await importBundledConfig\(\{ rejected: true \}\)\)\.imported/.test(api)
    && /retried: true/.test(api),
    'a 401 re-imports a file that moved on (setup --recheck after a rotation) and retries exactly once');
  ok(/NOT_CONFIGURED = 'not configured — run the companion setup/.test(SW) && /setup-companion\.mjs/.test(SW),
    'the not-configured message names the setup script and the checkout it has to run in');
  ok(/case 'companion:importConfig'/.test(SW) && /tokenLength: \(cfg\.token \|\| ''\)\.length/.test(SW),
    'the worker answers companion:importConfig with the token\'s length, never the token');
  ok(/type: 'companion:importConfig', force: true/.test(OPTIONS_JS) && /id="reload"/.test(OPTIONS_HTML),
    'the options page has a "Reload from setup file" button that makes the file win');

  // Drive the shipped import logic against a stubbed chrome.storage and fetch.
  const withAsync = (name) => {
    const fn = extractFunction(SW, name);
    return SW.includes(`async function ${name}(`) ? `async ${fn}` : fn;
  };
  const src = [
    extractConst(SW, 'BUNDLED_CONFIG'),
    extractConst(SW, 'normalizeUrl'),
    withAsync('readBundledConfig'),
    withAsync('fingerprint'),
    withAsync('importBundledConfig'),
  ].join('\n');
  const load = (chrome, fetch) => new Function('chrome', 'fetch', `${src}\nreturn { importBundledConfig, fingerprint };`)(chrome, fetch);
  const stubChrome = (initial = {}) => {
    const store = { ...initial };
    const chrome = {
      runtime: { getURL: (p) => `chrome-extension://stub/${p}` },
      storage: { local: {
        get: async (defaults) => Object.fromEntries(Object.keys(defaults).map((k) => [k, k in store ? store[k] : defaults[k]])),
        set: async (values) => { Object.assign(store, values); },
      } },
    };
    return { chrome, store };
  };
  const fileFetch = (file) => async () => (file
    ? { ok: true, json: async () => file }
    : { ok: false, json: async () => { throw new Error('404'); } });
  const HEX64 = /^[0-9a-f]{64}$/;

  await (async () => {
    // No file: nothing happens, storage is untouched.
    {
      const { chrome, store } = stubChrome();
      const r = await load(chrome, fileFetch(null)).importBundledConfig();
      ok(r.file === false && r.imported === false && Object.keys(store).length === 0,
        'no setup file → nothing imported, storage untouched (the panel then names setup)');
    }
    // A fresh profile: the file fills storage, normalised, with a record of which file.
    {
      const { chrome, store } = stubChrome();
      const worker = load(chrome, fileFetch({ baseUrl: 'http://s:8377/', token: ' t-one ' }));
      const r = await worker.importBundledConfig();
      ok(r.imported === true && store.baseUrl === 'http://s:8377' && store.token === 't-one',
        'a fresh profile imports the file into storage, normalised like the options page would');
      ok(HEX64.test(store.bundledFingerprint) && store.bundledFingerprint === await worker.fingerprint('http://s:8377', 't-one'),
        'and records the fingerprint of what it imported');
      ok((await worker.importBundledConfig()).imported === false, 'importing the same file again changes nothing');

      // An override typed on the options page survives worker restarts...
      store.baseUrl = 'http://elsewhere';
      store.token = 'typed';
      ok((await worker.importBundledConfig()).imported === false && store.token === 'typed',
        'a value saved on the options page survives a worker restart (same file → storage left alone)');
      // ...but a rotated file wins.
      const rotated = load(chrome, fileFetch({ baseUrl: 'http://s:8377', token: 't-two' }));
      ok((await rotated.importBundledConfig()).imported === true && store.token === 't-two' && store.baseUrl === 'http://s:8377',
        'a changed file (rotated token) is imported over the override — setup is the source of truth when it moves');
      store.token = 'typed-again';
      ok((await rotated.importBundledConfig({ force: true })).imported === true && store.token === 't-two',
        '"Reload from setup file" (force) makes the file win over anything');
    }
    // A profile configured the old way, with no import record.
    {
      const { chrome, store } = stubChrome({ baseUrl: 'http://s:8377', token: 't-one' });
      const worker = load(chrome, fileFetch({ baseUrl: 'http://s:8377', token: 't-one' }));
      ok((await worker.importBundledConfig()).imported === false && HEX64.test(store.bundledFingerprint),
        'a profile already holding the file\'s values gets the import record without a rewrite');
    }
    {
      const { chrome, store } = stubChrome({ baseUrl: 'http://s:8377', token: 'stale-seeded' });
      const worker = load(chrome, fileFetch({ baseUrl: 'http://s:8377', token: 't-new' }));
      ok((await worker.importBundledConfig()).imported === false && store.token === 'stale-seeded',
        'values with no import record are not clobbered on a plain start (they may have been typed on purpose)');
      ok((await worker.importBundledConfig({ rejected: true })).imported === true && store.token === 't-new',
        'but a 401 from the server makes the file take over');
    }
    // A file with no token, or not JSON, is no file.
    {
      const { chrome, store } = stubChrome();
      ok((await load(chrome, fileFetch({ baseUrl: 'http://s' })).importBundledConfig()).file === false && !store.baseUrl,
        'a file missing the token counts as no file');
      ok((await load(chrome, async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })).importBundledConfig()).file === false,
        'a corrupt file counts as no file, never throws');
    }
  })();
}

// ── best-guess selection: pickOption + labelMatcher + diceCoefficient ──────
// (items #1/#2 — the companion overhaul.) Pure functions, no DOM needed.
{
  const pureSource = `
${extractConst(COMPANION, 'clean')}
${extractConst(COMPANION, 'escRe')}
${extractFunction(COMPANION, 'diceCoefficient')}
${extractMultilineConst(COMPANION, 'US_STATES')}
${extractMultilineConst(COMPANION, 'SYNONYM_GROUPS')}
${extractFunction(COMPANION, 'pickOption')}
${extractFunction(COMPANION, 'labelMatcher')}
export { pickOption, labelMatcher, diceCoefficient };
`;
  const { pickOption, labelMatcher, diceCoefficient } =
    await import(`data:text/javascript;base64,${Buffer.from(pureSource, 'utf8').toString('base64')}`);

  // rung 1: exact (case/whitespace-insensitive)
  ok(pickOption(['Yes', 'No'], 'yes').value === 'Yes' && pickOption(['Yes', 'No'], 'yes').exact === true,
    'pickOption: exact case-insensitive match');
  // rung 2: normalized equality after stripping punctuation/parentheticals
  ok(pickOption(['Bachelors degree'], "Bachelor's Degree").exact === true,
    'pickOption: punctuation-stripped equality counts as exact');
  ok(pickOption(['Male (M)'], 'Male').value === 'Male (M)' && pickOption(['Male (M)'], 'Male').exact === true,
    'pickOption: a parenthetical on the OPTION side is stripped before comparing');
  // rung 3: synonym groups
  {
    const r = pickOption(['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran'], 'No');
    ok(r && r.value === 'I am not a protected veteran' && r.exact === false,
      'pickOption: CC-305 veteran-status synonym group resolves a bare "No" to the full legal phrasing, flagged non-exact');
  }
  {
    const r = pickOption(['Yes, I have a disability', 'No, I do not have a disability'], 'No');
    ok(r && r.value === 'No, I do not have a disability' && r.exact === false,
      'pickOption: CC-305 disability-status synonym group');
  }
  ok(pickOption(['Colorado', 'California'], 'CO').value === 'Colorado',
    'pickOption: a US state ABBREVIATION resolves to its full option-list name via the synonym table');
  ok(pickOption(['United States', 'Canada'], 'USA').value === 'United States',
    'pickOption: country synonym group (USA -> United States)');
  // rung 4: Dice coefficient >= 0.5
  {
    const r = pickOption(['Senior Software Engineer', 'Junior Analyst'], 'Sr. Software Engineer');
    ok(r && r.value === 'Senior Software Engineer' && r.exact === false,
      'pickOption: a close-but-not-exact title resolves via Dice similarity, flagged non-exact');
  }
  ok(pickOption(['Apples', 'Oranges'], 'Bicycle') === null,
    'pickOption: nothing close enough on any rung -> null (never a wild guess)');
  // rung 5: "how did you hear" ranked default — gated on the QUESTION text
  {
    const opts = ['Employee Referral', 'LinkedIn', 'Indeed', 'Other'];
    const r = pickOption(opts, 'Word of mouth', { question: 'How did you hear about us?' });
    ok(r && r.value === 'LinkedIn' && r.exact === false,
      'pickOption: an unrecognisable how-heard answer falls back to the ranked default (LinkedIn first)');
    ok(pickOption(opts, 'Word of mouth', { question: 'What is your favorite color?' }) === null,
      'pickOption: the ranked-default rung ONLY fires for a how-did-you-hear-shaped question — never a general fallback');
  }
  ok(pickOption([], 'Yes') === null, 'pickOption: no options -> null');
  ok(pickOption(['Yes'], null) === null, 'pickOption: no answer -> null');

  ok(diceCoefficient('night', 'nacht') < 0.3 && diceCoefficient('same', 'same') === 1,
    'diceCoefficient: identical strings score 1, dissimilar strings score low');

  // labelMatcher: \b-anchored — the §5.1b fix for the real, shipped
  // findByLabel/canned-loop regex-building bug (bare 'city'/'state'/'race'
  // matching as a SUBSTRING inside "capacity"/"statement"/"embrace"). Every
  // fixture below is chosen so the target word is genuinely absent as its
  // own token — "race condition" is deliberately NOT here: it contains
  // "race" as a real standalone word, so \b-anchored matching is SUPPOSED
  // to fire on it (the correct, safer direction), not a counterexample.
  const adversarial = [
    ['city', 'capacity constraints apply'],
    ['state', 'please read this statement'],
    ['state', 'United States of America'],
    ['race', 'please embrace our values'],
    ['ethnicity', 'velocity of delivery'],
  ];
  for (const [word, text] of adversarial) {
    ok(labelMatcher([word]).test(text) === false,
      `labelMatcher(['${word}']) does not fire on unrelated text containing it as a substring: "${text}"`);
  }
  ok(labelMatcher(['city']).test('City') === true, 'labelMatcher: still matches the real word it was built for');
  ok(labelMatcher(['race', 'ethnicity']).test('Race / Ethnicity') === true,
    'labelMatcher: still matches a real multi-word label');
  ok(labelMatcher(['race']).test('a race condition in the scheduler') === true,
    'labelMatcher: correctly DOES match when the word is a genuine standalone token, even in an unrelated sentence (word-boundary anchoring is not a blacklist of contexts)');
}

// ── findByLabel adopts labelMatcher (the fix applied to EXISTING code) ─────
{
  const findByLabelSrc = extractFunction(COMPANION, 'findByLabel');
  ok(/labelMatcher\(\[pattern\]\)/.test(findByLabelSrc),
    'findByLabel builds its single-key regex through labelMatcher, not a bare new RegExp(escRe(...))');
  ok(!/new RegExp\(escRe\(pattern\)/.test(findByLabelSrc),
    'findByLabel no longer builds an unanchored regex from a plain key string');
  const cannedLoop = COMPANION.slice(COMPANION.indexOf('for (const canned of plan.canned'), COMPANION.indexOf('return results;\n  }'));
  ok(/labelMatcher\(canned\.match/.test(cannedLoop),
    'the canned loop builds its regex through labelMatcher too (was a bare alternation with no word boundaries)');
}

// ── item #4: home-address vs work-location guards, mirrored byte-for-byte ──
// The byte-parity-against-the-REAL-autopilot-export half only runs inside
// the private repo: the public export (deploy/public/career-autopilot.yml)
// ships this file standalone with extension/ + a handful of lib/ helpers —
// autopilot/lib/{field-taxonomy,profile-questions}.mjs is never part of that
// payload, so importing it here would crash the exported copy outright
// (ERR_MODULE_NOT_FOUND), the same reason the icon-file check a few blocks up
// downgrades to a warning rather than a hard import. The structural checks
// (the guard is actually wired into runFill, not just present as dead code)
// still run everywhere — they read companion.js alone.
{
  if (IN_PRIVATE_REPO) {
    const taxonomy = await import(pathToFileURL(join(ROOT, 'autopilot', 'lib', 'field-taxonomy.mjs')).href);
    const profileQuestions = await import(pathToFileURL(join(ROOT, 'autopilot', 'lib', 'profile-questions.mjs')).href);

    const coHomeIds = JSON.parse(COMPANION.match(/const HOME_ADDRESS_IDS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
    ok(JSON.stringify(coHomeIds) === JSON.stringify(taxonomy.HOME_ADDRESS_IDS),
      'companion.js mirror: HOME_ADDRESS_IDS is byte-identical to field-taxonomy.mjs\'s real export');

    const coWorkLocRe = COMPANION.match(/const WORK_LOCATION_LABEL_RE = (\/.*\/i);/)[1];
    ok(coWorkLocRe === `/${taxonomy.WORK_LOCATION_LABEL_RE.source}/${taxonomy.WORK_LOCATION_LABEL_RE.flags}`,
      'companion.js mirror: WORK_LOCATION_LABEL_RE is byte-identical to field-taxonomy.mjs\'s real export');

    const coSensitiveRe = COMPANION.match(/const SENSITIVE_QUESTION_LABEL_RE = (\/.*\/i);/)[1];
    ok(coSensitiveRe === `/${profileQuestions.SENSITIVE_QUESTION_LABEL_RE.source}/${profileQuestions.SENSITIVE_QUESTION_LABEL_RE.flags}`,
      'companion.js mirror: SENSITIVE_QUESTION_LABEL_RE is byte-identical to profile-questions.mjs\'s real export (regenerate the literal in companion.js whenever the catalog\'s sensitive:true set changes)');
  } else {
    warn('not in the private repo (autopilot/lib/field-taxonomy.mjs and profile-questions.mjs are not part of the public export) — HOME_ADDRESS_IDS/WORK_LOCATION_LABEL_RE/SENSITIVE_QUESTION_LABEL_RE byte-parity skipped; tests/companion-field-memory.test.mjs (private-repo-only) covers the same parity');
  }

  // The guard is actually WIRED into the fields/learned loops, not just
  // present as an unused constant — this half needs only companion.js, so it
  // runs in every context, exported or not.
  ok(/const excludeRe = HOME_ADDRESS_IDS\.includes\(field\.id\) \? WORK_LOCATION_LABEL_RE : null;/.test(COMPANION),
    'runFill\'s fields loop excludes work-location-labeled controls from a home-address field\'s fallback match');
  ok(/const excludeRe = HOME_ADDRESS_IDS\.includes\(entry\.key\) \? WORK_LOCATION_LABEL_RE : null;/.test(COMPANION),
    'runFill\'s learned-fields loop applies the identical guard');
}

// ── item #3: cover-letter attachment never fights the resume input ────────
{
  const findCoverSrc = extractFunction(COMPANION, 'findCoverLetterInput');
  const findResumeRawSrc = extractFunction(COMPANION, 'findResumeInputRaw');
  const findResumeSrc = extractFunction(COMPANION, 'findResumeInput');
  ok(/COVER_LETTER_RE/.test(findCoverSrc), 'findCoverLetterInput scans label/accept/nearby text for cover-letter phrasing');
  ok(/findResumeInputRaw\(\)/.test(findCoverSrc),
    'findCoverLetterInput\'s positional rung compares against the raw resume lookup, not a mutually-recursive call to findResumeInput');
  ok(/const cover = findCoverLetterInput\(\);/.test(findResumeSrc) && /el !== cover/.test(findResumeSrc),
    'findResumeInput excludes whatever findCoverLetterInput claims');
  ok(findResumeRawSrc.length > 0, 'findResumeInputRaw (the lookup without the cover-letter exclusion, kept private) still exists');
  ok(!/accept\*=/.test(extractMultilineConst(COMPANION, 'ATS_PACKS')),
    'no ATS pack resolves the resume by a bare accept= match — it matched Ashby\'s "Autofill from resume" parser box first');

  // Drive the real functions against a minimal stub DOM. `#id` and
  // `input[name="…"]` are all the ATS packs' resume selectors need.
  const domSource = `
let hostname = 'careers.example.com';
const location = { get hostname() { return hostname; } };
const CSS = { escape: (s) => String(s).replace(/["\\\\]/g, '\\\\$&') };
let fileInputs = [];
const document = {
  querySelectorAll(sel) { return sel === 'input[type="file"]' ? fileInputs : []; },
  querySelector(sel) {
    if (sel === 'input[type="file"]') return fileInputs[0] || null;
    let m = sel.match(/^#([\\w-]+)$/);
    if (m) return fileInputs.find((el) => el.id === m[1]) || null;
    m = sel.match(/^input\\[name="([^"]+)"\\]$/);
    if (m) return fileInputs.find((el) => el.name === m[1]) || null;
    return null;
  },
};
export const setFiles = (list, host = 'careers.example.com') => { fileInputs = list; hostname = host; };
${extractConst(COMPANION, 'clean')}
${extractFunction(COMPANION, 'labelFor')}
const visible = (el) => el && el.offsetParent !== null && !el.disabled;
${extractMultilineConst(COMPANION, 'ATS_PACKS')}
${extractConst(COMPANION, 'atsPack')}
${extractConst(COMPANION, 'AUTOFILL_INPUT_RE')}
${extractFunction(COMPANION, 'fileInputContext')}
${extractFunction(COMPANION, 'isAutofillFileInput')}
${extractFunction(COMPANION, 'realFileInputs')}
${extractFunction(COMPANION, 'ownLabel')}
${extractConst(COMPANION, 'COVER_LETTER_RE')}
${extractConst(COMPANION, 'OTHER_DOCUMENT_RE')}
${extractFunction(COMPANION, 'findCoverLetterInput')}
${extractFunction(COMPANION, 'findResumeInputRaw')}
${extractFunction(COMPANION, 'findResumeInput')}
export { findCoverLetterInput, findResumeInput, isAutofillFileInput };
`;
  const { setFiles, findCoverLetterInput, findResumeInput, isAutofillFileInput } =
    await import(`data:text/javascript;base64,${Buffer.from(domSource, 'utf8').toString('base64')}`);

  // A container the input sits in: its class names and its visible text are
  // the two things isAutofillFileInput and labelFor read off it.
  const box = (className, innerText, parentElement = null) => ({ className, innerText, parentElement });
  const fileEl = ({ id = '', name = '', label = '', aria = '', parent = null } = {}) => ({
    tagName: 'INPUT', type: 'file', id, name, className: '', offsetParent: {}, disabled: false,
    getAttribute: (k) => ({ 'aria-label': aria || null }[k] ?? null),
    labels: label ? [{ textContent: label }] : [],
    parentElement: parent,
    closest: (sel) => (/^div/.test(sel) ? parent : null),
  });

  const resumeInput = fileEl({ id: 'resume-file', aria: 'Resume' });
  const coverInput = fileEl({ id: 'cover-file', aria: 'Cover Letter (optional)' });
  setFiles([resumeInput, coverInput]);
  const cover = findCoverLetterInput();
  const resume = findResumeInput();
  ok(cover === coverInput, 'findCoverLetterInput picks the input whose own label mentions "cover letter"');
  ok(resume === resumeInput, 'findResumeInput picks the OTHER input');
  ok(cover !== resume, 'findCoverLetterInput and findResumeInput never agree on the same input');

  // Only ONE file input, no cover-letter signal anywhere — the sole input is
  // presumably the resume; findCoverLetterInput must not also claim it.
  const onlyInput = fileEl({ id: 'only-file' });
  setFiles([onlyInput]);
  ok(findCoverLetterInput() === null, 'findCoverLetterInput returns null when there is only one, unlabelled file input');
  ok(findResumeInput() === onlyInput, 'findResumeInput still resolves the sole input as the resume');

  // Two upload questions and no other signal: the positional guess still
  // stands — the other input is the cover letter's.
  const plainResume = fileEl({ id: 'r', aria: 'Resume' });
  const unlabelled = fileEl({ id: 'u' });
  setFiles([plainResume, unlabelled]);
  ok(findCoverLetterInput() === unlabelled && findResumeInput() === plainResume,
    'two upload questions, one of them the resume: the other takes the cover letter (the positional rung)');
  // …but never an input whose own label names a different document…
  const portfolio = fileEl({ id: 'p', aria: 'Portfolio (PDF)' });
  setFiles([plainResume, portfolio]);
  ok(findCoverLetterInput() === null && findResumeInput() === plainResume,
    'an upload labelled as another document (a portfolio) is that document\'s slot — no cover letter goes there');
  // …and never a guess among three.
  setFiles([plainResume, unlabelled, fileEl({ id: 'u2' })]);
  ok(findCoverLetterInput() === null, 'three upload questions and no cover-letter label: no positional guess');

  // The layout every current Ashby form has (measured 2026-09-21 on 17 live
  // postings): an "Autofill from resume" parser box above the form — no id,
  // no name, PDF-accepting, first in the DOM — then the Resume question as
  // #_systemfield_resume with an EMPTY name. The old logic attached the resume
  // to the parser box and the cover letter into the Resume field.
  const autofillRoot = box('_root_xd2v0_1 ashby-application-form-autofill-input-root',
    'Autofill from resume Upload your resume here to autofill key application fields. Upload file',
    box('_autofillPane_5yu8i_448 ashby-application-form-autofill-pane', 'Autofill from resume …'));
  const parserBox = () => fileEl({ parent: autofillRoot });
  const ashbyResume = () => fileEl({
    id: '_systemfield_resume', label: 'Resume',
    parent: box('_container_10xk4_70 ashby-application-form-input-file', 'Upload File or drag and drop here',
      box('_fieldEntry_1e3gg_28 ashby-application-form-field-entry', 'Resume Upload File or drag and drop here')),
  });
  {
    const parser = parserBox();
    const real = ashbyResume();
    setFiles([parser, real], 'jobs.ashbyhq.com');
    ok(isAutofillFileInput(parser) && !isAutofillFileInput(real), 'Ashby\'s parser box is recognised as one; the Resume question is not');
    ok(findResumeInput() === real, 'Ashby: the resume goes to #_systemfield_resume, not the "Autofill from resume" parser box');
    ok(findCoverLetterInput() === null,
      'Ashby with no cover-letter question: nothing is claimed for the cover letter — never the Resume field');
  }
  {
    const parser = parserBox();
    const real = ashbyResume();
    const letter = fileEl({ id: '53c8ff07-780b-493b-84eb', label: 'Cover Letter', parent: box('x', 'Upload File or drag and drop here') });
    setFiles([parser, real, letter], 'jobs.ashbyhq.com');
    ok(findCoverLetterInput() === letter && findResumeInput() === real,
      'Ashby with a "Cover Letter" question: the letter goes there and the resume to the Resume question');
  }
  {
    const parser = parserBox();
    const real = ashbyResume();
    const extra = fileEl({ id: 'b1890667-a914-4163', label: 'Additional Attachments', parent: box('x', 'UPLOAD FILE or drag and drop here') });
    setFiles([parser, real, extra], 'jobs.ashbyhq.com');
    ok(findCoverLetterInput() === extra && findResumeInput() === real,
      'Ashby with Resume + "Additional Attachments": the parser box does not count, so the positional rung sees two questions');
  }
  // A parser box recognised from its wording alone, on a site with no pack.
  {
    const wordy = fileEl({ id: 'af', parent: box('upload-zone', 'Autofill your application with your resume') });
    const real = fileEl({ id: 'rs', aria: 'Resume' });
    setFiles([wordy, real]);
    ok(findResumeInput() === real && findCoverLetterInput() === null,
      'a parser box named only by its text ("Autofill your application…") is skipped for both files');
  }
  // When the parser box is the ONLY file input — Workday's "Autofill with
  // Resume" step — uploading there is the point, so it still gets the resume.
  {
    const only = fileEl({ id: 'wd', parent: box('css-1', 'Autofill with Resume Upload a file or drag and drop here') });
    setFiles([only]);
    ok(findResumeInput() === only && findCoverLetterInput() === null,
      'a parser box that is the only file input on the page still receives the resume');
  }
}

// ── the panel ↔ worker channel never fails silently ───────────────────────
// "Uncaught (in promise) Error: A listener indicated an asynchronous response
// by returning true, but the message channel closed before a response was
// received" — the worker was stopped mid-request (a pending fetch is not
// activity to Chrome's 30s idle timer), the panel's promise rejected, and the
// click handler died with its status line frozen. Both halves are pinned: the
// worker stays up and always answers, and the panel never lets a transport
// failure escape.
{
  const withAsync = (src, name) => {
    const fn = extractFunction(src, name);
    return src.includes(`async function ${name}(`) ? `async ${fn}` : fn;
  };

  // Worker, deadlines: generous only where a model call sits behind the route.
  {
    const { requestTimeoutMs } = new Function(`${extractFunction(SW, 'requestTimeoutMs')}\nreturn { requestTimeoutMs };`)();
    ok(requestTimeoutMs('/api/companion/live-fill', 'POST') === 200000 && requestTimeoutMs('/api/companion/draft', 'POST') === 200000
      && requestTimeoutMs('/api/companion/generate-message', 'POST') === 200000,
    'worker deadline: 200s for the model-backed POSTs (live fill budgets up to 180s server-side)');
    ok(requestTimeoutMs('/api/companion/draft?id=j1', 'GET') === 30000 && requestTimeoutMs('/api/companion/plan?url=x', 'GET') === 30000,
      'worker deadline: 30s for a poll or a plan — a missed poll just polls again');
    ok(requestTimeoutMs('/api/companion/cover-letter?item=a', 'GET') === 60000 && requestTimeoutMs('/api/companion/resume', 'GET') === 60000,
      'worker deadline: 60s for the binary downloads');
  }

  // Worker, api(): drive the shipped function with a stubbed fetch/chrome and
  // recorded timers. The deadline is shortened; everything else is as shipped.
  ok(/^let requestsInFlight = 0;$/m.test(SW) && /^let keepAliveTimer = null;$/m.test(SW),
    'sw.js declares the keep-alive counter and timer at module scope (the harness below mirrors them)');
  const apiSrc = [withAsync(SW, 'keepAliveWhile'), withAsync(SW, 'api')].join('\n');
  const loadApi = ({ fetch, timeoutMs = 40 }) => {
    const intervals = [];
    const cleared = [];
    const platformCalls = { n: 0 };
    const chrome = { runtime: { getPlatformInfo: async () => { platformCalls.n += 1; return {}; } } };
    const setIntervalFn = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
    const clearIntervalFn = (id) => { cleared.push(id); };
    const worker = new Function('chrome', 'fetch', 'setInterval', 'clearInterval', `
      let requestsInFlight = 0;
      let keepAliveTimer = null;
      const NOT_CONFIGURED = 'not configured';
      const getConfig = async () => ({ baseUrl: 'http://s:8377', token: 't' });
      const importBundledConfig = async () => ({ imported: false });
      const requestTimeoutMs = () => ${timeoutMs};
      ${apiSrc}
      return { api, inFlight: () => requestsInFlight, timer: () => keepAliveTimer };
    `)(chrome, fetch, setIntervalFn, clearIntervalFn);
    return { worker, intervals, cleared, platformCalls };
  };
  const jsonRes = (body, status = 200) => ({
    ok: status < 400, status, headers: { get: () => null }, json: async () => body,
  });
  // A fetch that answers only when told to — or when its signal aborts.
  const heldFetch = () => {
    const held = [];
    const fetch = (url, opts) => new Promise((resolve, reject) => {
      held.push({ url, resolve });
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    });
    return { fetch, held };
  };

  await (async () => {
    {
      const { fetch, held } = heldFetch();
      const { worker, intervals, cleared, platformCalls } = loadApi({ fetch, timeoutMs: 60000 });
      const pending = worker.api('/api/companion/draft?id=j1');
      await new Promise((r) => setTimeout(r, 5));
      ok(intervals.length === 1 && intervals[0].ms === 20000 && worker.inFlight() === 1,
        'while a request is open the worker runs one 20s keep-alive');
      await intervals[0].fn();
      ok(platformCalls.n === 1, 'the keep-alive tick calls a trivial extension API (chrome.runtime.getPlatformInfo), which is what resets Chrome\'s idle timer');
      const second = worker.api('/api/companion/plan?url=');
      await new Promise((r) => setTimeout(r, 5));
      ok(intervals.length === 1 && worker.inFlight() === 2, 'concurrent requests share the one keep-alive');
      held[0].resolve(jsonRes({ ok: true, job: { id: 'j1', status: 'running' } }));
      const first = await pending;
      ok(first.ok === true && first.job.id === 'j1' && cleared.length === 0,
        'the first answer comes back as before, and the keep-alive stays while the other request is open');
      held[1].resolve(jsonRes({ ok: true, mode: 'profile' }));
      await second;
      ok(cleared.length === 1 && worker.inFlight() === 0 && worker.timer() === null,
        'the keep-alive stops once the last open request settles — an idle worker is still allowed to sleep');
    }
    {
      const { fetch } = heldFetch();
      const { worker, cleared } = loadApi({ fetch, timeoutMs: 30 });
      const t0 = Date.now();
      const res = await worker.api('/api/companion/draft?id=j1');
      ok(res.ok === false && res.timeout === true && /did not answer within/.test(res.error) && Date.now() - t0 < 2000,
        'a request that never answers is cut off at its deadline and comes back as an ordinary error — the worker always answers');
      ok(cleared.length === 1 && worker.inFlight() === 0, 'and the keep-alive is released with it');
    }
    {
      const { worker } = loadApi({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
      const res = await worker.api('/api/companion/plan?url=');
      ok(res.ok === false && !res.timeout && /cannot reach the CareerAutopilot server: Failed to fetch/.test(res.error),
        'a network failure is still reported as unreachable, not as a timeout');
    }
    {
      const pdf = new TextEncoder().encode('%PDF-1.4 test');
      const fetch = async () => ({
        ok: true, status: 200,
        headers: { get: (h) => ({ 'content-disposition': 'attachment; filename="DavidC_CoverLetter_Vesta_SE.pdf"', 'content-type': 'application/pdf' }[h] || null) },
        arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength),
      });
      const { worker } = loadApi({ fetch });
      const res = await worker.api('/api/companion/cover-letter?item=2218-vesta');
      ok(res.ok === true && res.filename === 'DavidC_CoverLetter_Vesta_SE.pdf' && Buffer.from(res.b64, 'base64').toString() === '%PDF-1.4 test',
        'the cover-letter PDF still arrives base64-encoded under the server\'s filename');
    }
  })();

  // Worker, onMessage: a case that throws still answers.
  ok(/\}\)\(\)\.catch\(\(err\) => \{[\s\S]{0,700}?sendResponse\(\{ ok: false, error: `the extension could not handle that request/.test(SW),
    'the worker\'s message handler answers even when a case throws — an unanswered message is the "channel closed" error');

  // Panel, send(): drive the shipped function against a stubbed runtime.
  const sendSrc = [
    extractMultilineConst(COMPANION, 'RESENDABLE'),
    extractConst(COMPANION, 'CHANNEL_LOST_RE'),
    extractConst(COMPANION, 'CONTEXT_GONE_RE'),
    extractConst(COMPANION, 'RELOAD_PAGE'),
    extractConst(COMPANION, 'extensionAlive'),
    withAsync(COMPANION, 'send'),
  ].join('\n');
  const loadSend = (sendMessage, { id } = { id: 'ext-id' }) => {
    const calls = [];
    const chrome = { runtime: { id, sendMessage: (msg) => { calls.push(msg.type); return sendMessage(msg, calls.length); } } };
    return { ...new Function('chrome', `${sendSrc}\nreturn { send, RESENDABLE, RELOAD_PAGE };`)(chrome), calls };
  };
  const CLOSED = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';

  await (async () => {
    let escaped = null;
    try {
      {
        const s = loadSend(async (msg, n) => { if (n === 1) throw new Error(CLOSED); return { ok: true, b64: 'AA==', filename: 'x.pdf' }; });
        const r = await s.send({ type: 'companion:getCoverLetter', item: 'a' });
        ok(r.ok === true && r.filename === 'x.pdf' && s.calls.length === 2,
          'send(): a read whose channel closed is asked again once, and the second answer is what the caller gets');
      }
      {
        const s = loadSend(async () => { throw new Error(CLOSED); });
        const r = await s.send({ type: 'companion:getDraftJob', id: 'j' });
        ok(r.ok === false && r.transport === 'lost' && s.calls.length === 2 && /Lost contact/.test(r.error),
          'send(): a read that loses the channel twice comes back as { ok:false, transport:"lost" } — never a rejection');
      }
      {
        const s = loadSend(async () => { throw new Error(CLOSED); });
        const r = await s.send({ type: 'companion:getDraft', questions: ['q'] });
        ok(r.ok === false && r.transport === 'lost' && s.calls.length === 1,
          'send(): a request that starts a model call is never re-sent automatically');
      }
      {
        const s = loadSend(() => { throw new Error('Extension context invalidated.'); });
        const r = await s.send({ type: 'companion:getResume' });
        ok(r.ok === false && r.transport === 'invalidated' && r.error === s.RELOAD_PAGE && /reload this page/.test(r.error),
          'send(): a panel orphaned by an extension reload says to reload the page (a synchronous throw is caught too)');
      }
      {
        const s = loadSend(async () => { throw new Error(CLOSED); }, { id: undefined });
        const r = await s.send({ type: 'companion:getPlan' });
        ok(r.transport === 'invalidated' && s.calls.length === 1,
          'send(): no chrome.runtime.id left means the context is gone — reported as such, not retried');
      }
      {
        const s = loadSend(async () => ({ ok: true, mode: 'item' }));
        const r = await s.send({ type: 'companion:getPlan', url: 'u' });
        ok(r.ok === true && r.mode === 'item' && s.calls.length === 1, 'send(): an ordinary answer passes straight through');
      }
      {
        const s = loadSend(async () => { throw new Error('Message length exceeded maximum allowed length.'); });
        const r = await s.send({ type: 'companion:broadcast', payload: {} });
        ok(r.ok === false && r.transport === 'error' && /Message length exceeded/.test(r.error),
          'send(): any other messaging failure is reported with its own words');
      }
    } catch (err) {
      escaped = err;
    }
    ok(escaped === null, `send() never rejects${escaped ? ` (escaped: ${escaped.message})` : ''}`);
  })();

  {
    const { RESENDABLE } = new Function('chrome', `${sendSrc}\nreturn { RESENDABLE };`)({ runtime: {} });
    const never = ['companion:getDraft', 'companion:liveFill', 'companion:processPage', 'companion:generateMessage',
      'companion:broadcast', 'companion:submitIntent', 'companion:submitConfirmed', 'companion:observe',
      'companion:promoteField', 'companion:forgetLearned', 'companion:deleteAnswer'];
    ok(never.every((t) => !RESENDABLE.has(t)),
      'nothing that spends a model call, changes the pipeline or re-broadcasts to the page is in the re-send list');
    const unknown = [...RESENDABLE].filter((t) => !SW.includes(`case '${t}'`));
    ok(unknown.length === 0, `every re-sendable message type is one the worker handles${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
  }

  // Panel, the polling loops stop once the extension is unreachable for good.
  ok(/p && p\.transport === 'invalidated'\) return p;/.test(extractFunction(COMPANION, 'requestDraft')),
    'requestDraft stops polling (and says why) once the panel is orphaned by an extension reload');
  ok(/res && res\.transport === 'invalidated'/.test(extractFunction(COMPANION, 'watchRequest')),
    'watchRequest does the same for "process this page"');

  // Panel, a manual Attach that no frame answers says so.
  ok(/expectAttachAnswer\('resume', r\.filename\);\s*broadcast\(\{ type: 'companion:attachResume'/.test(COMPANION)
    && /expectAttachAnswer\('cover_letter_file', r\.filename\);\s*broadcast\(\{ type: 'companion:attachCoverLetter'/.test(COMPANION),
  'both manual Attach buttons wait for an answer before broadcasting');
  ok(/panelBus\['companion:resumeAttached'\] = \(\{ ok \}\) => \{\s*settleAttachWait\('resume'\);/.test(COMPANION)
    && /panelBus\['companion:coverLetterAttached'\] = \(\{ ok \}\) => \{\s*settleAttachWait\('cover_letter_file'\);/.test(COMPANION),
  'an attach result from any frame settles the wait');
  {
    const timers = [];
    const statuses = [];
    const src = `
      const rowStatus = new Map();
      const setStatusLine = (text, isError = false) => statuses.push({ text, isError });
      const paintStatuses = () => {};
      const setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; };
      const clearTimeout = (id) => { if (timers[id]) timers[id].live = false; };
      ${extractConst(COMPANION, 'ATTACH_ANSWER_MS')}
      ${extractConst(COMPANION, 'attachWaits')}
      ${extractFunction(COMPANION, 'expectAttachAnswer')}
      ${extractFunction(COMPANION, 'settleAttachWait')}
      return { expectAttachAnswer, settleAttachWait, rowStatus };
    `;
    const panel = new Function('timers', 'statuses', src)(timers, statuses);
    panel.expectAttachAnswer('cover_letter_file', 'DavidC_CoverLetter_Vesta_SE.pdf');
    ok(statuses.at(-1).text === 'Attaching DavidC_CoverLetter_Vesta_SE.pdf…', 'the status line moves on from "Fetching…" as soon as the file is in hand');
    timers[0].fn();
    ok(/no cover-letter upload field/.test(statuses.at(-1).text) && statuses.at(-1).isError && panel.rowStatus.get('cover_letter_file') === 'notfound',
      'no frame answering means no upload field: the panel says so and marks the row');
    panel.expectAttachAnswer('resume', 'DavidC_CV.pdf');
    panel.settleAttachWait('resume');
    ok(timers[1].live === false, 'an answer from a frame cancels the "not found" message');
  }
}

// ── item #7: panel drag clamps to the viewport at every extreme ───────────
{
  const clampSrc = extractFunction(COMPANION, 'clampToViewport');
  const src = `
const window = { innerHeight: 0, innerWidth: 0 };
export const setViewport = (h, w) => { window.innerHeight = h; window.innerWidth = w; };
${clampSrc}
export { clampToViewport };
`;
  const { setViewport, clampToViewport } =
    await import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`);

  setViewport(900, 1600);
  ok(JSON.stringify(clampToViewport(-50, -50)) === JSON.stringify({ top: 0, left: 0 }),
    'clampToViewport: negative coordinates clamp to the top-left corner');
  ok(JSON.stringify(clampToViewport(10000, 10000)) === JSON.stringify({ top: 860, left: 1540 }),
    'clampToViewport: coordinates past the viewport clamp so the header stays grabbable (40px/60px reserved)');
  ok(JSON.stringify(clampToViewport(200, 300)) === JSON.stringify({ top: 200, left: 300 }),
    'clampToViewport: an in-bounds position passes through unchanged');
  setViewport(20, 20); // a viewport smaller than the panel's own reserved margins
  ok(JSON.stringify(clampToViewport(500, 500)) === JSON.stringify({ top: 0, left: 0 }),
    'clampToViewport: never produces a negative clamp bound even on a tiny viewport');
}

// ── AI tab button gating (paid-tier / daily-cap disabling, never hiding) ──
{
  const gates = extractFunction(COMPANION, 'paintFeatureGates');
  ok(/co-livefill/.test(gates) && /live\.disabled = !allowed \|\| capped;/.test(gates),
    'paintFeatureGates disables (never removes) the Live-fill button when the tier or the cap says no');
  ok(/paid-plan feature — ask the admin to upgrade your tier/.test(gates),
    'a disabled Live-fill button states WHY, not just that it is off');
  ok(/co-draftq/.test(gates) && /draft\.disabled = capped;/.test(gates),
    'paintFeatureGates disables Draft-open-questions on a spent daily cap');
  ok(/co-process/.test(gates) && /paid-plan feature — ask the admin to upgrade your access/.test(gates),
    'the header\'s Process-this-page button is gated the same way, with its own stated reason');

  // Drive the real, extracted function against a stubbed `root`/`plan` for
  // each tier row, rather than trusting the regex checks above alone —
  // `plan` is a module-scope closure variable in the shipped source (not a
  // parameter), so the harness declares it the same way and reassigns it
  // per case. paintFeatureGates() now also calls three sibling helpers
  // (buildExternalLink/clearHint/paintUpsellHint/showConsentNotice) that live
  // OUTSIDE its own extracted body, so they ride along in the same harness —
  // extracting paintFeatureGates alone (as before this existed) would throw
  // ReferenceError the moment it called any of them.
  const upsellHelpers = ['buildExternalLink', 'clearHint', 'paintUpsellHint', 'showConsentNotice']
    .map((name) => extractFunction(COMPANION, name)).join('\n');
  const gateHarness = `
// A minimal fake element: enough for paintUpsellHint/showConsentNotice to
// read/write textContent, toggle hidden, and .append() a child (the real
// href/target/rel land on the link element itself, exposed as .child below).
function makeEl(id) {
  return {
    id, hidden: false, textContent: '',
    append(...parts) {
      this.textContent = parts.map((part) => (typeof part === 'string' ? part : part.textContent)).join('');
      this.child = parts.find((part) => part && typeof part === 'object') || null;
    },
  };
}
const document = { createElement: () => ({ textContent: '', href: '', target: '', rel: '', className: '' }) };
let plan = null;
const buttons = {
  'co-process': { disabled: false, title: '' },
  'co-livefill': { disabled: false, title: '' },
  'co-draftq': { disabled: false, title: '' },
  'co-process-hint': makeEl('co-process-hint'),
  'co-livefill-hint': makeEl('co-livefill-hint'),
  'co-consent-hint': makeEl('co-consent-hint'),
};
const root = { getElementById: (id) => buttons[id] || null };
export const setPlan = (p) => { plan = p; };
export const getButtons = () => buttons;
${upsellHelpers}
${gates}
export { paintFeatureGates };
`;
  const { setPlan, getButtons, paintFeatureGates } =
    await import(`data:text/javascript;base64,${Buffer.from(gateHarness, 'utf8').toString('base64')}`);

  const tierRow = (features, usage, extra = {}) => {
    setPlan({ features, usage, ...extra });
    paintFeatureGates();
    return getButtons();
  };

  {
    const b = tierRow({ live_fill: true, process_page: true, generate_message: true, auto_draft: true },
      { live_fills: { remaining: 33 }, drafts: { remaining: 195 } });
    ok(b['co-livefill'].disabled === false && b['co-process'].disabled === false && b['co-draftq'].disabled === false,
      'admin/paid row: every AI-tab and header button is enabled');
    ok(/33 left today/.test(b['co-livefill'].title), 'the Live-fill tooltip states the remaining count');
  }
  {
    const b = tierRow({ live_fill: false, process_page: false, generate_message: false, auto_draft: true },
      { live_fills: { remaining: 0 }, drafts: { remaining: 10 } });
    ok(b['co-livefill'].disabled === true && b['co-process'].disabled === true,
      'free-tier row: Live fill and Process this page are both disabled');
    ok(/paid-plan feature/.test(b['co-livefill'].title) && /paid-plan feature/.test(b['co-process'].title),
      'both disabled buttons state the paid-plan reason, not the daily-cap reason (the tier is what is blocking, not the cap)');
    // Neither field present (today's shape, before ChunkyLink ships upgrade_url)
    // — the panel must look and behave exactly as it does today: no visible
    // hint at all, only the title tooltip above.
    ok(b['co-process-hint'].hidden === true && b['co-process-hint'].textContent === ''
      && b['co-livefill-hint'].hidden === true && b['co-livefill-hint'].textContent === '',
      'with no plan.upgrade_url, no visible upsell hint is rendered — unchanged from before this existed');
  }
  {
    // A real https:// upgrade_url: the sentence AND a link both render, DOM-
    // built (never innerHTML with the server-supplied string).
    const b = tierRow({ live_fill: false, process_page: false, generate_message: false, auto_draft: true },
      { live_fills: { remaining: 0 }, drafts: { remaining: 10 } }, { upgrade_url: 'https://example.com/career/plan' });
    ok(b['co-process-hint'].hidden === false && /paid-plan feature/.test(b['co-process-hint'].textContent),
      'plan.upgrade_url present: the Process-this-page hint becomes visible with the feature sentence');
    ok(b['co-process-hint'].child && b['co-process-hint'].child.href === 'https://example.com/career/plan'
      && b['co-process-hint'].child.target === '_blank' && b['co-process-hint'].child.textContent === 'Upgrade plan',
      'the hint carries a real "Upgrade plan" link (built via createElement, not innerHTML) opening in a new tab');
    ok(b['co-livefill-hint'].hidden === false && b['co-livefill-hint'].child
      && b['co-livefill-hint'].child.href === 'https://example.com/career/plan',
      'the Live-fill hint gets the same treatment');
    // A non-https value (an operator typo, or something worse) must never
    // become a link — no href is set at all, only the plain sentence.
    const httpRow = tierRow({ live_fill: false, process_page: false, generate_message: false, auto_draft: true },
      null, { upgrade_url: 'http://example.com/not-secure' });
    ok(httpRow['co-process-hint'].hidden === true,
      'a non-https:// upgrade_url renders no hint at all, exactly like no url being present');
  }
  // ── SPEC v2 section 8 Pass 3 attack #3: every value the spec names, one at
  //    a time, plus a source-level guard that nothing here ever reaches
  //    innerHTML/insertAdjacentHTML with a server-supplied string. ─────────
  {
    const disabledFeatures = { live_fill: false, process_page: false, generate_message: false, auto_draft: true };
    const noHint = (upgrade_url) => {
      const b = tierRow(disabledFeatures, null, { upgrade_url });
      return b['co-process-hint'].hidden === true && b['co-livefill-hint'].hidden === true;
    };
    ok(noHint('javascript:alert(1)'), 'upgrade_url:"javascript:alert(1)" — no script runs, no link rendered (non-https scheme)');
    ok(noHint(42), 'upgrade_url as a bare number renders no hint (typeof check refuses it, not a coercion to string)');
    ok(noHint({ toString: () => 'https://evil.example' }), 'upgrade_url as an object (even one that would coerce to a plausible https URL via toString) renders no hint — typeof is checked before any use, never String(url)');
    ok(noHint('a'.repeat(100000)), 'upgrade_url as a 100,000-character string (not https-prefixed) renders no hint and does not hang or throw');
    // A 100,000-character string that DOES start with https:// is a genuine
    // (if wildly oversized) URL by this function's own contract — it may
    // render a link, but only via property assignment (a.href = ...), never
    // string concatenation into markup, so it stays inert regardless of size.
    {
      const hugeHttps = `https://example.com/${'a'.repeat(100000)}`;
      let threw = false;
      let b;
      try { b = tierRow(disabledFeatures, null, { upgrade_url: hugeHttps }); } catch { threw = true; }
      ok(!threw, 'a 100,000-character https:// upgrade_url does not throw');
      ok(b['co-process-hint'].child?.href === hugeHttps, 'and if rendered, the href is the literal string via property assignment, never parsed as markup');
    }
    // The XSS-shaped payload from the spec: it DOES start with https://, so a
    // link is expected — the point is that no markup injection occurs,
    // because buildExternalLink only ever does createElement + property
    // assignment, never string interpolation into innerHTML.
    {
      const xssUrl = 'https://evil.example/"><img src=x onerror=alert(1)>';
      const b = tierRow(disabledFeatures, null, { upgrade_url: xssUrl });
      ok(b['co-process-hint'].child?.href === xssUrl && b['co-process-hint'].child?.textContent === 'Upgrade plan',
        'an XSS-shaped https:// value is assigned verbatim to .href (never interpolated into markup) and the link\'s own text is always the fixed "Upgrade plan" label, never anything derived from the url');
    }
    // consent_url goes through the exact same buildExternalLink choke point —
    // one pass here is enough to confirm it is not a second, divergent path.
    ok((() => {
      const b = tierRow(disabledFeatures, null, { consent_required: true, consent_url: 'javascript:alert(1)' });
      return b['co-consent-hint'].hidden === false && !b['co-consent-hint'].child;
    })(), 'plan.consent_url:"javascript:alert(1)" — the consent sentence still shows (consent_required is independent of the url), but no link is built, and no script runs');

    // Source-level guard: none of the four helper functions this section
    // exercises may ever assign to innerHTML or call insertAdjacentHTML — the
    // DOM-construction discipline (createElement + textContent + property
    // assignment) is a design invariant, not something the behavioural
    // assertions above can fully rule out for a future edit that adds a
    // second, less careful code path alongside the ones tested here.
    ok(!/innerHTML|insertAdjacentHTML/.test(upsellHelpers),
      'buildExternalLink/clearHint/paintUpsellHint/showConsentNotice never mention innerHTML or insertAdjacentHTML anywhere in their source');
  }
  {
    // The consent notice: driven by plan.consent_required, independent of tier.
    const b = tierRow({ live_fill: true, process_page: true, generate_message: false, auto_draft: true },
      null, { consent_required: true, consent_url: 'https://example.com/career' });
    ok(b['co-consent-hint'].hidden === false && /review the updated terms/.test(b['co-consent-hint'].textContent),
      'plan.consent_required shows the consent notice even for an otherwise fully-allowed plan');
    ok(b['co-consent-hint'].child && b['co-consent-hint'].child.href === 'https://example.com/career',
      'the consent notice links to plan.consent_url');
    const clear = tierRow({ live_fill: true, process_page: true, generate_message: false, auto_draft: true }, null);
    ok(clear['co-consent-hint'].hidden === true, 'once consent is no longer required, the notice clears on the next repaint');
  }
  {
    const b = tierRow({ live_fill: true, process_page: true, generate_message: false, auto_draft: true },
      { live_fills: { remaining: 0 }, drafts: { remaining: 0 } });
    ok(b['co-livefill'].disabled === true && /limit reached/.test(b['co-livefill'].title),
      'paid tier but the daily cap is spent: Live fill disables with the CAP reason, not the tier reason');
    ok(b['co-draftq'].disabled === true && /limit reached/.test(b['co-draftq'].title),
      'Draft open questions disables the same way once its own daily cap is spent');
    ok(b['co-process'].disabled === false, 'Process this page has no daily cap of its own — stays enabled');
  }
  {
    const b = tierRow(null, null);
    ok(b['co-process'].disabled === false, 'no plan loaded yet: Process this page defaults to enabled (never disabled by the absence of data)');
  }
}

// ── deliberate-AI rule: Fill never triggers a model call ───────────────────
{
  const fillEverythingSrc = extractFunction(COMPANION, 'fillEverything');
  ok(!/autoDraft/.test(fillEverythingSrc) && !/getDraft/.test(fillEverythingSrc) && !/liveFill/i.test(fillEverythingSrc),
    'fillEverything() (auto-run AND the ⚡ button) never calls drafting or live-fill — Fill is deterministic-only');
  const autorunHandler = COMPANION.slice(
    COMPANION.indexOf("panelBus['companion:autorun']"),
    COMPANION.indexOf("panelBus['companion:frameAdded']"),
  );
  ok(/fillEverything\(\{ auto: true \}\)/.test(autorunHandler) && !/fillLive\(/.test(autorunHandler),
    'the auto-run handler (incl. its relink branch) calls only the deterministic fill, never fillLive — the AI tab\'s own click is the only way to trigger it');
}

// ── SPEC3 item #1: a constrained input never receives a value it cannot hold ─
// The Deloitte Avature bug: a type="month" start-date field handed a
// free-text availability answer ("Two weeks from offer acceptance.") got
// silently blanked by Chrome's own value sanitizer (no exception — the
// assignment just no-ops to ''), and the panel still reported the row
// 'filled' because nothing downstream of the native setter ever saw a
// failure. valueFitsInput/coerceForInput/setNativeValue are extracted from
// the SHIPPED source (never copied by hand) and driven against a minimal
// stub window: HTMLInputElement/HTMLTextAreaElement/HTMLSelectElement
// prototypes whose `value` setter records that it ran (or throws, for the
// one case exercising setNativeValue's own try/catch), plus bare
// InputEvent/Event stubs — companion.js calls `new InputEvent(...)` and
// `new Event(...)` directly, never through `window.`.
{
  const guardSource = `
class Event { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } }
class InputEvent extends Event {}
function makeCtor() {
  function Ctor() {}
  Object.defineProperty(Ctor.prototype, 'value', {
    configurable: true,
    set(v) {
      if (this.__throwOnSet) throw new Error('setter boom');
      this.__setterCalled = (this.__setterCalled || 0) + 1;
      this.value = v;
    },
  });
  return Ctor;
}
const window = { HTMLInputElement: makeCtor(), HTMLTextAreaElement: makeCtor(), HTMLSelectElement: makeCtor() };
${extractMultilineConst(COMPANION, 'INPUT_FORMATS')}
${extractFunction(COMPANION, 'coerceForInput')}
${extractFunction(COMPANION, 'valueFitsInput')}
${extractFunction(COMPANION, 'setNativeValue')}
export { INPUT_FORMATS, coerceForInput, valueFitsInput, setNativeValue };
`;
  const { INPUT_FORMATS, coerceForInput, valueFitsInput, setNativeValue } =
    await import(`data:text/javascript;base64,${Buffer.from(guardSource, 'utf8').toString('base64')}`);

  ok(JSON.stringify(Object.keys(INPUT_FORMATS).sort()) === JSON.stringify(['color', 'date', 'datetime-local', 'month', 'time', 'url', 'week'].sort()),
    'INPUT_FORMATS covers exactly the HTML input types Chrome sanitizes on a mismatch');

  // Stub elements. `dispatched` is a plain own array (not a getter behind a
  // closure the harness can't see) so a test can assert "no dispatch" by its
  // length alone.
  const makeEl = (tagName, type, initial = '') => ({
    tagName, type, value: initial, dispatched: [],
    dispatchEvent(e) { this.dispatched.push(e.type); },
  });

  // The regression itself: a free-text answer into a month field.
  {
    const el = makeEl('INPUT', 'month', '');
    const ok1 = setNativeValue(el, 'Two weeks from offer acceptance.');
    ok(ok1 === false, 'setNativeValue: a free-text answer into a month input is refused');
    ok(el.__setterCalled === undefined, 'setNativeValue: the native setter is never called on a refused value');
    ok(el.dispatched.length === 0, 'setNativeValue: nothing is dispatched on a refused value (no phantom "input"/"change")');
    ok(el.value === '', 'setNativeValue: the element is left exactly as it was found');
  }
  // A conforming month value is accepted as-is.
  {
    const el = makeEl('INPUT', 'month', '');
    ok(setNativeValue(el, '2026-10') === true, 'setNativeValue: a well-formed YYYY-MM value fits a month input');
    ok(el.value === '2026-10' && el.dispatched.includes('input') && el.dispatched.includes('change'),
      'setNativeValue: the value is set and input+change both dispatch on success');
  }
  // A full ISO date coerces down to what the month input can hold.
  {
    const el = makeEl('INPUT', 'month', '');
    ok(setNativeValue(el, '2026-10-15') === true, 'setNativeValue: an ISO date fits a month input once coerced');
    ok(el.value === '2026-10', 'setNativeValue: the month input receives the coerced YYYY-MM, not the original YYYY-MM-DD');
  }
  // A US-style date coerces into what a date input wants.
  {
    const el = makeEl('INPUT', 'date', '');
    ok(setNativeValue(el, '10/15/2026') === true, 'setNativeValue: an M/D/YYYY value fits a date input once coerced');
    ok(el.value === '2026-10-15', 'setNativeValue: the date input receives ISO YYYY-MM-DD');
  }
  // A currency-formatted amount coerces into a bare number.
  {
    const el = makeEl('INPUT', 'number', '');
    ok(setNativeValue(el, '$150,000') === true, 'setNativeValue: a currency-formatted figure fits a number input once coerced');
    ok(el.value === '150000', 'setNativeValue: thousands separator and currency symbol are stripped before the set');
  }
  // Non-numeric text into a number input is refused outright.
  {
    const el = makeEl('INPUT', 'number', '');
    ok(setNativeValue(el, 'abc') === false, 'setNativeValue: non-numeric text into a number input is refused');
    ok(el.__setterCalled === undefined, 'setNativeValue: and, again, the setter never runs on a refused value');
  }
  // Unconstrained controls always fit.
  {
    const el = makeEl('INPUT', 'text', '');
    ok(setNativeValue(el, 'anything at all') === true, 'setNativeValue: a plain text input holds anything');
    ok(el.value === 'anything at all', 'setNativeValue: an unconstrained text input is set unchanged (no coercion applied)');
  }
  {
    const el = makeEl('TEXTAREA', undefined, '');
    ok(setNativeValue(el, 'line one\nline two\nline three') === true, 'setNativeValue: a multi-line value fits a textarea');
  }
  // Email format.
  {
    const good = makeEl('INPUT', 'email', '');
    const bad = makeEl('INPUT', 'email', '');
    ok(setNativeValue(good, 'a@b.co') === true, 'setNativeValue: a well-formed address fits an email input');
    ok(setNativeValue(bad, 'not an email') === false, 'setNativeValue: plain text is refused by an email input');
    const multi = makeEl('INPUT', 'email', '');
    multi.multiple = true;
    ok(setNativeValue(multi, 'a@b.co, c@d.co') === true,
      'setNativeValue: a comma-separated list fits a multiple email input when every part is a valid address');
    ok(setNativeValue({ ...multi, value: '', dispatched: [], dispatchEvent(e) { this.dispatched.push(e.type); } }, 'a@b.co, not-an-email') === false,
      'setNativeValue: one bad part in a multiple email input refuses the whole value');
  }
  // The setter itself throwing must never escape — the whole point of
  // wrapping the body in try/catch.
  {
    const el = makeEl('INPUT', 'text', '');
    el.__throwOnSet = true;
    let threw = false;
    let result;
    try { result = setNativeValue(el, 'anything'); } catch { threw = true; }
    ok(threw === false, 'setNativeValue: a throwing native setter never escapes the function');
    ok(result === false, 'setNativeValue: and is reported as a refusal, not a silent success');
  }

  // valueFitsInput/coerceForInput directly, for the two rungs setNativeValue
  // delegates to (belt-and-braces on top of the end-to-end cases above).
  ok(valueFitsInput(makeEl('SELECT', undefined), 'anything') === true, 'valueFitsInput: a select always fits (no HTML constraint to violate)');
  ok(valueFitsInput({ tagName: 'DIV', isContentEditable: true }, 'anything') === true, 'valueFitsInput: contenteditable always fits');
  ok(coerceForInput(makeEl('INPUT', 'text'), '2026-10-15') === '2026-10-15', 'coerceForInput: a type it does not know how to coerce is returned untouched');
}

// ── SPEC3 item #1: every actuation caller honours a setNativeValue refusal ──
{
  const fillControlSrc = extractFunction(COMPANION, 'fillControl');
  ok(/if \(!setNativeValue\(el, String\(value\)\)\) return false;/.test(fillControlSrc),
    'fillControl: the plain-input tail never reports a fill that setNativeValue refused');

  const typeIntoSrc = extractFunction(COMPANION, 'typeInto');
  ok(/return setNativeValue\(el, String\(value\)\) && el\.value === String\(value\);/.test(typeIntoSrc),
    'typeInto: the execCommand fallback never reports success when the native-setter fallback was refused');
  ok(/execCommand\('insertText'/.test(typeIntoSrc), 'typeInto: still tries the browser input pipeline first (Workday behaviour unchanged)');

  const insertSrc = extractFunction(COMPANION, 'insertIntoFocused');
  ok(/if \(!setNativeValue\(el, text\)\) return null;/.test(insertSrc),
    'insertIntoFocused: returns null (not a fake "inserted" label) when the focused field refuses the text');

  const comboSrc = extractFunction(COMPANION, 'fillCombobox');
  ok(/setNativeValue\(input, String\(value\)\)/.test(comboSrc),
    'fillCombobox\'s filter-input write goes through the same choke point, so it is covered for free');
}

// ── SPEC3 item #1 (Errors page symptom): "single question" box on the AI tab ─
// The user's own words: "I cannot enter anything into the 'single question'
// field of the AI tab." That field is a plain <textarea> the panel's own
// insertText()/collectQuestions() flow never routes through a constrained
// HTML input — it broke because of item #2 (keyboard isolation), covered
// below — but confirm here that nothing about the typed-input guard itself
// can touch a textarea: setNativeValue must short-circuit to "always fits"
// before it ever reaches INPUT_FORMATS/number/email logic that has no
// meaning for one.
{
  ok(/if \(!el \|\| el\.tagName === 'TEXTAREA' \|\| el\.tagName === 'SELECT' \|\| el\.isContentEditable\) return true;/.test(COMPANION),
    'valueFitsInput exits true for textareas before any type-specific check runs');
}

// ── SPEC3 item #2: keystrokes typed into the panel never reach the page ────
// The retargeting bug: the panel is a shadow root on a host <div> appended to
// document.documentElement, so a page with a document-level keyboard handler
// (Avature/Deloitte-style hotkeys) sees every keystroke typed in the panel as
// a keystroke on that plain <div> — not an input — and a handler that cancels
// "keys outside inputs" cancels typing in the panel's own textareas. This is
// the actual cause of "I cannot enter anything into the single-question
// field": stopping propagation at the host, in the bubble phase, keeps the
// panel's own shadow-tree listeners (which run first) working while denying
// the page's document-level handler any event to act on.
{
  const buildPanelStart = COMPANION.indexOf('function buildPanel(');
  ok(buildPanelStart > -1, 'buildPanel exists');
  const hostCreate = COMPANION.indexOf("host = document.createElement('div');", buildPanelStart);
  const attach = COMPANION.indexOf('host.attachShadow(', buildPanelStart);
  ok(hostCreate > buildPanelStart, 'buildPanel creates the host element');
  ok(attach > hostCreate, 'the shadow root is attached after the host is created');

  const between = COMPANION.slice(hostCreate, attach);
  const loopMatch = between.match(/for \(const type of \[([^\]]*)\]\) \{\s*\n\s*host\.addEventListener\(type, \(e\) => e\.stopPropagation\(\)\);\s*\n\s*\}/);
  ok(Boolean(loopMatch),
    'buildPanel registers a host.addEventListener(type, stopPropagation) loop between creating the host and attaching the shadow root');

  const KEY_ISOLATION_TYPES = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'compositionstart',
    'compositionupdate', 'compositionend', 'paste', 'cut', 'copy'];
  const listedTypes = loopMatch ? loopMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
  ok(JSON.stringify(listedTypes) === JSON.stringify(KEY_ISOLATION_TYPES),
    `the loop lists exactly the eleven keyboard/composition/clipboard event types (got ${JSON.stringify(listedTypes)})`);

  ok(!listedTypes.includes('mousedown') && !listedTypes.includes('click') && !listedTypes.includes('focusin'),
    'mousedown/click/focusin are deliberately excluded — the existing mousedown-preventDefault on panel buttons and page-focus tracking must keep propagating');
}

// ── SPEC3 item #3: errors inside a fill never take the panel down ─────────
// Confirms the audit's conclusion holds in the shipped source rather than
// just in the plan: every per-control write already routes through a guarded
// entry point, and the new setNativeValue guard is itself fully wrapped.
{
  const setNativeValueSrc = extractFunction(COMPANION, 'setNativeValue');
  ok(/^\s*function setNativeValue\(el, value\) \{\s*\n\s*try \{/.test(setNativeValueSrc),
    'setNativeValue wraps its entire body in try/catch, starting on the very first line');
  ok(/\} catch \{\s*\n\s*return false;\s*\n\s*\}\s*\n\s*\}\s*$/.test(setNativeValueSrc),
    'setNativeValue\'s catch returns false rather than letting a DOM exception propagate up through fillControl/typeInto/insertIntoFocused');

  const fillControlSrc = extractFunction(COMPANION, 'fillControl');
  ok(/\} catch \{\s*\n\s*return false;\s*\n\s*\}\s*\n\s*\}\s*$/.test(fillControlSrc),
    'fillControl ends with the same catch-all try/catch it always had (unchanged by the item #1 fix)');
  ok(fillControlSrc.indexOf('try {') < fillControlSrc.indexOf("if (isComboLike(el)"),
    'the try block still opens before the first control-type branch, so every branch (including the new setNativeValue guard) is covered');

  const attachFileSrc = extractFunction(COMPANION, 'attachFile');
  ok(/try \{[\s\S]*\} catch \{\s*\n\s*return false;\s*\n\s*\}/.test(attachFileSrc),
    'attachFile is guarded (a bad file/DataTransfer failure never throws out of the fill loop)');
}

// ── manifest: patch bump for the Unlink fix ────────────────────────────────
// The version is how the candidate can tell, on chrome://extensions, that a
// reload actually picked up a fix.
{
  ok(MANIFEST.version === '0.4.5', 'manifest version bumped to 0.4.5 for the rename to CareerAutopilot Companion');
}
