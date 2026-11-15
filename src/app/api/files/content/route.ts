import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { cachedFileContent, fetchRemoteFile, indexedFile, validateContent } from '@/lib/files/service';
import { confineToRoot, isEditable, isSecretPath } from '@/lib/security/paths';
import { queryOne } from '@/lib/db';
import { languageFor, secretKindFor } from '@/lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open a production file: the bytes come from Pterodactyl right now, and the
 * stored draft (if any) is returned alongside so the editor can show both.
 */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const requested = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  if (!requested) throw new ApiError('path is required', 400, 'path_required');
  const server = await assertServerAccess(user, serverId, 'file.read');
  const path = confineToRoot(server.projectRoot, requested);

  if (isSecretPath(path)) {
    throw new ApiError(
      'This path is a WhatsApp session, credential or key file. It is protected and cannot be opened in the editor.',
      403,
      'secret_blocked',
    );
  }

  const snapshot = await fetchRemoteFile(server, path, { withStat: true });
  const indexRow = await indexedFile(server.id, path);
  const validation = await validateContent(path, snapshot.content);
  const draft = await queryOne<{ content: string; base_sha256: string | null; updated_at: string }>(
    `select content, base_sha256, updated_at from editor_drafts
      where server_id = $1 and path = $2 and user_id = $3 and status in ('draft','conflict')`,
    [server.id, path, user.id],
  );
  const cached = await cachedFileContent(server.id, path);

  return ok({
    path,
    content: snapshot.content,
    sha256: snapshot.sha256,
    language: languageFor(path) ?? 'plaintext',
    modifiedAt: snapshot.modifiedAt,
    sizeBytes: snapshot.sizeBytes,
    indexedSha: indexRow?.sha256 ?? null,
    inSync: Boolean(indexRow?.sha256 && indexRow.sha256 === snapshot.sha256),
    cachedAt: cached?.fetchedAt ?? null,
    draft: draft
      ? { content: draft.content, baseSha: draft.base_sha256, updatedAt: draft.updated_at }
      : null,
    validation: {
      ok: validation.ok,
      errors: validation.errors.map((message, index) => ({ line: index + 1, message })),
      warnings: validation.warnings,
    },
    editable: isEditable(path),
    secretKind: secretKindFor(path),
  });
});
