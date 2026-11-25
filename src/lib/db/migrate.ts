import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DbClient, DbConnection, MigrationRecord, MigrationStatus } from './types';

/**
 * Version-controlled migrations.
 *
 * The baseline is `db/schema.sql` — the single idempotent script that creates
 * every table, index and constraint. Everything after it lives in
 * `db/migrations/NNNN_name.sql` and is applied in filename order.
 *
 * Why not rewrite the schema into 40 ordered migrations? Because the baseline is
 * already `create … if not exists` and is shared by the embedded PGlite
 * development database, the tests and every existing deployment. Rewriting it
 * would mean guessing the state of production; adding a forward-only log on top
 * of it does not.
 *
 * Guarantees:
 *   - a **transaction-scoped** PostgreSQL advisory lock serialises concurrent
 *     boots (several serverless instances cold-starting at once must not race),
 *     and is released by PostgreSQL when the transaction ends, so a connection
 *     pooler cannot leave it held; the whole run is therefore atomic;
 *   - every applied file is recorded with a SHA-256 checksum, so an edited
 *     migration that was already deployed is reported instead of silently
 *     skipped;
 *   - a database created by an older build (legacy `schema_migrations` rows, no
 *     `db_migrations` table) is adopted without re-running anything and without
 *     touching existing data.
 */

const REGISTRY_TABLE = 'db_migrations';
const LEGACY_TABLE = 'schema_migrations';

/**
 * Advisory-lock name for the migration run.
 *
 * `_v2` is deliberate: the previous key (`hashtext('darknote_migrations')`) can
 * still be held by a leaked SESSION-level lock. On Neon's pooled endpoint
 * (`…-pooler.…neon.tech`) PgBouncer runs in transaction mode and may hand each
 * statement a different server connection, so `pg_advisory_lock()` was taken on
 * one backend and `pg_advisory_unlock()` delivered to another. The lock then
 * stayed held on a connection the application can no longer address, and every
 * later boot waited out the timeout and failed — the production login page was
 * stuck on it.
 *
 * A new key cannot collide with that orphan. From here on the lock is
 * transaction-scoped (`pg_advisory_xact_lock`), which PostgreSQL releases on
 * commit or rollback on the same backend connection the transaction ran on, so
 * it cannot leak through a pooler.
 */
const LOCK_KEY = `hashtext('darknote_migrations_v2')`;

export const BASELINE_NAME = '0001_baseline';

/**
 * Columns added to tables that a previous build already created.
 *
 * `create table if not exists` never alters a table that already exists, so an
 * older database keeps its old column set. schema.sql is then executed against
 * it and fails halfway — `imported_project_files_pending_delete_idx` references
 * `pending_delete`, which the old table does not have:
 *
 *   column "pending_delete" does not exist   (db/schema.sql:854)
 *
 * Because that failure happened before the version marker was written, every
 * later boot repeated it and every query failed (the production outage of
 * 2026-11-20). The repair therefore runs BEFORE the baseline and independently
 * of the registry, so a database that is already marked current but drifted
 * still heals itself.
 */
const LEGACY_COLUMNS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ['imported_project_files', 'pending_delete', 'boolean not null default false'],
  ['github_sync_jobs', 'message', 'text'],
  ['editor_drafts', 'expected_bytes', 'bigint'],
  ['editor_drafts', 'expected_sha256', 'text'],
  ['editor_drafts', 'chunk_count', 'integer'],
];

/** Folder holding `schema.sql` and `migrations/`, relative to the project root. */
const SQL_DIR = 'db';

/** How far up the tree to look for the project root before giving up. */
const MAX_ANCESTORS = 8;

declare const __dirname: string | undefined;

function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MAX_ANCESTORS; depth += 1) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return out;
}

/** Directory of the script that was started (`next start`, `npm run db:migrate`). */
function entryDir(): string | null {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.length > 0 ? path.dirname(path.resolve(entry)) : null;
}

