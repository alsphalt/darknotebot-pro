/**
 * DARKNOTE NEXUS connection settings.
 *
 * The control center is a *client* of Nexus: it reports the real state of the
 * WhatsApp process it manages and relays pairing work. It never stores Nexus
 * user data, and Nexus never reaches into this app's database.
 */
export type NexusConfig = {
  url: string;
  token: string;
  pairUrl: string;
  commandUrl: string;
  timeoutMs: number;
  autoSync: boolean;
};

function clean(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function nexusConfig(): NexusConfig {
  return {
    url: clean(process.env.NEXUS_URL),
    token: (process.env.NEXUS_BOT_TOKEN ?? '').trim(),
    pairUrl: clean(process.env.NEXUS_BOT_PAIR_URL),
    commandUrl: clean(process.env.NEXUS_BOT_COMMAND_URL),
    timeoutMs: Math.max(2_000, Math.min(Number(process.env.NEXUS_TIMEOUT_MS ?? 8_000), 30_000)),
    autoSync: process.env.NEXUS_AUTO_SYNC !== 'false',
  };
}

export function nexusEnabled(): boolean {
  const cfg = nexusConfig();
  return Boolean(cfg.url && cfg.token);
}
