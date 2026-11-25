/**
 * The migration lock must survive a connection pooler.
 *
 * Production evidence (GET /api/health on the deployed site, 2026-11-22):
 *
 *   databaseDriver: neon
 *   databaseTarget: ep-…-pooler.c-9.us-east-2.aws.neon.tech/neondb
 *   databaseError:  Another process is running DARKNOTE migrations
 *                   (advisory lock held for 20s)
 *
 * …on every request, 20.8 s each, minutes apart. The lock was not held by a
 * running migration: it was *leaked*. The old code took a session-level
 * `pg_advisory_lock()` through a node-postgres Pool pointed at Neon's pooled
 * endpoint. PgBouncer in transaction mode may give each statement a different
 * server connection, so the unlock was delivered to a backend that never held
 * the lock; the real holder kept it until its connection died, and every cold
 * start then waited out the timeout and failed.
 *
 * This test pins the contract that fixes it, without needing a pooled server:
 * the lock is transaction-scoped, taken on the same connection that runs the
 * DDL, and there is no separate unlock statement to misroute.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbClient, DbConnection, SqlParam } from '../src/lib/db/types.ts';
import { migrate } from '../src/lib/db/migrate.ts';

interface Recorded {
  sql: string;
  inTransaction: boolean;
}

function recordingClient(): { client: DbClient; statements: Recorded[] } {
  const statements: Recorded[] = [];
  let inTransaction = false;

  const executor = {
    async query<T>(sql: string, _params?: SqlParam[]) {
      statements.push({ sql, inTransaction });
      if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [{} as T] };
      if (/select name, checksum, applied_at/i.test(sql)) return { rows: [] as T[] };
      if (/information_schema\.(columns|tables)/i.test(sql)) return { rows: [{ present: false } as T] };
      return { rows: [] as T[] };
    },
    async exec(sql: string) {
      statements.push({ sql, inTransaction });
    },
  };

  const client: DbClient = {
    kind: 'pglite',
    target: 'recording',
    query: executor.query,
    exec: executor.exec,
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T> {
      const outer = inTransaction;
      inTransaction = true;
      try {
        return await fn(executor);
      } finally {
        inTransaction = outer;
      }
    },
    stats: () => null,
    async close() {
      /* nothing to close */
    },
  };

  return { client, statements };
}

test('the migration lock is transaction-scoped, not session-scoped', async () => {
  const { client, statements } = recordingClient();
  const result = await migrate(client);

  const sql = statements.map((entry) => entry.sql);
  assert.ok(
    sql.some((statement) => /pg_advisory_xact_lock/i.test(statement)),
    'the lock must be pg_advisory_xact_lock, which PostgreSQL releases on commit',
  );
  assert.ok(
    !sql.some((statement) => /pg_try_advisory_lock|pg_advisory_unlock/i.test(statement)),
    'no session-level lock or separate unlock: a pooler can route them to different connections',
  );
  assert.ok(
    sql.some((statement) => /set local lock_timeout/i.test(statement)),
    'the wait must be bounded by PostgreSQL, not by a client polling loop',
  );

  const lockAt = statements.findIndex((entry) => /pg_advisory_xact_lock/i.test(entry.sql));
  // `db_migrations` is created before the lock (it is the registry, and creating
  // it is `if not exists`); the baseline is what must never run unlocked.
  const baselineAt = statements.findIndex((entry) => /create table if not exists admin_users/i.test(entry.sql));
  assert.ok(lockAt >= 0, 'a lock statement was issued');
  assert.equal(statements[lockAt].inTransaction, true, 'the lock must be taken inside the transaction');
  assert.ok(baselineAt > lockAt, 'the baseline schema is applied after the lock is held');
  assert.ok(
    statements.slice(lockAt).some((entry) => entry.inTransaction),
    'the migration runs on the same connection that holds the lock',
  );
  assert.equal(result.appliedNow.length, 4, 'baseline + three migrations were applied in this run');
});

test('a lock conflict is reported as the operator-facing timeout, not a raw PostgreSQL code', async () => {
  const { client } = recordingClient();
  const conflict: DbClient = {
    ...client,
    async transaction<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T> {
      return fn({
        async query<R>(statement: string) {
          if (/pg_advisory_xact_lock/i.test(statement)) {
            const error = new Error('canceling statement due to lock timeout') as Error & { code?: string };
            error.code = '55P03';
            throw error;
          }
          return { rows: [] as R[] };
        },
        async exec() {
          /* not reached */
        },
      });
    },
  };

  await assert.rejects(
    () => migrate(conflict),
    /Another process is running DARKNOTE migrations/,
  );
});
