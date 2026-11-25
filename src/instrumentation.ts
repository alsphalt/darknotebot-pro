/**
 * Process-level background jobs are intentionally not started from the Next.js
 * instrumentation entrypoint: its import graph is also compiled for Edge, while
 * the jobs depend on Node-only PostgreSQL drivers. GitHub sync and pull actions
 * remain available through their explicit API routes.
 */
export async function register(): Promise<void> {
  // No process-level workers are started here.
}
