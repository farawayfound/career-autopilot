# Career-Ops Companion — Using the Extension

**Audience:** you, the person applying for jobs.
(If you're curious how it works under the hood, career-ops's own
`docs/extension/agent.md` has the architecture and API contract.)

The companion fills job application forms **in your own browser**, using data
from your career-ops pipeline. It is the alternative to the dashboard's
live-browser mirror: the mirror remote-controls a worker machine's browser,
the companion brings the data to the browser you are already sitting in — your
session, your cookies, your IP, no automation fingerprint for a CAPTCHA to
notice.

> **It never submits.** It fills, inserts, attaches, and copies. You always
> click the form's own Submit button yourself. This is a hard rule across all of
> career-ops and the extension has no code path that breaks it.

---

## 0. Getting a token

Two ways to run this, and everything below works the same either way — only
where the server URL and token come from differs.

**Hosted (most people).** Request access at **davidchui.work** — sign up (or
sign in), then ask for CareerOps access from the Career tab. You'll get an
email when it's approved. Once in, open **Career → Companion** and press
**Create token** — it's shown once, so copy it right away. Your server URL is
just `https://davidchui.work`.

**Self-hosted.** Run your own `career-ops` autopilot server, and use its own
URL plus the `server.token` value from its config. If it runs on the same
machine you're installing the extension on, setup finds the token by itself;
otherwise you'll paste in both values once.

Either way, the token stays on this machine — it lives in the browser's
extension storage and a gitignored config file next to the extension's code,
never in git, never printed to a terminal.

---

## 1. Launching it — the icon

**Double-click `companion.cmd` in the repo root.** That is the whole first run
on any PC with the repo synced.

It installs whatever is missing, asks once for your server URL and API token
(§0 above), walks you through the two steps only you can do, and then opens a
ready-to-go browser: extension loaded, settings filled in, sitting on your
pipeline dashboard. From there, open any application in your queue and the
panel takes over.

It also leaves **`Career-Ops Companion.lnk`** next to it, with a proper icon.
**Drag that to the taskbar or the Desktop** — that is your one-click launcher
from then on. It keeps working from anywhere on the machine; it remembers where
the repo is.

Every run after the first is a few seconds of checks and then the browser. The
launcher exits once the browser is up — the browser is your own session from
then on, so closing the console window no longer closes it.

<details>
<summary>On a Mac or Linux box instead</summary>

Double-click **`companion.command`** for the first run. On macOS, setup then
writes **`Career-Ops Companion.app`** in the repo root — that is the launcher
with the proper icon: **drag it onto the Dock to pin it** (`--desktop` also
symlinks it onto the Desktop). Same two targets as the Windows .lnk: while
something still needs setting up it opens Terminal on `companion.command`;
once the extension is loaded and its config file is written it opens Chrome
directly, no Terminal window at all. Unlike Windows, rerunning setup refreshes the app in place and
a Dock pin survives it — the Dock pins by path, not by Explorer's bookkeeping.

On Linux, setup writes `career-ops-companion.desktop` next to it — copy that
into `~/.local/share/applications/` for the applications menu.
</details>

### The shortcut, and what it skips

Once setup has finished, the shortcut points **straight at Chrome** — no console
window, no Node, nothing to wait for. It is on the Desktop; to get it on the
taskbar, right-click it → **Pin to taskbar** (Windows has no supported way for a
script to pin anything, so this one click is yours). If the menu is the short
one, **Show more options** first.

Two things worth knowing about it:

- **It skips the checks.** If the server token is ever rotated (or your
  CareerOps access changes), the shortcut still opens the browser and the
  panel just says the token was rejected. That is the moment to double-click
  **`companion.cmd`** instead — setup rewrites the config file the extension
  reads, and the extension picks it up by itself (on its next start, or the
  moment the server rejects the old token).
- **The taskbar icon may be Chrome's, not ours.** The Desktop icon is right; the
  live taskbar button can fall back to the plain Chrome icon, because Chrome
  owns that once a window is open. Cosmetic.