/** Directory of this module as emitted by the bundler, when the runtime has one. */
function moduleDir(): string | null {
  try {
    return typeof __dirname === 'string' && __dirname.length > 0 ? __dirname : null;
  } catch {
    return null;
  }
}

/**
 * Every directory that could be the project root, most explicit first.
 *
 * `process.cwd()` alone is not enough. A process started by systemd, pm2 or
 * Pterodactyl, a `next start` launched from a parent folder, and a Next
 * standalone/serverless bundle all have a working directory that has nothing to
 * do with where the project was built. The old lookup only tried `cwd` and its
 * parent, so the first database call failed with "db/schema.sql not found" even
 * though the file was committed.
 */
export function dbRootCandidates(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | null | undefined) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };

  // 1. Explicit override, so a host with an unusual layout has a documented way
  //    out. Accepts the project root or the `db` folder itself.
  const override = process.env.DARKNOTE_DB_DIR?.trim();
  if (override) {
    add(override);
    add(path.dirname(path.resolve(override)));
  }

  // 2. The working directory and its ancestors (`npm run`, `next dev`).
  for (const dir of ancestors(process.cwd())) add(dir);

  // 3. The entry script and this module, then their ancestors. Covers a server
  //    started from another directory and a bundled `.next` output.
  for (const start of [entryDir(), moduleDir()]) {
    if (!start) continue;
    for (const dir of ancestors(start)) add(dir);
  }

  return roots;
}

/** A `db/schema.sql` that is not the project's baseline (an empty file, a note) is rejected. */
function looksLikeBaseline(file: string): boolean {
  try {
    return /create\s+table/i.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The project root that owns `db/schema.sql`, or `null` when no candidate has
 * one. Exported for the test that proves the cwd-independent lookup.
 */
export function findDbRoot(roots: string[] = dbRootCandidates()): string | null {
  for (const root of roots) {
    if (looksLikeBaseline(path.join(root, SQL_DIR, 'schema.sql'))) return root;
    // DARKNOTE_DB_DIR may point straight at db/.
    if (path.basename(root) === SQL_DIR && looksLikeBaseline(path.join(root, 'schema.sql'))) {
      return path.dirname(root);
    }
  }
  return null;
}

let cachedRoot: string | null = null;

/** Slate the memoised root; only tests and scripts that chdir need this. */
export function resetDbRootCache(): void {
  cachedRoot = null;
}

/**
 * Project root, resolved once. Throws an operator-facing error that lists every
 * path that was tried — a bare "not found" is what made this hard to diagnose.
 */
export function dbRoot(): string {
  if (cachedRoot) return cachedRoot;
  const root = findDbRoot();
  if (!root) {
    const tried = dbRootCandidates().map((candidate) => path.join(candidate, SQL_DIR, 'schema.sql'));
    throw new Error(
      [
        'Cannot initialise the database: db/schema.sql was not found.',
        'Looked for:',
        ...tried.map((candidate) => `  ${candidate}`),
        'The file must sit next to package.json. If your host ships only the built output,',
        'make sure db/ is traced into the bundle (outputFileTracingIncludes in next.config.ts),',
        'or set DARKNOTE_DB_DIR to the directory that contains db/.',
      ].join('\n'),
    );
  }
  cachedRoot = root;
  return root;
}

function readSql(relative: string): string {
  const file = path.join(dbRoot(), relative);
  if (!fs.existsSync(file)) {
    throw new Error(`${relative} not found at ${file} — cannot initialise the database`);
  }
  return fs.readFileSync(file, 'utf8');
}

export function baselineSql(): string {
  return readSql(path.join(SQL_DIR, 'schema.sql'));
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 32);
}

/**
 * Every migration this build ships, in application order: the baseline first,
 * then `db/migrations/*.sql` sorted by name.
 */
export function migrationFiles(): MigrationFile[] {
  const baseline = baselineSql();
  const files: MigrationFile[] = [
    { name: BASELINE_NAME, sql: baseline, checksum: checksum(baseline) },
  ];

  // Same root as the baseline: a migrations folder found through a different
  // rule than schema.sql is a folder from a different checkout.
  const dir = path.join(dbRoot(), SQL_DIR, 'migrations');
  if (!fs.existsSync(dir)) return files;

  const extra = fs
    .readdirSync(dir)
    .filter((entry) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(entry))
    .sort();
  for (const entry of extra) {
    const sql = fs.readFileSync(path.join(dir, entry), 'utf8');
    files.push({ name: entry.replace(/\.sql$/i, ''), sql, checksum: checksum(sql) });
  }
  return files;
}

async function tableExists(client: DbClient, table: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.tables
        where table_schema = current_schema() and table_name = $1
     ) as present`,
    [table],
  );
  return Boolean(result.rows[0]?.present);
}

/** Idempotent: adds the column only when the table exists without it. */
async function addColumnIfMissing(
  client: DbClient,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = $1 and column_name = $2
     ) as present`,
    [table, column],
  );
  if (result.rows[0]?.present) return;
  if (!(await tableExists(client, table))) return;
  await client.query(`alter table ${table} add column if not exists ${column} ${definition}`);
}

