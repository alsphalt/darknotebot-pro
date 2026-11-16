# DARKNOTE CONTROL CENTER

Remote administration for an existing **Darknote WhatsApp bot** running on a **Pterodactyl** panel.

The bot stays where it is. This is a separate web application that talks to your panel through its
official **Client API**, so the files it shows, edits, backs up and deploys are the real production
files.

> Not a static dashboard. Every read, write, hash, backup and restart in this app goes through the
> panel API at request time. Where a capability is missing (no credentials, no permission, no
> console output) the UI says so instead of pretending.

---

## What it does

| Section | Reality |
|---|---|
| **Overview / Live Monitor** | Live container state, CPU/RAM/disk, uptime and restart count from the panel; Start/Stop/Restart over `POST /power`; WhatsApp verdict from the bot process's own status file or its own connection events |
| **Server Discovery** | Recursive walk of the actual filesystem → file index, SHA-256, AST-derived commands |
| **File Manager** | Browse, create, rename, move, copy, delete, upload, ZIP import with path-traversal rejection, ZIP download |
| **Code Editor** | Monaco, multi-tab, chunked load/save for multi-megabyte files, server-side drafts, validate → diff → deploy |
| **Case Manager** | Every `switch` case parsed with an AST, edit/duplicate/delete with structural checks |
| **Global Search** | Text, regex (ReDoS-guarded) and AST modes over indexed content, optional live re-verification |
| **Synchronization** | Index reconciliation, hash-based conflict detection, both sides preserved |
| **Deployments** | Backup → validate → atomic write → hash verify → restart → startup observation → rollback |
| **Backups & Versions** | Private content-addressed store + panel backups |
| **Download Center** | Serves freshly-read production bytes with a verified SHA-256 |
| **Terminal & Logs** | One persistent authenticated console websocket per server, relayed over SSE; command sending gated behind confirmation |
| **Admin Settings** | Accounts, roles, capability probe, security posture |

---

## Honest limits

- **No file-change events.** The Pterodactyl Client API has no webhook, so changes made directly in
  the panel are detected by *scheduled reconciliation*, not instantly. The UI labels the method.
- **A running container is not a connected WhatsApp session.** They are reported separately.
- **Startup health is only claimed when console output was actually observed.** If the panel will
  not give us the websocket, the deployment succeeds but is marked *unverified*, not *healthy*.
- **WhatsApp state has two sources.** If `DARKNOTE_BOT_STATUS_PATH` is configured and the bot writes
  a JSON status file (for example `/data/status.json` with `{"whatsapp":"connected","startedAt":"..."}`),
  that file is authoritative. Otherwise the state comes from this process's own console connection
  events; generic log text cannot change it, and events from a previous process are discarded. If
  neither is available the badge says *unknown* — it is never inferred from the container running.
- **The console buffer lives in process memory.** Run a single instance (`next start`), or the monitor
  and terminal will show different tails per replica.
- **Pterodactyl has no ranged file read.** Opening a large file downloads it once to the control
  center (cached for 90 s) and the browser then receives slices. The file itself is never truncated.
- **`node --check` is a syntax check, not a runtime proof.** A deployment can still fail at runtime;
  that is what rollback and the console are for.

---

## Quick start

```bash
npm install
cp .env.example .env.local        # then fill in the values
npm run db:check                  # connects, applies schema, prints table count
npm run create-admin -- --email you@example.com --name "You" --role owner
npm run dev                       # http://localhost:3000
```

Production:

```bash
npm run build && npm start        # must be a long-running Node process for SSE + scheduler
```

### Required environment

See `.env.example` for the annotated list. The three that matter:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string (`sslmode=require`) |
| `DARKNOTE_SECRET` | 32+ chars. Signs sessions and encrypts stored panel keys. **Changing it makes stored API keys unreadable.** |
| `DARKNOTE_ADMIN_EMAIL` / `DARKNOTE_ADMIN_PASSWORD` | One-time first-run owner bootstrap (or use `create-admin`) |

