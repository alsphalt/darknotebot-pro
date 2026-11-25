# Darknote Control Center — build status

Last updated: 2026-11-22 · branch `main`

## This pass — the production database never initialised: a leaked migration lock

### What the deployment actually returns

`GET https://v0-darknote.vercel.app/api/health`, unauthenticated, twice thirty
seconds apart on 2026-11-22:

```
HTTP 503 · time_total 20.86 s / 20.98 s
databaseDriver: neon
databaseTarget: ep-…-pooler.c-9.us-east-2.aws.neon.tech/neondb
databaseError:  Another process is running DARKNOTE migrations
                (advisory lock held for 20s). Retry when it finishes…
tables: null · administrators: null · migrations.applied: 0
```

`GET /login` answers `200` (the page renders — it is what the operator sees),
but every API call that needs the database waited the full 20 s and then failed.
So the live symptom is **not** a missing `db/schema.sql` and **not** a missing
`DATABASE_URL`: the connection string is configured and points at Neon's pooled
endpoint. The database layer never got past the migration lock.

### Root cause

`withAdvisoryLock()` took a **session-level** lock (`pg_try_advisory_lock`) with a
node-postgres `Pool` pointed at `…-pooler.…neon.tech`. That host runs PgBouncer
in transaction mode: consecutive statements may be served by different backend
connections. The lock was therefore taken on one backend and
`pg_advisory_unlock()` was sent to another. The holder kept the lock until its
connection was recycled, which can be hours, and each new cold start then waited
20 s, threw, and cached nothing — the whole authenticated surface stayed down.

Production had been failing long enough that `migrations.applied` was still `0`:
no boot had ever completed the run.

### Fix (`src/lib/db/migrate.ts`)

- **Transaction-scoped lock.** `withMigrationLock()` runs
  `client.transaction(...)` and issues `select pg_advisory_xact_lock(...)` on that
  one connection, immediately followed by the DDL on the same connection.
  PostgreSQL releases an xact lock on commit or rollback, so a pooler cannot
  leave it behind.
- **Bounded wait inside PostgreSQL.** `set local lock_timeout` (20 s) replaces the
  250 ms client polling loop; `55P03` is mapped to the existing operator message.
- **A new lock key** (`hashtext('darknote_migrations_v2')`). The orphan is held
  on the old key by a backend this application cannot address, so reusing the old
  key would keep failing forever. A different key cannot collide with it; the
  orphan disappears when PgBouncer retires that connection.
- Migrations now also run atomically: a failure rolls the whole run back instead
  of leaving half of `schema.sql` applied. The registry insert stays
  `on conflict`, and every file is still idempotent.

Nothing is deleted, no credential or session is touched, and an existing
database is adopted exactly as before.

### Also in this pass — the serverless fallback and the login screen

- `db.ts`: `pgliteFallbackAllowed()` refuses the embedded PGlite fallback on
  Vercel/Lambda/Netlify in production unless `DARKNOTE_DB_DRIVER=pglite` is set
  deliberately. An ephemeral `/tmp` database would be created empty on one
  instance and discarded on the next cold start, taking the owner account with
  it; the error now names `DATABASE_URL` and the pooled Neon connection string.
- `/api/auth/session` initialises the database inside a `try/catch` and always
  answers `200` with `database.ok`/`database.error`, so the login page renders
  the reason instead of a bare 500. A failed probe never reports
  `needsBootstrap`, which would have invited a second owner.
- The login page prints that error verbatim and disables sign-in while it is
  present.

### Verified here

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | **174 tests, 166 pass, 0 fail, 8 skipped** (the skips are the PostgreSQL integration tests; this sandbox has no runnable PostgreSQL — see below) |
| `tests/migration-lock.test.ts` | lock is `pg_advisory_xact_lock`, inside the transaction, before the baseline; no `pg_try_advisory_lock`/`pg_advisory_unlock` anywhere; conflict maps to the operator message |
| `tests/migration.test.ts` | a v4-era database still heals through the new transactional path |
| `npm run build` (isolated worktree at `e4690d2`) | passes; `114/115` route traces list `db/schema.sql` **and** all three `db/migrations/*.sql` |
| `next start` + PGlite | `/login` 200; `/api/auth/session` 200 `database.ok:true`, `needsBootstrap:true`; `/api/health` 200 `PostgreSQL 18.6`, **54 tables**, migrations applied 4, pending `[]`; `POST /api/auth/bootstrap` created the owner, `POST /api/auth/login` returned the full owner permission set, the session cookie reports the user, `/` returned 200 |
| Guard, end to end | second instance with `VERCEL=1 NODE_ENV=production` and no `DATABASE_URL`: `/login` 200, `/api/auth/session` 200 with `database.ok:false` and the `DATABASE_URL` message, `/api/health` 503 |

