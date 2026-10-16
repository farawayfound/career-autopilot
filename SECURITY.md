# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Email **david.gchui@gmail.com** with what you
found, how to reproduce it, and what you think the impact is. You will get a
reply; there is no formal SLA — this is a one-person project — but anything
that touches a hosted server's account boundary (one user's data reachable
from another user's token) is treated as urgent.

## What is in scope

- **The browser extension** (`extension/`) — what it reads off a page, what
  it types into a form, what it sends to your configured server, and whether
  a token can escape the browser it was pasted into.
- **The setup script** (`extension/setup-companion.mjs`) and the launchers
  (`companion.cmd`, `companion.command`) — anything that could write, print,
  or transmit an API token somewhere it should not.
- **The discovery node** (`autopilot/discovery-node.mjs`, its run script
  `autopilot/discovery-node-start.mjs` and the launchers `discovery-node.cmd`,
  `discovery-node.command`, `discovery-node.sh`) — how it stores and sends its
  discovery token, what its local dashboard (`autopilot/lib/discovery-node-dashboard.mjs`)
  exposes to other programs on the same computer or to a web page open in your
  browser, what it fetches on its own, and anything that makes it keep running
  or start itself after you closed its window.

## What is not

- The backend these tools talk to. This repository ships clients only — it
  never runs a server. If you found a vulnerability in a specific
  deployment's server (including the hosted one at davidchui.work), report it
  through that deployment's own security contact.
- Findings that require an already-compromised machine, or a token that was
  leaked some other way — though it is still worth telling us if this
  extension made that token easier to leak.

## Practices

- The token lives only in `chrome.storage.local` (this extension's own,
  isolated storage) and `companion.local.json` next to the extension's code,
  both gitignored, both per-machine. Content scripts never see it — only the
  background worker holds it and proxies every request.
- The extension never submits a form. It fills, inserts, attaches, and
  copies; a human always clicks Submit.
- The discovery node's token lives in `config/discovery-node.local.yml`, which
  is gitignored and limited to your user account where the system allows it.
  The node accepts a token from a hidden prompt, an environment variable or a
  file, never from a command-line argument. Its dashboard listens on this
  computer only, behind a random key that appears in the link printed in the
  window you started it in.
- The discovery node installs nothing that survives its window: no service,
  scheduled task, startup entry or cron line. It uses no AI model and
  submits nothing.
