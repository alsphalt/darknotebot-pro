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
| **Overview / Live Monitor** | Live container state, CPU/RAM/disk, uptime, restart count, and a WhatsApp connection verdict inferred from real console lines |
| **Server Discovery** | Recursive walk of the actual filesystem → file index, SHA-256, AST-derived commands |
| **File Manager** | Browse, create, rename, move, copy, delete, upload, ZIP import with path-traversal rejection, ZIP download |
| **Code Editor** | Monaco, multi-tab, drafts stored separately from production, validate → diff → deploy |
| **Case Manager** | Every `switch` case parsed with an AST, edit/duplicate/delete with structural checks |
| **Global Search** | Text, regex (ReDoS-guarded) and AST modes over indexed content, optional live re-verification |
| **Synchronization** | Index reconciliation, hash-based conflict detection, both sides preserved |
| **Deployments** | Backup → validate → atomic write → hash verify → restart → startup observation → rollback |
| **Backups & Versions** | Private content-addressed store + panel backups |
| **Download Center** | Serves freshly-read production bytes with a verified SHA-256 |
| **Terminal & Logs** | Real console output over SSE, command sending gated behind confirmation |
| **Admin Settings** | Accounts, roles, capability probe, security posture |

---

## Honest limits

- **No file-change events.** The Pterodactyl Client API has no webhook, so changes made directly in
  the panel are detected by *scheduled reconciliation*, not instantly. The UI labels the method.
- **A running container is not a connected WhatsApp session.** They are reported separately.
- **Startup health is only claimed when console output was actually observed.** If the panel will
  not give us the websocket, the deployment succeeds but is marked *unverified*, not *healthy*.
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
npm test              # 10/10
npm run build         # compiles
```

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
