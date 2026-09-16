// Career-Ops Companion — background service worker.
// Owns the backend connection (base URL + bearer token from chrome.storage)
// and relays messages between the top-frame panel and the per-frame fill
// engines. Content scripts never see the token.

const getConfig = () =>
  chrome.storage.local.get({ baseUrl: '', token: '' });

// Behaviour toggles (options.html). autoRun: when a page matches an active
// queue item, open the panel and fill without a click — deterministic only,
// per the deliberate-AI rule; it never triggers a model call. autoDraft:
// LEGACY, no longer read by companion.js's fillEverything — drafting moved
// to the AI tab's own explicit "Draft open questions" button so no inference
// call ever fires without a click. Kept in storage/options only so an
// existing install's value round-trips; its default flips true→false for a
// FRESH install only (getSettings' default here is never applied over an
// already-stored value). autoRunAll: watch every site for matches, not just
// known ATS hosts. learnFields: remember values the candidate types or
// confirms on application forms, so they can be prefilled next time. Default
// OFF — deliberately opt-in, since this reads personal data off forms the
// candidate fills in themselves.
const getSettings = () =>
  chrome.storage.local.get({ autoRun: true, autoDraft: false, autoRunAll: false, learnFields: false });

// ── configuration: the setup file ───────────────────────────────────────────
// api() reads storage, but storage starts empty in every profile that loads
// this directory, and it used to be filled from outside — a CDP seed that
// only worked when every precondition lined up (the extension loaded from
// exactly the checkout running setup, a throwaway debug instance able to
// start, the seed step actually reached). Load the extension from a second
// checkout, or open it in another profile, and the panel said "not configured".
//
// It fills itself now. extension/setup-companion.mjs writes companion.local.json
// next to this file (gitignored), and this worker imports it into storage
// when it starts, when storage is empty, when the file changes (a rotated
// token), and when the server rejects the token storage holds. The options
// page still overrides it, until setup writes a new file. Nothing is pushed
// in from outside.
//
// The file is not in web_accessible_resources, so only this extension can
// fetch chrome-extension://…/companion.local.json — a web page cannot.
const BUNDLED_CONFIG = 'companion.local.json';
const NOT_CONFIGURED = 'not configured — run the companion setup (companion.cmd, or node extension/setup-companion.mjs): create a token first (your dashboard → Career → Companion → Create token, or your own server\'s config if you self-host), and it writes extension/companion.local.json, which the extension picks up by itself. Or set the server URL and token in the extension options directly.';

const normalizeUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

async function readBundledConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL(BUNDLED_CONFIG), { cache: 'no-store' });
    if (!res.ok) return null;
    const cfg = await res.json();
    const baseUrl = normalizeUrl(cfg && cfg.baseUrl);
    const token = String((cfg && cfg.token) || '').trim();
    return baseUrl && token ? { baseUrl, token } : null;
  } catch {
    return null; // no file (setup has not run in this checkout), or not JSON
  }
}

