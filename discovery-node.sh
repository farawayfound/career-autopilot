#!/usr/bin/env bash
# CareerAutopilot discovery node - launcher for a Linux or macOS terminal.
#
# The first run installs what the node needs, asks for your CareerAutopilot
# address and a discovery token once, then starts the node in this terminal and
# prints the address of its dashboard. Press Ctrl+C (or close the terminal) to
# stop it: nothing is installed that keeps running after it, and nothing starts
# at boot or login.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo >&2
  echo "  Node.js is not installed, or it is not on PATH." >&2
  echo "  Install the LTS build from https://nodejs.org (or your package manager), then run this again." >&2
  echo >&2
  exit 1
fi

exec node autopilot/discovery-node-start.mjs "$@"