Do **not** hand-edit a shortcut you have already pinned. Explorer re-resolves a
pinned `.lnk` against its own bookkeeping, decides it no longer matches, and
deletes the pin — that happened once here, which is why setup now refuses to
touch the pin folder at all.

### The same thing from a terminal

```bash
npm run setup:companion    # setup only — no browser
npm run companion          # launch, assuming setup has run
npm run companion -- https://boards.greenhouse.io/acme/jobs/123   # start on a specific application
```

`node extension/setup-companion.mjs --recheck` re-asks for the server URL and token, which
is what you want after the token is rotated. `--desktop` also drops the shortcut
straight onto your Desktop. `--server <url>` (or the `COMPANION_URL` environment
variable) points setup at a specific server without being asked; `COMPANION_TOKEN`
does the same for the token — handy for a scripted or repeat install.

Logins persist between runs (`.companion-profile-chrome/`), so you sign into
the dashboard and any ATS accounts once and they stick. After editing extension
code, hit the 🔄 reload icon on `chrome://extensions`.

### Setting up a second PC

1. Sync the repo (it is the same checkout — nothing extra to install by hand).
2. Double-click `companion.cmd`.
3. Give it the server URL and token when it asks — see §0. Hosted: your
   server URL is `https://davidchui.work` and the token is whatever you
   created on **Career → Companion**. Self-hosted: setup pulls the token off
   this machine automatically if it also runs the server here, and asks
   otherwise.
4. Drag the shortcut it created to the taskbar.

Your answers land in `config/companion.local.json`, which is gitignored — the
token stays on that machine and is never committed or printed — and are copied
to `extension/companion.local.json` (also gitignored), which is what the
extension itself reads.

### It runs in real Chrome, in a profile of its own

Applying means signing in *inside* this browser: Google OAuth on some boards,
and an email+password candidate account per Workday tenant — whose screening
questions only ever render once you are signed in. Branded Chrome is the only
build where that works, so it is the only browser the companion runs in. The
old Chromium path is retired.

Setup walks you through the two steps nobody can do for you, opening the right
page for each and checking afterwards that it actually took:

1. **Load the extension once.** Chrome has ignored the `--load-extension` flag
   since v137, so setup opens `chrome://extensions` and waits while you turn on
   **Developer mode**, click **Load unpacked**, and choose this checkout's
   `extension/` directory (setup prints the exact path). The profile keeps it
   after that.
2. **Sign the profile in to Chrome.** Your saved passwords, autofill and the
   password generator come with it — which is why creating a Workday account no
   longer means switching to your normal Chrome to look a credential up.

Everything else it does itself: finds Chrome, resolves the server URL and token,
writes them into `extension/companion.local.json` *before* you load the
extension — so the first load is already a configured load; the extension
imports that file by itself whenever it starts — and then verifies by asking
the extension, from a throwaway browser, whether it imported the file, and by
making it call the server through its own fetch — not merely by checking the
server is up. (That in-browser check needs Playwright; if it isn't installed,
setup says so and skips it — everything else still works. `npm install playwright`
adds it.) Rerun setup whenever; finished steps prompt for nothing, and
anything left is listed again at the end.

### If the panel says "not configured"

The extension reads its server URL and token from `companion.local.json` in
the directory it was loaded from. The panel saying *not configured — run the
companion setup…* means that file is missing there. Three causes, in the order
they actually happen:

1. **The extension was loaded from a different checkout** than the one setup
   ran in — a worktree, or an older clone a Desktop shortcut still points at.
   Setup now detects this: it prints the directory the extension really came
   from, writes the file there too when that checkout gitignores it, and
   otherwise tells you to either run setup there or re-load the extension
   from this checkout's `extension/` folder.
2. **The extension is running code from before this file existed.** Hit the
   🔄 reload icon on its card at `chrome://extensions` once; it imports the
   file the moment it starts.
3. **Storage holds something else** (typed by hand, or left over). Open the
   extension's options page and press **Reload from setup file** — the file
   wins.

It is a separate profile from your everyday one on purpose: the extension can
read every page in whatever profile it lives in, so keep it to job applications.

