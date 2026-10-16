# Changelog

All notable changes to career-autopilot are documented here. This repository
is a mirror: it is generated from the `extension/` tree and the discovery
node's files inside the private `career-ops` monorepo
(`scripts/system/export-public.mjs`) on every push to its `main` branch, so
entries here track what changed in the companion and the discovery node, not in
the pipeline they talk to.

## [Unreleased]

### Changed

- The extension is now called **CareerAutopilot Companion** (manifest 0.4.5),
  matching the name of the service it connects to. Running `npm run setup`
  again renames the launcher it made before: the old `.lnk` is replaced, and
  on macOS the old app becomes a link to the new one, so a Dock pin keeps
  working. A taskbar pin is never touched. Setup says so and leaves re-pinning
  to you.

### Added

- **The discovery node.** A small program that searches public job boards and
  company career pages for the roles and places you set up on your
  CareerAutopilot Targeting tab, checks the results on your own computer, and
  sends the matches to your own account (your pay answers are never sent to the
  node; your account applies your pay floor when it evaluates the matches).
  Start it by hand with
  `discovery-node.cmd` (Windows), `discovery-node.command` (macOS) or
  `./discovery-node.sh` (Linux), or `npm run discovery`. It asks for a discovery
  token once (created on Targeting → "Discovery on your computer"), then runs in
  that window with a dashboard on this computer only, where you can pause,
  resume or stop it and change what each job does and when. It uses no AI model,
  never submits an application, and installs no service, scheduled task or
  startup entry: closing the window stops it. See `docs/DISCOVERY_NODE.md`.
- This package now has one runtime dependency, `js-yaml`, pinned by
  `package-lock.json`; the discovery node installs it with `npm ci` the first
  time it runs.
- First public mirror of the Career-Ops Companion browser extension: install
  it unpacked, run `npm run setup`, create a token on your dashboard's
  Career → Companion tab (or point it at your own self-hosted server), and
  apply from your own browser. See `docs/USER_GUIDE.md`.
