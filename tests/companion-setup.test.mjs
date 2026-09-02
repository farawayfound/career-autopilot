// tests/companion-setup.test.mjs — the double-click launcher contract.
//
// This is the path onto a machine nobody has set up: sync the repo, run one
// thing, get a working browser. Three ways that quietly breaks, all of them
// invisible until someone is standing at the other PC:
//
//   1. A committed token. setup writes the server URL and API token to
//      config/companion.local.json. If .gitignore ever stops covering it, the
//      next `git add -A` publishes a live credential to GitHub.
//   2. A launcher that will not run. companion.command needs LF endings and
//      the executable bit in the index — a CRLF shebang is "bad interpreter"
//      on macOS, and mode 100644 means double-clicking does nothing.
//   3. A broken icon. The .ico is a committed binary; a truncated or
//      single-size file gives a blank or smeared taskbar button, and nobody
//      notices from the machine that generated it.
import { pass, fail, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { flagValue } from '../lib/cli-flags.mjs';

console.log('\ncompanion — one-click setup and launcher');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// ── secrets never reach the repo ────────────────────────────────────────────
{
  const ignored = (rel) => {
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  ok(ignored('config/companion.local.json'),
    'the saved server URL + API token is gitignored (it holds a live credential)');
  ok(ignored('Career-Ops Companion.lnk'),
    'generated .lnk shortcuts are gitignored (they hard-code one machine\'s repo path)');
  ok(git('ls-files', 'config/companion.local.json') === '',
    'no companion.local.json has ever been committed');
  // Setup also writes a copy next to the extension code, because that is the
  // only place the extension itself can read from. Same live token, same rule.
  ok(ignored('extension/companion.local.json'),
    'the copy the extension reads (extension/companion.local.json) is gitignored too');
  ok(git('ls-files', 'extension/companion.local.json') === '',
    'and has never been committed');

  // The token is printed nowhere: setup reports its length, never its value.
  const setup = read('extension/setup-companion.mjs');
  const leaks = [...setup.matchAll(/console\.log\([^)]*\btoken\b[^)]*\)/g)]
    .map((m) => m[0])
    .filter((line) => !/\.length/.test(line));
  ok(leaks.length === 0, `setup never prints the token value (${leaks[0] || 'no bare token in any log line'})`);
  ok(/token: \$\{conn\.token\.length\} characters/.test(setup),
    'setup reports the token by length, which is enough to spot an empty or truncated one');
}

// ── the launchers survive a clone on another OS ─────────────────────────────
{
  ok(existsSync(join(ROOT, 'companion.cmd')), 'companion.cmd exists (Windows double-click)');
  ok(existsSync(join(ROOT, 'companion.command')), 'companion.command exists (macOS/Linux double-click)');

  const mode = git('ls-files', '-s', 'companion.command').split(/\s+/)[0];
  ok(mode === '100755', `companion.command is executable in the index (mode ${mode})`);

  const attrs = read('.gitattributes');
  ok(/companion\.command text eol=lf/.test(attrs),
    'companion.command is pinned to LF (a CRLF shebang is "bad interpreter" on macOS)');

  // Read the blob out of the index, not the working copy: what a fresh clone
  // gets is what matters, and this checkout is on Windows.
  const blob = execFileSync('git', ['show', ':companion.command'], { cwd: ROOT, encoding: 'utf8' });
  ok(!blob.includes('\r\n'), 'the committed companion.command has no CRLF line endings');
  ok(blob.startsWith('#!'), 'companion.command starts with a shebang');

  for (const [file, body] of [['companion.cmd', read('companion.cmd')], ['companion.command', blob]]) {
    ok(/setup-companion\.mjs --launch/.test(body), `${file} runs the setup script with --launch`);
    ok(/node/i.test(body) && /nodejs\.org/.test(body),
      `${file} checks for Node and points at nodejs.org when it is missing`);
  }
}