### Not verified here

- **No Vercel credentials in this environment.** The deployment was inspected
  only through its public endpoints; deployment and runtime *logs* were not
  readable, so the Next.js digest `2171611015` cannot be decoded here — a digest
  is build-specific and only that deployment's log rows resolve it.
- **No Neon credentials.** The fix is exercised against PGlite (same PostgreSQL
  engine, 18.6) and against the mocked-pool contract test; the real pooled
  endpoint is not touched. `embedded-postgres` cannot run in this sandbox
  (its binaries need `libssl.so.1.1`, and `node_modules` is on a `noexec` mount).
- **No physical Android device.** Chrome/PWA behaviour and the "Aw, Snap!"
  renderer kill are unchanged by this pass and remain attributed only to what
  `browser_terminated_session` records on the next launch.

## Previous pass — `db/schema.sql` resolution, build packaging, one honest correction

`db/schema.sql` was already in the repository, at the exact path the code reads
(`db/schema.sql`, next to `package.json`, committed). What could fail was **finding** it and
**shipping** it.

- **Finding it.** `readSql()` tried `process.cwd()` and `process.cwd()/..` only. That is right for
  `npm run dev` from the project and wrong for everything else: systemd/pm2/Pterodactyl units, a
  `next start` launched from another directory, a bundled `.next` output. `src/lib/db/migrate.ts` now
  resolves the root from `DARKNOTE_DB_DIR`, then the cwd and its ancestors, then the entry script and
  the bundled module directory and their ancestors (8 levels, stopping at `/`). A candidate counts
  only if `db/schema.sql` exists and contains a `create table`; the failure message lists every path
  tried and names the override instead of saying "not found".
- **Shipping it.** No module imports the SQL, so the bundler never traced it and a serverless or
  standalone build could ship without the folder. `next.config.ts` now sets
  `outputFileTracingIncludes` for `db/schema.sql` and `db/migrations/**/*.sql`. Verified in the build
  output: every route trace (`.next/server/app/**/*.nft.json`) lists all four SQL files.
- **Not `vercel.json`.** `{"functions": {"api/*.js": {"includeFiles": "db/**"}}}` applies to Pages
  Router files under `api/`. This project has none — it is App Router route handlers — so that
  snippet would have been inert. The tracing include is the mechanism that actually works on Vercel.
- **Sentinel false positives.** `CrashSentinel` was mounted in both the root layout and the app
  layout, so every authenticated navigation started a second sentinel; each start read the first
  one's live heartbeat as "terminated without unloading" and filed a false
  `browser_terminated_session`. It is now mounted once, and a heartbeat under 60 s old is treated as a
  live page (second tab, fast reload) instead of a crash.

**"Aw, Snap!" is not a server error.** Chrome shows it when the renderer process dies (memory/GPU);
a 500 from the server renders the Next.js error page in a working tab. The database path fix removes
the "schema not found" failure, but it cannot explain or cure a renderer kill, and this pass does not
claim otherwise. The sentinel is what will identify it, now that its evidence is not polluted.

**Verified:** `tsc --noEmit` clean; `npm test` **168 tests, 160 pass, 0 fail, 8 pre-existing skips**
(8 new: root resolution, override, rejection of a non-schema file, subdirectory start, actionable
error, tracked-file check, live-heartbeat guard); `npm run build` succeeds and the trace lists the
SQL files. Runtime check with the process started from `/tmp`, i.e. outside the checkout:
`scripts/db-check.ts` created all 54 tables from `schema.sql` + 4 migrations, and a production
`next start` returned `200` for `/login` and `/api/health` with `migrations.pending: []`.

**Not verified:** a serverless deployment (no Vercel/Neon credentials here) and a physical Android
device.

## Production incident — "a server-side exception has occurred" (fixed)

Symptom: `v0-darknote.vercel.app` showed the Next.js error page
(`Application error: a server-side exception has occurred … Digest: 2171611015`)
for a signed-in browser, and every `/api/*` route answered
`500 {"error":"column \"pending_delete\" does not exist"}`.

