/**
 * Typed client for the Nexus bot API (`/api/bot/v1/*`).
 *
 * Every call is authenticated with the bot token issued by Nexus when this bot
 * was paired there. No Nexus session cookie or user credential is involved.
 */
/**
 * Reads the environment directly so this module has no relative imports: it is
 * usable from the Next.js build and from `node --test` (which needs extensions).
 */
type Runtime = { url: string; token: string; timeoutMs: number };

function runtime(): Runtime {
  return {
    url: (process.env.NEXUS_URL ?? '').trim().replace(/\/+$/, ''),
    token: (process.env.NEXUS_BOT_TOKEN ?? '').trim(),
    timeoutMs: Math.max(2_000, Math.min(Number(process.env.NEXUS_TIMEOUT_MS ?? 8_000), 30_000)),
  };
}

export class NexusError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = 'nexus_error') {
    super(message);
    this.name = 'NexusError';
    this.status = status;
    this.code = code;
  }
}

export type NexusSessionPayload = {
  externalId: string;
  label?: string;
  phone: string;
  status: string;
  statusDetail?: string;
  meNumber?: string;
  meJid?: string;
  platform?: string;
  connectedAt?: string;
  pairingCode?: string;
};

export type NexusSyncPayload = {
  status: 'ONLINE' | 'OFFLINE' | 'PAUSED' | 'ERROR';
  version?: string;
  message?: string;
  messagesSent?: number;
  errors?: number;
  sessions: NexusSessionPayload[];
};

export type NexusPairingRequest = { id: string; phone: string; label: string; requestedAt: string | null };

export type NexusSyncResult = {
  ok: boolean;
  serverTime: string;
  synced: number;
  removed: number;
  pairingRequests: NexusPairingRequest[];
};

export type NexusCommand = {
  id: string;
  type: 'RESTART' | 'LOGOUT' | string;
  createdAt: string;
  session: { id: string; externalId: string; phone: string; label: string } | null;
};

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const cfg = runtime();
  if (!cfg.url || !cfg.token) {
    throw new NexusError('Nexus is not configured (NEXUS_URL / NEXUS_BOT_TOKEN)', 0, 'not_configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new NexusError(`Nexus returned a non-JSON response (HTTP ${res.status})`, res.status, 'bad_response');
    }

    if (!res.ok) {
      const body = data as { error?: { message?: string; code?: string } } | null;
      throw new NexusError(
        body?.error?.message || `Nexus rejected the request (HTTP ${res.status})`,
        res.status,
        body?.error?.code || 'request_failed',
      );
    }

    return data as T;
  } catch (err) {
    if (err instanceof NexusError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new NexusError(`Nexus did not answer within ${cfg.timeoutMs}ms`, 0, 'timeout');
    }
    throw new NexusError((err as Error)?.message || 'Nexus request failed', 0, 'network');
  } finally {
    clearTimeout(timer);
  }
}

export function ping() {
  return call<{ ok: boolean; bot: { id: string; name: string }; sessions: number; pendingPairing: number }>(
    '/api/bot/v1/ping',
  );
}

export function sync(payload: NexusSyncPayload) {
  return call<NexusSyncResult>('/api/bot/v1/sync', { method: 'POST', body: payload });
}

export function reportPairing(id: string, result: { code?: string; error?: string; expiresAt?: string; phone?: string }) {
  return call<{ ok: boolean; status: string }>(`/api/bot/v1/pairing/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: result,
  });
}

export function pullCommands() {
  return call<{ commands: NexusCommand[] }>('/api/bot/v1/commands');
}

export function ackCommand(id: string, result: { status: 'DONE' | 'ERROR'; result?: string }) {
  return call<{ ok: boolean }>(`/api/bot/v1/commands/${encodeURIComponent(id)}`, { method: 'POST', body: result });
}

export function reportEvents(events: { level: 'INFO' | 'WARN' | 'ERROR'; message: string; sessionId?: string }[]) {
  return call<{ ok: boolean; stored: number }>('/api/bot/v1/events', { method: 'POST', body: { events } });
}
