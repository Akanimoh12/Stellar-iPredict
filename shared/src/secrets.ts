/**
 * Secrets source for the backend stack — issue #205.
 *
 * Every service (api, indexer, oracle-aggregator, oracle-monitor) reads its
 * configuration from `process.env`. That is the contract the Zod schemas in
 * `backend/src/config`, `indexer/src/config`, `oracle/src/aggregator/config.ts`
 * and `oracle/src/monitor/config.ts` already parse against, and nothing here
 * changes it. What this module adds is a *source* in front of that contract:
 * one place that decides where the values come from before the schemas run.
 *
 * ## Backends
 *
 * Selected with `SECRETS_BACKEND`:
 *
 * | Value      | Behaviour                                                      |
 * |------------|----------------------------------------------------------------|
 * | `env`      | Default. Ambient environment only — what compose/CI already set |
 * | `env-file` | Additionally reads a dotenv-format file (`SECRETS_ENV_FILE`)    |
 * | `vault`    | Reserved. Fails loudly; see {@link VaultSecretsBackend}         |
 *
 * `_FILE` indirection is applied under **every** backend, including `env`:
 * `POSTGRES_PASSWORD_FILE=/run/secrets/pg_password` sets `POSTGRES_PASSWORD`
 * from the file's contents. That is the Docker/Kubernetes secret convention,
 * and it is the reason a mounted-secret deployment needs no code change today
 * and a Vault-injected one needs none tomorrow — a sidecar that writes the
 * secret to a path is already supported.
 *
 * ## Precedence
 *
 * 1. A variable already present (and non-empty) in the ambient environment.
 * 2. `<NAME>_FILE`, read from disk.
 * 3. The backend's own values (the env-file).
 *
 * Ambient wins so that `docker run -e ORACLE_API_KEY=…` and a CI job's secret
 * store override a checked-out file rather than being silently ignored, which
 * is the failure mode operators hit first. Setting both `<NAME>` and
 * `<NAME>_FILE` is an error rather than a precedence rule: it always means
 * someone believes the wrong one is in effect.
 *
 * ## Never logs a value
 *
 * {@link loadSecrets} returns variable *names* only, and
 * {@link describeSecrets} redacts anything whose name looks like a credential.
 * Hold new tooling to the same bar — see "Secret handling" in
 * `infra/README.md`.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A mutable environment map. `process.env` satisfies this structurally. */
export type EnvRecord = Record<string, string | undefined>;

/** Backend identifiers accepted by `SECRETS_BACKEND`. */
export const SECRETS_BACKENDS = ["env", "env-file", "vault"] as const;
export type SecretsBackendName = (typeof SECRETS_BACKENDS)[number];

export const DEFAULT_SECRETS_BACKEND: SecretsBackendName = "env";

/** Default path used when `SECRETS_ENV_FILE` is unset and the backend is `env-file`. */
export const DEFAULT_SECRETS_ENV_FILE = ".env";

/** Suffix that marks a variable as an indirection to a file on disk. */
export const SECRET_FILE_SUFFIX = "_FILE";

/**
 * A source of secret material.
 *
 * Implementations return a flat `NAME -> value` map. They do not decide
 * precedence and they do not touch `process.env`; {@link loadSecrets} owns
 * both so that every backend behaves identically from the caller's side.
 */
export interface SecretsBackend {
  readonly name: SecretsBackendName;
  /** Where the values come from, safe to log. Never contains a value. */
  describe(): string;
  load(): Promise<Record<string, string>>;
}

/** Names-only report of what a load did. Safe to log verbatim. */
export interface SecretsLoadResult {
  readonly backend: SecretsBackendName;
  /** Human-readable source, e.g. `env-file:/srv/ipredict/.env`. */
  readonly source: string;
  /** Names set into the environment from the backend, sorted. */
  readonly applied: readonly string[];
  /** Names the backend supplied that the ambient environment already had, sorted. */
  readonly overridden: readonly string[];
  /** Names resolved through `<NAME>_FILE` indirection, sorted. */
  readonly fromFiles: readonly string[];
}

