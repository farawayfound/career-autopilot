// Options page: server URL + token, saved to chrome.storage.local.
//
// Normally there is nothing to type here. extension/setup-companion.mjs writes
// companion.local.json next to this page and the service worker imports it by
// itself (sw.js). This page shows where the stored values came from, lets them
// be overridden, and can re-import the file on demand — the repair for a
// profile that ended up with stale or hand-typed values.
const $ = (id) => document.getElementById(id);

const setStatus = (text, ok) => {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
};

// Same formula as the worker's import record, so the page can say whether
// the values on screen are the file's or an override.
async function fingerprint(baseUrl, token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${baseUrl}\n${token}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function describeSource({ baseUrl, token, bundledFingerprint }) {
  const el = $('source');
  if (!bundledFingerprint) {
    el.textContent = !baseUrl || !token
      ? 'Not configured. Create a token on your dashboard (Career → Companion → Create token), then paste the server URL and it below — or run the companion setup (companion.cmd, or node extension/setup-companion.mjs) and it fills both in for you.'
      : 'Entered by hand — no setup file has been imported into this profile.';
    return;
  }
  const current = await fingerprint(baseUrl, token);
  el.textContent = current === bundledFingerprint
    ? 'Imported from extension/companion.local.json, which setup wrote. Saving different values here overrides it until setup writes a new file.'
    : 'Overridden here. The setup file (extension/companion.local.json) holds different values — "Reload from setup file" restores them.';
}

async function load() {
  const cfg = await chrome.storage.local.get({
    // autoDraft defaults to false for a FRESH install (this default only ever
    // applies when the key is absent from storage — chrome.storage.local.get
    // never overwrites an existing value with its default) — drafting is now
    // a deliberate AI-tab button, never automatic, so a fresh profile should
    // not carry a stale "on" default forward. See options.html's copy.
    baseUrl: '', token: '', autoRun: true, autoDraft: false, autoRunAll: false, learnFields: false, bundledFingerprint: '',
  });
  $('baseUrl').value = cfg.baseUrl;
  $('token').value = cfg.token;
  $('autoRun').checked = cfg.autoRun;
  $('autoDraft').checked = cfg.autoDraft;
  $('autoRunAll').checked = cfg.autoRunAll;
  $('learnFields').checked = cfg.learnFields;
  await describeSource(cfg);
}

load();

$('save').addEventListener('click', async () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  await chrome.storage.local.set({
    baseUrl,
    token,
    autoRun: $('autoRun').checked,
    autoDraft: $('autoDraft').checked,
    autoRunAll: $('autoRunAll').checked,
    learnFields: $('learnFields').checked,
  });
  setStatus('Saved.', true);
  await load();
});

$('reload').addEventListener('click', async () => {
  setStatus('Reading the setup file…', true);
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'companion:importConfig', force: true });
  } catch (err) {
    setStatus(`Could not reach the extension's service worker (${err.message}) — reload the extension at chrome://extensions.`, false);
    return;
  }
  if (!res || !res.file) {
    setStatus('No companion.local.json next to the extension. Run the companion setup (companion.cmd, or node extension/setup-companion.mjs) in the checkout this extension was loaded from.', false);
    return;
  }
  await load();
  setStatus(`Loaded from the setup file — ${res.baseUrl} (token ${res.tokenLength} characters).`, true);
});

$('test').addEventListener('click', async () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!baseUrl || !token) { setStatus('Enter both the server URL and the token first.', false); return; }
  setStatus('Testing…', true);
  try {
    const res = await fetch(`${baseUrl}/api/companion/plan?url=`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) setStatus(`Connected — profile plan loaded (${(data.fields || []).length} contact fields on file).`, true);
    else if (res.status === 401) setStatus('Server reached, but: token rejected or your CareerOps access is not active.', false);
    else setStatus(`Server error: ${data.error || res.status}`, false);
  } catch (err) {
    setStatus(`Cannot reach ${baseUrl} — is the server up, and the URL right? (${err.message})`, false);
  }
});
