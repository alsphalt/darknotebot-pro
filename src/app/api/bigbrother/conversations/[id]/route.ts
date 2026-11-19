import { z } from 'zod';
import { ok, route } from '@/lib/api';
import {
  deleteConversation,
  getConversation,
  renameConversation,
} from '@/lib/bigbrother/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = route<Params>({ permission: null }, async ({ params, user }) => {
  const result = await getConversation(user.id, params.id);
  return ok(result);
});

const patchSchema = z.object({ title: z.string().min(1).max(120) });

export const PATCH = route<Params>({ permission: null }, async ({ params, body, user }) => {
  const input = await body(patchSchema);
  return ok({ conversation: await renameConversation(user.id, params.id, input.title) });
});

export const DELETE = route<Params>({ permission: null }, async ({ params, user }) => {
  await deleteConversation(user.id, params.id);
  return ok({ deleted: params.id });
});
