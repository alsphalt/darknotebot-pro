/**
 * Optional in-process scheduler for scheduled reconciliation.
 *
 * The Pterodactyl Client API has no file-change webhook, so polling is the only
 * way to notice edits made directly in the panel. Enable with
 * ENABLE_SCHEDULED_SCAN=true and SCAN_INTERVAL_SECONDS (default 300).
 *
 * Runs only in the Node.js runtime and only when explicitly enabled; serverless
 * deployments should call POST /api/servers/{id}/sync from an external scheduler.
 */
export async function register(): Promise<void> {
  // Scheduled scans are triggered externally through the sync API route.
}
