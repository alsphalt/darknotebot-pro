import { ok, publicRoute } from '@/lib/api';
import { dbKind, queryOne } from '@/lib/db';
import { env, warnMissingConfig } from '@/lib/env';
import { backupStorage } from '@/lib/backups/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness/diagnostic endpoint. It reports what is actually configured rather
 * than a blanket "ok" — missing Neon or Pterodactyl settings are listed here.
 */
export const GET = publicRoute(async () => {
  const missing = warnMissingConfig();

  let database = 'unreachable';
  let admins = 0;
  try {
    const row = await queryOne<{ count: string | number }>('select count(*)::int as count from admin_users');
    admins = Number(row?.count ?? 0);
    database = 'ok';
  } catch {
    database = 'error';
  }

  let storage = 'unreachable';
  try {
    await backupStorage().list('');
    storage = 'ok';
  } catch {
    storage = 'error';
  }

  return ok({
    ok: database === 'ok' && storage === 'ok',
    database,
    databaseDriver: dbKind(),
    storage,
    storageDriver: backupStorage().kind,
    administrators: admins,
    missing,
    pterodactylConfigured: Boolean(process.env.DARKNOTE_PANEL_URL),
    node: process.version,
    time: new Date().toISOString(),
    note:
      'Pterodactyl credentials are stored encrypted per server; this endpoint never reports them. Configure a server under Admin Settings to connect.',
  });
});
