# KCS Vote

Anonymous, department-weighted voting for **K Casting and Solution Co., Ltd. (KCS)** — ~150 employees, 12 departments.

| Part | Tech | Where it runs |
|---|---|---|
| Voter page (scan ONE QR code) | Static HTML/CSS/JS, no build, no framework | Cloudflare Pages (free) |
| Backend | Supabase Postgres: RLS on every table, SECURITY DEFINER RPCs, anon key only | Supabase (free) |
| Admin + projector display | Electron (Windows installer + portable `.exe`), Three.js | Any Windows PC |

Thai is the default language everywhere; English is one click away.

```
KCS-Vote/
├─ supabase/migrations/…_kcs_vote_init.sql   tables, RLS, RPCs, scoring
├─ supabase/add-admin.sql                    make a Supabase user an admin
├─ tests/db.test.mjs                         scoring + one-vote-per-name tests (real SQL in PGlite)
├─ voter/                                    the voter web page (deploy this folder)
├─ desktop/                                  Electron admin app + display + exports
├─ scripts/                                  voter config generator, asset copier
└─ assets/                                   KCS logo variants
```

---

## 1. Supabase (one time, ~10 minutes)

1. Create a **new** project at <https://supabase.com> (free plan, region *Southeast Asia (Singapore)*). Save the database password somewhere safe.
2. **SQL Editor → New query** → paste and **Run** each file in `supabase/migrations/` **in order**: `…0001_kcs_vote_init.sql`, then `…0002_keep_alive.sql`.
   *(Alternative with the CLI: `npx supabase link --project-ref <ref>` then `npx supabase db push`.)*
3. **Authentication → Users → Add user → Create new user**: admin email + strong password, tick *Auto Confirm User*.
4. **SQL Editor**: open `supabase/add-admin.sql`, replace the email, **Run**. It must list the admin.
5. **Authentication → Sign In / Providers → turn OFF “Allow new users to sign up”.** (Non-admins could not do anything anyway, but there is no reason to allow sign-ups.)
6. **Project Settings → API Keys**: copy the **Project URL** and the **anon** (or **publishable**) key.
   ⚠️ Never use the `service_role` / secret key anywhere in this project.

> Free-tier projects pause after ~7 days without database activity. Set up the keep-alive (section “Never paused” below) and check **Last DB activity** in the admin app (*Settings*).

## 2. Voter page on Cloudflare Pages

The page is plain static files — no Worker, no Functions — so it stays far below every free-plan limit.

**Option A — upload from this PC (simplest)**

```bash
copy .env.example .env      # then edit .env: SUPABASE_URL and SUPABASE_ANON_KEY
npm install
npm run voter:deploy        # writes voter/config.js, then `wrangler pages deploy voter`
```

The first `wrangler` run opens a browser to log in to Cloudflare and creates the project `kcs-vote`. You get a URL like `https://kcs-vote.pages.dev`.

**Option B — Git integration**: push the repo, then in Cloudflare → *Workers & Pages → Create → Pages → Connect to Git*:
- Build command: `node scripts/voter-config.mjs`
- Build output directory: `voter`
- Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`

`voter/_headers` sets a strict Content-Security-Policy (only `https://*.supabase.co` may be contacted). If you use a custom Supabase domain, add it to `connect-src`.