Cause — a migration that cannot converge:

1. `imported_project_files` was created by an older build (v4 schema, no
   `pending_delete` column).
2. `create table if not exists` never alters an existing table, so the column was
   still missing.
3. `migrate()` ran `db/schema.sql` **before** the ALTERs that add the column, and
   schema.sql line 854 creates `imported_project_files_pending_delete_idx … where
   pending_delete = true` → `column "pending_delete" does not exist`.
4. That throws before `schema_migrations` is written, so every cold start retried
   and failed again: the whole authenticated surface stayed at 500.
5. `/` renders the authenticated layout for a browser that holds a session
   cookie → `currentUser()` → first query → the same exception → the digest page.
   Anonymous `curl /` only sees the 307 to `/login`, which is why it looked
   intermittent.

Fix (`src/lib/db.ts`): a pre-flight `repairLegacyColumns()` runs before
`schema.sql` and independently of the version marker. It adds
`imported_project_files.pending_delete`, `github_sync_jobs.message` and the
`editor_drafts` v2 columns when the table exists without them. schema.sql then
finds every column its indexes reference, and the marker is recorded once.
Existing data is untouched — only missing columns are added.

Second defect in the same deploy (`src/lib/env.ts`): `ensureDataDirs()` ran
`mkdir '/var/task/.data'` on Vercel's read-only filesystem, so `/api/health`
returned `500 ENOENT … mkdir '/var/task/.data'` and any upload/backup write
failed. It now falls back to `os.tmpdir()/darknote-data`, logs one warning, and
keeps `backupDir`/`uploadDir`/`pgliteDir` consistent. On serverless that
directory is ephemeral — durable uploads/backups still need `DARKNOTE_DATA_DIR`
on a persistent volume or object storage.

Verified: `npx tsc --noEmit` clean, `npm test` **129/129** (new
`tests/migration.test.ts` builds a v4-era database and proves it heals),
`npm run build` passes. Reproduced the exact production error locally against a
drifted database before the fix (500 `column "pending_delete" does not exist`)
and confirmed 200 after it; `/sys` (read-only) also falls back and reports
`storage: ok`.

## This pass — Android stability: bounded history, error containment, polling discipline

Reported symptom: Chrome for Android eventually kills the tab with `Aw, Snap!`.
There is no crash log from a real device in this repository, so this pass fixes the
causes that are provable from the code rather than claiming a single culprit.

### What was actually unbounded

- **BIGBROTHER history.** `getConversation` selected every row of a thread and the
  API serialised all of them; the full workspace and the always-mounted floating
  panel both kept the whole array in React state. A long thread of answers with
  blocks and citations is tens of megabytes of JS objects, and the renderer is the
  first thing Android reclaims.
- **`useApi` cache.** Sixty entries with no size accounting. One cached
  `/api/monitor` payload carries the console tail, so a browsing session could pin
  several megabytes for the life of the tab.
- **Polling while hidden.** `refreshMs` timers kept firing in background tabs, so a
  dashboard left open kept hitting the panel and the database.
- **Console auto-scroll.** `scrollIntoView({ behavior: "smooth" })` ran once per log
  line, restarting a compositor animation for every line a busy bot printed.
- **No error boundary existed anywhere.** One throw during render unmounted the
  entire tree, which on a phone is indistinguishable from a crash and takes the
  navigation with it.

### What changed

- `bigbrother/memory.ts`: `getConversation` now pages newest-first with
  `limit` (1-200, default 40) and an opaque `before` cursor built from
  `(created_at, id)`. It returns `hasMore`, `nextCursor` and `total`. The cursor is
  normalised to ISO-8601 because `pg` hands back `Date` objects for `timestamptz`.
- `api/bigbrother/conversations/[id]`: accepts `limit` and `before`, rejects a
  malformed cursor with 400 instead of silently restarting at the top.
- BIGBROTHER workspace: loads 40 messages, "Load earlier messages" prepends the
  previous page, hard ceiling of 240 messages in memory.
- Floating panel: loads the last 60 messages, and **releases them when closed** —
  the panel is mounted by the app shell for the whole session.
- `lib/use-api.ts`: cache is bounded by retained bytes (3 MB) as well as entries
  (30), evicting least-recently-fetched first; polling stops on `visibilitychange`
  and runs one fresh read when the page returns.
