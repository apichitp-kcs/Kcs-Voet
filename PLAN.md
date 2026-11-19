# KCS Vote — implementation plan

| Phase | Deliverable | Where |
|---|---|---|
| 1. DB + RPC | Tables, RLS (deny-all to anon), SECURITY DEFINER RPCs, scoring SQL, rate limit, audit log | `supabase/migrations/` |
| 1b. Tests | PGlite (real Postgres in WASM) tests: scoring fixtures (50 vs 5 dept, self-vote, low turnout, ties, unweighted), one-vote-per-name, idempotent retry, undo, RLS/grants | `tests/` |
| 2. Voter page | Zero-build static site (HTML/CSS/JS, plain `fetch` to PostgREST RPC). Thai/English. | `voter/` → Cloudflare Pages |
| 3. Admin app | Electron: app-password gate (scrypt), Supabase Auth admin login, employee import (.xlsx), topics CRUD, live 3D chart, turnout, undo, rules text | `desktop/` |
| 4. Display | Second window (projector, F11). Modes: waiting / voting (QR + counter) / reveal (5→4→podium 3-2-1, confetti) / ranking / rules. Three.js | `desktop/renderer/display.*` |
| 5. Export | Excel (exceljs) + PDF (Chromium `printToPDF`, Thai fonts OK), QR PNG/print | `desktop/main.js`, `report.html` |
| 6. Packaging | electron-builder: NSIS installer + portable .exe, README | `desktop/package.json` |

## Key design decisions
- **Anonymity**: `ballots` has no emp_code, no timestamp, random UUID id. Registry and ballot are written in one RPC transaction.
  Admin-undo needs a link, so `voters_registry.ballot_id` is stored **only when `topics.allow_undo = true`** (default).
  Turn it off for a fully unlinkable topic (undo then impossible). See README “Anonymity”.
- **Voter identity** in the browser is an opaque random `employees.id` UUID; `emp_code` never leaves the database.
- **Admin auth**: Supabase Auth user listed in `public.admins`. Admin RPCs check `is_admin()`. The desktop app only holds URL + anon key + admin email; the Supabase password is AES-256-GCM encrypted with a key derived (scrypt) from the local app password, so the config file is portable to any PC.
- **Realtime**: admin app subscribes to `topics` / `topic_counters` (Supabase Realtime) and also polls every 2 s as a fallback. The display window gets its data from the admin window over IPC (one Supabase session only).
- **Scoring**: `public.score_topic(topic)` and `public.dept_turnout(topic)` SQL functions (see README “Scoring”).