**Prefer email+password over "Sign in with Google"** when a board offers both.
A per-tenant account you own outright is one your password manager can hold,
and it does not care what the OAuth path is doing that week.

<details>
<summary>If Chrome is not installed</summary>

Setup stops and says to install it. There is no fallback any more: a portable
Chromium and Playwright's bundled build both lack the API keys Chrome sign-in
needs, so every login this thing exists for failed in them. `COMPANION_CHROME`
still points at a Chrome kept somewhere unusual.
</details>

### What a healthy run looks like

```
[1] Node.js          ✓ v24.18.0
[2] Dependencies     ✓ already installed
[3] Browser          ✓ Google Chrome
                       (path to your Chrome install)
                     Sign this profile into Chrome on first run — your saved
                     passwords come with it.
[4] Career-ops server
      ✓ using saved settings (config/companion.local.json)
      ✓ reachable — HTTP 200, profile plan with 9 contact fields
[5] Launcher icon    ✓ Career-Ops Companion.lnk (in the repo root)

Ready.
```

`cannot reach …` means the server is down, or you are offline. Setup continues
and the browser still opens, so fix connectivity and press **Test connection**
on the extension's options page. `token rejected or your CareerOps access is
not active` means either the token was rotated (rerun with `--recheck`) or —
on the hosted service — your access has been paused; check the Career page.

Everything below is the manual equivalent, for a browser you want to set up by
hand or keep configured permanently.

---

## 2. Manual setup (alternative to the icon)

### Install (free — no Chrome Web Store account, no $5 developer fee)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
2. Turn on **Developer mode** — top-right toggle
3. Click **Load unpacked**
4. Select the `extension/` directory in your career-ops checkout

The extension stays loaded across restarts. You only redo this if you move the
folder or you want to pick up code changes after a `git pull` (then just hit the
🔄 reload icon on its card).

### Connect it to your server

The setup script does this for you: it writes `extension/companion.local.json`
and the extension imports it by itself. By hand instead, click the extension's
**Details → Extension options**, then set:

| Field | Value |
|---|---|
| **Server URL** | Hosted: `https://davidchui.work`. Self-hosted: wherever `autopilot/server.mjs` listens — loopback (`http://127.0.0.1:8377`) if it runs on this same machine, its own URL otherwise. |
| **API token** | Hosted: created on **Career → Companion → Create token**. Self-hosted: the `server.token` value from `config/autopilot.local.yml` on the server machine. |

Paste it, click **Save**, then **Test connection**. A good result reads:

> Connected — profile plan loaded (9 contact fields on file).