- Console: tail following writes `scrollTop` instead of starting a smooth scroll
  per line.
- New error containment: `components/error-boundary.tsx` (reusable, reports the
  component stack to `/api/errors/report`), `app/error.tsx`,
  `app/(app)/error.tsx` (keeps the sidebar and session), `app/global-error.tsx`
  (inline styles, no providers) and `app/not-found.tsx`. The workspace layout wraps
  page content in a boundary, so a failing page no longer takes the shell down.

### Verified in this pass

- `npx tsc --noEmit`: clean.
- `npm test`: **135 passing** (134 before this pass, plus a new pagination test that
  proves newest-first ordering, a working cursor across three pages, no gaps, no
  duplicates, clamping and cursor rejection).
- `npm run build`: production build succeeds.
- `npm start` smoke test with a real seeded account: login 200, dashboard 200,
  `/api/servers` 200, unauthenticated API 401, `/api/monitor` without `serverId`
  400, unknown route renders the new 404 page, `/manifest.webmanifest` and `/sw.js`
  200.
- Pagination over HTTP on the running server: 2-message thread with `limit=1`
  returned one message, `hasMore: true` and an ISO cursor; the `before` page
  returned the older message with `hasMore: false`; `before=garbage` returned 400.

### Not verified here

- **A physical Android device.** Chrome for Android, the installed PWA and an
  Android WebView were not available in this environment, so the memory profile
  after a long session, the animation cost and `Aw, Snap!` itself are not measured
  here. What can be said is that the unbounded allocations above are gone.
- **A live Neon instance.** No `DATABASE_URL` was supplied, so the database layer
  was exercised against PGlite (the same SQL engine in WASM). Neon itself, pooling
  limits and connection exhaustion under serverless were not re-tested in this pass.

## This pass — GitHub & file import, CRASH AND FIX, automatic synchronization

### Import

- **LIVE MONITORING → Upload a file** opens a compact chooser: **📂 File Upload** or **🐙 GitHub
  Import**. Nothing is a mock-up: both paths write real rows and report real counters.
- **File upload** accepts a ZIP or individual files (64 MB per file, 128 MB extracted, 800 files).
  Entries that are absolute, contain `..` or a NUL byte are rejected; credential-shaped paths and
  `node_modules`/`dist`/`.next`-style folders are skipped; a single wrapping folder is stripped so the
  project keeps its own structure. Every text file keeps its original bytes, filename and folder.
- **GitHub import** reads the repository through the GitHub API (`GET /user/repos` for the account
  list, recursive tree + blobs for the contents) and stores text inline plus each file's git blob sha.
  A specific repository configured in Admin Settings is offered directly (scenario A); otherwise the
  account's repositories are listed with search and paging (scenario B); with nothing configured the
  dialog says **GITHUB NOT CONNECTED** and links to the settings section (scenario C).
- Import progress is a real job row (`project_import_jobs`) polled by the dialog, so the bar reflects
  files actually fetched and stored.

### GitHub connection (Admin Settings → GitHub)

- A token is verified against `GET /user` before it is stored, then encrypted with AES-256-GCM under
  `DARKNOTE_SECRET`; only `••••••••abcd` is ever displayed, no route returns it, and it is never
  logged or written into project files.
- An OAuth App authorization-code flow is implemented (`/api/github/oauth/start` → callback, single-use
  state, 10-minute expiry, secret and code exchanged server-side). It needs a registered OAuth App;
  the token path works without one.
- A GitHub **email address is not authentication** anywhere in the flow.
- Connection status (connected/disconnected), repository configured, token configured, failure reason,
  **TEST CONNECTION** (token → account → repository list → configured repository → branch) and
  disconnect/replace are all present.
- Sync preferences: enable/disable automatic synchronization and the debounce delay (default 5 s,
  2–120 s), with the pending list and a manual push per project.

### CRASH AND FIX 👷‍♂️

- `/crash-and-fix`: animated three-colour terminal (blue scanning, green success, red failure) with a
  3 s initialisation and a ~5 s scan window. The pacing is presentation only — every result line comes
  from the API response (`filesScanned`, `casesExamined`, `durationMs`), and a search that takes longer
  simply keeps running.
- The search parses the imported projects' JavaScript with acorn and returns **only** matching
  `case '<name>':` blocks, with exact start/end offsets. Nested switches, block-scoped cases and
  neighbouring cases are handled; no file name, folder or surrounding code is sent to the browser.
