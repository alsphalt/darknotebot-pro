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
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_SCHEDULED_SCAN !== "true") return;

  const store = globalThis as unknown as { __dnScheduler?: boolean };
  if (store.__dnScheduler) return;
  store.__dnScheduler = true;

  const seconds = Number.parseInt(process.env.SCAN_INTERVAL_SECONDS ?? "300", 10) || 300;
  const intervalMs = Math.max(60, seconds) * 1000;

  const tick = async () => {
    try {
      const { listServers } = await import("./lib/servers/repo");
      const { scanServer } = await import("./lib/services/discovery");
      const servers = await listServers();
      for (const server of servers) {
        if (!server.isActive) continue;
        try {
          const result = await scanServer({ server, mode: "poll" });
          if (result.added + result.changed + result.deleted > 0) {
            // eslint-disable-next-line no-console
            console.info(
              `[scheduler] ${server.name}: +${result.added} ~${result.changed} -${result.deleted} (${result.message})`,
            );
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`[scheduler] scan failed for ${server.name}`, error);
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[scheduler] tick failed", error);
    }
  };

  setTimeout(() => void tick(), 15_000);
  setInterval(() => void tick(), intervalMs);
}
