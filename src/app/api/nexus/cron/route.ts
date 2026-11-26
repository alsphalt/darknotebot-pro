import { NextResponse } from 'next/server';
import { runNexusSync } from '@/lib/nexus/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled sync (Vercel Cron or any scheduler).
 *
 *   GET /api/nexus/cron
 *   Authorization: Bearer $CRON_SECRET
 *
 * Deliberately read-only with respect to the bot: it pushes state, relays a
 * pairing request and acks commands. It never touches auth files, so a failing
 * cron can never log the bot out.
 */
export async function GET(req: Request) {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: { code: 'cron_not_configured', message: 'Set CRON_SECRET to enable scheduled sync.' } },
      { status: 503 },
    );
  }
  const header = req.headers.get('authorization') ?? '';
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthorized', message: 'Invalid cron secret.' } },
      { status: 401 },
    );
  }

  const result = await runNexusSync();
  return NextResponse.json({ ok: result.ok, data: result }, { status: result.ok ? 200 : 502 });
}
