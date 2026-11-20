import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DbClient, MigrationRecord, MigrationStatus } from './types';

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
 *   - a PostgreSQL advisory lock serialises concurrent boots (several serverless
 *     instances cold-starting at once must not race);
 *   - every applied file is recorded with a SHA-256 checksum, so an edited
 *     migration that was already deployed is reported instead of silently
 *     skipped;
 *   - a database created by an older build (legacy `schema_migrations` rows, no
 *     `db_migrations` table) is adopted without re-running anything and without
 *     touching existing data.
 */

const REGISTRY_TABLE = 'db_migrations';
const LEGACY_TABLE = 'schema_migrations';
const LOCK_KEY = `hashtext('darknote_migrations')`;

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

function readSql(relative: string): string {
  const candidates = [
    path.join(process.cwd(), relative),
    path.join(process.cwd(), '..', relative),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }
  throw new Error(`${relative} not found — cannot initialise the database`);
}

export function baselineSql(): string {
  return readSql(path.join('db', 'schema.sql'));
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

  const dirCandidates = [
    path.join(process.cwd(), 'db', 'migrations'),
    path.join(process.cwd(), '..', 'db', 'migrations'),
  ];
  const dir = dirCandidates.find((candidate) => fs.existsSync(candidate));
  if (!dir) return files;

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

async function withAdvisoryLock<T>(
  client: DbClient,
  fn: () => Promise<T>,
  waitMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  let locked = false;
  while (!locked) {
    const result = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(${LOCK_KEY}) as locked`,
    );
    locked = Boolean(result.rows[0]?.locked);
    if (locked) break;
    if (Date.now() > deadline) {
      throw new Error(
        'Another process is running DARKNOTE migrations (advisory lock held for 20s). Retry when it finishes, or run `npm run db:migrate` once from a single machine.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try {
    return await fn();
  } finally {
    try {
      await client.query(`select pg_advisory_unlock(${LOCK_KEY})`);
    } catch {
      /* the connection is closing; the lock dies with the session */
    }
  }
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

  const run = async (): Promise<string[]> => {
    const appliedNow: string[] = [];
    for (const file of pending) {
      if (options.dryRun) {
        appliedNow.push(file.name);
        continue;
      }
      const started = Date.now();
      try {
        await client.exec(file.sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.name} failed: ${message}`);
      }
      await client.query(
        `insert into ${REGISTRY_TABLE} (name, checksum, duration_ms) values ($1, $2, $3)
         on conflict (name) do update set checksum = excluded.checksum, duration_ms = excluded.duration_ms`,
        [file.name, file.checksum, Date.now() - started],
      );
      appliedNow.push(file.name);
    }
    return appliedNow;
  };

  const appliedNow = options.noLock ? await run() : await withAdvisoryLock(client, run);
  const status = await migrationStatus(client);

  return { ...status, appliedNow, skipped: appliedNow.length === 0 };
}
