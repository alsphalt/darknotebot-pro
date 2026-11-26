/**
 * One-shot Nexus sync — useful from a process manager, a systemd timer, a
 * Pterodactyl startup command or CI smoke test.
 *
 *   npm run nexus:sync
 */
import { runNexusSync } from '../src/lib/nexus/sync.ts';
import { nexusConfig, nexusEnabled } from '../src/lib/nexus/config.ts';

async function main() {
  if (!nexusEnabled()) {
    console.error('NEXUS_URL and NEXUS_BOT_TOKEN must be set.');
    process.exitCode = 2;
    return;
  }
  const cfg = nexusConfig();
  console.log(`[nexus] syncing with ${cfg.url}`);
  const result = await runNexusSync();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[nexus] sync crashed', err);
  process.exitCode = 1;
});
