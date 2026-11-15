import 'server-only';
import WebSocket from 'ws';
import { query, queryOne } from '../db';
import { uuid } from '../crypto';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import { sleep } from '../util/async';
import type { PterodactylClient } from '../pterodactyl/client';

const MAX_LINES = 1200;

interface Buffer {
  lines: string[];
  updatedAt: number;
  capturing: boolean;
  error: string | null;
}

const buffers = new Map<string, Buffer>();

function bufferFor(serverId: string): Buffer {
  let buffer = buffers.get(serverId);
  if (!buffer) {
    buffer = { lines: [], updatedAt: 0, capturing: false, error: null };
    buffers.set(serverId, buffer);
  }
  return buffer;
}

export function consoleBuffer(serverId: string): { lines: string[]; updatedAt: number; error: string | null } {
  const buffer = bufferFor(serverId);
  return { lines: [...buffer.lines], updatedAt: buffer.updatedAt, error: buffer.error };
}

function pushLines(serverId: string, lines: string[]): void {
  const buffer = bufferFor(serverId);
  for (const line of lines) {
    if (!line) continue;
    buffer.lines.push(line);
    if (buffer.lines.length > MAX_LINES) buffer.lines.splice(0, buffer.lines.length - MAX_LINES);
  }
  buffer.updatedAt = Date.now();
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Attach to the panel websocket, request the log backlog and collect output for
 * a bounded amount of time. Real console output only — nothing is simulated.
 */
export async function captureConsole(
  server: ServerRecord,
  durationMs = 6000,
): Promise<{ lines: string[]; error?: string }> {
  const buffer = bufferFor(server.id);
  if (buffer.capturing) {
    return { lines: buffer.lines.slice(-200) };
  }
  buffer.capturing = true;
  buffer.error = null;
  const collected: string[] = [];
  let client: PterodactylClient | null = null;

  try {
    client = await serverClient(server);
    const credentials = await client.getWebsocketCredentials();
    const socketUrl = credentials.socket;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const ws = new WebSocket(socketUrl, {
        origin: server.panelUrl,
        handshakeTimeout: 15_000,
        headers: { 'User-Agent': 'DarknoteControlCenter/1.0' },
      });
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        done();
      }, durationMs);

      ws.on('open', () => {
        ws.send(JSON.stringify({ event: 'auth', args: [credentials.token] }));
      });
      ws.on('message', (raw) => {
        try {
          const payload = JSON.parse(String(raw)) as { event: string; args?: unknown[] };
          if (payload.event === 'auth success') {
            ws.send(JSON.stringify({ event: 'send logs', args: [null] }));
          }
          if (payload.event === 'console output' && Array.isArray(payload.args)) {
            collected.push(stripAnsi(String(payload.args[0] ?? '')));
          }
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on('error', (error) => {
        buffer.error = `Console websocket failed: ${error.message}`;
        clearTimeout(timer);
        done();
      });
      ws.on('close', () => {
        clearTimeout(timer);
        done();
      });
    });

    pushLines(server.id, collected);
    return { lines: collected, error: buffer.error ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    buffer.error = message;
    return { lines: [], error: message };
  } finally {
    buffer.capturing = false;
  }
}

export function inferWhatsAppState(lines: string[]): {
  state: 'connected' | 'disconnected' | 'qr_pending' | 'logged_out' | 'unknown';
  signal: string | null;
} {
  const patterns: Array<{ state: 'connected' | 'disconnected' | 'qr_pending' | 'logged_out'; re: RegExp }> = [
    { state: 'connected', re: /connected to whatsapp|whatsapp connected|connection open|opened connection to whatsapp|session restored|pairing successful|logged in successfully/i },
    { state: 'qr_pending', re: /scan the qr|qr code|pairing code|enter the code/i },
    { state: 'logged_out', re: /logged out|session closed|invalid session|401 unauthorized|bad session/i },
    { state: 'disconnected', re: /connection closed|disconnected|connection lost|reconnecting/i },
  ];
  let state: 'connected' | 'disconnected' | 'qr_pending' | 'logged_out' | 'unknown' = 'unknown';
  let signal: string | null = null;
  // Later lines win — the most recent state is what matters.
  for (const line of lines.slice(-250)) {
    for (const pattern of patterns) {
      if (pattern.re.test(line)) {
        state = pattern.state;
        signal = line.trim().slice(0, 240);
      }
    }
  }
  return { state, signal };
}

export interface StatusView {
  containerState: string;
  whatsappState: string;
  whatsappSignal: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  diskBytes: number | null;
  uptimeMs: number | null;
  restartCount: number;
  isSuspended: boolean;
  checkedAt: string;
  consoleError?: string | null;
  recentErrors: string[];
}

const ERROR_PATTERNS = /(error:|syntaxerror|referenceerror|typeerror|cannot find module|module_not_found|econnrefused|unhandledpromiserejection|failed to connect|logged out)/i;

export async function refreshStatus(
  server: ServerRecord,
  options: { captureConsole?: boolean; captureMs?: number } = {},
): Promise<StatusView> {
  const client = await serverClient(server);
  const resources = await client.getResources();

  let lines: string[] = consoleBuffer(server.id).lines.slice(-300);
  let consoleError: string | null = null;
  if (options.captureConsole) {
    const capture = await captureConsole(server, options.captureMs ?? 5000);
    if (capture.lines.length) lines = capture.lines;
    consoleError = capture.error ?? null;
  }

  const wa = inferWhatsAppState(lines);
  const container = String(resources.current_state ?? 'unknown');
  const cpu = resources.resources?.cpu_absolute ?? null;
  const memory = resources.resources?.memory_bytes ?? null;
  const memoryLimit = resources.resources?.memory_limit_bytes ?? null;
  const disk = resources.resources?.disk_bytes ?? null;
  const uptime = resources.resources?.uptime ?? null;

  const restartRow = await queryOne<{ count: string | number }>(
    'select count(*)::int as count from deployments where server_id = $1 and restart_performed = true',
    [server.id],
  );
  const restartCount = Number(restartRow?.count ?? 0);
  const recentErrors = lines.filter((line) => ERROR_PATTERNS.test(line)).slice(-12);
  const lastError = recentErrors[recentErrors.length - 1] ?? null;

  await query(
    `insert into bot_status (id, server_id, container_state, whatsapp_state, whatsapp_signal, cpu_percent,
       memory_bytes, memory_limit_bytes, disk_bytes, uptime_ms, restart_count, last_error, checked_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     on conflict (server_id) do update set container_state = excluded.container_state,
       whatsapp_state = excluded.whatsapp_state, whatsapp_signal = excluded.whatsapp_signal,
       cpu_percent = excluded.cpu_percent, memory_bytes = excluded.memory_bytes,
       memory_limit_bytes = excluded.memory_limit_bytes, disk_bytes = excluded.disk_bytes,
       uptime_ms = excluded.uptime_ms, restart_count = excluded.restart_count,
       last_error = excluded.last_error, checked_at = now()`,
    [
      uuid(),
      server.id,
      container,
      wa.state,
      wa.signal,
      cpu,
      memory,
      memoryLimit,
      disk,
      uptime,
      restartCount,
      lastError,
    ],
  );

  return {
    containerState: container,
    whatsappState: wa.state,
    whatsappSignal: wa.signal,
    cpuPercent: cpu,
    memoryBytes: memory,
    memoryLimitBytes: memoryLimit,
    diskBytes: disk,
    uptimeMs: uptime,
    restartCount,
    isSuspended: Boolean(resources.is_suspended),
    checkedAt: new Date().toISOString(),
    consoleError,
    recentErrors,
  };
}

export async function sendConsoleCommand(server: ServerRecord, command: string): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Command is empty');
  const client = await serverClient(server);
  await client.sendCommand(trimmed);
}

