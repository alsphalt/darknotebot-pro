/**
 * Builds the authoritative session snapshot from what this control center can
 * actually observe: the panel's `bot_status` rows plus, when configured, the
 * status file the bot itself writes (`DARKNOTE_BOT_STATUS_PATH`).
 *
 * Nothing here is invented. A container that is not running is reported as
 * disconnected, and a WhatsApp state of `unknown` stays "unknown" in the
 * detail text instead of being guessed.
 */
import fs from 'node:fs';
import { query } from '../db.ts';
import type { NexusSessionPayload } from './client.ts';

type ServerRow = {
  id: string;
  name: string;
  server_identifier: string;
  whatsapp_state: string | null;
  whatsapp_signal: string | null;
  container_state: string | null;
  checked_at: string | null;
};

const STATUS_MAP: Record<string, string> = {
  connected: 'CONNECTED',
  disconnected: 'DISCONNECTED',
  qr_pending: 'PAIRING_CODE',
  logged_out: 'LOGGED_OUT',
  unknown: 'DISCONNECTED',
};

type StatusFile = {
  whatsapp?: string;
  phone?: string;
  startedAt?: string;
  connectedAt?: string;
  platform?: string;
  sessions?: Array<{
    id?: string;
    label?: string;
    phone?: string;
    status?: string;
    connectedAt?: string;
    meJid?: string;
    platform?: string;
    pairingCode?: string;
  }>;
};

function readStatusFile(): StatusFile | null {
  const file = (process.env.DARKNOTE_BOT_STATUS_PATH ?? '').trim();
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as StatusFile;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function mapStatus(raw: string | null | undefined, container: string | null | undefined): string {
  if (container && !['running', 'starting'].includes(container)) return 'DISCONNECTED';
  return STATUS_MAP[(raw ?? 'unknown').toLowerCase()] ?? 'DISCONNECTED';
}

export async function buildNexusSnapshot(): Promise<{
  status: 'ONLINE' | 'OFFLINE' | 'ERROR';
  version: string;
  message: string;
  sessions: NexusSessionPayload[];
}> {
  const statusFile = readStatusFile();

  // A bot that writes `sessions[]` is the most precise source available.
  if (statusFile?.sessions?.length) {
    const sessions = statusFile.sessions.map((s, index) => ({
      externalId: (s.id || `session-${index + 1}`).slice(0, 120),
      label: (s.label || s.phone || `Session ${index + 1}`).slice(0, 60),
      phone: (s.phone || '').replace(/\D/g, ''),
      status: mapStatus(s.status || statusFile.whatsapp, 'running'),
      statusDetail: s.status ? `reported by the bot: ${s.status}` : '',
      meNumber: (s.phone || '').replace(/\D/g, ''),
      meJid: s.meJid || '',
      platform: s.platform || statusFile.platform || '',
      connectedAt: s.connectedAt,
      pairingCode: s.pairingCode,
    }));

    const online = sessions.some((s) => s.status === 'CONNECTED');
    return {
      status: online ? 'ONLINE' : 'OFFLINE',
      version: process.env.npm_package_version || '1.0.0',
      message: `status file: ${sessions.length} session(s)`,
      sessions,
    };
  }

  const rows = await query<ServerRow>(
    `select s.id, s.name, s.server_identifier,
            b.whatsapp_state, b.whatsapp_signal, b.container_state, b.checked_at
       from connected_servers s
       left join bot_status b on b.server_id = s.id
      where s.is_active = true
      order by s.created_at asc`,
  );

  const sessions: NexusSessionPayload[] = rows.map((row) => {
    const status = mapStatus(row.whatsapp_state, row.container_state);
    const phone = (statusFile?.phone || '').replace(/\D/g, '');
    return {
      externalId: row.server_identifier || row.id,
      label: row.name,
      phone,
      status,
      statusDetail: status === 'DISCONNECTED' ? `panel says whatsapp=${row.whatsapp_state ?? 'unknown'}, container=${row.container_state ?? 'unknown'}` : '',
      meNumber: phone,
      connectedAt: status === 'CONNECTED' ? (statusFile?.connectedAt || row.checked_at || undefined) : undefined,
    };
  });

  const online = sessions.some((s) => s.status === 'CONNECTED');
  return {
    status: online ? 'ONLINE' : 'OFFLINE',
    version: process.env.npm_package_version || '1.0.0',
    message: `panel snapshot: ${sessions.length} server(s)`,
    sessions,
  };
}
