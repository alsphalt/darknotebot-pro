# Darknote Control Center — build status

**This tree is not runnable right now.** It contains the UI layer of one build and the server
layer of a second, concurrent build. `next build` cannot pass until one of them is chosen.

## What happened

Two implementations were written into `/project` at the same time:

| Location | Contents |
| --- | --- |
| `project/darknote-control-center` | this tree — UI written for a Prisma backend |
| `project/darknote-control` | a second tree with its own `node_modules`, Prisma-free SQL backend |

The second build also wrote into this folder: `src/lib/db.ts`, `src/lib/api.ts`,
`src/lib/auth/`, `src/lib/services/`, `src/lib/pterodactyl/`, `src/lib/security/`,
`src/lib/servers/`, `src/lib/util/`, `src/lib/sync.ts`, `src/lib/events.ts`. It replaced
`package.json` (Prisma was removed) and deleted the files this UI imports:
`src/lib/http.ts`, `guard.ts`, `rbac.ts`, `paths.ts`, `pterodactyl.ts`, `servers.ts`,
`storage.ts`, `indexer.ts`, `search.ts`, `deploy.ts`, `monitor.ts`, `console.ts`,
`downloads.ts`, `audit.ts` (replaced), `crypto.ts` (replaced).

Because the UI calls `/api/...` routes that only existed in the deleted layer, the app
compiles neither half.

## What is complete and reusable

UI (all 13 sections, responsive, dark premium theme):

- `src/components/app-shell.tsx`, `providers.tsx`, `ui.tsx`
- `src/app/(app)/page.tsx` — Overview
- `monitor`, `discovery`, `files`, `editor` (Monaco + mobile toolbar), `cases`, `search`,
  `sync`, `deployments`, `backups`, `downloads`, `console` (SSE), `settings`
- `src/app/login/page.tsx` — sign-in + first-run bootstrap
- `src/lib/client.ts` (CSRF-aware fetch, downloads), `use-api.ts`, `format.ts`

Database design (Prisma, 20 models: servers, indexes, versions, backups, deployments,
activity, drafts, sync history, conflicts, downloads):

- `prisma/schema.prisma`

Backend design that was implemented and then deleted (rewrite from the notes below):

- Pterodactyl Client API wrapper: `files/list|contents|write|download|upload|mkdir|rename|
  delete|copy|compress|decompress`, `resources`, `power`, `command`, `websocket`, `backups`
- Safe path layer: `withinRoot`, traversal rejection, secret classification
  (`.env`, `auth/`, `*.pem`, db files), binary sniffing
- Discovery: breadth-first walk (no recursive API), size/mtime/SHA-256 diff, index upsert,
  command metadata, conflict creation when a draft base hash is stale
- Search: literal / regex / switch-case / function / fuzzy, live re-read of production
- Cases: acorn AST extraction of `switch` cases with exact ranges, structural replace/
  delete/duplicate, re-parse validation
- Deploy: serializable DB lock, pre-flight conflict check, encrypted backup, write,
  re-read + SHA verify, restart, console health check, per-deployment rollback
- Console: server-side websocket relay with token refresh, ring buffer, SSE fan-out
- Backups: AES-256-GCM local driver or S3 (SSE-AES256), versions with inline copy < 250 KB

## Minimum work to finish (one architecture)

1. Decide: Prisma backend (schema above) **or** the SQL backend in `darknote-control`.
2. Delete the losing set of files and restore its `package.json`.
3. Re-create the API routes for the 13 pages with a single response envelope; the UI expects
   bare JSON payloads and `{ error: { code, message } }` on failure (`src/lib/client.ts`).
4. `npm install && npx prisma generate && npm run build`.
5. Configure `.env` from `.env.example`, create the first owner with `SETUP_TOKEN`, register
   the panel URL + Client API key + server identifier, then run discovery.

Nothing in this folder touches the bot or the Pterodactyl server. No credentials are stored
in the UI layer; the placeholder `.env` was removed.
