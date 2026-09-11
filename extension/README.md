# Career-Ops Companion (browser extension)

**Hard rule carried over from the rest of career-ops: it never submits.**
It fills, inserts, and copies. You always click the form's own Submit.

Fills job application forms **in your own browser** from your career-ops
pipeline. Complements the dashboard live-browser mirror: the mirror remote-controls
the worker machine's browser; the companion brings the data to the browser you
are already signed in to, so your answers stay on your machine and in the tab
in front of you.

> **Full documentation:** [docs/extension/user.md](../docs/extension/user.md)
> (using it) · [docs/extension/agent.md](../docs/extension/agent.md)
> (architecture, API contract, extending it). This file is the short version.

## The compatibility ladder

One panel, four tiers — failure never dead-ends, it just moves down a rung:

| Tier | What happens | Works on |
|------|--------------|----------|
| A | Known-ATS auto-fill (selector packs) | Greenhouse, Lever, Ashby |
| B | Generic auto-fill (label matching) | Any plain-DOM form |
| C | Assisted insert — click the field, press **Insert** | Anything scriptable |
| D | **Copy** → paste yourself | Everything (Workday included) |

Auto-fill pre-completes the checklist; whatever it missed stays one click from
done. Every Insert also copies to the clipboard as a backstop.

## Launch (double-click)

**`companion.cmd`** in the repo root (macOS/Linux: `companion.command`). First
run on a machine installs dependencies, finds Chrome, asks once for the server
URL + API token, walks you through the two steps only you can do, and creates
the launcher: **`Career-Ops Companion.lnk`** on Windows (drag to the Desktop,
right-click to pin), **`Career-Ops Companion.app`** on macOS (drag onto the
Dock; `--desktop` also symlinks it to the Desktop). Once setup has finished it
opens Chrome directly: no console or Terminal window, extension loaded,
settings applied, on `https://davidchui.work/career`.

From a terminal:

```bash
npm run setup:companion                                           # setup only
npm run companion                                                 # launch
npm run companion -- https://boards.greenhouse.io/acme/jobs/123   # start on an application
node extension/setup-companion.mjs --recheck                                # re-enter URL + token
```

Answers are saved to `config/companion.local.json` (gitignored — the token
never leaves that machine) and copied to `extension/companion.local.json`
(also gitignored), which is what the extension itself reads: it imports that
file whenever it starts, so any profile that loads this directory is
configured the moment it loads. The browser profile persists in
`.companion-profile-chrome/`, so logins stick across runs.

Runs in **branded Chrome**, in a dedicated profile — and only there. It is the
only build with a working Google identity layer, which is what applying
actually needs: Google OAuth on some boards, and a Workday candidate account
whose screening questions only render once you are signed in. The old Chromium
fallback could sign in to none of that, so it was retired rather than left as a
trap. (Playwright's build still runs `companion:smoke`, which signs in to
nothing.)

`extension/setup-companion.mjs` is the whole onboarding, and it is idempotent — rerun it
any time; finished steps prompt for nothing. It finds Chrome, resolves the
server URL and token, writes them into the config file the extension reads
(before you load it, so the first load is a configured load), walks you
through the two steps only you can do (loading the extension once through
`chrome://extensions`, and signing the profile in to Chrome so your saved
passwords come with it), then verifies — from a throwaway browser over CDP —
that the extension imported the file and can call the server itself. Nothing
is pushed into the browser: if the panel ever says *not configured*, run setup
in the checkout the extension was loaded from (setup prints which one that is
when it differs) and reload the extension once. Anything still outstanding is
repeated in the closing summary.

## Install manually (free, no store account)

1. Chrome/Edge/Brave → `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` directory
4. Give it a server URL and token. Most people: click the extension's
   **Options** and paste in a token created on your dashboard's
   **Career → Companion** tab (its own origin is the server URL). Self-hosting
   your own autopilot server instead: run `node extension/setup-companion.mjs`
   (it writes `extension/companion.local.json`, which the extension imports
   by itself), or set the two fields by hand — **Server URL** is wherever
   `autopilot/server.mjs` listens, **API token** is `server.token` from your
   autopilot config.
5. **Test connection** → should report the profile plan loaded

## Use

**Automatic (default):** open a job application page. If the URL matches an
active queue item on a known ATS host, the panel opens and fills everything by
itself — fields, screening answers, cover letter, resume attached, and local-model
drafts for open free-text questions. Review, then click Submit yourself.
Toggles in the extension options (auto-run / auto-draft / watch-all-sites).

**Manual (fallback / non-queue pages):**

1. Open a job application page
2. Click the toolbar icon (or **Alt+Shift+C**) → the panel opens on the right
3. It auto-matches the page URL to your queue (or pick the item / stay in
   profile-only mode for un-evaluated applications)
4. **⚡ Fill everything**, then work the remaining rows with Insert / Copy
5. **Attach** the resume (or ⬇ download it and attach manually)
6. **AI assist**: click into an unanswered question → **Read focused** →
   **Draft answer** → review/edit → **Insert**
7. Review everything, click the form's Submit yourself

**Generate message (second tab):** the panel's second tab, when your server has
this feature turned on. On a recruiter's message, a LinkedIn thread or a
posting, switch to **Generate message**, optionally select the text you are
replying to and add context, then press **Generate message**. The server drafts
a plain, friendly reply or first message from your CV: a short introduction and
interest in the opportunity on screen. Review it, then **Insert into focused
field** or **Copy**. It never sends.

**A posting the pipeline never scanned:** press **＋ Process this page**. The
URL goes to your server for a full evaluation (report, score, tailored CV,
cover letter, package) and you can close the tab — progress shows on the
dashboard under *Sent for evaluation*, and the finished application lands in
*Ready for review*. Re-sending a posting already queued, packaged, or tracked
is recognised, not re-evaluated.

**After you submit:** the extension watches for the confirmation page and
records the application — queue item → `submitted`, tracker row → `Applied`.
Two signals are required (your click, then a page that says the application was
received), so it is tuned to miss rather than to guess. When it misses, the
dashboard's **Mark as applied** button on the processed list does the same two
writes. Tracker writes are forward-only: nothing pulls a row back from
Interview.

**Verify:** `npm run companion:smoke` (real browser, fake form, asserts what
landed in the DOM) and `node tests/test-all.mjs --only companion-extension`.

## Notes

- The token lives in `chrome.storage.local` — imported from
  `extension/companion.local.json`, which is gitignored and not web-accessible
  — and is only sent to the configured server URL. Don't install this on a
  shared machine's browser profile.
- Message drafting is `POST /api/companion/generate-message`; its model and
  prompt are set on whatever server you point this at (on the reference
  Career Ops server, that route is admin-only — a signed-in guest gets a
  clear error there instead of a draft).
- Backend routes live in `autopilot/server.mjs` (`/api/companion/*`); the fill
  plan is built by `autopilot/lib/apply/fill-plan.mjs` — the same module the
  Playwright apply-worker uses, so the two paths cannot drift.
- Firefox: `about:debugging` → Load Temporary Add-on works, but host
  permissions must be granted manually under the extension's settings.