// The same formula as configFingerprint() in extension/launch.mjs, so setup
// can tell that what storage holds came from the file it wrote.
async function fingerprint(baseUrl, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${baseUrl}\n${token}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Bring storage up to date with the file. `bundledFingerprint` records which
// file contents were last imported: a different file means import again (the
// token was rotated); the same file means leave storage alone, so a value
// saved on the options page survives a worker restart. `rejected` means the
// server just answered 401 for what storage holds, which makes a file that
// differs worth importing even with no record of an earlier import. `force`
// is the options page's "Reload from setup file" button.
async function importBundledConfig({ force = false, rejected = false } = {}) {
  const file = await readBundledConfig();
  if (!file) return { file: false, imported: false };
  const cur = await chrome.storage.local.get({ baseUrl: '', token: '', bundledFingerprint: '' });
  const fp = await fingerprint(file.baseUrl, file.token);
  const differs = cur.baseUrl !== file.baseUrl || cur.token !== file.token;
  if (!differs) {
    if (cur.bundledFingerprint !== fp) await chrome.storage.local.set({ bundledFingerprint: fp });
    return { file: true, imported: false };
  }
  const unconfigured = !cur.baseUrl || !cur.token;
  const fileChanged = Boolean(cur.bundledFingerprint) && cur.bundledFingerprint !== fp;
  if (!(force || unconfigured || fileChanged || rejected)) return { file: true, imported: false };
  await chrome.storage.local.set({ baseUrl: file.baseUrl, token: file.token, bundledFingerprint: fp });
  return { file: true, imported: true };
}

// At every worker start — the first thing a profile that has just loaded this
// directory needs — and on the two events that mean "new browser session" and
// "just (re)loaded", in case nothing else wakes the worker.
importBundledConfig().catch(() => {});
chrome.runtime.onStartup.addListener(() => { importBundledConfig().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { importBundledConfig().catch(() => {}); });

async function api(path, { method = 'GET', body = null, retried = false } = {}) {
  let { baseUrl, token } = await getConfig();
  if (!baseUrl || !token) {
    // Storage is empty in a profile that has only just loaded this directory;
    // the file next to this code is not.
    if ((await importBundledConfig()).imported) ({ baseUrl, token } = await getConfig());
  }
  if (!baseUrl || !token) {
    return { ok: false, error: NOT_CONFIGURED };
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // A rejected token, when the file on disk has moved on (setup --recheck
    // after a rotation), is the file's cue to take over: one retry, then the
    // 401 is reported like any other failure.
    if (res.status === 401 && !retried && (await importBundledConfig({ rejected: true })).imported) {
      return api(path, { method, body, retried: true });
    }
    // Both binary downloads (resume, and item #3's cover-letter PDF) share
    // this shape: base64-encode over the message channel, decode in the
    // content script that actually attaches/downloads the file.
    if (path.includes('/resume') || path.includes('/cover-letter')) {
      const label = path.includes('/cover-letter') ? 'cover letter' : 'resume';
      if (!res.ok) return { ok: false, error: `${label} fetch failed (${res.status})` };
      const buf = await res.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const disposition = res.headers.get('content-disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || (label === 'cover letter' ? 'CoverLetter.pdf' : 'Resume.pdf');
      return { ok: true, b64: btoa(binary), filename, mime: res.headers.get('content-type') || 'application/pdf' };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `request failed (${res.status})`, status: res.status };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: `cannot reach the career-ops server: ${String(err && err.message || err)}` };
  }
}

// ── per-tab state ────────────────────────────────────────────────────────────
// MV3 kills this worker after ~30s idle and restarts it with a blank module
// scope, so per-tab state cannot live in a plain Map: a killed worker would
// forget which tabs carry the engine (dropping late-mounted form iframes on
// the floor) and forget which URLs it already auto-ran (re-firing a fill over
// a half-completed form). chrome.storage.session survives the restart and
// dies with the browser; it is trusted-context-only, so content scripts still
// cannot read it.
const sessionGet = async (key, fallback) => {
  try {
    const got = await chrome.storage.session.get({ [key]: fallback });
    return got[key] ?? fallback;
  } catch {
    return fallback;
  }
};
const sessionSet = (key, value) => chrome.storage.session.set({ [key]: value }).catch(() => {});

const isInjected = async (tabId) => Boolean((await sessionGet('injectedTabs', {}))[tabId]);
const markInjected = async (tabId) => {
  const map = await sessionGet('injectedTabs', {});
  map[tabId] = true;
  await sessionSet('injectedTabs', map);
};
const autoRanUrl = async (tabId) => (await sessionGet('autoRan', {}))[tabId] || null;
const markAutoRan = async (tabId, url) => {
  const map = await sessionGet('autoRan', {});
  map[tabId] = url;
  await sessionSet('autoRan', map);
};

// Same host-family test companion.js's frameTrusted/maybeAutoRun logic uses —
// duplicated here for the same reason TAXONOMY/CONFIRM_RE are duplicated (no
// module system to share it from).
const registrable = (h) => String(h || '').toLowerCase().split('.').slice(-2).join('.');

// ── multi-page linking (items 6/8) ──────────────────────────────────────────
// A tab, once linked to a queue item (by an explicit item= plan load, or the
// Link button), stays linked across every navigation on that tab — the fix
// for "Continue applications remain highly manual". `host` is the origin the
// link was made on, so a later navigation can tell "still this application"
// (same registrable domain, or still ATS-like) from "left for an unrelated
// site" without re-deriving it from the item itself.
const tabLinkOf = async (tabId) => (await sessionGet('tabLink', {}))[tabId] || null;
const setTabLink = async (tabId, item, host) => {
  const m = await sessionGet('tabLink', {});
  m[tabId] = { item, host: host || '', since: Date.now() };
  await sessionSet('tabLink', m);
};
// Clearing the link also clears the per-tab "live-fill next steps" tick —
// the tick's whole meaning is "for the rest of THIS linked application", so
// it cannot outlive the link itself without becoming a stale, silently-armed
// setting on whatever gets linked next.
const clearTabLink = async (tabId) => {
  const m = await sessionGet('tabLink', {});
  delete m[tabId];
  await sessionSet('tabLink', m);
  await setLiveFillNextSteps(tabId, false);
};
const panelOpenOf = async (tabId) => Boolean((await sessionGet('panelOpen', {}))[tabId]);
const setPanelOpenState = async (tabId, open) => {
  const m = await sessionGet('panelOpen', {});
  if (open) m[tabId] = true; else delete m[tabId];
  await sessionSet('panelOpen', m);
};
const liveFillNextStepsOf = async (tabId) => Boolean((await sessionGet('liveFillNextSteps', {}))[tabId]);
const setLiveFillNextSteps = async (tabId, value) => {
  const m = await sessionGet('liveFillNextSteps', {});
  if (value) m[tabId] = true; else delete m[tabId];
  await sessionSet('liveFillNextSteps', m);
};

chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const key of ['injectedTabs', 'autoRan', 'pendingSubmit', 'tabLink', 'panelOpen', 'liveFillNextSteps']) {
    const map = await sessionGet(key, {});
    if (tabId in map) { delete map[tabId]; await sessionSet(key, map); }
  }
});

