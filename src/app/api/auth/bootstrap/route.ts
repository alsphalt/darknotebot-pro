import { NextRequest } from 'next/server';
import { z } from 'zod';
import { publicRoute, ok, ApiError, rateLimit } from '@/lib/api';
import { countUsers, login } from '@/lib/auth/session';
import { hashPassword, passwordProblems } from '@/lib/auth/passwords';
import { buildSessionPayload } from '@/lib/session-payload';
import { env } from '@/lib/env';
import { safeEqual, uuid } from '@/lib/crypto';
import { jsonb, query } from '@/lib/db';
import { logActivity } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  setupToken: z.string().min(1).max(200),
});

/**
 * First-run owner creation from the browser.
 *
 * Only works while no administrator exists and only with the SETUP_TOKEN that
 * the deployment was configured with. It never falls back to "first request
 * wins": without a configured token the route stays closed.
 */
export const POST = publicRoute(async (req: NextRequest) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  rateLimit(`bootstrap:${ip}`, 10, 10 * 60_000);

  const body = schema.parse(await req.json());

  if (!env.setupToken) {
    throw new ApiError(
      'First-run setup is disabled: set DARKNOTE_SETUP_TOKEN (or SETUP_TOKEN) in the environment, or run `npm run create-admin`.',
      503,
      'setup_disabled',
    );
  }
  if (!safeEqual(body.setupToken, env.setupToken)) {
    await logActivity({
      action: 'auth.bootstrap_failed',
      target: body.email.toLowerCase(),
      severity: 'warning',
      detail: { reason: 'invalid_setup_token' },
    });
    throw new ApiError('Invalid setup token.', 403, 'invalid_setup_token');
  }

  if ((await countUsers()) > 0) {
    throw new ApiError('An administrator already exists. Sign in instead.', 409, 'already_bootstrapped');
  }

  const problems = passwordProblems(body.password);
  if (problems.length > 0) {
    throw new ApiError(`Password does not meet the policy: ${problems.join('; ')}`, 422, 'weak_password');
  }

  const email = body.email.toLowerCase();
  const id = uuid();
  try {
    await query(
      `insert into admin_users (id, email, name, password_hash, role, permissions)
       values ($1,$2,$3,$4,'owner',$5::jsonb)`,
      [id, email, body.name, await hashPassword(body.password), jsonb([])],
    );
  } catch (error) {
    // Unique index on lower(email): someone else finished setup first.
    const message = error instanceof Error ? error.message : '';
    if (/duplicate key|unique/i.test(message)) {
      throw new ApiError('An administrator already exists. Sign in instead.', 409, 'already_bootstrapped');
    }
    throw error;
  }

  await logActivity({
    action: 'auth.bootstrap',
    target: email,
    severity: 'critical',
    detail: { role: 'owner', via: 'setup_token' },
  });

  const result = await login(email, body.password);
  if (!result.ok || !result.user) {
    throw new ApiError(
      result.error ?? 'Owner account created but the session could not be issued. Sign in manually.',
      500,
      'session_failed',
    );
  }

  return ok({ session: await buildSessionPayload(result.user) });
});
