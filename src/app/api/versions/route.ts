import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { getVersion, readVersionText, buildDiff } from '@/lib/versions';
import { fetchRemoteFile } from '@/lib/files/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Compare a stored version with what is running in production right now. */
export const GET = route({ permission: 'backup.manage' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const id = url.searchParams.get('id');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!id) throw new ApiError('id is required', 400, 'version_required');
  const server = await assertServerAccess(user, serverId, 'backup.manage');

  const version = await getVersion(server.id, id);
  const content = await readVersionText(version);

  let current: { content: string; sha256: string } | null = null;
  try {
    const snapshot = await fetchRemoteFile(server, version.path, { withStat: false });
    current = { content: snapshot.content, sha256: snapshot.sha256 };
  } catch {
    current = null;
  }

  return ok({
    version: {
      id: version.id,
      path: version.path,
      version: version.version,
      sha256: version.sha256,
      createdAt: version.createdAt,
      source: version.changeNote ?? 'automatic backup',
      message: version.changeNote,
      author: version.authorEmail,
    },
    content,
    current,
    identical: current ? current.sha256 === version.sha256 : false,
    diff: current ? buildDiff(content, current.content) : null,
  });
});
