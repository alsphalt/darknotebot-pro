import { route, ok, ApiError } from '@/lib/api';
import { buildSessionPayload } from '@/lib/session-payload';
import { countUsers, ensureBootstrapAdmin } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: null }, async ({ user }) => {
  return ok({ session: await buildSessionPayload(user) });
});

export const POST = route({ permission: null }, async () => {
  const total = await countUsers();
  if (total > 0) throw new ApiError('An administrator already exists.', 409, 'already_bootstrapped');
  const result = await ensureBootstrapAdmin();
  return ok(result);
});