export async function repairLegacyColumns(client: DbClient): Promise<void> {
  for (const [table, column, definition] of LEGACY_COLUMNS) {
    await addColumnIfMissing(client, table, column, definition);
  }
}

async function ensureRegistry(client: DbClient): Promise<void> {
  await client.query(
    `create table if not exists ${REGISTRY_TABLE} (
       name         text primary key,
       checksum     text not null,
       applied_at   timestamptz not null default now(),
       duration_ms  integer
     )`,
  );
}

async function appliedMigrations(client: DbClient): Promise<MigrationRecord[]> {
  const rows = await client.query<{
    name: string;
    checksum: string;
    applied_at: string;
    duration_ms: number | null;
  }>(`select name, checksum, applied_at, duration_ms from ${REGISTRY_TABLE} order by name`);
  return rows.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    appliedAt:
      (row.applied_at as unknown) instanceof Date
        ? (row.applied_at as unknown as Date).toISOString()
        : String(row.applied_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  }));
}

export async function migrationStatus(client: DbClient): Promise<MigrationStatus> {
  await ensureRegistry(client);
  const files = migrationFiles();
  const applied = await appliedMigrations(client);
  const appliedByName = new Map(applied.map((record) => [record.name, record]));
  return {
    available: files.map((file) => file.name),
    applied,
    pending: files.filter((file) => !appliedByName.has(file.name)).map((file) => file.name),
    drifted: files
      .filter((file) => {
        const record = appliedByName.get(file.name);
        return record ? record.checksum !== file.checksum : false;
      })
      .map((file) => file.name),
  };
}

/**
 * Run the migrations under a transaction-scoped advisory lock.
 *
 * Everything happens on ONE connection: `set local lock_timeout` and
 * `pg_advisory_xact_lock` inside `client.transaction`. That is what makes the
 * lock safe behind a transaction-mode pooler — the lock is bound to the same
 * backend as the DDL that follows it, and PostgreSQL drops it when the
 * transaction ends, however it ends. The previous implementation used
 * `pg_try_advisory_lock` on the pool, where lock and unlock could land on
 * different server connections and the lock outlived the process.
 *
 * The timeout is enforced by PostgreSQL (`lock_timeout`) rather than a polling
 * loop, so a waited-on lock cannot silently extend past it.
 */
async function withMigrationLock<T>(
  client: DbClient,
  fn: (connection: DbConnection) => Promise<T>,
  waitMs = 20_000,
): Promise<T> {
  return client.transaction(async (connection) => {
    await connection.query(`set local lock_timeout = '${Math.max(1_000, Math.floor(waitMs))}ms'`);
    try {
      await connection.query(`select pg_advisory_xact_lock(${LOCK_KEY})`);
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === '55P03') {
        throw new Error(
          'Another process is running DARKNOTE migrations (advisory lock held for 20s). Retry when it finishes, or run `npm run db:migrate` once from a single machine.',
        );
      }
      throw error;
    }
    return fn(connection);
  });
}