// ── injection (toolbar click, keyboard command, or auto-run) ────────────────
async function injectCompanion(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['companion.js'],
  });
  await markInjected(tabId);
}

async function openPanel(tab) {
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) return;
  try {
    await injectCompanion(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'companion:toggle' }, { frameId: 0 });
  } catch (err) {
    console.warn('companion inject failed', err);
  }
}

chrome.action.onClicked.addListener(openPanel);
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-panel') return;
  openPanel(tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});

// ── auto-run ─────────────────────────────────────────────────────────────────
// When a page finishes loading on a known ATS host (or anywhere, if the user
// opted in), ask the server whether the URL matches an active queue item. On a
// match: badge the toolbar, inject, open the panel, and run the full fill
// (fields + resume + drafted answers). Filling only — submitting stays with
// the human, always.
const ATS_HOST_RE = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|jobvite\.com|icims\.com|bamboohr\.com|workable\.com|workablecdn\.com|recruitee\.com|teamtailor\.com|breezy\.hr|applytojob\.com|jazz\.co|pinpointhq\.com|dover\.com|rippling\.com|ripplinghq\.com|gem\.com)$/i;

const hostMatches = (url) => {
  try { return ATS_HOST_RE.test(new URL(url).hostname); } catch { return false; }
};

// tabs.onUpdated and webNavigation.onHistoryStateUpdated routinely both fire
// for the same SPA load. The persisted autoRan check sits behind an await, so
// on its own it is a check-then-set race: both callers would pass it before
// either recorded anything. This synchronous in-memory claim closes that
// window; the persisted record closes the worker-restart window.
const inflight = new Set();

