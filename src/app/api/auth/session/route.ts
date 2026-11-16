import { publicRoute, ok, ApiError, route } from '@/lib/api';
import { countUsers, currentUser, ensureBootstrapAdmin } from '@/lib/auth/session';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unauthenticated probe used by the login screen: who am I (if anyone), whether
 * the deployment still needs a first-run owner, and which configuration is
 * missing. Never returns credentials or panel keys.
 */
export const GET = publicRoute(async () => {
  const user = await currentUser();
  const total = await countUsers();
  const missing: string[] = [];
  if (!env.databaseUrl && env.dbDriver !== 'pglite') {
    missing.push('DATABASE_URL');
  }
  if (!env.secret) missing.push('DARKNOTE_SECRET');

  return ok({
    user: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null,
    needsBootstrap: total === 0,
    setupTokenConfigured: Boolean(env.setupToken),
    env: { ok: missing.length === 0, missing, backupDriver: 'local' },
  });
});

/** Environment-driven bootstrap, kept for `npm run`-less deployments. */
export const POST = route({ permission: null }, async () => {
  const total = await countUsers();
  if (total > 0) throw new ApiError('An administrator already exists.', 409, 'already_bootstrapped');
  const result = await ensureBootstrapAdmin();
  return ok(result);
});