export interface LoadSecretsOptions {
  /** Environment to read from and write into. Defaults to `process.env`. */
  env?: EnvRecord;
  /** Overrides `SECRETS_BACKEND`. */
  backend?: SecretsBackendName;
  /** Overrides `SECRETS_ENV_FILE`. Relative paths resolve against `cwd`. */
  envFilePath?: string;
  /**
   * Treat a missing env-file as an error. Defaults to
   * `SECRETS_ENV_FILE_REQUIRED === "true"`.
   *
   * The default is false because a compose deployment that injects everything
   * as ambient variables legitimately has no file, and refusing to start there
   * would be wrong. Set it to true in deployments where the file *is* the
   * source, so a bad mount fails at boot instead of at the first query.
   */
  required?: boolean;
  /** Set the resolved values into `env`. Defaults to true. */
  apply?: boolean;
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected in tests. Defaults to a UTF-8 `readFileSync`. */
  readFile?: (path: string) => string;
  /** Injected in tests. Defaults to `statSync().isFile()`. */
  fileExists?: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for every failure in this module. */
export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

/** The configured env-file does not exist and `required` was set. */
export class SecretsFileNotFoundError extends SecretsError {
  constructor(readonly path: string) {
    super(
      `Secrets file not found: ${path}. Create it (cp infra/.env.example ${path}) ` +
        `or unset SECRETS_ENV_FILE_REQUIRED to start from the ambient environment.`,
    );
    this.name = "SecretsFileNotFoundError";
  }
}

/** A line in the env-file is not `NAME=value`. */
export class SecretsFileParseError extends SecretsError {
  constructor(
    readonly path: string,
    readonly line: number,
  ) {
    // The offending line is deliberately not included: it may be the secret.
    super(
      `Malformed secrets file ${path} at line ${line}: expected NAME=value, ` +
        `a # comment, or a blank line.`,
    );
    this.name = "SecretsFileParseError";
  }
}

/** Both `<NAME>` and `<NAME>_FILE` are set. */
export class SecretsConflictError extends SecretsError {
  constructor(readonly variable: string) {
    super(
      `Both ${variable} and ${variable}${SECRET_FILE_SUFFIX} are set. ` +
        `Set exactly one — the other is silently ignored otherwise.`,
    );
    this.name = "SecretsConflictError";
  }
}

/** `SECRETS_BACKEND` is not one of {@link SECRETS_BACKENDS}. */
export class UnknownSecretsBackendError extends SecretsError {
  constructor(readonly backend: string) {
    super(
      `Unknown SECRETS_BACKEND "${backend}". Expected one of: ${SECRETS_BACKENDS.join(", ")}.`,
    );
    this.name = "UnknownSecretsBackendError";
  }
}

/** A backend is wired but not implemented yet. */
export class SecretsBackendNotImplementedError extends SecretsError {
  constructor(
    readonly backend: SecretsBackendName,
    detail: string,
  ) {
    super(`SECRETS_BACKEND=${backend} is not implemented yet. ${detail}`);
    this.name = "SecretsBackendNotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// dotenv-format parsing
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Parse dotenv-format text into a flat map.
 *
 * Supported, because `infra/.env.example` and the per-service `.env.example`
 * files already use all of it:
 *
 * ```sh
 * # a comment
 * NAME=value
 * export NAME=value          # `export` prefix is tolerated
 * NAME=                      # empty value — "declared but not configured"
 * NAME="quoted value"        # \n \r \t \\ \" are unescaped inside double quotes
 * NAME='raw $value'          # single quotes are literal
 * NAME=value  # trailing     # stripped only outside quotes
 * ```
 *
 * Deliberately unsupported: multi-line values and `${VAR}` interpolation.
 * Compose does its own interpolation before the process ever starts, and a
 * second, subtly different implementation here would be a source of
 * "works in compose, not on the host" bugs.
 *
 * A later duplicate key wins, matching how a shell sourcing the file behaves.
 *
 * @throws {SecretsFileParseError} on a line that is neither blank, a comment,
 *         nor an assignment.
 */
export function parseEnvFile(contents: string, path = "<memory>"): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = ASSIGNMENT.exec(raw);
    if (!match) {
      throw new SecretsFileParseError(path, i + 1);
    }
    out[match[1]!] = unquote(match[2]!);
  }

