/**
 * Nexus connector tests — no network.
 *
 * Asserts the exact request the control center sends (URL, bearer token, body)
 * and that server errors are surfaced instead of swallowed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NEXUS_URL = 'https://nexus.example/';
process.env.NEXUS_BOT_TOKEN = 'dnx_test_token';
process.env.NEXUS_TIMEOUT_MS = '3000';

const client = await import('../src/lib/nexus/client.ts');

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let responder: (call: Call) => Response = () => Response.json({ ok: true });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = { url: String(input), init: init ?? {} };
  calls.push(call);
  return responder(call);
}) as typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('ping sends the bot token to the trimmed base URL', async () => {
  calls.length = 0;
  responder = () => json({ ok: true, bot: { id: 'b1', name: 'relay' }, sessions: 2, pendingPairing: 0 });

  const result = await client.ping();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://nexus.example/api/bot/v1/ping');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer dnx_test_token');
  assert.equal(result.sessions, 2);
});

test('sync posts the full session snapshot', async () => {
  calls.length = 0;
  responder = () =>
    json({ ok: true, serverTime: '2026-01-01T00:00:00.000Z', synced: 1, removed: 0, pairingRequests: [{ id: 's1', phone: '447700900123', label: 'Main', requestedAt: null }] });

  const result = await client.sync({
    status: 'ONLINE',
    version: '1.2.3',
    sessions: [{ externalId: 'srv-1', label: 'Main', phone: '447700900123', status: 'CONNECTED', meNumber: '447700900123' }],
  });

  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(calls[0].url, 'https://nexus.example/api/bot/v1/sync');
  assert.equal(body.status, 'ONLINE');
  assert.equal(body.sessions[0].externalId, 'srv-1');
  assert.equal(result.pairingRequests[0].id, 's1');
});

test('reportPairing relays a real code', async () => {
  calls.length = 0;
  responder = () => json({ ok: true, status: 'PAIRING_CODE' });

  await client.reportPairing('s1', { code: 'ABCD1234', phone: '447700900123' });

  assert.equal(calls[0].url, 'https://nexus.example/api/bot/v1/pairing/s1');
  assert.equal(JSON.parse(String(calls[0].init.body)).code, 'ABCD1234');
});

test('server errors surface code and message', async () => {
  calls.length = 0;
  responder = () => json({ error: { code: 'BOT_DISABLED', message: 'This bot is disabled by its owner' } }, 403);

  await assert.rejects(
    () => client.sync({ status: 'ONLINE', sessions: [] }),
    (err: unknown) => {
      const e = err as { status: number; code: string; message: string };
      assert.equal(e.status, 403);
      assert.equal(e.code, 'BOT_DISABLED');
      assert.match(e.message, /disabled/);
      return true;
    },
  );
});

test('missing configuration fails fast without a network call', async () => {
  calls.length = 0;
  const saved = process.env.NEXUS_BOT_TOKEN;
  delete process.env.NEXUS_BOT_TOKEN;

  await assert.rejects(
    () => client.ping(),
    (err: unknown) => (err as { code: string }).code === 'not_configured',
  );
  assert.equal(calls.length, 0);

  process.env.NEXUS_BOT_TOKEN = saved;
});

test('commands are pulled and acknowledged', async () => {
  calls.length = 0;
  responder = () => json({ commands: [{ id: 'c1', type: 'RESTART', createdAt: '2026-01-01T00:00:00.000Z', session: null }] });

  const { commands } = await client.pullCommands();
  assert.equal(commands[0].type, 'RESTART');

  responder = () => json({ ok: true });
  await client.ackCommand('c1', { status: 'DONE' });
  assert.equal(calls[1].url, 'https://nexus.example/api/bot/v1/commands/c1');
});
