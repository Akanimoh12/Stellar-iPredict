/**
 * One configuration pattern for every service — issue #631.
 *
 * The rule is simple:
 *
 * 1. Each service declares its own schema (zod, or anything with a compatible
 *    `safeParse`) and keeps its own keys and defaults.
 * 2. The service loads configuration through {@link parseConfig}, which
 *    **throws** a {@link ConfigError} on failure. Library code never exits the
 *    process; that would make the failure path impossible to unit test.
 * 3. Only the process entrypoint decides to exit, by passing the error to
 *    {@link reportStartupFailure} and calling `process.exit(1)`.
 *
 * Every misconfiguration then reads the same way:
 *
 *     [ipredict-indexer] invalid configuration:
 *       DATABASE_URL: DATABASE_URL must be a valid URL
 *       START_LEDGER: START_LEDGER is required
 *
 * This module does not depend on zod. The schema parameter is structural, so
 * the shared package stays free of a runtime dependency on any one validator.
 */

/** One problem with one key. `path` is empty when the problem is the whole input. */
export interface ConfigIssue {
  path: readonly PropertyKey[];
  message: string;
}

/** The structural subset of a zod schema that {@link parseConfig} needs. */
export interface ConfigSchema<Output> {
  safeParse(input: unknown):
    | { success: true; data: Output }
    | { success: false; error: { issues: readonly ConfigIssue[] } };
}

/** Thrown when configuration is missing or invalid. */
export class ConfigError extends Error {
  /** The service whose configuration failed, e.g. `ipredict-indexer`. */
  readonly service: string;
  /** Every problem found, in schema order. */
  readonly issues: readonly ConfigIssue[];

  constructor(service: string, issues: readonly ConfigIssue[]) {
    super(formatConfigIssues(service, issues));
    this.name = "ConfigError";
    this.service = service;
    this.issues = issues;
  }
}

/**
 * Renders issues in the one format every service uses.
 *
 * Kept separate from the error so a caller that already holds issues (for
 * example a warning) can format them without constructing an error.
 */
export function formatConfigIssues(service: string, issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => {
    const key = issue.path.map(String).join(".") || "config";
    return `  ${key}: ${issue.message}`;
  });
  return [`[${service}] invalid configuration:`, ...lines].join("\n");
}

/**
 * Validates `input` against a service's schema.
 *
 * @throws {ConfigError} when any key is missing or invalid.
 */
export function parseConfig<Output>(
  service: string,
  schema: ConfigSchema<Output>,
  input: unknown,
): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(service, result.error.issues);
  }
  return result.data;
}

/**
 * Writes a startup failure to stderr in a consistent shape.
 *
 * Entrypoints call this once, then `process.exit(1)`. A {@link ConfigError}
 * prints its formatted issues; any other error prints a `fatal` line with the
 * stack. Nothing else in the services writes startup failures.
 */
export function reportStartupFailure(service: string, error: unknown, write: (line: string) => void = (line) => process.stderr.write(line)): void {
  if (error instanceof ConfigError) {
    write(`${error.message}\n`);
    return;
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  write(`[${service}] fatal: ${detail}\n`);
}