async function maybeAutoRun(tabId, url) {
  if (!/^https?:/.test(url || '')) return;
  const claim = `${tabId}\n${url}`;
  if (inflight.has(claim)) return;
  inflight.add(claim);
  try {
    // Multi-page relink (items 6/8), checked BEFORE the ordinary URL-match
    // gate below: a tab already linked to a queue item re-fetches THAT
    // item's plan on every navigation, so a Continue/next-step page never
    // asks the candidate to re-link. This is independent of autoRun/
    // autoRunAll — once a candidate has linked a page (deliberately, or via
    // the URL-match gate once), later steps of the SAME application keep
    // filling regardless of those settings, the same way a manually opened
    // panel would.
    const link = await tabLinkOf(tabId);
    if (link && link.item) {
      let stillLinked = hostMatches(url);
      if (!stillLinked) {
        try { stillLinked = registrable(new URL(url).hostname) === registrable(link.host); } catch { stillLinked = false; }
      }
      if (stillLinked) {
        const plan = await api(`/api/companion/plan?url=${encodeURIComponent(url)}&item=${encodeURIComponent(link.item)}`);
        if (plan && plan.ok && plan.mode === 'item') {
          await injectCompanion(tabId);
          const reopen = await panelOpenOf(tabId);
          await chrome.tabs.sendMessage(tabId, { type: 'companion:autorun', relink: true, item: link.item, reopen }, { frameId: 0 }).catch(() => {});
          return;
        }
        // A 404 means the item itself is gone (deleted, or no longer owned
        // by this actor) — clear the stale link and fall through to a fresh
        // URL match below. Anything else (server unreachable, a timeout) is
        // treated as transient: keep the link and retry on the NEXT
        // navigation, rather than re-linking to a possibly WRONG item mid-
        // application just because this one request failed.
        if (plan && plan.status === 404) await clearTabLink(tabId);
        else return;
      }
      // The tab left both the ATS-host pattern and the linked item's own
      // registrable domain — the link no longer describes what is on
      // screen, so it is cleared and this navigation falls through to the
      // ordinary URL-match gate below like an unlinked tab.
      await clearTabLink(tabId);
    }
    const { autoRun, autoRunAll } = await getSettings();
    if (!autoRun) return;
    if (await autoRanUrl(tabId) === url) return;
    if (!autoRunAll && !hostMatches(url)) return;
    const plan = await api(`/api/companion/plan?url=${encodeURIComponent(url)}`);
    // Unconfigured or server down — stay silent AND stay unrecorded, so a
    // later navigation retries instead of writing the URL off permanently.
    if (!plan || !plan.ok) return;
    await markAutoRan(tabId, url);
    try {
      await chrome.action.setBadgeText({ tabId, text: plan.mode === 'item' ? '✓' : '' });
    } catch { /* tab already gone */ }
    if (plan.mode !== 'item') return;
    await injectCompanion(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'companion:autorun' }, { frameId: 0 });
  } catch (err) {
    console.warn('companion auto-run failed', err);
  } finally {
    inflight.delete(claim);
  }
}

