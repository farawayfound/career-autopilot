// Looking inside the companion browser from outside it — to verify, never to
// configure.
//
// The companion's normal session is a plain spawn with no debugging channel —
// that is the whole point, because Google's sign-in refuses a browser that
// looks automated. Configuring the extension no longer needs a way in: it
// reads extension/companion.local.json by itself (see launch.mjs). But proving
// that the whole chain works — the file imported, the server reached with the
// token the extension actually holds — still means asking the extension.
//
// So this opens a *throwaway* instance with a debug port, asks, closes it, and
// leaves the candidate's real session to be started cleanly afterwards. The
// port is honoured because these profiles are never Chrome's own default
// user-data-dir — Chrome 136+ ignores the remote-debugging switches when they
// are.
//
// Everything talks to the extension's own options page rather than its
// service worker: an MV3 worker can be asleep when you go looking for it, a
// page cannot, and the page can wake the worker with a message.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { launchArgs, readDevToolsPort } from './launch.mjs';

const PORT_POLL_MS = 250;
const PORT_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` against a temporary, debuggable instance of the companion browser,
 * then shut it down.
 *
 * @param {{browser: string, profileDir: string, startUrl?: string}} opts
 * @param {(ctx: {context: object, browser: object}) => Promise<any>} fn
 * @returns {Promise<any>} whatever `fn` returned
 */
export async function withDebugBrowser({ browser, profileDir, startUrl }, fn) {
  const { chromium } = await import('playwright');

  // A stale port file from an earlier run would connect us to nothing.
  rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });

  const proc = spawn(
    browser,
    launchArgs({ profileDir, startUrl, debugPort: 0 }),
    { stdio: 'ignore' },
  );

  let port = null;
  for (let waited = 0; waited < PORT_TIMEOUT_MS && port === null; waited += PORT_POLL_MS) {
    await sleep(PORT_POLL_MS);
    port = readDevToolsPort(profileDir);
  }
  if (port === null) {
    proc.kill();
    throw new Error('Chrome never opened a debug port. Close any Chrome already running on this profile, then try again.');
  }

  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    return await fn({ context: cdp.contexts()[0], browser: cdp });
  } finally {
    // Close the browser itself, not just our connection, so whatever starts
    // next is a fresh process with no port open.
    try {
      const session = await cdp.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch { proc.kill(); }
    await cdp.close().catch(() => {});
    await new Promise((resolve) => {
      const bail = setTimeout(() => { proc.kill(); resolve(); }, CLOSE_TIMEOUT_MS);
      proc.on('exit', () => { clearTimeout(bail); resolve(); });
    });
  }
}

/** The extension's own options page — reachable, and never asleep. */
export function optionsUrl(extensionId) {
  return `chrome-extension://${extensionId}/options.html`;
}

/** Wait for the options page to be the one we can talk to. */
async function optionsPage(context, extensionId) {
  const url = optionsUrl(extensionId);
  for (let waited = 0; waited < PAGE_TIMEOUT_MS; waited += PORT_POLL_MS) {
    const page = context.pages().find((p) => p.url().startsWith(url));
    if (page) return page;
    await sleep(PORT_POLL_MS);
  }
  // It may simply not have been the start URL — open it ourselves.
  const page = await context.newPage();
  await page.goto(url, { timeout: PAGE_TIMEOUT_MS });
  return page;
}

/**
 * What the extension actually holds, after giving its worker the chance to
 * import the config file. Returns the token's length and fingerprints rather
 * than the token: these values get printed and compared.
 *
 * `bundledFingerprint` is the worker's record of the file it last imported;
 * `storedFingerprint` hashes what storage holds now, with the same formula as
 * configFingerprint() in launch.mjs. Both equal to configFingerprint(conn)
 * means the extension holds what setup wrote AND got it from the file.
 *
 * `reloaded` says the extension was found running pre-setup-file code and was
 * reloaded from disk here; `answered` whether the worker handled the import
 * message at all.
 *
 * @returns {Promise<{baseUrl: string|null, tokenLength: number, storedFingerprint: string|null,
 *   bundledFingerprint: string|null, autoRun: boolean, autoDraft: boolean, autoRunAll: boolean,
 *   reloaded: boolean, answered: boolean}>}
 */
export async function readConfig(context, extensionId, existingPage) {
  let page = existingPage || await optionsPage(context, extensionId);
  // Wakes the worker; it imports the file if storage needs it.
  const ask = () => page.evaluate(() => chrome.runtime.sendMessage({ type: 'companion:importConfig' })
    .catch((err) => ({ ok: false, error: String(err) })));
  let probe = await ask();
  // "unknown message" is the worker running code from before the setup file
  // existed — the profile loaded the extension, then the checkout moved on.
  // Chrome does not re-read a service worker until the extension is reloaded,
  // which is one click on chrome://extensions that nobody knows to make; so
  // make it here. chrome.runtime.reload() is that button. It tears down the
  // options page with everything else, hence the fresh page afterwards.
  let reloaded = false;
  if (probe && probe.ok === false && /unknown message/i.test(probe.error || '')) {
    await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await sleep(2000);
    page = await optionsPage(context, extensionId);
    probe = await ask();
    reloaded = true;
  }
  const stored = await page.evaluate(async () => {
    const cfg = await chrome.storage.local.get({
      baseUrl: '', token: '', bundledFingerprint: '', autoRun: true, autoDraft: true, autoRunAll: false,
    });
    let storedFingerprint = null;
    if (cfg.baseUrl && cfg.token) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${cfg.baseUrl}\n${cfg.token}`));
      storedFingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return {
      baseUrl: cfg.baseUrl || null,
      tokenLength: (cfg.token || '').length,
      storedFingerprint,
      bundledFingerprint: cfg.bundledFingerprint || null,
      autoRun: cfg.autoRun,
      autoDraft: cfg.autoDraft,
      autoRunAll: cfg.autoRunAll,
    };
  });
  return { ...stored, reloaded, answered: Boolean(probe && probe.ok) };
}

/**
 * Ask the extension to call the server exactly the way it will in anger —
 * through its own fetch, with its own stored token. A green result here means
 * the whole chain works, which "curl reached the server" does not.
 *
 * @returns {Promise<{ok: boolean, status: number|null, fields: number, error: string|null}>}
 */
export async function testConnection(context, extensionId) {
  const page = await optionsPage(context, extensionId);
  return page.evaluate(async () => {
    const { baseUrl, token } = await chrome.storage.local.get({ baseUrl: '', token: '' });
    if (!baseUrl || !token) return { ok: false, status: null, fields: 0, error: 'no server URL or token stored' };
    try {
      const res = await fetch(`${baseUrl}/api/companion/plan?url=`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      return {
        ok: res.ok && Boolean(data.ok),
        status: res.status,
        fields: (data.fields || []).length,
        error: res.status === 401 ? 'the token was rejected' : (data.error || null),
      };
    } catch (err) {
      return { ok: false, status: null, fields: 0, error: err.message };
    }
  });
}

/**
 * Whether the candidate is signed in to a site in this profile, judged by
 * cookies rather than by asking them.
 *
 * @returns {Promise<boolean>}
 */
export async function hasCookiesFor(context, url) {
  const cookies = await context.cookies(url).catch(() => []);
  return cookies.length > 0;
}