- Edit in Monaco (line numbers, undo/redo, search, unsaved indicator) and **SAVE**:
  file-hash check → case-offset/content check → fragment parse → whole-file parse → conditional
  `UPDATE … WHERE sha256` → re-read → history entry. A stale file, a moved case, a syntax error or a
  case-label change is refused with a readable reason and nothing is written.
- Every save records `crash_fix_history` (before/after code, both file hashes, status) and the panel
  can restore any of those versions through the same guarded path.

### Synchronization

- A save marks the file dirty and upserts one pending job at `now + delay`; further saves move the
  deadline, so 5 seconds of inactivity produce one commit.
- The worker compares the branch head and every touched blob sha with what was imported, then creates
  blobs → tree → commit and patches the ref **without force**. It reads the ref back (and up to five
  file contents) before reporting success, so `GITHUB SYNCHRONIZED SUCCESSFULLY` only appears after
  GitHub confirms the commit.
- A moved branch or a changed file is a **conflict**: nothing remote is overwritten, the local edit is
  kept, and the panel offers *rebase & push* (our changed files on top of the remote tree) or
  *discard local* (re-read the files from GitHub).
- The queue is drained by an in-process timer (`instrumentation.ts`, Node runtime) and by
  `POST /api/github/sync/tick`, which the pending views call — so it also works where a timer cannot
  run. `DARKNOTE_DISABLE_GITHUB_WORKER=1` turns the timer off (tests, e2e).

### Verified in this pass

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | **111/111** (`projects` incl. 12 new cases, plus `pipeline`, `editor`, `explorer`, `routes`, `monitor-editor`, `pwa`, `error-intelligence`, `bigbrother`, `llm-loop`) |
| `npm run build` | passes; `/crash-and-fix`, `/projects` and the new API routes are in the route table |
| `node tests/e2e-projects.mjs` | **25/25** against `next start` + a protocol-accurate GitHub double: token rejected when wrong, repository imported, case found and saved, stale save refused (409), push confirmed and the ref really moved, `.env` never imported, ZIP traversal entry rejected, three pages render |
| GitHub double | Real git blob SHAs (`sha1("blob <len>\0<content>")`), ref only advances through a commit, `force:false` enforced, per-file contents read back after the push |
| Conflict path | colleague push → local save → `conflict`, remote head untouched, local text preserved, then rebase-and-push lands both |

### Not verified here

- **A real GitHub account.** The end-to-end run used a protocol-accurate double; the client speaks the
  documented REST/Git Data API and maps 401/403/404/422/429, but the first run against github.com with
  a real token is still yours to make (Admin Settings → TEST CONNECTION).
- **The OAuth App flow.** It needs a registered OAuth App (client id + secret); the code path is
  implemented and type-checked but no real client id existed in this environment.
- **A physical phone.** Layout is mobile-first and the dialog is a bottom sheet, verified at HTML and
  CSS level only.
- **Very large repositories.** A truncated recursive tree is refused with a clear message rather than
  importing a partial project; binary and >2 MB files are metadata-only by design.

---

## Previous pass

### Installable app — PWA (new)

The console can now be installed as a standalone app. No dependency was added:

- `public/manifest.webmanifest` — `standalone`, scope `/`, dark theme, 192/512 icons plus maskable
  variants and three shortcuts.
- `public/sw.js` — root-scoped worker. Static build output is stale-while-revalidate; **navigations
  are network-first and never cached**, and `/api/*` is not intercepted at all, because this is an
  authenticated admin surface. Failed navigations fall back to `/offline`, whose hashed chunks are
  precached with it.
- `src/components/pwa.tsx` — `PwaProvider` in the root layout, `beforeinstallprompt` capture, an
  install row in the sidebar/drawer, a header icon button, a settings card, an iOS
  *Share → Add to Home Screen* sheet, an offline strip and a "new version" reload toast driven by
  `SKIP_WAITING`.
- `src/app/offline/page.tsx` — static fallback outside the authenticated group.
- `scripts/generate-icons.mjs` (`npm run icons`) — renders the icon set from signed distance fields,
  so there are no binary image sources to maintain and every icon is generated at its exact size.
- `next.config.ts` — `Service-Worker-Allowed: /`, `must-revalidate` for `sw.js`,
  `application/manifest+json` for the manifest, immutable caching for `/icons/*`.