**Pterodactyl credentials are not environment variables.** Enter the panel URL, server identifier
and Client API key in *Admin Settings*. They are encrypted with `DARKNOTE_SECRET` (AES-256-GCM)
before storage and are never returned to the browser.

### Pterodactyl API key

Create a **Client API key** (Account → API Credentials) for the account that owns the server.
The key needs these subusers permissions on that server:

```
control.console   control.start   control.stop   control.restart
file.read         file.create     file.update    file.delete
file.rename       file.compress   file.decompress
file.upload       file.download
backup.read       backup.create   backup.download
websocket.connect
```

`getServer()` / `getPermissions()` are used by the capability probe; if your panel does not expose
`/permissions`, the probe reports restart permission as *unknown* rather than guessing.

Enter the **short server identifier** from the panel URL
(`https://panel.example.com/server/<identifier>`), not the server name.

---

## Verification status

Run:

```bash
npm run typecheck     # clean
npm test              # 21/21
npm run build         # compiles
```

`tests/monitor-editor.test.ts` drives the real services against a protocol-accurate panel double
that **enforces HTTP verbs** (a wrong verb gets 405, exactly like Next.js and Pterodactyl) and serves
a real Pterodactyl-style websocket:

1. resources come from the panel, not from defaults (null, never 0, when absent)
2. Start/Stop/Restart go out as `POST /api/client/servers/{id}/power` with `{"signal":"..."}` and
   actually change the container state
3. the console websocket authenticates, streams output, survives a reconnect, and the monitor shows
   the same tail
4. WhatsApp state follows this process's events, flips to disconnected on a drop, and resets when a
   new process starts
5. a 3 MB JavaScript file opens completely, reassembles byte-for-byte from chunks, saves with a
   backup, and the pre-write version restores exactly
6. the per-server editor limit is 16 MB by default and clamped by `DARKNOTE_MAX_EDITOR_BYTES`

`tests/routes.test.ts` parses every route file and every client call site and fails when a component
uses a verb the route does not export — the exact defect behind “Request failed (405)”.

`tests/pipeline.test.ts` drives the real services against a Pterodactyl-shaped panel
(`tests/mock-pterodactyl.mjs`) and asserts:

1. connection + registration against the panel API
2. discovery indexes real files, discovers `menu` / `ping` / `play`, never indexes the session folder
3. reading `.env` / `auth/creds.json` is refused
4. a stale `expectedHash` blocks the write and leaves production byte-identical
5. an approved write is backed up, hash-verified on read-back, and versioned
6. deployment triggers a real restart and does not claim healthy without evidence
7. rollback restores only the files that deployment changed
8. downloads serve SHA-256-verified production bytes
9. an edit made directly in the panel is detected on the next scan
10. the monitor never invents a WhatsApp state

**What this does not prove:** your panel's real permissions, quirks, rate limits or startup
behaviour. Use *Admin Settings → Connection checks (deep)* against your server — it performs the
real operations, including a scratch write that is read back and deleted.

---

## Code editor runtime

The editor has to show the production bytes, so three things are deliberate:

| Concern | Implementation |
|---|---|
| Component binding | `@monaco-editor/react` is imported as `mod.Editor`, not as the module namespace. A dynamic import of the namespace object is not a React component and renders no surface at all while the rest of the page works. |
| Monaco hosting | Served from this origin at `/monaco/vs`. `scripts/copy-monaco.mjs` copies `node_modules/monaco-editor/min/vs` into `public/monaco` on `postinstall`, `predev` and `prebuild` (git-ignored, ~14 MB). `src/lib/editor/monaco.ts` probes that path first and only falls back to the jsDelivr CDN if the local copy is missing; if neither answers it switches to the plain-text surface instead of showing an empty box. |
| Editor height | Measured with a `ResizeObserver` and passed to Monaco as an explicit pixel height. Percentage heights inside an auto-height panel collapse to `0 px`, which renders a working editor with no visible area. |
| Content proof | `GET /api/files/content?mode=full` returns the body plus `sha256`/`totalChars`; the page refuses to open a tab whose buffer length differs from `totalChars` or is empty while production reports bytes. The header prints the live character count so the buffer is visible as a number, not just as pixels. |

