import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { buildMonitor } from '@/lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live status for one server. Container state, WhatsApp state and console output
 * are collected from the panel on every call — nothing is cached or simulated.
 */
export const GET = route({ permission: 'console.read' }, async ({ req, user }) => {
  const serverId = new URL(req.url).searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'console.read');
  const capture = new URL(req.url).searchParams.get('capture') === '1';
  const payload = await buildMonitor(server, { captureConsole: capture, captureMs: 5000 });
  return ok(payload);
});