// ── submission detection ─────────────────────────────────────────────────────
// The content script reports two things: an INTENT (the candidate clicked the
// form's own Submit) and, if the page stays put, a CONFIRMATION. When the
// submit navigates away instead, the content script dies with the document and
// this worker is the only thing left that can confirm — hence the pending
// record and the post-navigation probe below.
//
// Nothing here submits anything; it reports what the candidate already did.
// Keep CONFIRM_RE identical to the copy in companion.js — a test asserts it.
const CONFIRM_RE = /(thank you for (your interest|applying|your application|submitting)|thanks for applying|application (has been |was )?(received|submitted|successful)|application complete|we('ve| have) received your application|your application (has been |was )?(sent|received|submitted)|successfully (submitted|applied)|submission (was )?successful|you have (successfully )?(applied|submitted))/i;
// A confirmation the phrase check missed, read off the destination URL. Kept
// tight on purpose: "/apply/complete" counts, a stray "success" query param
// does not, and a bare /apply never does.
const CONFIRM_URL_RE = /(confirmation|thank[-_]?you|application[-_/]?(received|complete|submitted)|apply[-_/]?(complete|success|thanks))/i;
const PENDING_TTL_MS = 5 * 60 * 1000;

// A detected submit the server would not take is the outcome the candidate must
// never be left to guess at: on screen it is identical to "the detector never
// fired", and the fix — one click on the dashboard's Mark as applied — is only
// obvious to someone who knows it happened.
async function announceReportFailure(tabId, error, willRetry) {
  console.warn('companion: could not record the submit', error);
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c01c28' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
  } catch { /* tab already gone */ }
  chrome.tabs.sendMessage(
    tabId,
    { type: 'companion:appliedFailed', error: String(error).slice(0, 200), will_retry: willRetry },
    { frameId: 0 },
  ).catch(() => {});
}

// Report a submit exactly once per queue item: a confirmation page that
// reloads, or the in-page watcher racing the post-navigation probe, must not
// POST twice. (The server is idempotent too — this just keeps the log honest.)
//
// A FAILED report keeps its pending record. Clearing it up front — as this did
// until now — meant one unreachable-autopilot moment lost the submit for good:
// probeSubmitLanding returns early without a pending record, so nothing retried
// and the only trace was a console.warn inside a service worker nobody opens.
// "It only sometimes marks them applied" was this. The record now survives
// until the POST actually lands, so the next navigation on that tab retries,
// and a failure is announced instead of swallowed.
const MAX_REPORT_ATTEMPTS = 5;

async function clearPendingSubmit(tabId) {
  if (tabId == null) return;
  const pending = await sessionGet('pendingSubmit', {});
  if (tabId in pending) { delete pending[tabId]; await sessionSet('pendingSubmit', pending); }
}

async function reportApplied(tabId, item, evidence) {
  if (!item) return { ok: false, error: 'no item' };
  const done = await sessionGet('appliedItems', {});
  if (done[item]) {
    await clearPendingSubmit(tabId);
    if (tabId != null) await clearTabLink(tabId);
    return { ok: true, already_reported: true };
  }
  const res = await api('/api/companion/submitted', {
    method: 'POST',
    body: { item, evidence: evidence || '' },
  });
  if (!res || !res.ok) {
    const error = (res && res.error) || 'the career-ops server did not accept the submit';
    // Count the attempt on the pending record, so an autopilot that stays down
    // for the whole TTL does not re-POST on every SPA route change.
    let attempts = MAX_REPORT_ATTEMPTS;
    if (tabId != null) {
      const pending = await sessionGet('pendingSubmit', {});
      const record = pending[tabId];
      if (record) {
        record.attempts = (record.attempts || 0) + 1;
        record.last_error = String(error).slice(0, 200);
        // Keep the CONFIRMATION evidence, not the intent evidence the record
        // was created with — a retry must report the signal that qualified.
        record.confirmed_evidence = String(evidence || '').slice(0, 160);
        attempts = record.attempts;
        if (attempts >= MAX_REPORT_ATTEMPTS) delete pending[tabId];
        await sessionSet('pendingSubmit', pending);
      }
    }
    await announceReportFailure(tabId, error, attempts < MAX_REPORT_ATTEMPTS);
    return res || { ok: false, error };
  }
  await clearPendingSubmit(tabId);
  // A submitted application should not keep re-filling if the tab is
  // reopened or the candidate navigates back — the link (and its per-tab
  // live-fill-next-steps tick) is cleared the moment a submit is confirmed.
  if (tabId != null) await clearTabLink(tabId);
  done[item] = true;
  await sessionSet('appliedItems', done);
  try {
    // Back to green: a previous attempt may have left this tab's badge red.
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#26a269' });
    await chrome.action.setBadgeText({ tabId, text: '✔' });
  } catch { /* tab gone */ }
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'companion:appliedRecorded', ...res }, { frameId: 0 })
      .catch(() => {});
  }
  return res;
}

// The page the submit navigated to. The intent already happened; this decides
// whether the landing page is a confirmation.
async function probeSubmitLanding(tabId, url) {
  const pending = (await sessionGet('pendingSubmit', {}))[tabId];
  if (!pending) return;
  if (Date.now() - pending.ts > PENDING_TTL_MS) {
    const map = await sessionGet('pendingSubmit', {});
    delete map[tabId];
    await sessionSet('pendingSubmit', map);
    return;
  }
  if (url === pending.url) return; // same page — the in-page watcher owns it
  let phrase = null;
  try {
    // The function is serialized, so it carries no closure — the pattern goes
    // over as an argument rather than being duplicated here.
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (source) => {
        const text = String(document.body ? document.body.innerText : '')
          .replace(/\s+/g, ' ').trim().slice(0, 20000);
        const m = text.match(new RegExp(source, 'i'));
        return m ? m[0] : null;
      },
      args: [CONFIRM_RE.source],
    });
    phrase = hit && hit.result;
  } catch { /* unscriptable page (chrome://, PDF viewer, closed tab) */ }
  if (!phrase && !CONFIRM_URL_RE.test(url)) return;
  await reportApplied(tabId, pending.item, phrase ? `page says "${phrase.slice(0, 80)}"` : `landed on ${url.slice(0, 120)}`);
}

