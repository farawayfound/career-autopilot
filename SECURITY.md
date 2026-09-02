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

## What is not

- The backend this extension talks to. This repository ships the client
  only — it never runs a server. If you found a vulnerability in a specific
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
