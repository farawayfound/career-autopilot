# CareerAutopilot Companion

> **Neither tool here ever submits an application.** The browser extension
> fills, inserts, attaches, and copies; you always click the form's own Submit
> button yourself. The discovery node only looks for postings and sends the
> matches to your CareerAutopilot account. There is no code path in either that
> breaks this rule.

This repository holds two small tools that work with your CareerAutopilot
account (the [career-ops](https://github.com/farawayfound/career-ops) project):

- **The Companion browser extension** fills job application forms from your
  CareerAutopilot pipeline, in your own browser and under your own signed-in
  session. Your answers stay on your machine and in the tab in front of you: the
  extension has no account of its own, applies for nothing on your behalf, and
  leaves every submission to you. See [Install](#install-3-steps).
- **The discovery node** searches public job boards for the roles and places you
  set up in CareerAutopilot and sends what it finds to your own account, from
  your own computer. You start it by hand and it stops when you close its
  window. See [Discovery on your computer](#discovery-on-your-computer).

This repository is a generated mirror of the extension and the discovery node
inside the private [career-ops](https://github.com/farawayfound/career-ops)
monorepo, published here so they can be installed without cloning that whole
project. **The backend they talk to is not in this repository.** Most people use
the hosted one at [davidchui.work](https://davidchui.work); the extension works
just as well against your own self-hosted `career-ops` autopilot server.

The hosted backend answers on a self-hosted inference fleet, open sourced as
[open-fleet](https://github.com/farawayfound/open-fleet). There is a
walkthrough of it at [davidchui.work/fleet/tour](https://davidchui.work/fleet/tour)
and its live capacity at [davidchui.work/fleet](https://davidchui.work/fleet),
where you can also ask for a demo key of your own.

Built by [David Chui](https://davidchui.work). A personal project, on
hardware I own and on my own time, unrelated to my employer.

## Install (3 steps)

```bash
git clone https://github.com/farawayfound/career-autopilot.git
cd career-autopilot
npm install          # fast: one small dependency (js-yaml), used by the discovery node
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
   then ask for CareerAutopilot access from the Career tab. You'll get an email
   when it's approved.
2. **Sign in**, open **Career → Companion**, and press **Create token**. It's
   shown once — copy it.
3. **Paste it in** — either into `npm run setup` when it asks, or directly
   into the extension's Options page (server URL: `https://davidchui.work`).

Self-hosting your own `career-ops` autopilot server instead? Use its own URL
and the `server.token` value from its config — `npm run setup` will find it
automatically if it's running on the same machine.

## What the extension does

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

## Discovery on your computer

The discovery node is a small program that looks for jobs while you do
something else. It reads public job boards and company career pages from your
own computer, checks each result against the roles and places you set up on the
**Targeting** tab of your CareerAutopilot account, and sends the good ones to
your account, where your next scan evaluates them.

**Privacy, in one paragraph.** The node reads public job boards, company
websites and a few public funding-news feeds from your machine (those sites see
requests from your computer's internet address, as they would from a browser)
and sends the postings that match to *your* CareerAutopilot account; the only
other thing that leaves your computer is a small status report (its version,
what it is doing, counts and the last error). It uses no AI model and never
submits an application. Nothing runs unless you start it: it runs in the window you
opened it in, stops when you close that window, and installs no service,
scheduled task or startup entry. Your account sends it your targeting and a
list of skill keywords drawn from your résumé, never the résumé itself. Your
discovery token is kept in one file on your computer, limited to your own user
account where the system allows it.

Requirements: [Node.js](https://nodejs.org) 20 or newer, and a CareerAutopilot
account with a finished Profile tab.

Start it in three steps:

1. **Create a token.** Sign in at [davidchui.work](https://davidchui.work), go
   to **CareerAutopilot → Targeting → "Discovery on your computer"** and press
   **Create discovery token**. Copy it; it is shown once.
2. **Run the launcher** from this folder: double-click `discovery-node.cmd`
   (Windows) or `discovery-node.command` (macOS), or run `./discovery-node.sh`
   (Linux or macOS terminal). `npm run discovery` does the same. The first run
   installs its one dependency, then asks for three things: your CareerAutopilot
   address, the token (typed at a hidden prompt) and a name for this computer.
3. **Open the dashboard.** The window prints a link such as
   `http://127.0.0.1:8390/#k=…` and opens the dashboard page in your browser;
   paste that link into the page (or open it yourself) — the access key is kept
   out of the browser's command line on purpose. It works on this computer only. From there you can pause, resume or stop the node, switch a
   job on or off, change how often it runs and at what time, or run one now.

To stop it, press **Stop node** on the dashboard, press Ctrl+C in its window, or
just close the window. To start it again, run the launcher again. To remove it,
delete the folder.

The full guide, every setting and the fixes for common problems:
[docs/DISCOVERY_NODE.md](docs/DISCOVERY_NODE.md).

## License

MIT — see [LICENSE](LICENSE).

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) — please don't open a
public issue.