Verified locally: `npm run typecheck`, `npm test` (70 tests, including 7 new PWA contract tests) and
`npm run build` (route table shows `/offline` as static). The dev server answers `/sw.js`,
`/manifest.webmanifest`, `/icons/icon-192.png` and `/offline` with the expected status codes and
headers, and `/login` carries `<link rel="manifest">` plus the Apple web-app meta tags. The browser
install prompt itself was not exercised here — no browser was available in this environment.

### Code editor — blank surface (fixed)

The tab header rendered (path, 391 KB, SHA) while the editor area stayed empty. Three
independent causes were found and fixed:

1. **Zero-height editor container.** The surface sat in `h-[calc(100%-52px)]` inside an
   auto-height panel, so the percentage resolved to `auto`; `@monaco-editor/react` then
   applied `height: 100%` to a 0 px box and Monaco laid out nothing. The surface is now
   measured with a `ResizeObserver` and given an explicit pixel height (`CodeEditor`).
2. **Monaco loaded from a CDN.** If that host is unreachable the loader never resolves and
   the area stays blank forever. Monaco's AMD build is now served from `/monaco/vs`
   (copied at install/build time, git-ignored) with a CDN fallback and a plain-text
   surface as the last resort — the plain surface shows the real file, never placeholder.
3. **Silent emptiness.** An empty body or a short read is now a hard error
   (`checkLoadedContent`), the header prints the live character count, and `mode=full`
   refuses a 200-with-empty-body when the panel reports bytes (`empty_body`).

Also: non-UTF-8 files are refused instead of being decoded lossily, BOMs survive a
round-trip, the editor font is a real font stack (Monaco measures glyphs through canvas,
which does not understand `var(--font-mono)`), and an empty buffer cannot be written over
a non-empty production file (client guard + server guard `empty_write_blocked`).

### Project Explorer (new)

`/explorer` plus `/api/explorer{,/category,/file,/search,/scan}`. Seven categories
discovered from the indexed project (plugins, package.json, entry, cases, functions,
config, database), global search merging symbols + names + line-level code hits, an
import graph for relationships, a rescan that reports added/changed/deleted/renamed, and
file management (open/edit, download, replace, rename, move, create, delete) with
confirmation and pre-write backups. Protected: credentials are never read, database and
data records cannot be edited or deleted.

### Follow-up pass

- **Folder deletion is now guarded server-side.** A directory needs its own name as the
  confirmation token (not `DELETE`), and is refused when it is `.git`, `node_modules`,
  `auth`, `sessions`, a data directory (`database`/`data`/`storage`), or when any indexed
  descendant is a credential path or a data record. The UI asks for the folder name before
  enabling the button.
- **The discovery page no longer holds a hardcoded "important files" list** containing
  `BIGBRO.js`. It calls `detectEntryPoint()` and lists the file the panel actually starts
  plus the resolved `package.json`.
- Unit tests: 2 new cases for the deletion rules and `resolvePackageMainPath`.

### Pagination + freshness

- `GET /api/explorer/category` takes `offset` and returns the real `total`, so a long
  list pages instead of truncating at a fixed cap; the page appends the next 200.
- The overview warns `index_stale` when a file was written after the last index update
  (upload/deploy), pointing at a rescan.
- Dependency freshness is opt-in (`DARKNOTE_NPM_REGISTRY_CHECK=1`): latest published
  versions are compared with the declared ranges, bounded to 40 packages, 4 concurrent,
  4 s timeout, 30 min cache. Off = unknown, never a guess.
- Global search reports how many indexed files were skipped (binary/oversize/secret).

### Verified in this pass

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 63/63 (`pipeline`, `monitor-editor`, `editor`, `explorer`, `routes`) |
| `npm run build` | passes (Next 15 production build) |
| `node tests/e2e-live.mjs` | **34/34** against `next start` + a 405-enforcing panel double (13 of them explorer checks) |
| BIGBRO.js 391 KB | opened through `mode=full`, body length = `totalChars`, SHA-256 matches, draft saved, reload restored production, deploy kept every byte, original restored |
| Explorer discovery | a deliberately different layout (`/plugins`, `/commands`, `/config`, `/database`, `/data`) resolves all seven categories, `menu` plugin grouped with 2 files, cases from 3 files with lines, entry = `/index.js` from `node index.js` |
| Explorer safety | `/database/owner.json` delete → 403 `protected_data`; delete without confirmation → 400; `.env` never read; `.env.example` shows key names only |
| Rescan | new file appears, identical-content delete+add reported as a rename, unrelated delete reported as deleted |