/**
 * Wait for the container to come back up after a restart and look for fatal
 * errors in the startup output. Returns an honest health verdict, never a
 * guess: `unknown` means we could not observe the startup.
 */
export async function waitForStartup(
  server: ServerRecord,
  timeoutSeconds: number,
): Promise<{
  healthy: boolean;
  verdict: 'healthy' | 'crashed' | 'timeout' | 'unknown';
  detail: string;
  logs: string[];
  observedStates: string[];
}> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const client = await serverClient(server);
  const states: string[] = [];
  const logs: string[] = [];
  let runningStreak = 0;
  let sawRunning = false;

  while (Date.now() < deadline) {
    try {
      const resources = await client.getResources();
      const state = String(resources.current_state ?? 'unknown');
      if (states[states.length - 1] !== state) states.push(state);
      if (state === 'running') {
        sawRunning = true;
        runningStreak += 1;
      } else {
        runningStreak = 0;
      }
      if (runningStreak >= 2) break;
      if (state === 'offline' && sawRunning) {
        return {
          healthy: false,
          verdict: 'crashed',
          detail: 'Container returned to offline after starting — inspect the console output.',
          logs,
          observedStates: states,
        };
      }
    } catch (error) {
      states.push(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(3000);
  }

  // Pull a bounded slice of live console output to look for fatal errors.
  const capture = await captureConsole(server, 5000);
  logs.push(...capture.lines.slice(-120));
  const fatal = capture.lines.filter((line) =>
    /(syntaxerror|cannot find module|error: cannot find|unhandledpromiserejection|referenceerror is not defined|econnrefused|invalid session)/i.test(
      line,
    ),
  );
  const wa = inferWhatsAppState(capture.lines);

  // A running container is not proof that the bot started. Without observed
  // console output the only honest verdict is "unknown".
  const observed = !capture.error && capture.lines.length > 0;
  if (!observed) {
    return {
      healthy: false,
      verdict: 'unknown',
      detail: `Container state: ${states.slice(-1)[0] ?? 'unobserved'}. No console output could be observed (${
        capture.error ?? 'the panel websocket returned no lines'
      }), so startup health cannot be verified.`,
      logs,
      observedStates: states,
    };
  }
  if (!sawRunning) {
    return {
      healthy: false,
      verdict: 'timeout',
      detail: `Container did not reach "running" within ${timeoutSeconds}s (states: ${states.join(' → ') || 'unobserved'}).`,
      logs,
      observedStates: states,
    };
  }
  if (fatal.length) {
    return {
      healthy: false,
      verdict: 'crashed',
      detail: `Startup logs contain ${fatal.length} fatal error line(s): ${fatal[0].slice(0, 200)}`,
      logs,
      observedStates: states,
    };
  }
  return {
    healthy: true,
    verdict: 'healthy',
    detail: `Container running and ${capture.lines.length} startup line(s) observed with no fatal errors. WhatsApp state inferred from console: ${wa.state}${wa.signal ? ` (${wa.signal.slice(0, 120)})` : ''}.`,
    logs,
    observedStates: states,
  };
}

export async function power(server: ServerRecord, signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
  const client = await serverClient(server);
  await client.sendPower(signal);
}

export async function restartCount(serverId: string): Promise<number> {
  const row = await queryOne<{ count: string | number }>(
    'select count(*)::int as count from deployments where server_id = $1 and restart_performed = true',
    [serverId],
  );
  return Number(row?.count ?? 0);
}

export async function recentActivity(serverId: string, limit = 25) {
  return query(
    `select action, target, severity, user_email, detail, created_at from activity_logs
      where server_id = $1 order by created_at desc limit $2`,
    [serverId, limit],
  );
}