// A report that failed while the candidate stayed put on the confirmation page
// has no further navigation to ride. Returning to the tab is the other thing
// that reliably happens after submitting, so it is the second retry trigger.
// Only records that already FAILED a report qualify: a bare intent has not been
// confirmed yet, and reporting one on its own is exactly the false Applied this
// detector is built to avoid.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const record = (await sessionGet('pendingSubmit', {}))[tabId];
    if (!record || !record.attempts) return;
    if (Date.now() - record.ts > PENDING_TTL_MS) return;
    await reportApplied(tabId, record.item, record.confirmed_evidence || record.evidence || '');
  } catch { /* nothing left to retry against */ }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') {
    probeSubmitLanding(tabId, tab.url || '').catch(() => {});
    maybeAutoRun(tabId, tab.url || '');
  }
});
// SPA ATSes (Ashby, Workday) navigate via pushState — no 'complete' event.
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  probeSubmitLanding(tabId, url).catch(() => {});
  maybeAutoRun(tabId, url);
});
// ATS forms often live in iframes mounted AFTER page load (Greenhouse embeds,
// "Apply" buttons that reveal the form). Late frames get the engine injected,
// and the panel is told WHICH frame so it can replay the fill into that frame
// alone — replaying into every frame would stomp edits the candidate made in
// frames that were already filled.
chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId }) => {
  if (frameId === 0 || !(await isInjected(tabId))) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['companion.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'companion:frameAdded', frameId }, { frameId: 0 });
  } catch { /* frame vanished or is unscriptable */ }
});

