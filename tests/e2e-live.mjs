/**
 * Live HTTP end-to-end check.
 *
 * Boots the real Next.js server (production build) plus a protocol-accurate
 * Pterodactyl double, signs in over HTTP, and drives the same routes the browser
 * uses:
 *
 *   POST /api/monitor                      → power restart/start/stop
 *   GET  /api/monitor                      → real state, resources, console tail
 *   GET  /api/files/content?mode=meta      → size/limit without the bytes
 *   GET  /api/files/content?mode=chunk     → chunked read of a >2 MB file
 *   POST /api/drafts/chunk                 → create / PUT slices / finalize
 *   POST /api/deployments { draftId }      → write, verify hash, restart
 *   GET  /api/versions + POST /api/versions→ compare and restore a version
 *
 * The double answers 405 to a wrong verb, so a power call that is not POST
 * fails here exactly as it would on a real panel.
 *
 * Usage:  npm run build && node tests/e2e-live.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockPanel } from './mock-pterodactyl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.DARKNOTE_E2E_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'e2e-owner@example.com', password: 'Correct-Horse-Battery-9' };

if (!existsSync(path.join(projectRoot, '.next', 'BUILD_ID'))) {
  console.error('No production build found. Run `npm run build` first, then re-run this script.');
  process.exit(2);
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function largeSource(bytes) {
  const lines = ["#!/usr/bin/env node", "'use strict';", 'const handlers = new Map();'];
  let length = lines.join('\n').length;
  let index = 0;
  while (length < bytes) {
    const line = `handlers.set('command_${index}', async (conn, m) => { await m.reply('reply ${index}'); });`;
    lines.push(line);
    length += line.length + 1;
    index += 1;
  }
  lines.push('module.exports = { handlers };', '');
  return lines.join('\n');
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'darknote-e2e-'));
const panel = await createMockPanel({ identifier: 'abc12345', seed: { '/huge.js': largeSource(3 * 1024 * 1024) } }).start();

let nextProcess = null;
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(response) {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(method, pathname, body) {
  const headers = { Origin: BASE, Accept: 'application/json' };
  if (jar.size) headers.Cookie = cookieHeader();
  const csrf = jar.get('dn_csrf');
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(response);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  if (!response.ok || payload?.ok === false) {
    // A 405 here is the exact failure the browser used to show, so name it.
    const hint = response.status === 405 ? ' (HTTP 405 — the request used a verb this route/panel does not implement)' : '';
    throw new Error(`${method} ${pathname} → ${response.status}${hint}: ${payload?.error ?? payload?.raw ?? text}`);
  }
  return payload?.data ?? payload;
}

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const data = await call('GET', '/api/health');
      if (data?.database === 'ok') return data;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('The Next server did not become healthy in 90s. Check its output above.');
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let step = 0;
function ok(message) {
  step += 1;
  console.log(`  ✓ ${step}. ${message}`);
}

try {
  console.log(`\nDARKNOTE live HTTP check — Next on ${BASE}, panel double on ${panel.baseUrl}`);
  nextProcess = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(PORT)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DARKNOTE_DATA_DIR: dataDir,
      DARKNOTE_DB_DRIVER: 'pglite',
      DARKNOTE_SECRET: 'e2e-secret-value-that-is-long-enough-for-aes-256-gcm',
      DARKNOTE_ADMIN_EMAIL: ADMIN.email,
      DARKNOTE_ADMIN_PASSWORD: ADMIN.password,
      DARKNOTE_ADMIN_NAME: 'E2E Owner',
      DARKNOTE_APP_URL: BASE,
      DARKNOTE_MAX_EDITOR_BYTES: String(64 * 1024 * 1024),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nextProcess.stdout.on('data', (chunk) => process.stdout.write(`    [next] ${chunk}`));
  nextProcess.stderr.on('data', (chunk) => process.stderr.write(`    [next] ${chunk}`));
  nextProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`    [next] exited with code ${code}`);
  });

  await waitForServer();
  ok('production server is up and its database/storage are healthy');

  await call('POST', '/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
  assert.ok(jar.get('dn_session'), 'login must set a session cookie');
  assert.ok(jar.get('dn_csrf'), 'login must set a CSRF cookie');
  ok('signed in over HTTP with a session and CSRF token');

  const created = await call('POST', '/api/servers', {
    name: 'Darknote E2E',
    panelUrl: panel.baseUrl,
    serverIdentifier: panel.identifier,
    apiKey: panel.apiKey,
    rootPath: '/',
    maxFileBytes: 16 * 1024 * 1024,
  });
  const serverId = created?.server?.id;
  assert.ok(serverId, 'server registration must return an id');
  ok(`registered the panel (server ${serverId})`);

  const tested = await call('POST', `/api/servers/${serverId}/test`, { deep: false });
  assert.ok(Array.isArray(tested?.capabilities) && tested.capabilities.length > 0);
  assert.ok(tested.capabilities.some((check) => check.ok === true), 'at least the read checks must pass');
  ok(`connection test ran (${tested.capabilities.filter((check) => check.ok).length}/${tested.capabilities.length} checks ok)`);

  // ---- power -------------------------------------------------------------
  for (const action of ['restart', 'stop', 'start']) {
    const result = await call('POST', '/api/monitor', { serverId, action, confirm: 'CONFIRM' });
    assert.equal(result.method, 'POST', `${action} must be forwarded with POST`);
    assert.equal(result.endpoint, `/api/client/servers/${panel.identifier}/power`);
    const sent = panel.powers.at(-1);
    assert.equal(sent?.signal, action);
    assert.equal(sent?.method, 'POST');
    assert.ok(result.observedState, `the panel should report a state after ${action}`);
  }
  assert.deepEqual(
    [...new Set(panel.powers.map((entry) => entry.method))],
    ['POST'],
    'no power request may use a verb other than POST',
  );
  ok('restart, stop and start each reached the panel as POST …/power with the right signal');

  // ---- monitor -----------------------------------------------------------
  const monitor = await waitFor(async () => {
    const data = await call('GET', `/api/monitor?serverId=${serverId}`);
    return data?.console?.streamState === 'live' && data?.console?.lines?.length ? data : null;
  }, 25_000, 'the live console to attach');

  assert.equal(monitor.panel.reachable, true);
  assert.equal(monitor.panel.state, 'running');
  assert.equal(monitor.panel.cpuPercent, 12.5);
  assert.equal(monitor.panel.memoryBytes, 268435456);
  assert.ok(monitor.console.lines.some((line) => /Connected to WhatsApp/i.test(line.text)));
  assert.equal(monitor.bot.whatsapp, 'connected');
  assert.equal(monitor.bot.whatsappSource, 'console-event');
  ok(`live monitor: container running, CPU ${monitor.panel.cpuPercent}%, RAM ${monitor.panel.memoryBytes} B, console attached`);

  // ---- large file read ---------------------------------------------------
  const meta = await call('GET', `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/huge.js')}&mode=meta`);
  assert.ok(meta.sizeBytes > 2 * 1024 * 1024, `expected a >2 MB file, got ${meta.sizeBytes}`);
  assert.equal(meta.content, null, 'meta mode must not ship the file body');
  assert.ok(meta.limitBytes >= meta.sizeBytes, `limit ${meta.limitBytes} must allow the file`);

  const parts = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const chunk = await call(
      'GET',
      `/api/files/content?serverId=${serverId}&path=${encodeURIComponent('/huge.js')}&mode=chunk&offset=${offset}&length=${meta.chunkBytes}`,
    );
    parts.push(chunk.content ?? '');
    if (chunk.nextOffset === null) break;
    assert.ok(chunk.nextOffset > offset, 'the chunked reader must advance');
    offset = chunk.nextOffset;
  }
  const loaded = parts.join('');
  assert.equal(loaded.length, meta.totalChars, 'the whole file must arrive');
  assert.equal(sha256(loaded), meta.sha256, 'the reassembled file must hash identically');
  ok(`read a ${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB file in ${parts.length} chunks with a matching SHA-256`);

  // ---- chunked draft -----------------------------------------------------
  const edited = `${loaded}// e2e edit marker\n`;
  const createdDraft = await call('POST', '/api/drafts/chunk', {
    action: 'create',
    serverId,
    path: '/huge.js',
    totalBytes: Buffer.byteLength(edited, 'utf8'),
    totalChars: edited.length,
    baseSha: meta.sha256,
  });
  const stepChars = createdDraft.chunkBytes;
  const sliceCount = Math.ceil(edited.length / stepChars);
  for (let index = 0; index < sliceCount; index += 1) {
    await call('PUT', '/api/drafts/chunk', {
      serverId,
      draftId: createdDraft.draftId,
      index,
      content: edited.slice(index * stepChars, (index + 1) * stepChars),
    });
  }
  const finalized = await call('POST', '/api/drafts/chunk', {
    action: 'finalize',
    serverId,
    draftId: createdDraft.draftId,
    sha256: sha256(edited),
  });
  assert.equal(finalized.sha256, sha256(edited));
  assert.equal(finalized.bytes, Buffer.byteLength(edited, 'utf8'));
  ok(`stored the edited ${(finalized.bytes / 1024 / 1024).toFixed(1)} MB draft in ${sliceCount} chunks, server-verified`);

  const draftRead = await call(
    'GET',
    `/api/drafts/chunk?serverId=${serverId}&draftId=${createdDraft.draftId}&mode=chunk&offset=0&length=${stepChars}`,
  );
  assert.equal(draftRead.totalChars, edited.length);
  assert.equal(draftRead.content, edited.slice(0, stepChars));
  ok('read the stored draft back in slices without loading it whole');

  // ---- deploy by draftId -------------------------------------------------
  const deployed = await call('POST', '/api/deployments', {
    serverId,
    draftId: createdDraft.draftId,
    message: 'e2e large-file deploy',
  });
  const deployment = deployed.deployment;
  assert.equal(deployment.status, 'SUCCEEDED', `deployment failed: ${deployment.error}`);
  assert.equal(deployment.files[0].postHash, sha256(edited));
  assert.equal(panel.read('/huge.js'), edited, 'production must hold exactly the deployed bytes');
  ok('deployed the draft, hash re-read from production matches, bot restart issued');

  // ---- version + rollback ------------------------------------------------
  const versions = await call('GET', `/api/versions?serverId=${serverId}&path=${encodeURIComponent('/huge.js')}&limit=10`);
  const list = versions.versions ?? versions;
  const previous = (Array.isArray(list) ? list : []).find((version) => version.sha256 === meta.sha256);
  assert.ok(previous, 'the pre-deploy version must be listed');

  const compared = await call('GET', `/api/versions?serverId=${serverId}&id=${previous.id}`);
  assert.equal(compared.version.sha256, meta.sha256);
  assert.equal(compared.content, loaded, 'the stored version must be byte-identical to the original');
  assert.equal(compared.identical, false, 'the stored version differs from current production');
  ok('version comparison returns the original bytes and a diff against production');

  const restored = await call('POST', '/api/versions', {
    serverId,
    versionId: previous.id,
    message: 'e2e rollback',
  });
  assert.equal(restored.deployment.status, 'SUCCEEDED', `restore failed: ${restored.deployment.error}`);
  assert.equal(panel.read('/huge.js'), loaded, 'rollback must restore the original bytes exactly');
  ok('rollback restored the original file byte-for-byte');

  console.log(`\nAll ${step} live checks passed against ${BASE} + a 405-enforcing panel double.\n`);
} catch (error) {
  console.error(`\n✗ Live check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (nextProcess) {
    nextProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        nextProcess?.kill('SIGKILL');
        resolve();
      }, 8_000);
      nextProcess.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await panel.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