Try the UI without any backend: open the page with `?demo=1` (e.g. `npm run voter:serve` → <http://localhost:5173/?demo=1>).

## 3. Admin app (.exe)

### Build
```bash
cd desktop
npm install                # downloads Electron
npm run dist               # → desktop/dist/KCS-Vote-Setup-<version>.exe and KCS-Vote-Portable-<version>.exe
```
`npm start` runs it without building; `npm run smoke` renders a sample PDF/Excel/QR poster into `desktop/smoke-out/` as a self-check.
The `.exe` is not code-signed, so Windows SmartScreen shows “More info → Run anyway” the first time.

### First run (any PC)
The app asks for: Supabase URL, anon key, admin email + password (from step 1), the voter page URL, and a new **app password** (min. 8 characters).
It signs in to test everything, then saves `kcs-vote.config.json`:

- **Portable exe**: next to the `.exe` (carry it on a USB stick together with the exe).
- **Installed**: `%APPDATA%\KCS Vote\` (or next to the installed exe if a config file is already there).
- The Supabase password inside is encrypted (AES-256-GCM) with a key derived from the app password (scrypt). The file works on any PC, but only with the app password. *Settings → Export config* / *Import config* move it between PCs.
- 5 wrong app passwords → increasing lock-out.

### Automatic updates

Installed copies (**KCS-Vote-Setup-x.y.z.exe**) update themselves from this repository's GitHub Releases (`apichitp-kcs/Kcs-Voet`, set in `desktop/package.json → build.publish` and `desktop/updater.js`):

- The app checks at start-up and every 2 h, downloads in the background, and installs **when the app is closed** — never in the middle of an event. A banner offers *Restart & update now*; *Settings → App updates* shows the version and a *Check for updates* button.
- The **portable** exe cannot replace itself; it only shows “new version available” with a link to the download page. Use the installer on any PC that should stay up to date (install it once; after that, no more copying files around).
- Your settings file is not touched by updates. Use *Settings → Export config* / *Import config file…* to move it to the installed copy.

**Publishing a new version** (built by GitHub Actions, `.github/workflows/release.yml`, no token needed):

```bash
# 1. bump "version" in desktop/package.json, e.g. 1.1.0 -> 1.1.1, and commit
git tag v1.1.1
git push && git push origin v1.1.1
```

The workflow builds on Windows and publishes the release with `KCS-Vote-Setup`, `KCS-Vote-Portable` and `latest.yml`. The tag must equal the version in `desktop/package.json`. Releases of a public repository are downloadable by anyone — this is harmless (no secrets are inside the exe; the config file and app password are needed to use it).

> The exe is not code-signed. On PCs with **Smart App Control** turned on, Windows blocks it (and its updates). Use a PC without Smart App Control, or buy a code-signing certificate and add it to electron-builder.

## 3½. Never paused (keep-alive)

**Why:** Supabase pauses free projects after ~7 days of low **database** activity. A ping that only reaches an HTTP endpoint does not count, so every ping calls the RPC `public.keep_alive()`, which does a real read (`count(*)` of topics and employees — no row data is returned) plus a one-row upsert into `keep_alive_log`. It returns only `{ok, at}`, uses the public anon key (never `service_role`), and ignores pings more frequent than once a minute.

Three independent layers:

| Layer | Schedule | Setup |
|---|---|---|
| 1. Cloudflare Worker cron (`keepalive-worker/`) | every 12 h (00:00 / 12:00 UTC) | below |
| 2. GitHub Actions (`.github/workflows/keep-alive.yml`) | every 2nd day 03:00 UTC + manual run | below |
| 3. Admin app | at every start and every 6 h while open | automatic |

**Layer 1 — Cloudflare Worker** (free plan; no route, no public URL; one request per run, one retry after 5 s):

```bash
cd keepalive-worker
npx wrangler secret put SUPABASE_URL          # https://<ref>.supabase.co
npx wrangler secret put SUPABASE_ANON_KEY     # anon / publishable key
npx wrangler secret put ALERT_WEBHOOK         # optional: Slack/Discord/Google Chat webhook, called if both attempts fail
cd ..
npm run keepalive:deploy
```

(The first `secret put` may offer to create the Worker — answer yes.) Verify with `npm run keepalive:tail` and wait for the next cron, or in the Cloudflare dashboard open the Worker → *Settings → Trigger events* (cron listed) and *Logs* (“keep-alive ok”). `node keepalive-worker/test.mjs` tests the Worker logic offline.

**Layer 2 — GitHub Actions:** push the repo to GitHub → *Settings → Secrets and variables → Actions* → add `SUPABASE_URL` and `SUPABASE_ANON_KEY` → *Actions → Supabase keep-alive → Run workflow* once to test. The job fails (and GitHub e-mails you) if the HTTP status is not 200 or `ok` is not `true`.
⚠️ GitHub **disables scheduled workflows after 60 days without repository activity**. When you get that e-mail, re-enable the workflow in the *Actions* tab (or push a commit now and then).

**How to check:** admin app → *Settings* → **Last DB activity** (time + source: `cf-worker` / `github` / `desktop`). It turns red when older than 3 days, and the app warns at start-up if the database was idle for more than 3 days before it was opened. Or in Supabase: *Table Editor → keep_alive_log*.

**Already paused?** Supabase Dashboard → the project → **Resume project** (takes a few minutes; data is kept). A paused free project can only be resumed for a limited time (currently about 90 days); after that only a backup download is offered — do not ignore the pause warning e-mails.

## 4. Running an event

**Pre-event checklist (the day before):**
- [ ] Admin app → *Settings*: **Last DB activity** is less than 24 h old (`keep_alive_log.last_ping` < 24 h).
- [ ] Employees imported; headcount per department looks right.
- [ ] Topic options = the 12 departments; scoring parameters and the *Rules* page checked.
- [ ] QR poster printed; the voter URL opens on a phone over mobile data.
- [ ] Projector connected; *Open display* goes fullscreen on it.


1. **Employees** → *Download template* or use your own Excel: columns `emp_code`, `first_name`, `last_name`, `department` (Thai headers such as รหัส / ชื่อ / นามสกุล / แผนก / “ชื่อ-นามสกุล” are auto-detected; titles นาย/นาง/นางสาว are stripped). Preview shows duplicates and blanks; choose **Replace all** or **Merge/update**.
2. **Topics** → *New topic* → *Use all departments* (creates the 12 department options, linked for self-vote detection). Optional start/end time; weighting on/off, own-department weight, minimum turnout, exclude low turnout, allow undo.
3. **QR code** → save PNG or an A4 poster PDF / print. One QR for all topics.
4. **Live & control** → **Open voting**. Open the **display** (goes fullscreen on a second monitor/projector automatically; F11 toggles). Display mode *Voting (QR)* shows the QR, title and “voted X / total” only.
5. Watch the live 3D chart, voted counter and per-department turnout (low-turnout departments are flagged; *Include/Exclude* overrides).
6. **Close voting** → resolve ties with ▲▼ if shown → **Reveal results** → the display plays the reveal (5 → 4 → podium 3, 2, 1 with confetti). Space / → on the display skips ahead. Then *Full ranking* and *Rules*.
7. **Export Excel / PDF** (ranking, weighted + raw counts, turnout, rules, timestamp, logo).

If someone voted under another person’s name: **Undo a vote** → search the name → *Undo* (reason is logged). The name becomes free and exactly that ballot is removed; nobody sees what it was.
**Reset topic** asks twice (the second time you must type `RESET`).

## 5. Scoring

`public.score_topic(topic)` and `public.dept_turnout(topic)` in the migration. With **weighting on**:

- Every voting department distributes a total of **1.0** point, whatever its size.
- Inside a department each vote is worth `raw / Σraw`, where `raw = 1` normally and `raw = self_vote_weight` (default 0.5) for a vote for one’s own department. Without self votes that is exactly `1 / (number of people from that department who voted)`; with self votes it is re-normalised so the department still totals 1.0.
- A department whose turnout is below `min_turnout_pct` (default 30 %) of its headcount is flagged **low turnout** and, if `exclude_low_turnout`, its 1.0 is not counted — the admin can re-include it.
- **Score = sum over departments.** Highest first. Equal scores share a rank and are marked as a tie; the admin sets their order (tiebreak). Raw vote counts are always shown next to the score.

With **weighting off**: plain vote count.

Worked example (from the tests): department A (50 people) all vote C; department B (5 people) all vote A → C = 1.0, A = 1.0 (a tie). Size alone does not win.
Self-vote example: 4 of B vote B, 1 votes A, weight 0.5 → raw 2 vs 1 → B gets 2/3, A gets 1/3.
Note: re-normalisation means that if *every* voter of a department votes for itself, that department still gives itself the full 1.0 (the self-weight only shifts the share *between* options). Set the weight to 0 to ignore self votes entirely.

## 6. Anonymity — what is stored

| Table | Contains | Never contains |
|---|---|---|
| `voters_registry` | topic, emp_code, vote time (rounded to the minute), retry key | the choice |
| `ballots` | topic, voter **department**, option, random UUID | name, emp_code, employee id, timestamp |

Both rows are written in one transaction by `submit_vote`, so they can never disagree.

**Tradeoff for admin undo.** To delete exactly one person’s ballot, the registry row keeps the ballot’s id **only when the topic has `allow_undo = true` (default)**. No RPC ever returns that link, and anon / admin users cannot read either table, but whoever has *database owner* access (Supabase dashboard / service role) could join them. For a fully unlinkable vote, untick *Allow admin to undo* on the topic: the link is then never stored, and switching it off later erases existing links permanently (undo becomes impossible). Other leaks were closed on purpose: ballots have no timestamp and random ids (no ordering correlation); the admin app and exports only see aggregates; the projector only receives results after **Reveal**.

Voters never see results. The name list is only served while a topic is accepting votes; `emp_code` is never sent to the browser (voters pick an opaque random id).

## 7. Security & limits

- RLS on all tables, all table privileges revoked from `anon` / `authenticated`; voters can call only `get_open_topics`, `voter_names`, `submit_vote`. Admin RPCs check `is_admin()` (Supabase Auth user listed in `public.admins`).
- `submit_vote` is atomic and idempotent (client retry key), enforces open status + time window, one vote per name (`PRIMARY KEY (topic_id, emp_code)`), valid option, and rate limits (per client IP 600/min — generous because a whole office may share one IP — and 10/min per name).
- ~150 concurrent voters is a tiny load for Supabase free tier (each vote = one short transaction). The admin app uses Supabase Realtime with a 2-second polling fallback.
- No secrets in the repo: `.env`, `voter/config.js`, `kcs-vote.config.json` are git-ignored. The anon key is public by design.

## 8. Development

```bash
npm install
npm test                 # 21 DB tests (incl. keep-alive): scoring fixtures (50 vs 5, self vote, low turnout, ties, unweighted),
                         # one-vote-per-name, idempotent retry, time window, undo, anonymity, RLS/grants
npm run assets           # re-copy fonts/logos into voter/ and desktop/renderer/
```

Browser-only previews (dev files are excluded from the .exe):
- `desktop/renderer/dev-display.html?mode=voting|reveal|ranking|rules` — display with fake data.
- `desktop/renderer/dev-admin.html` — the full admin UI running against the real migration inside PGlite (serve the repo root, e.g. `npx http-server . -p 5175`).

Fonts: *Prompt* (SIL Open Font License) via `@fontsource/prompt`.