chrome.action.setBadgeBackgroundColor({ color: '#26a269' });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    switch (msg.type) {
      // Panel → backend
      case 'companion:getPlan': {
        // title/h1/company (item #8): hints for the plan route's
        // rankCandidates() when no hard URL match exists, sent by the panel
        // from quickPageHints() — never sent alongside an explicit item id
        // (loadPlan only computes them for an itemless load).
        const params = new URLSearchParams({ url: msg.url || '' });
        if (msg.item) params.set('item', msg.item);
        if (msg.title) params.set('title', msg.title);
        if (msg.h1) params.set('h1', msg.h1);
        if (msg.company) params.set('company', msg.company);
        sendResponse(await api(`/api/companion/plan?${params.toString()}`));
        break;
      }
      // company/role/jd_excerpt are the page's own hints (companion.js's
      // draftJobHints), forwarded so an ITEMLESS draft — the extension's
      // everyday shape, no queue item yet — still knows which employer the
      // question is about. Without them the route saw a blank company name
      // and could neither research it nor let the model write "why them".
      case 'companion:getDraft':
        sendResponse(await api('/api/companion/draft', {
          method: 'POST',
          body: {
            questions: msg.questions, item: msg.item || null,
            company: msg.company || '', role: msg.role || '', jd_excerpt: msg.jd_excerpt || '',
            // The page the draft is FOR — the server records answers into the
            // per-application ledger keyed off the item, but also stamps the
            // page url on each recorded entry (application-answers.mjs's
            // page_url) so a later review can tell which form a Q/A pair came
            // from even across a multi-step ATS flow.
            url: msg.url || '',
            // async:true routes the server onto its job-queue path (202 +
            // {job}) instead of holding the request open for the whole
            // drafting call — companion.js's requestDraft() sends this and
            // then polls companion:getDraftJob below. Forwarded verbatim so
            // an old panel build (no async field) keeps the prior
            // synchronous shape with no change on this end.
            async: msg.async === true,
          },
        }));
        break;
      // Poll a job started by the getDraft call above (async:true). Same
      // shape as companion:getRequest just below — an id in, the server's
      // own job status/body out, untouched.
      case 'companion:getDraftJob':
        sendResponse(await api(`/api/companion/draft?id=${encodeURIComponent(msg.id || '')}`));
        break;
      // Per-application answer memory (the AI tab's "Remembered answers"
      // section) — the server-side ledger every draft/live-fill call already
      // writes into; these three just read/edit/delete it. Query params on
      // the DELETE (not a body) on purpose: some proxies strip a DELETE body,
      // the same reason /forget above had to accept POST instead.
      case 'companion:getAnswers':
        sendResponse(await api(`/api/companion/answers${msg.item ? `?item=${encodeURIComponent(msg.item)}` : ''}`));
        break;
      case 'companion:saveAnswer':
        sendResponse(await api('/api/companion/answers', {
          method: 'POST',
          body: {
            item: msg.item, id: msg.id || null, question: msg.question || '',
            answer: msg.answer == null ? null : String(msg.answer), used: msg.used === true,
          },
        }));
        break;
      case 'companion:deleteAnswer':
        sendResponse(await api(`/api/companion/answers?item=${encodeURIComponent(msg.item)}&id=${encodeURIComponent(msg.id)}`, { method: 'DELETE' }));
        break;
      case 'companion:getResume':
        sendResponse(await api(`/api/companion/resume${msg.item ? `?item=${encodeURIComponent(msg.item)}` : ''}`));
        break;
      // Item #3's fetch half — a real cover-letter PDF, same binary shape as
      // getResume (api() routes both through its /resume-or-cover-letter
      // binary branch below).
      case 'companion:getCoverLetter':
        sendResponse(await api(`/api/companion/cover-letter${msg.item ? `?item=${encodeURIComponent(msg.item)}` : ''}`));
        break;
      // Item #8's explicit "link this page" path — the cross-session case
      // (a browser restart clears chrome.storage.session's own tabLink; the
      // URL alone, maybe now on a later Continue step, has to re-find the
      // item via the server's stored link_aliases next time).
      case 'companion:link':
        sendResponse(await api('/api/companion/link', { method: 'POST', body: { item: msg.item, url: msg.url } }));
        break;
      // Live fill (item #11) — the ONE route that ever calls a model without
      // the candidate reviewing every field first; gated server-side on tier
      // and the daily cap, never here.
      case 'companion:liveFill':
        sendResponse(await api('/api/companion/live-fill', {
          method: 'POST',
          body: { item: msg.item || null, url: msg.url || '', page: msg.page || {}, form: msg.form || [] },
        }));
        break;
      // Admin-only "KB context: on/off" indicator (§2.10's note: the
      // autopilot cannot compute this from `plan` itself, since it has no
      // visibility into whether ChunkyLink's AMA index actually exists).
      case 'companion:getKbStatus':
        sendResponse(await api('/api/companion/kb-status'));
        break;
      // Multi-page link persistence (items 6/8) — chrome.storage.session,
      // trusted-context-only, so the panel (a content script) round-trips
      // through the worker rather than touching it directly.
      case 'companion:setTabLink':
        if (tabId != null && msg.item) await setTabLink(tabId, msg.item, msg.host || '');
        sendResponse({ ok: true });
        break;
      case 'companion:clearTabLink':
        if (tabId != null) await clearTabLink(tabId);
        sendResponse({ ok: true });
        break;
      case 'companion:setPanelOpen':
        if (tabId != null) await setPanelOpenState(tabId, Boolean(msg.open));
        sendResponse({ ok: true });
        break;
      case 'companion:getLiveFillNextSteps':
        sendResponse({ ok: true, value: tabId != null ? await liveFillNextStepsOf(tabId) : false });
        break;
      case 'companion:setLiveFillNextSteps':
        if (tabId != null) await setLiveFillNextSteps(tabId, Boolean(msg.value));
        sendResponse({ ok: true });
        break;
      // Panel position/collapse (item #7) — chrome.storage.local, per-origin,
      // survives a worker restart AND a browser restart (unlike the
      // session-scoped state above).
      case 'companion:getPanelPos': {
        const all = await chrome.storage.local.get({ panelPos: {} });
        sendResponse({ ok: true, pos: (all.panelPos || {})[msg.origin] || null });
        break;
      }
      case 'companion:setPanelPos': {
        const all = await chrome.storage.local.get({ panelPos: {} });
        const panelPos = all.panelPos || {};
        panelPos[msg.origin] = { top: msg.top, left: msg.left };
        await chrome.storage.local.set({ panelPos });
        sendResponse({ ok: true });
        break;
      }
      case 'companion:resetPanelPos': {
        const all = await chrome.storage.local.get({ panelPos: {} });
        const panelPos = all.panelPos || {};
        delete panelPos[msg.origin];
        await chrome.storage.local.set({ panelPos });
        sendResponse({ ok: true });
        break;
      }
      case 'companion:getPanelCollapsed': {
        const all = await chrome.storage.local.get({ panelCollapsed: {} });
        sendResponse({ ok: true, collapsed: Boolean((all.panelCollapsed || {})[msg.origin]) });
        break;
      }
      case 'companion:setPanelCollapsed': {
        const all = await chrome.storage.local.get({ panelCollapsed: {} });
        const panelCollapsed = all.panelCollapsed || {};
        if (msg.collapsed) panelCollapsed[msg.origin] = true; else delete panelCollapsed[msg.origin];
        await chrome.storage.local.set({ panelCollapsed });
        sendResponse({ ok: true });
        break;
      }
      case 'companion:testConnection':
        sendResponse(await api('/api/companion/plan?url='));
        break;
      case 'companion:getSettings':
        sendResponse(await getSettings());
        break;
      // Options page (and setup's verification pass): re-read the setup file.
      // `force` makes the file win over whatever storage holds — the repair
      // for a profile that ended up with stale or hand-typed values. Answers
      // with the token's length, never the token.
      case 'companion:importConfig': {
        const result = await importBundledConfig({ force: Boolean(msg.force) });
        const cfg = await chrome.storage.local.get({ baseUrl: '', token: '', bundledFingerprint: '' });
        sendResponse({
          ok: true,
          ...result,
          baseUrl: cfg.baseUrl || null,
          tokenLength: (cfg.token || '').length,
          bundledFingerprint: cfg.bundledFingerprint || null,
        });
        break;
      }
      // Field memory: what the companion has learned from filled-in forms.
      // Observations arrive from the engine as the candidate confirms or edits
      // a prefilled value; the panel reads and manages the learned set from
      // here. Learned values fill FORMS only — they must never become CV or
      // cover-letter content (see AGENTS.md).
      case 'companion:observe':
        sendResponse(await api('/api/companion/observe', {
          method: 'POST',
          body: { item: msg.item || null, url: msg.url || '', observations: msg.observations || [] },
        }));
        break;
      case 'companion:getLearned':
        sendResponse(await api('/api/companion/field-memory'));
        break;
      case 'companion:forgetLearned':
        sendResponse(await api('/api/companion/forget', { method: 'DELETE', body: { key: msg.key || null } }));
        break;
      // Copies one learned value into the profile proper. The server writes
      // data/user-profile.json via saveUserProfile()/saveUserProfileFor() —
      // config/profile.yml is never machine-written.
      case 'companion:promoteField':
        sendResponse(await api('/api/companion/promote', { method: 'POST', body: { key: msg.key } }));
        break;
      // "Process this page": hand a posting the scanners never found to the
      // pipeline. Fire-and-forget by design — the server queues it and the
      // candidate closes the tab.
      case 'companion:processPage':
        sendResponse(await api('/api/companion/process', {
          method: 'POST',
          // `capture` is what the panel read off the live tab (JD text, visible
          // questions) — the server's fallback when it cannot fetch the posting
          // itself (custom career pages, JS shells). Job-description input only.
          body: { url: msg.url || '', title: msg.title || '', company: msg.company || '', capture: msg.capture || null },
        }));
        break;
      // Panel polling a queued "process this page" request until it is done,
      // so it can load the packaged item's plan and fill without a page reload.
      // "Generate message": the page's message thread / selection + optional
      // context → a drafted reply with a fresh fleet demo key. Draft only.
      case 'companion:generateMessage':
        sendResponse(await api('/api/companion/generate-message', {
          method: 'POST',
          body: { context: msg.context || '', capture: msg.capture || null },
        }));
        break;
      case 'companion:getRequest':
        sendResponse(await api(`/api/companion/request?id=${encodeURIComponent(msg.id || '')}`));
        break;
      // Engine → worker: the candidate clicked the form's own Submit.
      // Recorded, not acted on — confirmation still has to arrive.
      case 'companion:submitIntent': {
        if (tabId != null && msg.item) {
          const pending = await sessionGet('pendingSubmit', {});
          pending[tabId] = {
            item: msg.item,
            url: msg.url || '',
            evidence: String(msg.evidence || '').slice(0, 120),
            ts: Date.now(),
          };
          await sessionSet('pendingSubmit', pending);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'companion:submitConfirmed':
        sendResponse(await reportApplied(tabId, msg.item, msg.evidence));
        break;
      // Panel (top frame) → engines. No frameId broadcasts to every frame; a
      // frameId targets one (the late-mounted-form replay path).
      case 'companion:broadcast':
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, msg.payload, msg.frameId != null ? { frameId: msg.frameId } : undefined)
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      // Any frame's engine → the top frame's panel.
      case 'companion:toTop':
        if (tabId != null) chrome.tabs.sendMessage(tabId, msg.payload, { frameId: 0 }).catch(() => {});
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async sendResponse
});
