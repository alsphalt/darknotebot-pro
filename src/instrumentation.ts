/**
 * Process-level background worker for GitHub synchronization.
 *
 * The debounced queue lives in PostgreSQL (`github_sync_jobs`), so the claim step
 * is safe even when several requests try to drain it at once. This timer simply
 * gives long-running Node deployments a reliable drain without an external
 * scheduler; where timers are not dependable (serverless), the panel calls
 * POST /api/github/sync/tick while a push is pending.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.DARKNOTE_DISABLE_GITHUB_WORKER === '1') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const cache = globalThis as unknown as { __darknoteSyncWorker?: boolean };
  if (cache.__darknoteSyncWorker) return;
  cache.__darknoteSyncWorker = true;

  try {
    const { runDueSyncJobs } = await import('./lib/github/sync');
    const { pruneCache } = await import('./lib/cache');
    const timer = setInterval(() => {
      void runDueSyncJobs(2).catch(() => undefined);
      // Cheap housekeeping on the same tick: expired settings/server cache
      // entries are dropped instead of accumulating for the process lifetime.
      pruneCache(200);
    }, 3_000);
    // Never keep the process alive just for the poller.
    timer.unref?.();
  } catch {
    // A missing database at boot must not stop the server from starting.
  }
}
