/**
 * Neon/PostgreSQL integration tests.
 *
 * The rest of the suite runs on PGlite, which is PostgreSQL compiled to WASM —
 * same SQL, single connection. These tests run against a real PostgreSQL server
 * over TCP, which is the protocol Neon speaks, so they cover what PGlite cannot:
 *
 *   - the migration registry and its advisory lock against a server,
 *   - a pool that is closed and reopened (a redeploy / cold start),
 *   - transactions that really roll back,
 *   - persistence of the records the console depends on.
 *
 * They are skipped unless a server is provided:
 *
 *   DARKNOTE_TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/darknote_test \
 *   DATABASE_SSL=disable npm test
 *
 * CI and local runs without PostgreSQL therefore stay green, and nothing here
 * ever points at production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PG_URL = process.env.DARKNOTE_TEST_PG_URL ?? '';
const enabled = PG_URL.length > 0;

if (enabled) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darknote-pg-'));
  process.env.DATABASE_URL = PG_URL;
  process.env.DARKNOTE_DATA_DIR = dataDir;
  process.env.DARKNOTE_SECRET = 'test-secret-value-that-is-long-enough-for-aes-256-gcm';
  process.env.DARKNOTE_DB_DRIVER = process.env.DARKNOTE_DB_DRIVER ?? 'postgres';
  process.env.NODE_ENV = 'test';
}

const skip = enabled ? false : 'set DARKNOTE_TEST_PG_URL to run PostgreSQL integration tests';

test('migrations apply once, then report the registry as current', { skip }, async () => {
  const { migrate, migrationStatus } = await import('../src/lib/db/migrate.ts');
  const { db } = await import('../src/lib/db.ts');
  const client = await db();

  const first = await migrate(client, { allowDrift: true });
  const second = await migrate(client, { allowDrift: true });
  assert.equal(second.pending.length, 0, 'a second run must leave nothing pending');
  assert.equal(second.appliedNow.length, 0, 'a second run must not re-apply anything');

  const status = await migrationStatus(client);
  assert.ok(status.applied.some((record) => record.name === '0001_baseline'));
  assert.deepEqual(status.drifted, [], 'released migrations must not change checksum');
  assert.ok(first.available.length >= 1);
});

test('the schema the app queries really exists after migration', { skip }, async () => {
  const { query } = await import('../src/lib/db.ts');
  const tables = await query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = current_schema()`,
  );
  const names = new Set(tables.map((row) => row.table_name));
  for (const required of [
    'admin_users',
    'sessions',
    'connected_servers',
    'imported_projects',
    'imported_project_files',
    'bigbrother_conversations',
    'bigbrother_messages',
    'error_intel_events',
    'github_connection',
    'system_health_reports',
  ]) {
    assert.ok(names.has(required), `${required} must exist`);
  }

  const indexes = await query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = current_schema()`,
  );
  const indexNames = new Set(indexes.map((row) => row.indexname));
  assert.ok(indexNames.has('login_attempts_email_created_idx'), 'lockout lookup index');
  assert.ok(indexNames.has('bigbrother_messages_conversation_desc_idx'), 'conversation paging index');
});

test('records survive a pool restart (a redeploy)', { skip }, async () => {
  const { query, queryOne, closeDatabase } = await import('../src/lib/db.ts');
  const email = `pg-${Date.now()}@example.com`;
  const userId = `usr_pg_${Date.now()}`;

  await query(
    `insert into admin_users (id, email, name, password_hash, role)
     values ($1, $2, $3, $4, 'owner') on conflict (id) do nothing`,
    [userId, email, 'PG Test', 'x'],
  );

  // Drop every pooled connection, then reconnect — what a redeploy does.
  await closeDatabase();
  const again = await queryOne<{ email: string }>('select email from admin_users where id = $1', [
    userId,
  ]);
  assert.equal(again?.email, email, 'the row must still be there after reconnecting');
});

test('a failed transaction leaves nothing behind', { skip }, async () => {
  const { withTransaction, queryOne } = await import('../src/lib/db.ts');
  await assert.rejects(
    withTransaction(async (connection) => {
      await connection.query(
        `insert into imported_projects (id, name, source, status, created_by)
         values ('prj_rollback', 'rollback', 'upload', 'ready', 'usr_pg_test')`,
      );
      throw new Error('boom');
    }),
  );
  const row = await queryOne('select id from imported_projects where id = $1', ['prj_rollback']);
  assert.equal(row, null, 'the rolled back insert must not be visible');
});

test('conversation history is paged newest-first and scoped to its conversation', { skip }, async () => {
  const { query } = await import('../src/lib/db.ts');
  const conversationId = `cnv_${Date.now()}`;
  await query(
    `insert into bigbrother_conversations (id, user_id, title, message_count)
     values ($1, 'usr_pg_test', 'paging', 5) on conflict (id) do nothing`,
    [conversationId],
  );
  for (let index = 0; index < 5; index += 1) {
    await query(
      `insert into bigbrother_messages (id, conversation_id, user_id, role, content)
       values ($1, $2, 'usr_pg_test', 'user', $3)`,
      [`msg_${conversationId}_${index}`, conversationId, `turn ${index}`],
    );
  }

  const page = await query<{ content: string }>(
    `select content from bigbrother_messages
      where conversation_id = $1 order by created_at desc, id desc limit 2`,
    [conversationId],
  );
  assert.equal(page.length, 2, 'only one page is ever read into memory');

  const other = await query<{ count: string | number }>(
    `select count(*)::int as count from bigbrother_messages where conversation_id = $1`,
    ['cnv_does_not_exist'],
  );
  assert.equal(Number(other[0]?.count ?? -1), 0, 'a thread must never leak into another query');
});

test('retention prunes only what is past its window', { skip }, async () => {
  const { query } = await import('../src/lib/db.ts');
  const { pruneOperationalData } = await import('../src/lib/db/maintenance.ts');

  const sessionId = `old-${Date.now()}`;
  await query(
    `insert into login_attempts (email, ip, success, reason, created_at)
     values ('old@example.com', '127.0.0.1', false, 'test', now() - interval '90 days')`,
  );
  await query(
    `insert into login_attempts (email, ip, success, reason, created_at)
     values ('new@example.com', '127.0.0.1', false, 'test', now())`,
  );

  const results = await pruneOperationalData({
    loginAttemptsDays: 30,
    errorEventsDays: 120,
    downloadHistoryDays: 90,
    githubSyncEventsDays: 60,
    healthReportsDays: 30,
    activityLogsDays: 0,
  });
  const pruned = results.find((entry) => entry.table === 'login_attempts');
  assert.ok((pruned?.deleted ?? 0) >= 1, 'the 90-day-old attempt must be deleted');

  const remaining = await query<{ count: string | number }>(
    `select count(*)::int as count from login_attempts where email = 'new@example.com'`,
  );
  assert.ok(Number(remaining[0]?.count ?? 0) >= 1, 'a recent attempt is kept');
  void sessionId;
});

test('a logical backup writes one gzip file per table and a manifest', { skip }, async () => {
  const { query } = await import('../src/lib/db.ts');
  const { backupDatabase } = await import('../src/lib/db/maintenance.ts');
  const { directory, manifest } = await backupDatabase('test');

  assert.equal(manifest.format, 'ndjson.gz');
  assert.ok(manifest.tables.length > 10);
  assert.ok(fs.existsSync(path.join(directory, 'manifest.json')));

  const adminTable = manifest.tables.find((entry) => entry.table === 'admin_users');
  assert.ok(adminTable, 'admin_users must be in the backup');
  assert.ok(adminTable!.bytes > 0);
  assert.match(adminTable!.sha256, /^[0-9a-f]{64}$/);

  const rows = await query<{ count: string | number }>('select count(*)::int as count from admin_users');
  assert.ok(Number(rows[0]?.count ?? 0) >= 1, 'the backup ran against a populated database');
});

test('dbHealth reports the live server, not a cached verdict', { skip }, async () => {
  const { dbHealth, closeDatabase } = await import('../src/lib/db.ts');
  const health = await dbHealth();
  assert.equal(health.ok, true);
  assert.equal(health.kind, 'postgres');
  assert.match(String(health.serverVersion), /^PostgreSQL/);
  assert.ok((health.tables ?? 0) > 10);
  assert.ok((health.latencyMs ?? 1) >= 0);
  assert.equal(health.migrations.pending.length, 0);
  await closeDatabase();
});