Safety before any write: an empty (or whitespace-only) buffer cannot be saved or
deployed over a file that has bytes on production, the panel response is checked
for a 200-with-empty-body, non-UTF-8 files are refused rather than decoded lossily,
and a deploy still re-reads production and compares SHA-256 before the restart.

## Large files

The old build refused anything above 2 MB. That limit came from a 512 KB database default multiplied
by four in the read layer; it is gone.

| Setting | Meaning |
|---|---|
| `DARKNOTE_MAX_EDITOR_BYTES` | Process-wide ceiling for one text file (default 64 MB) |
| `DARKNOTE_EDITOR_CHUNK_BYTES` | Slice size for chunked reads/writes (default 512 KB, 64 KB–8 MB) |
| `DARKNOTE_MAX_DOWNLOAD_BYTES` | Ceiling for downloads, backups and uploads (default 96 MB) |
| Settings → *Editor file limit (MB)* | Per-server limit, default 16 MB, clamped by the ceiling |
| `DARKNOTE_MAX_SQL_CACHE_BYTES` | Files above this (default 1 MB) are not mirrored into SQL |

How a large edit flows:

1. `GET /api/files/content?mode=meta` — size, SHA-256 and limit, no body.
2. `GET …&mode=chunk&offset=&length=` — ordered slices (UTF-16 units), progress bar in the UI.
3. `POST /api/drafts/chunk` (create) → `PUT` each slice → `POST` (finalize). Finalize reassembles
   once, checks every index is present, compares the byte count and verifies the browser's SHA-256.
4. `POST /api/deployments` with `{ draftId }` — the browser never re-uploads the file. Deploy backs
   up the current production file, writes atomically, re-reads and verifies SHA-256, restarts and
   watches startup output.
5. Older content stays restorable from Backups & Versions.

If a file genuinely exceeds the limit, the API answers **413** with the actual size, the configured
limit and the ceiling — it does not silently truncate.

---

## Architecture

```
src/app/(app)/*            13 server-rendered pages
src/app/api/*              28 route handlers (all mutating routes: permission + CSRF + origin check)
src/lib/pterodactyl/       Client API client (retries, typed errors, signed upload/download)
src/lib/files/             remote file operations, guarded writes, backups, validation
src/lib/services/          discovery, deploy, console, cases, replace, downloads
src/lib/sync.ts            reconciliation state, conflicts, resolution
src/lib/security/paths.ts  path confinement, secret blocking, exclusion rules
db/schema.sql              23 tables (Neon + embedded PGlite for local evaluation)
```

- **Pterodactyl is the source of truth.** Neon stores administration, indexes, hashes, versions,
  deployments, drafts, conflicts and audit history — never a shadow copy of production.
- **Every remote path** is resolved through `confineToRoot` and checked against the exclusion list and
  the secret patterns before any API call.
- **Drafts never touch production** until a deployment writes and verifies them.
- **Backups** live in a private store outside `public/`, written `0600`, and are read back only
  through authenticated routes.

---

## Security notes

- bcrypt (cost 12) password hashing; server-side sessions with revocation; CSRF double-submit on
  every mutating request; per-IP/per-email login throttling.
- Roles: `owner` → `admin` → `operator` → `viewer`, with per-server grants.
- WhatsApp session folders, `.env` files, private keys and `creds.json` are blocked from reading,
  editing, versioning and export — including from the Download Center.
- Credentials shared in chat should be rotated after use: **the GitHub token and the Neon password
  in this project's history should both be considered exposed.**
