#!/usr/bin/env bash
# CareerAutopilot discovery node - double-clickable launcher (macOS).
#
# The first run installs what the node needs, asks for your CareerAutopilot
# address and a discovery token once, then starts the node in THIS window and
# prints the address of its dashboard. Close the window to stop the node:
# nothing is installed that keeps running after it, and nothing starts at login.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed, or it is not on PATH."
  echo "  Install the LTS build from https://nodejs.org, then run this again."
  echo
  read -r -p "  Press Enter to close." _
  exit 1
fi

if ! node autopilot/discovery-node-start.mjs "$@"; then
  echo
  echo "  The node did not start, or it stopped with an error - the message above says why."
  echo
  read -r -p "  Press Enter to close." _
  exit 1
fi
