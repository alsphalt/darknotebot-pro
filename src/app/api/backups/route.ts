import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess, serverClient } from '@/lib/servers/repo';
import { backupStorage } from '@/lib/backups/storage';
import { query } from '@/lib/db';
import { listDeployments } from '@/lib/services/deploy';
import { publicId, toUiStatus } from '@/lib/deploy-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backups and versions. Two independent stores are reported separately:
 * the control center's private object store (content-addressed file copies) and
 * the panel's own backup feature, which may be disabled on the host.
 */
export const GET = route({ permission: 'backup.manage' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'backup.manage');

  const storage = backupStorage();
  let ready = true;
  let detail = `${storage.kind} store at the configured data directory`;
  try {
    await storage.list(serverId);
  } catch (error) {
    ready = false;
    detail = error instanceof Error ? error.message : String(error);
  }

  let panelBackups: Array<{
    uuid: string;
    name: string;
    bytes: number;
    createdAt: string | null;
    completedAt: string | null;
    isSuccessful: boolean;
    isLocked: boolean;
  }> = [];
  let panelError: string | null = null;
  try {
    const client = await serverClient(server);
    const backups = await client.backups();
    panelBackups = backups.map((backup) => ({
      uuid: backup.uuid,
      name: backup.name,
      bytes: backup.bytes,
      createdAt: backup.createdAt,
      completedAt: backup.completedAt,
      isSuccessful: backup.isSuccessful,
      isLocked: backup.isLocked,
    }));
  } catch (error) {
    panelError = error instanceof Error ? error.message : String(error);
  }

  const versions = await query<{
    id: string;
    path: string;
    version: number;
    sha256: string;
    size_bytes: string | number;
    change_note: string | null;
    created_at: string;
    author: string | null;
  }>(
    `select v.id, v.path, v.version, v.sha256, v.size_bytes, v.change_note, v.created_at, u.email as author
       from file_versions v left join admin_users u on u.id = v.created_by
      where v.server_id = $1 order by v.created_at desc limit 80`,
    [server.id],
  );

  const objects = await query<{
    id: string;
    storage_kind: string;
    storage_key: string;
    size_bytes: string | number;
    sha256: string;
    created_at: string;
  }>(
    `select id, storage_kind, storage_key, size_bytes, sha256, created_at from file_backups
      where server_id = $1 order by created_at desc limit 80`,
    [server.id],
  );

  const deployments = (await listDeployments(server.id, 10)) as Array<{
    id: string;
    status: string;
    started_at: string;
    file_count: number;
  }>;

  return ok({
    storage: { driver: storage.kind, ready, detail },
    panelBackups,
    panelError,
    versions: versions.map((version) => ({
      id: version.id,
      path: version.path,
      version: Number(version.version),
      sha256: version.sha256,
      size: Number(version.size_bytes ?? 0),
      source: version.change_note ?? 'automatic backup',
      message: version.change_note,
      createdAt: version.created_at,
      author: version.author,
    })),
    objects: objects.map((object) => ({
      id: object.id,
      storage: object.storage_kind,
      key: object.storage_key,
      size: Number(object.size_bytes ?? 0),
      sha256: object.sha256,
      createdAt: object.created_at,
    })),
    deployments: deployments.map((deployment) => ({
      publicId: publicId(deployment.id),
      id: deployment.id,
      status: toUiStatus(deployment.status),
      startedAt: deployment.started_at,
      fileCount: Number(deployment.file_count ?? 0),
    })),
    note:
      'Versions are stored in the control center\'s private backup store. Panel backups are listed from the panel itself and may be unavailable if the feature is disabled on the host.',
  });
});