// ── setup does the whole job ────────────────────────────────────────────────
{
  const setup = read('extension/setup-companion.mjs');
  for (const [what, re] of [
    ['installs dependencies', /npm.*'install'|\['install'\]/],
    ['requires branded Chrome', /Google Chrome is not installed here/],
    ['resolves the server token', /discoverToken/],
    ['verifies the token against the server', /status === 401/],
    ['writes the file the extension reads its config from', /writeBundledConfig\(EXT_DIR, conn\)/],
    ['recognises a copy loaded from another checkout', /findCompanionExtensions\(/],
    ['builds the shortcut', /shortcutSpec\(|shortcutScript\(/],
    ['can launch straight after', /dev-launch\.mjs/],
  ]) {
    ok(re.test(setup), `setup ${what}`);
  }
  // The config used to be pushed into one profile's storage over CDP, which
  // only worked when the extension had been loaded from exactly this checkout
  // and a debug instance could start — otherwise the panel said "not
  // configured". The extension reads the file itself now; CDP is for asking
  // it what it holds, never for telling it.
  ok(!/seedConfig|seedMarkerPath|isSeeded\(/.test(setup),
    'setup never pushes config into the browser — the extension reads extension/companion.local.json by itself');
  ok(setup.indexOf('writeBundledConfig(EXT_DIR, conn)') < setup.indexOf("heading('Extension')"),
    'the file is written BEFORE the load-unpacked step, so the first load is a configured load');
  ok(/profileInUse\(PROFILE\)/.test(setup),
    'setup says up front when a running browser blocks the in-browser check, instead of timing out');
  ok(/CreateShortcut/.test(read('extension/shortcut.mjs')),
    'and the shortcut itself is written by extension/shortcut.mjs');
  // Branded Chrome, and nothing else: it is the only build that can sign in to
  // Google, which is what a Workday candidate account and half the boards need.
  // The Chromium fallback could sign in to none of it, so it was retired rather
  // than left as a trap for whoever hit it first.
  ok(/ignored --load-extension/i.test(setup),
    'setup records why Chrome needs the extension loaded by hand once');

  // Three steps need a person. A wizard that prints instructions and then
  // assumes they were followed is worse than no wizard, so each one re-checks
  // and anything still undone is repeated in the closing summary.
  ok(/function guide\(/.test(setup) && /outstanding\.push/.test(setup),
    'manual steps are guided, re-checked, and collected into a closing summary');
  ok(/--no-prompt/.test(setup) && /INTERACTIVE/.test(setup),
    'setup can run unattended without blocking on a prompt nobody will answer');
  ok(/testConnection/.test(setup),
    "setup verifies through the extension's own fetch, not just its own reachability check");
  ok(/signedInAccounts/.test(setup),
    'setup reports whether the profile is signed in — that is what brings the saved passwords');

  const launcher = read('extension/dev-launch.mjs');
  ok(/config\/companion\.local\.json|companion\.local\.json/.test(launcher),
    'dev-launch.mjs reads the settings setup saved (otherwise a fresh PC re-prompts every run)');
  ok(/bundledConfigCurrent\(/.test(launcher) && /writeBundledConfig\(/.test(launcher),
    'dev-launch.mjs keeps extension/companion.local.json in step with them, so a rotated token reaches the extension on its next start');
  ok(/findCompanionExtensions\(/.test(launcher),
    'dev-launch.mjs launches a copy loaded from another checkout too, and keeps THAT directory\'s file current');
}

// ── --server / COMPANION_URL always wins, even when a token auto-discovers ──
// Regression: discoverToken() used to return the fleet-hints or local-yml
// branch's OWN baseUrl verbatim whenever either found a token, silently
// discarding an explicitly-passed --server/COMPANION_URL — exactly the case
// a self-hoster whose autopilot listens on a LAN address (not 127.0.0.1, not
// this fleet's own tailnet IP) needs. Runs the REAL discoverToken() extracted
// out of the shipped source (never a copy) against controlled stubs for every
// free variable it closes over — the same technique
// tests/companion-extension.test.mjs uses to exercise a function without
// importing the whole side-effecting script.
{
  const setup = read('extension/setup-companion.mjs');
  const start = setup.indexOf('function discoverToken()');
  if (start < 0) throw new Error('function discoverToken() not found in extension/setup-companion.mjs');
  let depth = 0;
  let end = -1;
  for (let j = setup.indexOf('{', start); j < setup.length; j += 1) {
    if (setup[j] === '{') depth += 1;
    else if (setup[j] === '}') { depth -= 1; if (depth === 0) { end = j; break; } }
  }
  const fnSrc = setup.slice(start, end + 1);

  /**
   * Run the extracted discoverToken() body against fabricated stubs.
   * @param {Record<string,string>} env - process.env
   * @param {string[]} args - argv
   * @param {{discoverToken: Function}|null} hints - fleetHints
   * @param {{path: string, content: string}|null} cfg - the one local-yml file that "exists"
   */
  const runDiscoverToken = (env, args, hints, cfg) => {
    const factory = new Function( // eslint-disable-line no-new-func -- extracting shipped source for a real (not regex) behavioural test, same technique as tests/companion-extension.test.mjs
      'process', 'flagValue', 'argv', 'fleetHints', 'existsSync', 'readFileSync', 'path', 'REPO', 'DEFAULT_URL',
      `${fnSrc}\nreturn discoverToken();`,
    );
    return factory(
      { env },
      flagValue,
      args,
      hints,
      (p) => Boolean(cfg) && p === cfg.path,
      () => cfg?.content ?? '',
      { join: (...parts) => parts.join('/') },
      '/repo',
      'https://davidchui.work',
    );
  };

  // Case 1: fleet-hints finds a token AND names a server of its own — an
  // explicit --server must still win, keeping the discovered token.
  const viaFleet = runDiscoverToken({}, ['--server', 'http://10.20.30.40:8377'],
    { discoverToken: () => ({ token: 'fleet-token', baseUrl: 'http://198.51.100.9:8377', from: 'ssh some-other-box' }) },
    null);
  ok(viaFleet.baseUrl === 'http://10.20.30.40:8377' && viaFleet.token === 'fleet-token',
    `--server overrides the URL fleet-hints.mjs discovered, keeping its token (got ${JSON.stringify(viaFleet)})`);

  // Case 2: no fleet-hints; a local config/autopilot.local.yml supplies a
  // token — an explicit COMPANION_URL must still win over the hardcoded
  // 127.0.0.1 loopback that branch otherwise always returns.
  const viaLocalCfg = runDiscoverToken({ COMPANION_URL: 'http://10.20.30.40:8377' }, [], null,
    { path: '/repo/config/autopilot.local.yml', content: 'token: local-token\n' });
  ok(viaLocalCfg.baseUrl === 'http://10.20.30.40:8377' && viaLocalCfg.token === 'local-token',
    `COMPANION_URL overrides the loopback URL a local autopilot.local.yml implies, keeping its token (got ${JSON.stringify(viaLocalCfg)})`);

  // Case 3: nothing explicit given — the ordinary no-flag path is unchanged.
  const viaLocalCfgDefault = runDiscoverToken({}, [], null,
    { path: '/repo/config/autopilot.local.yml', content: 'token: local-token\n' });
  ok(viaLocalCfgDefault.baseUrl === 'http://127.0.0.1:8377',
    `with no --server/COMPANION_URL, the local-machine default (127.0.0.1:8377) is unchanged (got ${viaLocalCfgDefault.baseUrl})`);
}

// ── the icon is a real multi-size ICO ───────────────────────────────────────
{
  const ico = readFileSync(join(ROOT, 'assets', 'career-ops.ico'));
  ok(ico.length > 2000, `the icon has real content (${ico.length} bytes)`);
  ok(ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, 'assets/career-ops.ico has a valid ICO header');

  const count = ico.readUInt16LE(4);
  ok(count >= 4, `it ships several sizes (${count}) — Windows picks per surface, taskbar to alt-tab`);

  let smallest = 999;
  let largest = 0;
  let intact = true;
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    smallest = Math.min(smallest, size);
    largest = Math.max(largest, size);
    // Every entry must point at a whole PNG that is actually inside the file.
    const png = ico.subarray(offset, offset + bytes);
    if (offset + bytes > ico.length || png.length !== bytes
      || png.readUInt32BE(0) !== 0x89504e47 || png.subarray(bytes - 8, bytes - 4).toString('ascii') !== 'IEND') {
      intact = false;
    }
  }
  ok(intact, 'every icon entry points at a complete PNG inside the file (no truncation)');
  ok(smallest <= 16, `it includes a 16px entry for the taskbar (smallest ${smallest}px)`);
  ok(largest >= 256, `it includes a 256px entry for large views (largest ${largest}px)`);
  ok(existsSync(join(ROOT, 'scripts', 'system', 'make-icon.mjs')),
    'the icon can be regenerated (scripts/system/make-icon.mjs) rather than being an unexplained binary');
}
