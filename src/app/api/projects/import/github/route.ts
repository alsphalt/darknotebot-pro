import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { getConnectionView } from '@/lib/github/credentials';
import { importFromGitHub } from '@/lib/projects/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const schema = z.object({
  owner: z.string().trim().min(1).max(120).optional(),
  repo: z.string().trim().min(1).max(120).optional(),
  branch: z.string().trim().max(200).optional(),
  jobId: z.string().min(1).optional(),
});

/**
 * Imports a repository through the GitHub API — the operator never downloads a
 * ZIP. When the request omits owner/repo, the repository configured in Admin
 * Settings is used (scenario A).
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  rateLimit(`project-import-github:${user.id}`, 20, 60_000);
  const input = await body(schema);

  const view = await getConnectionView();
  if (!view.connected) {
    const error = new Error('GitHub is not connected. Connect it in Admin Settings → GitHub Connection before importing.');
    (error as Error & { statusCode?: number }).statusCode = 424;
    throw error;
  }

  const owner = input.owner ?? view.repository?.owner;
  const repoName = input.repo ?? view.repository?.name;
  if (!owner || !repoName) {
    const error = new Error('No repository selected and none configured in Admin Settings.');
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  const result = await importFromGitHub({
    owner,
    repoName,
    branch: input.branch ?? view.repository?.branch ?? null,
    userId: user.id,
    jobId: input.jobId,
  });

  return ok({
    project: result.project,
    summary: result.summary,
    note: `Imported ${result.summary.files} files from ${owner}/${repoName}@${result.summary.branch ?? ''}.`,
  });
});
