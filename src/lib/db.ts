import fs from 'node:fs';
import path from 'node:path';
import { env, ensureDataDirs } from './env';

export type SqlParam = string | number | boolean | null | string[] | number[];
export interface DbClient {
  readonly kind: 'neon' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<{ rows: T[] }>;
  /** Run a multi-statement script. Used only for schema application. */
  exec(sql: string): Promise<void>;
}

const SCHEMA_VERSION = 1;

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

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db();
  await client.query('begin');
  try {
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      /* ignore rollback failure */
    }
    throw error;
  }
}

export function dbKind(): 'neon' | 'pglite' | 'unknown' {
  return env.databaseUrl && env.dbDriver !== 'pglite' ? 'neon' : 'pglite';
}
