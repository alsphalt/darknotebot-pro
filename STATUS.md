# Darknote Control Center — build status

Last updated: 2026-11-20 · branch `main`

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
