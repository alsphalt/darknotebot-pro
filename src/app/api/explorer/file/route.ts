import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { explorerFileInfo } from '@/lib/services/explorer';
import { deletePaths } from '@/lib/files/ops';
import { confineToRoot, isSecretPath } from '@/lib/security/paths';
import { isDataRecord } from '@/lib/explorer/classify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** File detail: metadata, symbols, imports and reverse dependencies. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!path) throw new ApiError('path is required', 400, 'path_required');
  const server = await assertServerAccess(user, serverId, 'file.read');
  const target = confineToRoot(server.projectRoot, path);
  const info = await explorerFileInfo(server, target);
  return ok(info);
});

/**
 * Delete from the explorer.
 *
 * Deleting a file is destructive, so this path is deliberately narrower than the
 * generic file manager: credentials and database records are refused outright,
 * and every deletion is backed up before the panel removes anything.
 */
export const DELETE = route({ permission: 'file.delete' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  const confirm = url.searchParams.get('confirm');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!path) throw new ApiError('path is required', 400, 'path_required');
  if (confirm !== 'DELETE') {
    throw new ApiError('Type DELETE to confirm removing a production file.', 400, 'confirmation_required');
  }
  const server = await assertServerAccess(user, serverId, 'file.delete');
  const target = confineToRoot(server.projectRoot, path);
  if (isSecretPath(target)) {
    throw new ApiError('Credential and session files cannot be deleted from the explorer.', 403, 'secret_blocked');
  }
  if (isDataRecord(target)) {
    throw new ApiError(
      'This is a production data or database file. It is protected from deletion here — download it or use the panel.',
      403,
      'protected_data',
    );
  }
  const result = await deletePaths(server, [target], user, { backup: true });
  return ok(result);
});