  return out;
}

/** Strip surrounding quotes, unescape double-quoted values, drop trailing comments. */
function unquote(rawValue: string): string {
  const value = rawValue.trim();
  if (value === "") return "";

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closing = findClosingQuote(value, quote);
    if (closing !== -1) {
      const inner = value.slice(1, closing);
      return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
    }
    // Unterminated quote: fall through and treat the whole thing as literal
    // rather than guessing where the operator meant it to end.
  }

  // Unquoted: a `#` preceded by whitespace starts a comment. `#` inside a
  // value (a URL fragment, a generated password) survives.
  const comment = / +#/.exec(value);
  return (comment ? value.slice(0, comment.index) : value).trim();
}

function findClosingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (value[i] === quote) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(inner: string): string {
  return inner.replace(/\\([nrt\\"'])/g, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return char;
    }
  });
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * The ambient environment. Supplies nothing of its own — `process.env` is
 * already populated — but keeps `SECRETS_BACKEND=env` on the same code path as
 * every other backend, so `_FILE` indirection and the load report work
 * identically in local development and in production.
 */
export class AmbientSecretsBackend implements SecretsBackend {
  readonly name = "env" as const;

  describe(): string {
    return "env:ambient";
  }

  async load(): Promise<Record<string, string>> {
    return {};
  }
}

export interface EnvFileSecretsBackendOptions {
  path: string;
  required: boolean;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
}

/** Reads a dotenv-format file from disk. */
export class EnvFileSecretsBackend implements SecretsBackend {
  readonly name = "env-file" as const;

  constructor(private readonly options: EnvFileSecretsBackendOptions) {}

  describe(): string {
    return `env-file:${this.options.path}`;
  }

  async load(): Promise<Record<string, string>> {
    const { path, required, readFile, fileExists } = this.options;
    if (!fileExists(path)) {
      if (required) throw new SecretsFileNotFoundError(path);
      return {};
    }
    return parseEnvFile(readFile(path), path);
  }
}

/** Environment variables a future Vault backend will read. */
export const VAULT_ENV_VARS = [
  "VAULT_ADDR",
  "VAULT_NAMESPACE",
  "VAULT_TOKEN",
  "VAULT_TOKEN_FILE",
  "VAULT_ROLE",
  "VAULT_SECRET_PATH",
] as const;

/**
 * Placeholder for a HashiCorp Vault (or AWS Secrets Manager / SOPS) backend.
 *
 * It is wired into {@link createSecretsBackend} and into `SECRETS_BACKEND`
 * validation so that adopting it later is a one-file change: implement
 * `load()` to fetch `VAULT_SECRET_PATH` from `VAULT_ADDR` and return the flat
 * map. Everything downstream — precedence, `_FILE` indirection, redaction,
 * the load report, every service entrypoint — already works against the
 * {@link SecretsBackend} interface and needs no edit.
 *
 * `load()` throws rather than returning `{}`. A secrets backend that silently
 * supplies nothing is indistinguishable from a working one right up until a
 * service starts with a default password, so this fails at boot instead.
 *
 * Until it lands, the supported path to a managed secret store is the one
 * described in `infra/README.md`: have the agent, sidecar, or CSI driver write
 * the value to a file and point `<NAME>_FILE` at it. That works today under
 * any backend.
 */
export class VaultSecretsBackend implements SecretsBackend {
  readonly name = "vault" as const;

  constructor(private readonly env: EnvRecord = {}) {}

  describe(): string {
    const address = this.env.VAULT_ADDR;
    return address ? `vault:${address} (not implemented)` : "vault:unconfigured (not implemented)";
  }

  /** Names of the Vault variables that are set. Values are never read here. */
  configuredVars(): string[] {
    return VAULT_ENV_VARS.filter((name) => nonEmpty(this.env[name]));
  }

  async load(): Promise<Record<string, string>> {
    throw new SecretsBackendNotImplementedError(
      "vault",
      "Use SECRETS_BACKEND=env-file, or have the Vault agent write each secret " +
        "to a file and point <NAME>_FILE at it — that path is supported today. " +
        `Recognised (unused) variables: ${VAULT_ENV_VARS.join(", ")}.`,
    );
  }
}

/**
 * Build the backend named by `SECRETS_BACKEND`.
 *
 * @throws {UnknownSecretsBackendError} on an unrecognised name — a typo in
 *         `SECRETS_BACKEND` must not silently degrade to the ambient
 *         environment.
 */
export function createSecretsBackend(
  name: SecretsBackendName,
  options: EnvFileSecretsBackendOptions & { env: EnvRecord },
): SecretsBackend {
  switch (name) {
    case "env":
      return new AmbientSecretsBackend();
    case "env-file":
      return new EnvFileSecretsBackend(options);
    case "vault":
      return new VaultSecretsBackend(options.env);
    default: {
      throw new UnknownSecretsBackendError(name);
    }
  }
}

/** Narrow an arbitrary string to a {@link SecretsBackendName}. */
export function parseSecretsBackend(value: string | undefined): SecretsBackendName {
  if (!nonEmpty(value)) return DEFAULT_SECRETS_BACKEND;
  const normalised = value.trim().toLowerCase();
  const match = SECRETS_BACKENDS.find((candidate) => candidate === normalised);
  if (!match) throw new UnknownSecretsBackendError(value);
  return match;
}

// ---------------------------------------------------------------------------
// `<NAME>_FILE` indirection
// ---------------------------------------------------------------------------

export interface FileIndirectionOptions {
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  cwd?: string;
}

/**
 * Resolve every `<NAME>_FILE` variable into `<NAME>`, reading the file's
 * contents as the value.
 *
 * One trailing newline is stripped — `echo -n` is easy to forget and a
 * password with a `\n` on the end fails authentication in a way that is very
 * hard to see in a log.
 *
 * @returns the base names that were populated, sorted.
 * @throws {SecretsConflictError} when both `<NAME>` and `<NAME>_FILE` are set.
 * @throws {SecretsFileNotFoundError} when the referenced file is missing —
 *         an explicit pointer at a path that is not there is always a
 *         deployment bug, never an opt-out.
 */
export function resolveFileIndirection(
  env: EnvRecord,
  options: FileIndirectionOptions = {},
): string[] {
  const readFile = options.readFile ?? defaultReadFile;
  const fileExists = options.fileExists ?? defaultFileExists;
  const cwd = options.cwd;
  const resolved: string[] = [];

  for (const key of Object.keys(env)) {
    if (!key.endsWith(SECRET_FILE_SUFFIX)) continue;
    const pointer = env[key];
    if (!nonEmpty(pointer)) continue;

    const base = key.slice(0, -SECRET_FILE_SUFFIX.length);
    if (base === "") continue;
    if (nonEmpty(env[base])) throw new SecretsConflictError(base);

    const path = absolutePath(pointer.trim(), cwd);
    if (!fileExists(path)) throw new SecretsFileNotFoundError(path);

    env[base] = stripTrailingNewline(readFile(path));
    resolved.push(base);
  }

  return resolved.sort();
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Resolve secrets from the configured backend and apply them to `env`.
 *
 * Safe to call more than once: values already present are never overwritten,
 * so a second call is a no-op rather than a reload.
 *
 * ```ts
 * const result = await loadSecrets();
 * logger.info("secrets loaded", {
 *   backend: result.backend,
 *   source: result.source,
 *   applied: result.applied.length,   // names, never values
 * });
 * const config = loadAggregatorConfig();   // reads process.env as before
 * ```
 */
export async function loadSecrets(
  options: LoadSecretsOptions = {},
): Promise<SecretsLoadResult> {
  const env = options.env ?? (globalThis as { process?: { env: EnvRecord } }).process?.env ?? {};
  const cwd = options.cwd;
  const readFile = options.readFile ?? defaultReadFile;
  const fileExists = options.fileExists ?? defaultFileExists;

  const backendName = options.backend ?? parseSecretsBackend(env.SECRETS_BACKEND);
  const envFilePath = absolutePath(
    options.envFilePath ?? orDefault(env.SECRETS_ENV_FILE, DEFAULT_SECRETS_ENV_FILE),
    cwd,
  );
  const required = options.required ?? isTrue(env.SECRETS_ENV_FILE_REQUIRED);
  const apply = options.apply ?? true;

  const backend = createSecretsBackend(backendName, {
    env,
    path: envFilePath,
    required,
    readFile,
    fileExists,
  });

  const supplied = await backend.load();

  const applied: string[] = [];
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(supplied)) {
    if (nonEmpty(env[key])) {
      // Ambient wins. Recorded so an operator can see the file was read and
      // deliberately not used, instead of wondering whether it was read at all.
      overridden.push(key);
      continue;
    }
    if (apply) env[key] = value;
    applied.push(key);
  }

  // Runs under every backend, and after the merge so a pointer supplied by the
  // env-file itself (`RESOLVER_KEY_FILE=/run/secrets/resolver`) is honoured.
  const fromFiles = apply ? resolveFileIndirection(env, { readFile, fileExists, cwd }) : [];

  return Object.freeze({
    backend: backendName,
    source: backend.describe(),
    applied: Object.freeze(applied.sort()),
    overridden: Object.freeze(overridden.sort()),
    fromFiles: Object.freeze(fromFiles),
  });
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Names matching this are treated as credentials by {@link describeSecrets}.
 *
 * `*_URL` is included on purpose: `DATABASE_URL` and `REDIS_URL` carry the
 * Postgres and Redis passwords inline.
 */
export const SECRET_NAME_PATTERN =
  /(SECRET|PASSWORD|PASSWD|TOKEN|_KEY|KEY_|^KEY$|CREDENTIAL|PRIVATE|SEED|AUTH|DSN|_URL$)/i;

/** True when a variable name looks like it holds a credential. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Placeholder substituted for a redacted value. */
export const REDACTED = "***" as const;

/**
 * Replace credential-looking values with {@link REDACTED} so an environment
 * dump can be logged.
 *
 * Non-secret values pass through, which is what makes the output worth logging
 * at all — `POLL_INTERVAL_MS` and `COUNCIL_SIZE` are exactly what you want to
 * see in a startup line.
 */
export function describeSecrets(env: EnvRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) continue;
    out[key] = isSecretName(key) ? REDACTED : value;
  }
  return out;
}

/**
 * One-line, value-free summary of a load. Intended for a startup log line.
 *
 * ```
 * secrets: backend=env-file source=env-file:/srv/ipredict/.env applied=23 overridden=2 from_files=1
 * ```
 */
export function summariseSecretsLoad(result: SecretsLoadResult): string {
  return [
    `backend=${result.backend}`,
    `source=${result.source}`,
    `applied=${result.applied.length}`,
    `overridden=${result.overridden.length}`,
    `from_files=${result.fromFiles.length}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function orDefault(value: string | undefined, fallback: string): string {
  return nonEmpty(value) ? value : fallback;
}

function isTrue(value: string | undefined): boolean {
  return nonEmpty(value) && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function absolutePath(path: string, cwd?: string): string {
  if (isAbsolute(path)) return path;
  const base = cwd ?? (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  return resolvePath(base, path);
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