export interface MigrateOptions {
  /** Only report what would change. */
  dryRun?: boolean;
  /** Ignore checksum drift instead of failing. */
  allowDrift?: boolean;
  /** Skip the advisory lock (single-connection embedded databases). */
  noLock?: boolean;
}

export interface MigrateResult extends MigrationStatus {
  appliedNow: string[];
  skipped: boolean;
}

/**
 * Apply everything that is pending. Safe to call on every boot: after the first
 * successful run it costs two reads.
 */
export async function migrate(
  client: DbClient,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  // Heal drifted tables before the baseline touches their indexes.
  await repairLegacyColumns(client);
  await ensureRegistry(client);

  const files = migrationFiles();
  const existing = await appliedMigrations(client);

  // Adoption: a database created by a build that only knew `schema_migrations`
  // already contains the baseline tables. Record it instead of re-running 900
  // lines of `create … if not exists` on every cold start.
  if (existing.length === 0 && (await tableExists(client, LEGACY_TABLE))) {
    const legacy = await client.query<{ version: number }>(`select version from ${LEGACY_TABLE}`);
    if (legacy.rows.length > 0 && !options.dryRun) {
      const baseline = files[0];
      await client.query(
        `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, 0)
         on conflict (name) do nothing`,
        [baseline.name, baseline.checksum],
      );
      existing.push({
        name: baseline.name,
        checksum: baseline.checksum,
        appliedAt: new Date().toISOString(),
        durationMs: 0,
      });
    }
  }

  const appliedByName = new Map(existing.map((record) => [record.name, record]));
  const pending = files.filter((file) => !appliedByName.has(file.name));
  const drifted = files
    .filter((file) => {
      const record = appliedByName.get(file.name);
      return record ? record.checksum !== file.checksum : false;
    })
    .map((file) => file.name);

  /**
   * The baseline is `create … if not exists` end to end, so re-running it can
   * only add what is missing — never rewrite a row. A cosmetic edit to
   * schema.sql (a comment, a reordered column in a table that already exists)
   * therefore must not block a boot; it is re-applied once and its checksum
   * refreshed. Numbered migrations are not idempotent by contract and stay
   * strictly checked: editing a released one is a bug, not a taste change.
   */
  const baselineDrift = drifted.includes(BASELINE_NAME);
  const strictDrift = drifted.filter((name) => name !== BASELINE_NAME);
  if (strictDrift.length > 0 && !options.allowDrift) {
    throw new Error(
      `Migration checksum drift: ${strictDrift.join(', ')} changed after it was applied. Add a new migration instead of editing a released one (or pass --allow-drift if you know the change is safe).`,
    );
  }

  if (baselineDrift && !options.dryRun) {
    await client.exec(files[0].sql);
    await client.query(
      `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, 0)
       on conflict (name) do update set checksum = excluded.checksum`,
      [files[0].name, files[0].checksum],
    );
    const record = appliedByName.get(files[0].name);
    if (record) record.checksum = files[0].checksum;
  }

  /** Apply every pending file through one executor (the pool or its transaction). */
  const run = async (executor: DbClient | DbConnection): Promise<string[]> => {
    const appliedNow: string[] = [];
    for (const file of pending) {
      if (options.dryRun) {
        appliedNow.push(file.name);
        continue;
      }
      const started = Date.now();
      try {
        await executor.exec(file.sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.name} failed: ${message}`);
      }
      await executor.query(
        `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, $3)
         on conflict (name) do update set checksum = excluded.checksum, duration_ms = excluded.duration_ms`,
        [file.name, file.checksum, Date.now() - started],
      );
      appliedNow.push(file.name);
    }
    return appliedNow;
  };

  const appliedNow = options.noLock
    ? await run(client)
    : await withMigrationLock(client, (connection) => run(connection));
  const status = await migrationStatus(client);

  return { ...status, appliedNow, skipped: appliedNow.length === 0 };
}
