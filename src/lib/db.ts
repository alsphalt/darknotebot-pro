import fs from 'node:fs';
import path from 'node:path';
import { env, ensureDataDirs } from './env';

export type SqlParam = string | number | boolean | null | string[] | number[];
export interface DbConnection {
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<{ rows: T[] }>;
  /** Run a multi-statement script. Used only for schema application. */
  exec(sql: string): Promise<void>;
}

export interface DbClient extends DbConnection {
  readonly kind: 'neon' | 'pglite';
  transaction<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T>;
}

const SCHEMA_VERSION = 4;

interface Cache {
  client?: Promise<DbClient>;
}
const globalCache = globalThis as unknown as { __darknoteDb?: Cache };
const cache: Cache = (globalCache.__darknoteDb ??= {});

function schemaSql(): string {
  const candidates = [
    path.join(process.cwd(), 'db', 'schema.sql'),
    path.join(process.cwd(), '..', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }
  throw new Error('db/schema.sql not found — cannot initialise the database');
}

async function createNeon(): Promise<DbClient> {
  const { Pool } = await import('pg');
  const sslSetting = env.databaseSsl;
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: Number(process.env.DARKNOTE_DB_POOL ?? 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl:
      sslSetting === 'disable'
        ? false
        : { rejectUnauthorized: sslSetting !== 'no-verify' },
  });
  const client: DbClient = {
    kind: 'neon',
    async query<T>(sql: string, params?: SqlParam[]) {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>) {
      const connection = await pool.connect();
      const transactionClient: DbConnection = {
        async query<T>(sql: string, params?: SqlParam[]) {
          const result = await connection.query(sql, params as unknown[]);
          return { rows: result.rows as T[] };
        },
        async exec(sql: string) {
          await connection.query(sql);
        },
      };
      try {
        await connection.query('begin');
        const result = await fn(transactionClient);
        await connection.query('commit');
        return result;
      } catch (error) {
        try {
          await connection.query('rollback');
        } catch {
          /* ignore rollback failure */
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  };
  return client;
}

async function createPglite(): Promise<DbClient> {
  ensureDataDirs();
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create({ dataDir: env.pgliteDir });
  const client: DbClient = {
    kind: 'pglite',
    async query<T>(sql: string, params?: SqlParam[]) {
      const res = await pg.query(sql, params as unknown[]);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>) {
      const transactionClient: DbConnection = {
        async query<T>(sql: string, params?: SqlParam[]) {
          const result = await pg.query(sql, params as unknown[]);
          return { rows: result.rows as T[] };
        },
        async exec(sql: string) {
          await pg.exec(sql);
        },
      };
      await pg.query('begin');
      try {
        const result = await fn(transactionClient);
        await pg.query('commit');
        return result;
      } catch (error) {
        try {
          await pg.query('rollback');
        } catch {
          /* ignore rollback failure */
        }
        throw error;
      }
    },
  };
  return client;
}

async function migrate(client: DbClient): Promise<void> {
  await client.query(
    `create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())`,
  );
  const applied = await client.query<{ version: number }>(`select version from schema_migrations`);
  const versions = new Set(applied.rows.map((r) => Number(r.version)));
  if (versions.has(SCHEMA_VERSION)) return;
  // schema.sql is idempotent (create ... if not exists). It must run on the same
  // connection/instance the application will query, otherwise the tables land in
  // a different database.
  await client.exec(schemaSql());

  // v2: the old schema defaulted every server to a 512 KB file limit, which the
  // read layer doubled into the "2048 KB editor/backup limit" error. Raise that
  // old default once; values an operator deliberately set are left alone.
  if (!versions.has(2)) {
    await client.query(
      `alter table connected_servers alter column max_file_bytes set default 16777216`,
    );
    await client.query(`update connected_servers set max_file_bytes = 16777216 where max_file_bytes = 524288`);
    await client.query(`alter table editor_drafts add column if not exists expected_bytes bigint`);
    await client.query(`alter table editor_drafts add column if not exists expected_sha256 text`);
    await client.query(`alter table editor_drafts add column if not exists chunk_count integer`);
  }

  // v3: Error Intelligence (error_intel_events) and BIGBROTHER (conversations,
  // messages, memory, assets, tutorials, usage). schema.sql is idempotent, so
  // the table block above already creates them; this block only records the
  // migration marker and keeps the version list consistent.
  await client.query(`insert into schema_migrations (version) values ($1) on conflict do nothing`, [
    SCHEMA_VERSION,
  ]);
}

export function db(): Promise<DbClient> {
  if (!cache.client) {
    cache.client = (async () => {
      const useNeon = env.databaseUrl.length > 0 && env.dbDriver !== 'pglite';
      const client = useNeon ? await createNeon() : await createPglite();
      await migrate(client);
      return client;
    })().catch((error) => {
      cache.client = undefined;
      throw error;
    });
  }
  return cache.client;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const client = await db();
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** JSON columns are always sent as stringified values so both drivers agree. */
export function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export async function withTransaction<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T> {
  const client = await db();
  return client.transaction(fn);
}

export function dbKind(): 'neon' | 'pglite' | 'unknown' {
  return env.databaseUrl && env.dbDriver !== 'pglite' ? 'neon' : 'pglite';
}