If it says the token was rejected, the server is up but the value is wrong (or,
on the hosted service, your CareerOps access isn't active). If it says it
cannot reach the URL, check the server is running and that you have network
access to it.

---

## 3. Applying to a job

### Automatic (default)

Open the job's application page. If the URL matches an item in your active
queue and the site is a known ATS, the panel **opens and fills by itself**:
contact fields, screening answers, cover letter, resume attached, and drafts
for any open free-text questions (your local model writes them; they land in
the form *and* in a "Drafted answers" list for review). The toolbar icon shows
a green ✓ on matched pages. You review everything and click Submit yourself —
the extension has no way to do that, ever.

Turn pieces of this off in the extension options: auto-run, auto-drafting, or
widen it to non-ATS sites.

### Manual (fallback, and non-queue pages)

1. **Open the job's application page** in a normal tab.
2. **Click the toolbar icon** (or press **Alt+Shift+C**). The panel opens down
   the right-hand side.
3. **Check the header.** The panel matches the page URL against your active
   queue automatically. When it finds a match it shows the company and role, and
   loads that item's tailored answers and cover letter. When it doesn't, you get
   a dropdown — *"— link this page to a pipeline item —"* — or you can stay in
   profile-only mode, which still fills your contact details on any form.
   Only items in an active state are offered (`pending_review`, `needs_input`,
   `approved`, `needs_human`, `filled_awaiting_user`).
4. **Click ⚡ Fill everything.** It fills the fields, attaches the resume, and
   drafts open questions in one go. Then read the status line, e.g.
   *"Auto-fill: 7 done, 2 left for you — review before submitting."*
5. **Work the leftovers.** Every field is a row with a coloured dot:

   | Dot | Meaning | What to do |
   |---|---|---|
   | 🟢 green | filled | nothing |
   | ⚪ grey | already had a value | nothing — it left your existing text alone |
   | 🟠 amber | not found, or the fill failed | click the field on the page, press **Insert** |

   Amber is not a failure state, it is the fallback rung. **Insert** types the
   value into whichever field you last clicked. **Copy** puts it on the
   clipboard for anything the extension cannot script at all.

6. **Attach the resume.** The resume row's **Attach** button pushes the file
   straight into the form's file input. If the form uses a custom uploader that
   rejects it, press **⬇** to download the correctly-named PDF
   (`FirstnameLastname_Resume.pdf`) and attach it by hand.
7. **Answer the custom questions** — see AI assist below.
8. **Review the whole form yourself, then click Submit.**

### A posting the pipeline has never seen — "＋ Process this page"

Somebody sends you a link. It is on a board nobody tracks, or it came from a
newsletter, or a friend forwarded it. The scanners will never find it, so
there is no evaluation, no score, no tailored CV — nothing to fill from.

Open the panel and press **＋ Process this page**. That hands the URL to your
own server, which runs the full evaluation: fetch the JD, score it, write the
report, tailor the CV, draft the cover letter and screening answers, and
package it for review.

**Then close the tab.** Nothing depends on the page staying open. The work runs
on your server and can take several minutes — longer if a scan is already
running, since evaluations run one at a time.

Track it on your dashboard's **Career** page under **Sent for evaluation**:

| Chip | Meaning |
|---|---|
| 🟠 queued | waiting for the current cycle to finish |
| 🔵 running | being evaluated right now |
| 🟢 done | evaluated — the note says the score and whether it was packaged |
| 🔴 failed | the note says why (posting closed, board the fetcher can't read) |

When it lands, the application shows up in **Ready for review** like anything
the scanner found, and you apply from there — reopen the posting and the panel
will match it automatically.

Two things worth knowing:

- **Sending the same posting twice is free.** It recognises a URL already
  queued, already in the queue, or already in your tracker, and tells you where
  it is instead of burning a second evaluation.
- **Your server fetches the page itself, not your browser.** A posting behind a
  login will come back as *failed — unsupported job board*. Public postings
  (which is nearly all of them) are fine.

### AI assist for free-text questions

For "Why do you want to work here?"-style boxes:

1. Click into the question's answer field on the page
2. **Read focused** — pulls the question text off the page into the panel
   (you can also just type the question in yourself)
3. **Draft answer** — runs it against your server's model. This can take a minute;
   the status line says so. Drafts come from your CV, profile, and tone config —
   the same source-of-truth boundary the rest of career-ops uses.
4. **Read and edit the draft.** It is a starting point, not a final answer.
5. **Insert into focused field**, or **Copy**

Self-ID / EEO questions are tucked into a collapsible **Self-ID / EEO answers**
section, prefilled from your saved answers where you have set them.

### Generate message — replying to a recruiter

The panel's second tab, when your server has this feature turned on. Open it
on a recruiter's message, a LinkedIn thread, a posting or a profile:

1. Optionally **select** the text you are replying to (a selection is read
   verbatim; otherwise the panel reads the messaging surface, or the page).
2. Optionally add context — who they are, what you want to say, a role to mention.
3. **Generate message** — a minute on your server's model. The draft is plain
   prose tailored to the context you gave it.
4. Read and edit it. Then **Insert into focused field** (click into the reply
   box first) or **Copy**.

It never sends.

### After you press Submit

You click the form's own Submit — the extension never does. When it sees the
confirmation page that follows, it records the application for you: the queue
card moves to **processed** and the tracker row moves to **Applied**. The panel
says which, e.g. *"Submitted ✔ recorded — tracker #142 → Applied."* The toolbar
icon turns to ✔.

It only reports on **two** signals: your click, and then a page that actually
says the application was received. A click on its own is never enough — forms
reject and re-render, and a tracker row that claims Applied for an application
that never went out is worse than no automation. So it errs toward missing
things.

When it misses one — an unusual confirmation page, the panel was never open,
you applied from your phone — open your dashboard's **Career** page, find the
card, and press **Mark as applied**. Same two writes, one click. It tells you
what moved, including the case where it moved nothing because your row already
says Interview.

Tracker rows only ever move **forward**. A late or duplicate signal cannot pull
a row back from Responded/Interview/Offer to Applied, and cannot reopen a
Rejected one.

### What it will never do to your work

Anything you typed yourself wins. If you answer a question by hand while a
draft is still being written, the draft does not replace it — it lands in the
panel's **Drafted answers** list instead, and the field keeps your text. Same
for a dropdown you corrected or a radio button you switched: a later fill
leaves them alone. And the resume is only ever attached automatically inside
the application itself, never into a support-chat or feedback widget the
careers page happens to embed.

---

## 4. Why it degrades instead of failing

Wide compatibility was the design goal, so there are four rungs and a failure on
one just moves you down to the next:

| Tier | Mechanism | Covers |
|---|---|---|
| **A** | Known-ATS selector packs | Greenhouse, Lever, Ashby |
| **B** | Generic label matching | Any plain-DOM form |
| **C** | Assisted insert — click field, press **Insert** | Anything scriptable |
| **D** | **Copy** → paste yourself | Everything, Workday included |

So auto-fill is not really the product — **the checklist is**. Auto-fill just
pre-completes as much of it as it can, and whatever it misses stays one click
from done. A form where nothing auto-fills is still faster than typing from
scratch.

Every **Insert** also copies to the clipboard as a silent backstop, so if no
field was focused you lose nothing — the panel tells you it copied instead.

---

## 5. When something goes wrong

**"The panel didn't open by itself."**
Auto-run needs three things: the auto-run toggle on (extension options), the
page URL matching an active queue item, and the site being a recognised ATS
host (or the "watch every site" toggle on). A branded careers domain that
isn't in the ATS host list won't trigger — open the panel manually (toolbar
icon or Alt+Shift+C); everything else works the same.

**"Nothing filled / fields not found."**
Many ATSes mount the form lazily. The filler now waits up to ~8 seconds for
the form to appear, but if the page is a job *description* with an Apply
button, click Apply first so the form actually exists in the DOM, then
⚡ Fill everything.

**"Insert does nothing."**
Insert targets the last field you clicked. Click directly into the field, then
press Insert without clicking anywhere else in between. Panel buttons are built
not to steal focus, so clicking them will not blur your field.

**Dropdowns behave oddly.**
`react-select` comboboxes (very common on Greenhouse) rebuild their DOM on every
keystroke. This is the least reliable path by design. If one misbehaves, set it
by hand.

**The form is inside an iframe.**
Already handled — the engine is injected into every frame, and the panel only
renders in the top one.

**Workday.**
Workday is effectively Tier D. Use Copy on each row. This is expected, not a
bug.

**Wrong company/role in the header.**
The URL matcher guessed wrong. Pick the right item from the dropdown; it
reloads the plan.

**"I submitted, but the tracker still says Evaluated."**
The confirmation page did not say anything the detector recognises, or the
panel had never opened on that page so nothing was armed. Use **Mark as
applied** on the card on your dashboard's Career page.

**Nothing works after a `git pull`.**
Reload the extension on `chrome://extensions` — content scripts are cached until
you do.

---

## 6. Privacy

- The token lives in `chrome.storage.local` and is sent only to the server URL
  you configured. Content scripts never see it — the service worker holds it and
  proxies the calls. The file it is imported from,
  `extension/companion.local.json`, is gitignored and is not web-accessible: a
  web page cannot fetch it, only the extension can.
- Do not install this in a browser profile you share.
- Your CV, answers, and drafts never leave the server you configured. Nothing
  is sent anywhere else.
