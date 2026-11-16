import { z } from 'zod';
import { ApiError, ok, publicRoute, rateLimit } from '@/lib/api';
import { hashPassword, passwordProblems } from '@/lib/auth/passwords';
import { jsonb, withTransaction } from '@/lib/db';
import { safeEqual, uuid } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(12).max(200),
  setupToken: z.string().min(1).max(512),
});

export const POST = publicRoute(async (req) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  rateLimit(`bootstrap:${ip}`, 5, 15 * 60_000);

  const body = schema.parse(await req.json());
  const expectedToken = process.env.SETUP_TOKEN ?? '';
  if (!expectedToken) {
    throw new ApiError('Account creation is not configured.', 503, 'setup_unavailable');
  }
  if (!safeEqual(body.setupToken, expectedToken)) {
    throw new ApiError('Invalid setup token.', 403, 'invalid_setup_token');
  }

  const problems = passwordProblems(body.password);
  if (problems.length) {
    throw new ApiError('Password does not meet the requirements.', 422, 'weak_password', problems);
  }

  const id = uuid();
  const passwordHash = await hashPassword(body.password);
  await withTransaction(async (client) => {
    await client.query('lock table admin_users in exclusive mode');
    const existing = await client.query<{ count: string | number }>(
      'select count(*)::int as count from admin_users',
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      throw new ApiError('An administrator already exists.', 409, 'already_bootstrapped');
    }
    await client.query(
      `insert into admin_users (id, email, name, password_hash, role, permissions)
       values ($1, $2, $3, $4, 'owner', $5::jsonb)`,
      [id, body.email.toLowerCase(), body.name, passwordHash, jsonb([])],
    );
  });

  return ok({ created: true, email: body.email.toLowerCase() });
});
