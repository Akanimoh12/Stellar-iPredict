/**
 * Startup Dependency Verification (#643)
 *
 * Verifies Postgres, Redis, and Soroban RPC dependencies at startup before
 * accepting work. Clearly distinguishes misconfiguration (e.g. malformed URL,
 * missing protocol) from unavailability (e.g. network failure, connection refused).
 */

export type DependencyName = "postgres" | "redis" | "soroban_rpc";
export type FailureKind = "misconfiguration" | "unavailability";

export interface DependencyConfig {
  postgresUrl?: string;
  redisUrl?: string;
  sorobanRpcUrl?: string;
}

export interface DependencyCheckResult {
  dependency: DependencyName;
  healthy: boolean;
  message: string;
  failureKind?: FailureKind;
}

export interface StartupVerificationReport {
  allHealthy: boolean;
  checks: DependencyCheckResult[];
}

export class DependencyCheckError extends Error {
  public readonly dependency: DependencyName;
  public readonly failureKind: FailureKind;
  public readonly likelyCause: string;

  constructor(dependency: DependencyName, failureKind: FailureKind, likelyCause: string) {
    super(
      `[Startup Check Failed] ${dependency.toUpperCase()} is unavailable due to ${failureKind}: ${likelyCause}`
    );
    this.name = "DependencyCheckError";
    this.dependency = dependency;
    this.failureKind = failureKind;
    this.likelyCause = likelyCause;
  }
}

/**
 * Validates connection strings and checks availability with injectable ping functions for testing.
 */
export async function checkPostgres(
  url?: string,
  pingFn?: () => Promise<boolean>
): Promise<DependencyCheckResult> {
  if (!url) {
    return {
      dependency: "postgres",
      healthy: false,
      failureKind: "misconfiguration",
      message: "POSTGRES_URL / DATABASE_URL is missing or empty",
    };
  }

  try {
    const parsed = new URL(url);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      return {
        dependency: "postgres",
        healthy: false,
        failureKind: "misconfiguration",
        message: `Invalid Postgres protocol: '${parsed.protocol}', expected 'postgres:' or 'postgresql:'`,
      };
    }
  } catch {
    return {
      dependency: "postgres",
      healthy: false,
      failureKind: "misconfiguration",
      message: `Invalid Postgres URL format: '${url}'`,
    };
  }

  if (pingFn) {
    try {
      const ok = await pingFn();
      if (!ok) {
        return {
          dependency: "postgres",
          healthy: false,
          failureKind: "unavailability",
          message: "Postgres ping returned false (database connection failed)",
        };
      }
    } catch (err: any) {
      return {
        dependency: "postgres",
        healthy: false,
        failureKind: "unavailability",
        message: `Cannot reach Postgres: ${err.message || String(err)}`,
      };
    }
  }

  return {
    dependency: "postgres",
    healthy: true,
    message: "Postgres connection verified successfully",
  };
}

export async function checkRedis(
  url?: string,
  pingFn?: () => Promise<boolean>
): Promise<DependencyCheckResult> {
  if (!url) {
    return {
      dependency: "redis",
      healthy: false,
      failureKind: "misconfiguration",
      message: "REDIS_URL is missing or empty",
    };
  }

  try {
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol)) {
      return {
        dependency: "redis",
        healthy: false,
        failureKind: "misconfiguration",
        message: `Invalid Redis protocol: '${parsed.protocol}', expected 'redis:' or 'rediss:'`,
      };
    }
  } catch {
    return {
      dependency: "redis",
      healthy: false,
      failureKind: "misconfiguration",
      message: `Invalid Redis URL format: '${url}'`,
    };
  }

  if (pingFn) {
    try {
      const ok = await pingFn();
      if (!ok) {
        return {
          dependency: "redis",
          healthy: false,
          failureKind: "unavailability",
          message: "Redis ping returned false (instance unreachable)",
        };
      }
    } catch (err: any) {
      return {
        dependency: "redis",
        healthy: false,
        failureKind: "unavailability",
        message: `Cannot reach Redis: ${err.message || String(err)}`,
      };
    }
  }

  return {
    dependency: "redis",
    healthy: true,
    message: "Redis connection verified successfully",
  };
}

export async function checkSorobanRpc(
  url?: string,
  pingFn?: () => Promise<boolean>
): Promise<DependencyCheckResult> {
  if (!url) {
    return {
      dependency: "soroban_rpc",
      healthy: false,
      failureKind: "misconfiguration",
      message: "SOROBAN_RPC_URL is missing or empty",
    };
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        dependency: "soroban_rpc",
        healthy: false,
        failureKind: "misconfiguration",
        message: `Invalid Soroban RPC protocol: '${parsed.protocol}', expected 'http:' or 'https:'`,
      };
    }
  } catch {
    return {
      dependency: "soroban_rpc",
      healthy: false,
      failureKind: "misconfiguration",
      message: `Invalid Soroban RPC URL format: '${url}'`,
    };
  }

  if (pingFn) {
    try {
      const ok = await pingFn();
      if (!ok) {
        return {
          dependency: "soroban_rpc",
          healthy: false,
          failureKind: "unavailability",
          message: "Soroban RPC ping returned false (node unreachable)",
        };
      }
    } catch (err: any) {
      return {
        dependency: "soroban_rpc",
        healthy: false,
        failureKind: "unavailability",
        message: `Cannot reach Soroban RPC: ${err.message || String(err)}`,
      };
    }
  }

  return {
    dependency: "soroban_rpc",
    healthy: true,
    message: "Soroban RPC connection verified successfully",
  };
}

export interface VerificationHooks {
  pingPostgres?: () => Promise<boolean>;
  pingRedis?: () => Promise<boolean>;
  pingSorobanRpc?: () => Promise<boolean>;
}

/**
 * Runs startup dependency verification across all configured services.
 * Throws `DependencyCheckError` immediately if throwOnFailure is true and any check fails.
 */
export async function verifyStartupDependencies(
  config: DependencyConfig,
  hooks: VerificationHooks = {},
  throwOnFailure: boolean = true
): Promise<StartupVerificationReport> {
  const results: DependencyCheckResult[] = [];

  if (config.postgresUrl !== undefined) {
    results.push(await checkPostgres(config.postgresUrl, hooks.pingPostgres));
  }
  if (config.redisUrl !== undefined) {
    results.push(await checkRedis(config.redisUrl, hooks.pingRedis));
  }
  if (config.sorobanRpcUrl !== undefined) {
    results.push(await checkSorobanRpc(config.sorobanRpcUrl, hooks.pingSorobanRpc));
  }

  const failed = results.find((r) => !r.healthy);
  if (failed && throwOnFailure) {
    throw new DependencyCheckError(
      failed.dependency,
      failed.failureKind ?? "unavailability",
      failed.message
    );
  }

  return {
    allHealthy: !failed,
    checks: results,
  };
}
