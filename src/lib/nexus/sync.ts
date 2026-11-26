/**
 * Nexus synchronisation loop.
 *
 * One pass = push the real snapshot, then work through anything Nexus queued:
 * pairing requests (relayed to the bot process) and control commands
 * (restart / unlink). Everything is idempotent and safe to run often; nothing
 * touches the bot's auth files.
 */
import { nexusConfig, nexusEnabled } from './config.ts';
import { buildNexusSnapshot } from './snapshot.ts';
import {
  NexusError,
  ackCommand,
  pullCommands,
  reportPairing,
  sync,
  type NexusCommand,
  type NexusPairingRequest,
} from './client.ts';

export type SyncSummary = {
  ok: boolean;
  at: string;
  reason?: string;
  synced?: number;
  removed?: number;
  pairing?: { id: string; ok: boolean; detail: string }[];
  commands?: { id: string; type: string; ok: boolean; detail: string }[];
  error?: string;
};

let last: SyncSummary | null = null;
let inFlight: Promise<SyncSummary> | null = null;
const attempts = new Map<string, number>();

export function lastSync(): SyncSummary | null {
  return last;
}

async function postBotEndpoint(url: string, body: unknown): Promise<Record<string, unknown>> {
  const cfg = nexusConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`bot endpoint returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(String((data.error as string) || (data.message as string) || `HTTP ${res.status}`));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function issuePairing(req: NexusPairingRequest): Promise<{ id: string; ok: boolean; detail: string }> {
  const cfg = nexusConfig();

  if (!cfg.pairUrl) {
    return {
      id: req.id,
      ok: false,
      detail:
        'The bot has no pairing endpoint. Set NEXUS_BOT_PAIR_URL to the bot\'s /pair route so it can call Baileys requestPairingCode for this number.',
    };
  }

  const tries = attempts.get(req.id) ?? 0;
  if (tries >= 3) return { id: req.id, ok: false, detail: 'Gave up after 3 attempts' };

  attempts.set(req.id, tries + 1);
  try {
    const data = await postBotEndpoint(cfg.pairUrl, { phone: req.phone, label: req.label, nexusId: req.id });
    const code = typeof data.code === 'string' ? data.code : '';
    if (!code) throw new Error('bot endpoint did not return a code');
    await reportPairing(req.id, {
      code,
      phone: req.phone,
      ...(typeof data.expiresAt === 'string' ? { expiresAt: data.expiresAt } : {}),
    });
    return { id: req.id, ok: true, detail: 'code relayed to Nexus' };
  } catch (err) {
    const message = (err as Error)?.message || 'pairing failed';
    // Report once the bot has actually tried; a missing endpoint stays queued.
    await reportPairing(req.id, { error: message.slice(0, 280) }).catch(() => undefined);
    return { id: req.id, ok: false, detail: message };
  }
}

async function runCommand(command: NexusCommand): Promise<{ id: string; type: string; ok: boolean; detail: string }> {
  const cfg = nexusConfig();
  if (!cfg.commandUrl) {
    await ackCommand(command.id, {
      status: 'ERROR',
      result: 'NEXUS_BOT_COMMAND_URL is not configured on this control center',
    }).catch(() => undefined);
    return { id: command.id, type: command.type, ok: false, detail: 'no command endpoint' };
  }
  try {
    await postBotEndpoint(cfg.commandUrl, {
      action: command.type.toLowerCase(),
      session: command.session?.externalId ?? '',
      phone: command.session?.phone ?? '',
    });
    await ackCommand(command.id, { status: 'DONE' });
    return { id: command.id, type: command.type, ok: true, detail: 'executed' };
  } catch (err) {
    const message = (err as Error)?.message || 'command failed';
    await ackCommand(command.id, { status: 'ERROR', result: message.slice(0, 280) }).catch(() => undefined);
    return { id: command.id, type: command.type, ok: false, detail: message };
  }
}

/** Fire-and-forget sync used by request paths: never blocks, never throws. */
export function maybeSync(minIntervalMs = 10_000): void {
  if (!nexusEnabled()) return;
  const lastAt = last ? Date.parse(last.at) : 0;
  if (Date.now() - lastAt < minIntervalMs) return;
  void runNexusSync().catch(() => undefined);
}

export async function runNexusSync(): Promise<SyncSummary> {
  if (!nexusEnabled()) {
    last = { ok: false, at: new Date().toISOString(), reason: 'NEXUS_URL / NEXUS_BOT_TOKEN are not set' };
    return last;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const at = new Date().toISOString();
    try {
      const snapshot = await buildNexusSnapshot();
      const result = await sync({
        status: snapshot.status,
        version: snapshot.version,
        message: snapshot.message,
        sessions: snapshot.sessions,
      });

      const pairing = [];
      for (const req of result.pairingRequests) pairing.push(await issuePairing(req));

      const commands: SyncSummary['commands'] = [];
      try {
        const { commands: pending } = await pullCommands();
        for (const command of pending) commands.push(await runCommand(command));
      } catch (err) {
        if (!(err instanceof NexusError && err.status === 404)) throw err;
      }

      last = {
        ok: true,
        at,
        synced: result.synced,
        removed: result.removed,
        pairing,
        commands,
      };
      return last;
    } catch (err) {
      const message =
        err instanceof NexusError ? `${err.code}: ${err.message}` : (err as Error)?.message || 'sync failed';
      last = { ok: false, at, error: message };
      return last;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
