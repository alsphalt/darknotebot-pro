# Darknote Control Center — build status

Last updated: 2026-11-16 · branch `main`


## This pass

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

### Verified in this pass

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 57/57 (`pipeline`, `monitor-editor`, `editor`, `explorer`, `routes`) |
| `npm run build` | passes (Next 15 production build) |
| `node tests/e2e-live.mjs` | **31/31** against `next start` + a 405-enforcing panel double (9 of them explorer checks) |
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
