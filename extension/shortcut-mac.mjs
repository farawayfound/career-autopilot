// What the "Career-Ops Companion" app bundle launches — the macOS analog of
// shortcut.mjs, which renders the Windows .lnk.
//
// macOS has no .lnk. The Dock pins applications, and an application is a
// directory with a known shape: Contents/Info.plist naming an executable,
// the executable itself, an .icns for the icon. A shell script is a perfectly
// legal executable for one, and LaunchServices runs it with no Terminal
// window — which is exactly the property the Windows fast target exists for.
//
// The same two targets as Windows, decided the same way:
//
//   fast    have LaunchServices open branded Chrome (`open -n Chrome.app
//           --args …`) with the same arguments dev-launch would have spawned.
//           No Terminal, no Node, no server round-trip.
//
// Why `open -n` and not `exec` of the Chrome binary: when a bundle's shell
// script execs the binary, macOS keeps the resulting process tree in the
// background scheduling band it gave the script — the browser stays visible
// and focused, but every renderer runs ~5× slower (pure-CPU 202 ms vs 37 ms
// for the same loop; boards.greenhouse.io took 38 s to load instead of 0.5 s,
// the same on every run). Not the profile, not the extension, not the
// network — the launch. Handing the launch back to LaunchServices makes
// Chrome the application being opened, and it gets the foreground priority
// its own Dock icon would. Measured in the session that found it; the test
// guards the shape so it cannot quietly regress.
//   setup   open Terminal on companion.command. Setup is interactive — it may
//           ask for the token and it walks the manual steps — so it needs a
//           real terminal, and companion.command is the entry point that
//           already exists for one.
//
// Unlike Windows, rewriting the bundle in place is safe: the Dock pins by
// path, not by a registry blob, so a pinned app keeps working when setup
// flips its launcher from the setup target to the fast one. What must stay
// stable is CFBundleIdentifier — LaunchServices caches by it, and changing it
// turns the next write into a brand-new app — so the plist is rendered
// constant and only the launcher script varies.
//
// Everything here is pure: it decides and renders, it does not write.
// extension/setup-companion.mjs owns the writes. Guarded by
// tests/companion-shortcut-mac.test.mjs.
import path from 'node:path';
import { launchArgs } from './launch.mjs';

/** The bundle's directory name, in the repo root (and symlinked wherever else). */
export const APP_BUNDLE_NAME = 'Career-Ops Companion.app';

/**
 * Never change this. The Dock survives a rewrite because the path is stable;
 * LaunchServices survives it because this is.
 */
export const BUNDLE_ID = 'work.davidchui.career-ops.companion';

/**
 * Quote one argument for a bash command line: wrap in single quotes, and end,
 * escape, reopen around any single quote in the value. Nothing else needs
 * escaping inside single quotes — not spaces, not backslashes, not `$`.
 *
 * @param {string} arg
 * @returns {string}
 */
export function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a string for an XML text node. A repo path with an `&` (or a future
 * name with `<`) would otherwise end the plist early.
 *
 * @param {string} s
 * @returns {string}
 */
export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Decide what the app bundle should launch. Same contract as shortcutSpec():
 * `ready` means the extension is loaded in the profile and the config file it
 * reads (extension/companion.local.json) is current, so a launch has nothing
 * left to do.
 *
 * @param {{browser: string|null, repo: string, profileDir: string, startUrl: string,
 *          ready: boolean}} opts
 * @returns {{kind: string, exec: string[], description: string, why: string}}
 */
export function appBundleSpec({ browser, repo, profileDir, startUrl, ready }) {
  const setup = {
    kind: 'setup',
    // Terminal on companion.command, not the script bare: setup asks
    // questions and waits on Enter, and LaunchServices gives a bundle's
    // executable no terminal to do that in.
    exec: ['open', '-a', 'Terminal', path.join(repo, 'companion.command')],
    description: 'Set up and launch the Career-Ops Companion browser',
    why: ready
      ? 'the fast target needs a browser this launcher can spawn directly'
      : 'the extension is not loaded in the profile yet, so a launch still has work to do',
  };
  if (!ready || !browser) return setup;

  const args = launchArgs({ profileDir, startUrl });
  const bundle = appBundleOf(browser);
  return {
    kind: 'fast',
    // `-n` opens a new instance even while the candidate's everyday Chrome is
    // running; the new process then meets the companion profile's singleton
    // and forwards to the live session if there is one — so a second click on
    // the pin still behaves like reopening the app. A browser that is not an
    // .app (there is none on a Mac today) is exec'd as before.
    exec: bundle
      ? ['open', '-n', bundle, '--args', ...args]
      : [browser, ...args],
    description: 'Career-Ops Companion — the browser your applications are filled in',
    why: 'the extension is loaded and its config file is current, so there is nothing to do but open the browser',
  };
}

/**
 * The .app bundle a macOS binary lives in — `/Applications/Google
 * Chrome.app` for its `Contents/MacOS/Google Chrome` — or null when the path
 * is not inside one. What `open` needs, since it opens applications, not
 * executables.
 *
 * @param {string} binary
 * @returns {string|null}
 */
export function appBundleOf(binary) {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(binary));
  return m ? m[1] : null;
}

/**
 * The launcher the bundle executes. `exec` rather than spawn-and-exit, so the
 * script never lingers: for the fast target it becomes `open`, which returns
 * as soon as LaunchServices has started Chrome; for setup it becomes the
 * Terminal launch.
 *
 * @param {{exec: string[], kind: string, why: string}} spec
 * @returns {string}
 */
export function launcherScript(spec) {
  return [
    '#!/bin/bash',
    `# Career-Ops Companion — ${spec.kind} target: ${spec.why}`,
    '# Written by extension/setup-companion.mjs; rerunning setup refreshes it in place.',
    `exec ${spec.exec.map(shellQuote).join(' ')}`,
    '',
  ].join('\n');
}

/**
 * The bundle's Info.plist. Deliberately constant across setup/fast — see the
 * header — which is why the spec is not a parameter.
 *
 * @param {{iconBaseName?: string, version?: string}} [opts]
 * @returns {string}
 */
export function infoPlist({ iconBaseName = 'career-ops', version = '1.0' } = {}) {
  const entries = [
    ['CFBundleName', 'Career-Ops Companion'],
    ['CFBundleDisplayName', 'Career-Ops Companion'],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleExecutable', 'launcher'],
    ['CFBundleIconFile', iconBaseName],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    ['LSMinimumSystemVersion', '11.0'],
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map(([k, v]) => `\t<key>${xmlEscape(k)}</key>\n\t<string>${xmlEscape(v)}</string>`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * Every text file the bundle holds, as {path, content, mode} relative to the
 * bundle root. The icon is a committed binary (assets/career-ops.icns), so the
 * writer copies it to Contents/Resources/ rather than this module carrying it.
 *
 * @param {{spec: object, iconBaseName?: string, version?: string}} opts
 * @returns {{path: string, content: string, mode: number}[]}
 */
export function bundleFiles({ spec, iconBaseName = 'career-ops', version = '1.0' }) {
  return [
    { path: 'Contents/Info.plist', content: infoPlist({ iconBaseName, version }), mode: 0o644 },
    // Legacy but harmless, and some tools still read it before the plist.
    { path: 'Contents/PkgInfo', content: 'APPL????', mode: 0o644 },
    { path: 'Contents/MacOS/launcher', content: launcherScript(spec), mode: 0o755 },
  ];
}
