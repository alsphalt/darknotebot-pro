import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { query, queryOne } from '@/lib/db';
import { uuid } from '@/lib/crypto';
import { confineToRoot } from '@/lib/security/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drafts live only in the database. They are never production content. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.read');

  if (path) {
    const target = confineToRoot(server.projectRoot, path);
    const draft = await queryOne<{ content: string; base_sha256: string | null; updated_at: string; status: string }>(
      `select content, base_sha256, updated_at, status from editor_drafts
        where server_id = $1 and path = $2 and user_id = $3`,
      [server.id, target, user.id],
    );
    return ok({
      draft: draft ? { content: draft.content, baseSha: draft.base_sha256, updatedAt: draft.updated_at, status: draft.status } : null,
    });
  }

  const drafts = await query<{ path: string; updated_at: string; base_sha256: string | null; status: string }>(
    `select path, updated_at, base_sha256, status from editor_drafts
      where server_id = $1 and user_id = $2 and status in ('draft','conflict')
      order by updated_at desc limit 100`,
    [server.id, user.id],
  );
  return ok({
    drafts: drafts.map((draft) => ({
      path: draft.path,
      updatedAt: draft.updated_at,
      baseSha: draft.base_sha256,
      status: draft.status,
    })),
  });
});

const saveSchema = z.object({
  serverId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  baseSha: z.string().nullable().optional(),
  note: z.string().max(300).optional(),
});

export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(saveSchema);
  const server = await assertServerAccess(user, input.serverId, 'file.write');
  const path = confineToRoot(server.projectRoot, input.path);

  await query(
    `insert into editor_drafts (id, server_id, path, user_id, content, base_sha256, status, note, updated_at)
     values ($1,$2,$3,$4,$5,$6,'draft',$7, now())
     on conflict (server_id, path, user_id) do update set content = excluded.content,
       base_sha256 = excluded.base_sha256, status = 'draft', note = excluded.note, updated_at = now()`,
    [uuid(), server.id, path, user.id, input.content, input.baseSha ?? null, input.note ?? null],
  );
  return ok({ saved: true, path, status: 'draft' });
});

export const DELETE = route({ permission: 'file.write' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  const path = url.searchParams.get('path');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.write');

  if (path) {
    const target = confineToRoot(server.projectRoot, path);
    await query('delete from editor_drafts where server_id = $1 and path = $2 and user_id = $3', [
      server.id,
      target,
      user.id,
    ]);
    return ok({ discarded: true, path: target });
  }
  await query('delete from editor_drafts where server_id = $1 and user_id = $2', [server.id, user.id]);
  return ok({ discarded: true, all: true });
});
