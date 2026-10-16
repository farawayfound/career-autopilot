# Discovery on your computer

The CareerAutopilot **discovery node** is a small program you run on your own
computer. It searches public job boards and company career pages for the roles
and places you set up on the **Targeting** tab of your CareerAutopilot account,
checks each result, and sends the good ones to your account, where your next
scan evaluates them.

A few things to know up front:

- **You start it, and it stops when you close its window.** It installs no
  service, scheduled task, startup entry, login item or cron line. Nothing keeps
  running after you close the window, and nothing starts when you reboot.
- **It never applies for anything.** It only finds postings.
- **It uses no AI model.** Its checks are plain arithmetic and text matching on
  the title, place, pay and date of each result.
- **It talks to four kinds of places:** public job sites (to read their
  listings); the websites of companies it has heard of (the `resolve` job reads
  a company's own site to find its careers page); a few public news feeds about
  funding rounds (TechCrunch, PR Newswire, The Guardian and Hacker News, read by
  the `sources` job to hear about companies you did not list); and your own
  CareerAutopilot account (to get your targeting and send the matches). Nothing
  else, apart from the one-time download of its library from the npm registry on
  the first run. Like a browser, it reaches the first three from your computer's
  internet address, so those sites can see that address; the `sources` and
  `resolve` jobs can be switched off on the dashboard.

This guide is for the hosted CareerAutopilot at
[davidchui.work](https://davidchui.work). If you run your own server, give the
node its address with `--url` (see [Options](#options)).

## What you need

- A CareerAutopilot account with access to CareerAutopilot, and a **finished
  Profile tab** (your résumé or a short bio): without it there is nothing to
  search for.
- **Node.js 20 or newer.** Get the LTS version from
  [nodejs.org](https://nodejs.org). To check what you have, open a terminal and
  run `node --version`.
- An internet connection. The first run downloads one small library (js-yaml).

## 1. Get the package

Either clone it:

```bash
git clone https://github.com/farawayfound/career-autopilot.git
cd career-autopilot
```

or download the ZIP from
[github.com/farawayfound/career-autopilot](https://github.com/farawayfound/career-autopilot)
(Code, then Download ZIP) and unpack it somewhere you will find again, such as
your home folder. Use a fresh copy: the node refuses to run in a folder that
holds a full career-ops project (one with a `cv.md` or a tracker in it), so it
can never touch your own files.

## 2. Create a discovery token

The node proves who it is with a **discovery token**: a long secret starting
with `cot_` that works only for discovery. It cannot read your résumé or drive
the browser extension, and the browser extension's own token will not work here.

1. Sign in at [davidchui.work](https://davidchui.work).
2. Open **CareerAutopilot → Targeting**.
3. Find the card **"Discovery on your computer"** and press **Create discovery
   token**. You may be asked to accept a short notice first.
4. **Copy the token now.** It is shown once. If you lose it, create another.

Treat it like a password. If it ever leaks, revoke it on the **Companion** tab
and create a new one.

## 3. Start it

| Where | How |
| --- | --- |
| **Windows** | Double-click `discovery-node.cmd`. (From a terminal in the folder: `.\discovery-node.cmd`.) |
| **macOS** | Double-click `discovery-node.command`, or run `./discovery-node.sh` in Terminal. |
| **Linux** | Run `./discovery-node.sh` in a terminal. |
| **Any** | `npm run discovery`, or `node autopilot/discovery-node-start.mjs`. |

Notes for particular systems:

- **Windows** may show a "Windows protected your PC" notice for a script you
  downloaded. Choose **More info**, then **Run anyway**, once you have read
  what the script does (it is a few lines; the real work is in
  `autopilot/discovery-node-start.mjs`).
- **macOS** may refuse a downloaded `.command` file from an "unidentified
  developer". Right-click it, choose **Open**, then **Open** again.
- **A ZIP download loses the "executable" flag** on `discovery-node.sh` and
  `discovery-node.command`. If you see "permission denied", run this once in
  the folder: `chmod +x discovery-node.sh discovery-node.command`. A `git clone`
  keeps the flag.
- If the launcher says **Node.js is not installed**, install it (see above) and
  open a new terminal window so it is found.

### The first run

The first time, the node installs its one dependency (you will see `npm ci`
run; this happens once), then asks three questions:

1. **CareerAutopilot address.** Press Enter to accept `https://davidchui.work`.
2. **The token.** Paste it. It is **not shown as you type** and cannot be given
   on the command line, because other programs on your computer can read a
   program's command line. The node checks the token with your account right
   away and tells you in plain words if something is wrong.
3. **A name for this computer**, such as `home-laptop`. Lowercase letters,
   digits and hyphens, up to 32 characters. Your account shows this name so you
   can tell your computers apart (up to five per account).

It saves your answers (see [Where things are kept](#where-things-are-kept)) and
starts. Next time it starts without asking anything.

## 4. Open the dashboard

When the node is running, its window prints something like:

```
CareerAutopilot discovery node is running.

Dashboard (open this link in your browser):
  http://127.0.0.1:8390/#k=abc...
It works only on this computer, and only while this window stays open.
```

It also opens the dashboard page in your browser, unless you started it with
`--no-open`. The page works **on this computer only** (`127.0.0.1` is "this
machine"; nothing outside it can reach it).

The part after `#k=` is a random access key made fresh every time the node
starts. The browser is opened on the address **without** the key, because a
key passed to another program on its command line can be read by other programs
on your computer. So the page first asks you to **paste your dashboard link**:
copy the full link from the window (the line with `#k=`) and paste it into the
box, or simply open that link yourself. The page takes the key out of the
address bar as soon as it loads, so a screenshot of the tab does not show it.
Do not paste the full link anywhere else: while the node is running, anyone who
has it on your computer can pause or stop the node. If you close the tab by
mistake, use the link in the window again, or stop the node and start it again
for a new one.

If port 8390 is already in use, the node uses the next free one and prints the
address it chose; `--port N` picks a port yourself.

### What the dashboard shows

- **Status.** *Running*, *Working* (a job is in progress), *Paused* or
  *Stopped*, a line saying what it is doing, and these counters:
  - *Hub*: whether your CareerAutopilot account is reachable.
  - *Waiting to check*: results found, not yet checked.
  - *Waiting to send*: results that passed the checks and are queued for your
    account.
  - *Sent*, *Held back* (scored too low to be worth sending) and *Dropped*
    (failed a check, for example a posting that has closed).
  - *Accepted today: N (daily allowance M)*: how many postings your account has
    accepted today, and its daily allowance (see
    [How many finds per day](#how-many-finds-per-day)).
- **Pause / Resume.** While paused, no new job, check or send starts. A job that
  is already running finishes first. The pause is **not remembered**: restart
  the node and it runs again.
- **Stop node.** Asks to confirm, then shuts the node down completely. Nothing
  runs after that until you start it again from the launcher. You can also press
  Ctrl+C in the window, or just close the window.
- **Jobs.** One row for each job (see [What each job does](#what-each-job-does)):
  - *On*: switch the job on or off.
  - *Every (min)*: how long after a run finishes before the next one, from 5 to
    10080 minutes (a week).
  - *Start at*: optionally run at a fixed time of day instead (06:00, say). The
    job then runs at that time and every interval after it, starting again each
    day. With a start time, an interval longer than a day must be a whole number
    of days (1440, 2880, ...). Checking results has no start time.
  - *Last run*: when it last ran, whether it worked, and a one-line summary.
  - **Save** keeps your change, **Run now** starts that job as soon as nothing
    else is running (even if it is switched off, or the node is paused), and
    **Reset** goes back to what the settings file says.
  Changes made here are remembered across restarts.
- **Recent finds sent to your account**: the last few postings it sent, as links.
- **What it searches for**: the targeting your account gave it (roles, places,
  companies).

## What each job does

The node runs one job at a time.

| Job (dashboard name) | What it does | Default |
| --- | --- | --- |
| `tracked` (Companies you track) | Reads the career pages of the companies listed in your Targeting settings. | on, every 8 hours |
| `boards` (Job boards) | Searches the job boards listed in `boards:` in your settings file (below). | on, every 12 hours |
| `aggregators` (Remote job feeds) | Reads RemoteOK, Remotive, We Work Remotely and the monthly Hacker News "Who is hiring" thread. | on, every 6 hours |
| `sources` (New companies) | Hears about companies you did not list (funding news, and companies seen in your own results) and queues them for the next job. | on, every 12 hours |
| `resolve` (Careers pages) | Finds the careers page of a company `sources` heard about, by reading that company's own website. It obeys each site's `robots.txt` and goes no more than two pages deep. | on, every 8 hours |
| `validate` (Checking results) | Looks at each result locally: is the posting still open, and how well does it fit your targeting? Then decides what to send. | on, every 15 minutes |
| `ats_full` (Full ATS sweep) | Sweeps every company on the big applicant-tracking systems. It can run for hours and makes thousands of requests. | **off** |
| `seeds` (Startup lists) | A smaller sweep of venture-backed startups. | **off** |
| `local_employers` (Local employers) | Looks up the career pages of employers you name in the `local_employers:` list. | **off** |

The three jobs that are off are heavy. Turn one on only if you know you want it.

The intervals are deliberately gentle: this runs on your computer and talks to
other people's servers, and the node spaces its requests out (at least five
seconds between requests to the same site while checking results). Please do not
make them much shorter.

## Which job boards it reads

The `boards` job reads these, none of which needs an account or a key. They are
in addition to any job boards your CareerAutopilot account already lists:

- **Jobicy**, **Himalayas**, **Working Nomads**, **NoDesk**, **The Muse**,
  **Jobspresso**, **4 Day Week** and **Agentic Engineering Jobs**: remote and
  flexible job listings.
- **We Work Remotely** and **Hacker News "Who is hiring"**.
- **Workable jobs**: the job search on jobs.workable.com, with four placeholder
  searches for remote software, platform, data and DevOps roles.
- **EURES**: the European Union's public employment services (placeholder
  search: software engineer in Ireland, the Netherlands, Germany and France).
- **YC jobs**: Y Combinator's own jobs pages (remote software engineer roles).
- **HN job stories**: job posts by Y Combinator companies on Hacker News.
- **LinkedIn guest search**: LinkedIn's public, no-login search, with three
  placeholder searches. It is rate-sensitive, so the node waits 12 seconds or
  more between its requests.
- **JazzHR** is in the file but switched off (commented out): its first run
  downloads about 20 MB.

The searches marked "placeholder" are examples. Open `config/discovery-node.yml`
and replace them with the roles and places you actually want; keep each list
short. To drop a board, delete its line or put `#` in front of it; to add one,
copy a line in the same style (the providers it can use are the files in
`providers/`). Then stop the node and start it again.

## How many finds per day

Your account accepts a limited number of finds per day from your computers
together (typically 100 on a free account and 400 on a paid one; the dashboard
shows yours as the *daily allowance*). A posting your account refuses (for
example one on a site it does not accept) also uses a quarter of a find, so the
allowance can run out before *Accepted today* reaches it. Your CareerAutopilot
Targeting tab shows exactly how much is used. When the limit is used up, the node keeps what it
found, waits until your account's day rolls over, and sends the rest then, in the
order it found them. Nothing is lost; raising the limit is up to whoever runs
your account.

## What is sent to your account

For each matching posting: its link, title, company, place, the pay if the
posting states it, the date it was posted, which board it came from, the node's
score for it and a few short reasons for that score. Separately, every few
minutes, a small status report: the node's version, how long it has been up,
which job is running, how each job last went (with a one-line summary), the
counts shown on the dashboard, and the last error if there was one. Your account
keeps only part of that report.

Coming the other way, your account sends the node your targeting: the roles,
places, companies and job boards from your Targeting tab, a few work-location
and work-authorization preferences, your city, state and country, and a list of
skill keywords drawn from your résumé. Your résumé itself, your contact details,
your pay answers and the Profile tab's private answers are never sent to the
node. Your pay floor stays on your account and is applied when your account
evaluates what the node sends.

## Changing settings

Two places, for two kinds of change:

- **The dashboard** for the job controls: on/off, interval, start time, run now.
  Remembered across restarts.
- **`config/discovery-node.yml`** for everything else: the job boards, how high
  a result must score to be sent (`hub.ship_min_score`, 40 by default; lower it
  to see more), how often the node re-reads your targeting, the dashboard's port,
  and so on. It is a plain text file with a comment on every setting. Stop and
  restart the node after editing it.

Your **targeting** itself (roles, places, companies) is not in that file. Change
it on the Targeting tab of your CareerAutopilot account; the node picks it up
within about half an hour.

To change the site address, the token or this computer's name, run the
launcher with `--reconfigure`:

```bash
./discovery-node.sh --reconfigure          # Linux / macOS terminal
.\discovery-node.cmd --reconfigure         # Windows (cmd or PowerShell)
```

## Options

Options go after the launcher's name. All are optional.

| Option | What it does |
| --- | --- |
| `--reconfigure` | Ask again for the address, token and name, then start. |
| `--port N` | Use dashboard port N (default 8390; the next free port if it is busy). |
| `--no-open` | Do not open the dashboard in your browser. |
| `--token-file PATH` | Read the token from a file, for setting up without a terminal. |
| `--url URL` | The CareerAutopilot address (default `https://davidchui.work`). It must be `https`. |
| `--name NAME` | A name for this computer. |
| `--help` | Show the options. |

The token can also come from the `CAREER_OPS_NODE_TOKEN` environment variable.
There is deliberately **no `--token` option**: a token on the command line can
be read by other programs on your computer.

## Where things are kept

Everything stays in the folder you unpacked it into:

| Path | What it is |
| --- | --- |
| `config/discovery-node.yml` | Your settings. Not secret. |
| `config/discovery-node.local.yml` | **Your token.** Limited to your user account where the system allows it. Never share it, commit it or copy it anywhere. |
| `data/discovery-node/` | The node's working files: state, a local copy of your controls, and logs (`data/discovery-node/logs/daemon.log`, which never holds your token). |
| `portals.yml`, `config/profile.yml`, `data/` | Written by the node from your targeting (`portals.yml` and `config/profile.yml` hold your title keywords, companies, places, city, state and country). They carry a "MACHINE-WRITTEN" note; do not edit them. |
| `node_modules/` | The one library it installed. |

Every file in this table is listed in the package's `.gitignore`, so
`git add -A`, a commit or a fork never carries them. (The package's own tests
start the node in a scratch folder and ask git about each file it wrote.)

## Troubleshooting

The node prints what is wrong in plain words; this is what the common messages
mean.

**"That is not a discovery token."** (The site calls this `token_scope`.) You
pasted a token meant for something else (the browser extension's, for instance).
Create a **discovery** token on Targeting → "Discovery on your computer", then
run the launcher with `--reconfigure`.

**"The site did not accept that token."** It was mistyped, has expired or was
revoked. Create a new one the same way and run with `--reconfigure`. Tokens
start with `cot_`.

**"The token works, but your CareerAutopilot profile is not finished."** (The
site calls this `profile_incomplete`.) The token is fine; your account has
nothing to search for yet. Add your résumé or a short bio on the Profile tab. The
node starts working as soon as you do.

**"The site is not allowing discovery for this account right now"** when you
set it up, or **"hub refused this node (...)"** in the window while it runs. The
site said no to the account, not to a single request. The message names which of
these it is:

- `stopped_by_administrator`: your account was stopped.
- `discovery_node_disabled`: discovery is switched off for your account.
- `pipeline_disabled`: your account's pipeline is switched off.
- `careerops_access_required`: your account no longer has CareerAutopilot access.
- `token_scope`: the token is the wrong kind. Create a **discovery** token.
- `use_node_mode`: the account is an administrator's, which runs its node in the
  self-hosted mode instead of this package.

Apart from `token_scope`, a new token does not help. The node waits at least an
hour before it tries again, and that wait survives a restart. If it is a
surprise, contact whoever runs your CareerAutopilot account.

**The daily limit.** If the site answers with a daily-limit message
(`daily_cap`), nothing is wrong: the node
keeps what it found and sends it after the limit resets. Nothing is lost.

**"this account already has the most nodes it may have" (`too_many_nodes`).**
An account can have up to five computers. Use a name you used before, or wait: a
computer that has not checked in for 30 days is forgotten. The node keeps what it
found and asks again in an hour.

**"Could not reach ... Check the address and your internet connection."** The
address is wrong, you are offline, or a firewall or proxy is in the way. The
address must start with `https://` and must not redirect somewhere else.

**"Installing failed (the output above says why)."** The first run needs the
internet to fetch js-yaml. Check your connection, then run
`npm install --omit=dev --ignore-scripts` in the folder (the command the message
itself gives) and read what it says.

**"Node.js 20 or newer is required."** Install the current LTS from
[nodejs.org](https://nodejs.org), then open a new terminal window.

**"Not starting: this folder already holds career-ops files of its own (...)".**
The node found a `cv.md`, a tracker or a hand-written `portals.yml` or
`config/profile.yml` here (the message lists which), or a career-ops environment
variable is set, and it will not write over your files. Unpack a fresh copy of
the package somewhere else.

**It runs but finds nothing.** Open the dashboard's *What it searches for*
section: if your roles or places are empty, fill in the Targeting tab. Remember
that most jobs run every several hours; use **Run now** to try one. Results
below `hub.ship_min_score` are held back and counted as *Held back*.

**The dashboard will not open.** Use the link printed in the window (it has the
access key). If you closed that window the node is not running: start it again.

## Stopping, starting again, and removing it

- **Stop:** press **Stop node** on the dashboard, press Ctrl+C in the window, or
  close the window. Nothing is left running.
- **Start again:** run the launcher again. It starts straight away with your
  saved settings.
- **Remove it:** stop it, then delete the folder. Then revoke the token on the
  **Companion** tab of your account so it can no longer be used. There is
  nothing else to uninstall, because nothing was installed anywhere else: the
  node never adds a service, scheduled task, startup entry or anything else that
  outlives its window.

## Getting help

If something here does not match what you see, open an issue at
[github.com/farawayfound/career-autopilot/issues](https://github.com/farawayfound/career-autopilot/issues).
Please do not paste your token or the dashboard link into an issue. To report a
security problem, follow [SECURITY.md](../SECURITY.md) instead.
