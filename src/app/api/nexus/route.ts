import { route, ok } from '@/lib/api';
import { nexusConfig, nexusEnabled } from '@/lib/nexus/config';
import { lastSync, runNexusSync } from '@/lib/nexus/sync';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connection state of this control center → DARKNOTE NEXUS. */
export const GET = route({ permission: 'console.read' }, async () => {
  const cfg = nexusConfig();
  return ok({
    configured: nexusEnabled(),
    url: cfg.url || null,
    tokenSet: Boolean(cfg.token),
    pairEndpointConfigured: Boolean(cfg.pairUrl),
    commandEndpointConfigured: Boolean(cfg.commandUrl),
    autoSync: cfg.autoSync,
    lastSync: lastSync(),
  });
});

/** Manual "Sync now" — pushes the real snapshot and drains pending work. */
export const POST = route({ permission: 'server.power' }, async ({ user }) => {
  const result = await runNexusSync();
  await logActivity({
    user,
    action: 'nexus.sync',
    detail: {
      ok: result.ok,
      synced: result.synced ?? 0,
      removed: result.removed ?? 0,
      error: result.error ?? '',
    },
  });
  return ok(result);
});