### Not verified here

- **Your real panel.** No credentials were supplied; everything above ran against a
  protocol-accurate panel double. Categories reflect whatever the index contains — run
  “Scan project” once on your server, then check the counts.
- **A physical phone.** Layout is mobile-first (sheet navigation, large tap targets, no
  horizontal page overflow) but verified at the HTML/asset level, not by touch.
- **Outdated dependency versions.** No npm registry lookup is configured, so the UI
  reports declared ranges, missing folders and undeclared imports — never a guessed
  “latest” version.
- **Import graph completeness.** The graph parses up to 400 cached files within a 12 MB
  budget; larger projects report how many files were skipped.

## Verified here

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 21/21 pass (`pipeline`, `monitor-editor`, `routes`) |
| `npm run build` | passes (Next 15 production build) |
| Power actions | `POST /api/monitor` → `POST /api/client/servers/{id}/power` `{"signal":"…"}`; the panel double answers 405 to any other verb and still sees the call only when POST is used |
| Console | one persistent authenticated websocket per server, auth → `send logs`, live output buffered, reconnect with backoff, token expiry re-auth |
| Large files | 3 MB file opened, chunked, saved with a backup, restored byte-identically |
| Route surface | every client `apiGet/apiPost/apiPut/apiDelete` call maps to a route that exports that method |

## Fixed in this pass

- **HTTP 405 on Restart/Start/Stop.** `POST /api/monitor` did not exist; the route only exported GET.
  Added the power handler and moved power permission to `server.power`.
- **Same defect elsewhere.** `PUT /api/drafts` (editor draft save), `POST /api/versions` (restore),
  `POST /api/backups` (panel backup) and the whole chunked-draft resource were missing. All added.
- **Live Monitor placeholders.** `buildMonitor` coerced missing CPU/RAM/disk/uptime to `0`; they are
  now `null` and the UI shows “—”. Container state comes from `/resources`, not from a default.
- **Console never attached.** The monitor passed `capture: false`, so nothing was ever captured.
  The service now keeps one authenticated websocket per server; the monitor, terminal and deploy
  health check share its buffer.
- **WhatsApp state.** Parsing is restricted to WhatsApp-specific connection events from the current
  process (a new process start resets it). Generic log text cannot change the badge. An optional
  `DARKNOTE_BOT_STATUS_PATH` makes a bot-written status file authoritative.
- **2 MB editor limit.** Removed. The 512 KB schema default × 4 was the cause. Per-server limit
  (default 16 MB) clamped by a 64 MB process ceiling, chunked read/write, server-side drafts,
  SHA-256 verified finalize, deploy by `draftId`, 413 with real sizes when genuinely too large.
- **Mobile editor freezes.** The editor walked the entire string on every keystroke; validation is
  now debounced and skipped above 400 K characters, and a large-file Monaco profile is applied.
- **API key type.** A `ptla_` Application key is rejected up front with an actionable message
  instead of a confusing 401 from every Client route.

## Not verified here

- **Your real panel.** No panel URL, Client API key or server identifier were supplied. Everything
  above ran against a protocol-accurate panel double. To confirm for real: Settings → Test
  connection, then Restart/Start/Stop from Overview and Live Monitor, then open a >10 MB `.js`,
  save a draft, deploy, and restore a version.
- **A physical phone.** Chunked IO and the Monaco profile are exercised at API level only.
- **Multiple replicas.** The console buffer and websocket are process memory. Run one instance, or
  move the buffer to Redis/pub-sub before scaling out.
- **Panel ranged reads.** Pterodactyl `/files/contents` has no range support, so the first open
  downloads the whole file to the control center (cached 90 s) and slices it for the browser.

## Operational notes

- Set `DARKNOTE_SECRET` before production; changing it makes stored panel keys unreadable.
- Use a **Client** API key (`ptlc_…`), never an Application key (`ptla_…`).
- `DARKNOTE_MAX_EDITOR_BYTES` / `DARKNOTE_EDITOR_CHUNK_BYTES` tune large-file behaviour;
  `DARKNOTE_BOT_STATUS_PATH` enables the authoritative WhatsApp probe.
- Schema migration v2 raises old 512 KB server limits to 16 MB and adds the chunk table. It is
  idempotent and runs on startup.
