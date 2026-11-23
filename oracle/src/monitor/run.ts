import { loadSecrets, reportStartupFailure, summariseSecretsLoad } from "@ipredict/shared";
import { startMonitor } from "./index.js";

async function main(): Promise<void> {
  // The monitor is deliberately given no signing credential (see
  // infra/README.md), but it still needs DATABASE_URL and ALERT_WEBHOOK_URL
  // from whichever source the deployment configured. See docs/SECRETS.md.
  const secrets = await loadSecrets();
  console.info(`[ipredict-oracle-monitor] secrets: ${summariseSecretsLoad(secrets)}`);

  await startMonitor();
}

main().catch((error: unknown) => {
  reportStartupFailure("ipredict-oracle-monitor", error);
  process.exit(1);
});
