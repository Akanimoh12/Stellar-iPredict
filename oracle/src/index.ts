import { loadSecrets, summariseSecretsLoad } from "@ipredict/shared";
import { startAggregator } from "./aggregator/index.js";
import { createResolverKeyProvider } from "./aggregator/key-rotation.js";

async function main(): Promise<void> {
  // The aggregator holds RESOLVER_KEY, so it is the service that most needs a
  // real secrets source. Resolving it here — before loadAggregatorConfig()
  // parses process.env — is what lets `RESOLVER_KEY_FILE=/run/secrets/…` work
  // without the config schema knowing anything about files. See docs/SECRETS.md.
  const secrets = await loadSecrets();
  console.info(`[ipredict-oracle] secrets: ${summariseSecretsLoad(secrets)}`);

  // Resolver keys may come directly from the environment for local development
  // or from a secret-manager mounted file in production. Retrieval failure is
  // fatal and the key value is never included in logs or errors.
  const resolverKeyProvider = createResolverKeyProvider(process.env);
  process.env.RESOLVER_KEY = await resolverKeyProvider.getKey();
  process.env.RESOLVER_SECRET_KEY ??= process.env.RESOLVER_KEY;

  await startAggregator();
}

main().catch((error: unknown) => {
  console.error("[ipredict-oracle] fatal:", error);
  process.exit(1);
});