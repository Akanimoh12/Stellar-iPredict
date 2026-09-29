export type AdapterApiKeyName =
  | "coinGecko"
  | "coinMarketCap"
  | "sportData"
  | "theOdds"
  | "metaculus";

export type AdapterApiKeys = Partial<Record<AdapterApiKeyName, string>>;

export type AdapterEnvironment = Record<string, string | undefined>;

/**
 * Environment variables used by the data sources described in the oracle
 * architecture. Providers that do not require credentials simply have no
 * entry in the returned key map.
 */
export const ADAPTER_API_KEY_ENV: Readonly<Record<AdapterApiKeyName, readonly string[]>> = {
  coinGecko: ["COINGECKO_API_KEY"],
  coinMarketCap: ["COINMARKETCAP_API_KEY", "CMC_API_KEY"],
  sportData: ["SPORTDATA_API_KEY", "SPORTDATAAPI_API_KEY"],
  theOdds: ["THE_ODDS_API_KEY", "THEODDS_API_KEY"],
  metaculus: ["METACULUS_API_KEY"],
};

function readEnvironment(environment: AdapterEnvironment, name: AdapterApiKeyName): string | undefined {
  const variables = ADAPTER_API_KEY_ENV[name];
  const values = variables
    .map((variable) => ({ variable, value: environment[variable] }))
    .filter((entry): entry is { variable: string; value: string } => entry.value !== undefined);

  const nonBlank = values.map(({ variable, value }) => ({ variable, value: value.trim() }));
  const blank = nonBlank.find(({ value }) => value.length === 0);
  if (blank) {
    throw new Error(`${blank.variable} must not be blank`);
  }

  if (nonBlank.length === 0) return undefined;

  const first = nonBlank[0];
  const conflicting = nonBlank.find(({ value }) => value !== first.value);
  if (conflicting) {
    throw new Error(
      `Conflicting environment variables for ${name}: ${first.variable} and ${conflicting.variable}`,
    );
  }

  return first.value;
}

/**
 * Loads every supported adapter credential from the supplied environment.
 * Credentials are optional because adapters may be disabled or may use a
 * public endpoint. Any configured credential is validated before returning.
 *
 * The environment argument is injectable so startup configuration can be
 * tested without mutating process.env.
 */
export function loadAdapterApiKeys(environment: AdapterEnvironment = process.env): AdapterApiKeys {
  const keys: AdapterApiKeys = {};

  for (const name of Object.keys(ADAPTER_API_KEY_ENV) as AdapterApiKeyName[]) {
    const value = readEnvironment(environment, name);
    if (value !== undefined) keys[name] = value;
  }

  return keys;
}

/**
 * Returns a configured key or fails fast with a provider-specific error.
 * This should be used when constructing an adapter that requires credentials.
 */
export function requireAdapterApiKey(
  name: AdapterApiKeyName,
  environment: AdapterEnvironment = process.env,
): string {
  const key = readEnvironment(environment, name);
  if (key === undefined) {
    throw new Error(`Missing API key for ${name}; set ${ADAPTER_API_KEY_ENV[name][0]}`);
  }
  return key;
}
