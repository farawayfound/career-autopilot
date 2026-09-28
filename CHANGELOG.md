# Changelog

All notable changes to career-autopilot are documented here. This repository
is a mirror: it is generated from the `extension/` tree inside the private
`career-ops` monorepo (`scripts/system/export-public.mjs`) on every push to
its `main` branch, so entries here track what changed in the companion, not
in the pipeline it talks to.

## [Unreleased]

### Changed

- The extension is now called **CareerAutopilot Companion** (manifest 0.4.5),
  matching the name of the service it connects to. Running `npm run setup`
  again renames the launcher it made before: the old `.lnk` is replaced, and
  on macOS the old app becomes a link to the new one, so a Dock pin keeps
  working. A taskbar pin is never touched. Setup says so and leaves re-pinning
  to you.

### Added

- First public mirror of the Career-Ops Companion browser extension: install
  it unpacked, run `npm run setup`, create a token on your dashboard's
  Career → Companion tab (or point it at your own self-hosted server), and
  apply from your own browser. See `docs/USER_GUIDE.md`.
