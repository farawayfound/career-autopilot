#!/usr/bin/env bash
# Career-Ops Companion — double-clickable launcher (macOS, Linux).
#
# macOS: double-click in Finder, or drag onto the Dock.
# Linux: run setup once; it writes career-ops-companion.desktop next to this
#        file for the applications menu.
#
# First run installs dependencies, finds Chrome, and asks for the server
# URL + token once. Every run after that goes straight to the browser.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed, or it is not on PATH."
  echo "  Install the LTS build from https://nodejs.org, then run this again."
  echo
  read -r -p "  Press Enter to close." _
  exit 1
fi

if ! node extension/setup-companion.mjs --launch "$@"; then
  echo
  echo "  Setup or launch did not finish - the message above says why."
  echo
  read -r -p "  Press Enter to close." _
  exit 1
fi
