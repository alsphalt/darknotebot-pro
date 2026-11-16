# Darknote Control Center — build status

Last updated: 2026-11-16 · branch `main`

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
