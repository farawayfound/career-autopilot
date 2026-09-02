# Career-Ops Companion

A browser extension that fills job application forms **in your own browser**,
from your [career-ops](https://github.com/farawayfound/career-ops) pipeline —
your session, your cookies, your IP, no automation fingerprint for a CAPTCHA
to notice.

> **It never submits.** It fills, inserts, attaches, and copies. You always
> click the form's own Submit button yourself. There is no code path that
> breaks this rule.

This repository is the extension only — a generated mirror of the
`extension/` directory inside the private
[career-ops](https://github.com/farawayfound/career-ops) monorepo, published
here so it can be installed without cloning that whole project. **The backend
it talks to is not in this repository.** Most people use the hosted one at
[davidchui.work](https://davidchui.work); the extension works just as well
against your own self-hosted `career-ops` autopilot server.

## Install (3 steps)

```bash
git clone https://github.com/farawayfound/career-autopilot.git
cd career-autopilot
npm install          # fast — this package has no dependencies to fetch
npm run setup        # walks you through the rest, prints what's left to do
```

`npm run setup` finds Chrome, resolves a server URL and token if it can (or
asks for them once), walks you through the two steps only a human can do —
loading the extension into Chrome, signing the profile in — and finishes on a
ready-to-go browser. Its closing "Still to do" section, if anything is still
outstanding, is the exact list of what's left; rerun it any time and it picks
up where it left off.

Prefer to do it by hand? Open `chrome://extensions`, turn on **Developer
mode**, **Load unpacked**, and select this repository's `extension/`
directory. Then open the extension's **Options** page and paste in a server
URL and token (see below).

## Getting a token

1. **Request access** at [davidchui.work](https://davidchui.work) — sign up,
   then ask for CareerOps access from the Career tab. You'll get an email
   when it's approved.
2. **Sign in**, open **Career → Companion**, and press **Create token**. It's
   shown once — copy it.
3. **Paste it in** — either into `npm run setup` when it asks, or directly
   into the extension's Options page (server URL: `https://davidchui.work`).

Self-hosting your own `career-ops` autopilot server instead? Use its own URL
and the `server.token` value from its config — `npm run setup` will find it
automatically if it's running on the same machine.

## What it does

- **Auto-fills** known ATS forms (Greenhouse, Lever, Ashby) and degrades
  gracefully everywhere else — generic label matching, then click-to-insert,
  then copy-to-clipboard — so a form where nothing auto-fills is still faster
  than typing from scratch.
- **Drafts answers** for open-ended screening questions from your CV and
  profile, using your own configured server's model — never fabricated,
  never invented past what you've told it.
- **Attaches your tailored résumé** to the form's own file input.
- **Watches for the confirmation page** after you submit and reports it back,
  so your tracker moves forward on its own.
- **"Process this page"** hands a posting the pipeline never scanned to your
  server for a full evaluation, so you can apply to it the same way.

Full walkthrough: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## License

MIT — see [LICENSE](LICENSE).

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) — please don't open a
public issue.
