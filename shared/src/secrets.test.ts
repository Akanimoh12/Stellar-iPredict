/**
 * Tests for the secrets source (issue #205).
 *
 * Run with `npm test --workspace=@ipredict/shared`. The package has no test
 * framework dependency on purpose — these use `node:test`, which is why the
 * script compiles first and runs the emitted JS from `dist/`.
 *
 * Every filesystem access goes through the injected `readFile`/`fileExists`
 * hooks, so the suite touches no real paths and needs no fixtures on disk.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AmbientSecretsBackend,
  DEFAULT_SECRETS_BACKEND,
  EnvFileSecretsBackend,
  REDACTED,
  SecretsConflictError,
  SecretsFileNotFoundError,
  SecretsFileParseError,
  SecretsBackendNotImplementedError,
  UnknownSecretsBackendError,
  VaultSecretsBackend,
  VAULT_ENV_VARS,
  describeSecrets,
  isSecretName,
  loadSecrets,
  parseEnvFile,
  parseSecretsBackend,
  resolveFileIndirection,
  summariseSecretsLoad,
  type EnvRecord,
} from "./secrets.js";

/** Build a fake filesystem for the injected hooks. */
function fakeFs(files: Record<string, string>) {
  return {
    readFile: (path: string): string => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    fileExists: (path: string): boolean => Object.hasOwn(files, path),
  };
}

type ErrorClass<E extends Error> = abstract new (...args: never[]) => E;

/**
 * `assert.throws` returns `undefined`, so it cannot be used to inspect the
 * error's own fields (`.line`, `.variable`). These capture it instead.
 */
function captureError<E extends Error>(fn: () => unknown, type: ErrorClass<E>): E {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${type.name} to be thrown`);
}

async function captureRejection<E extends Error>(
  fn: () => Promise<unknown>,
  type: ErrorClass<E>,
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${type.name} to be rejected with`);
}

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

test("parseEnvFile reads the forms the checked-in .env.example files use", () => {
  const parsed = parseEnvFile(
    [
      "# ── Postgres ──",
      "",
      "POSTGRES_USER=ipredict",
      "export POSTGRES_DB=ipredict",
      "REDIS_PASSWORD=",
      'CORS_ORIGINS="https://ipredict.app,https://www.ipredict.app"',
      "NETWORK_PASSPHRASE='Public Global Stellar Network ; September 2015'",
      "POLL_INTERVAL_MS=5000  # milliseconds",
      "  MONITOR_INTERVAL_MS = 60000  ",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    POSTGRES_USER: "ipredict",
    POSTGRES_DB: "ipredict",
    REDIS_PASSWORD: "",
    CORS_ORIGINS: "https://ipredict.app,https://www.ipredict.app",
    NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    POLL_INTERVAL_MS: "5000",
    MONITOR_INTERVAL_MS: "60000",
  });
});

test("parseEnvFile keeps a # that is part of a value", () => {
  // Generated passwords routinely contain '#'; only ' #' starts a comment.
  const parsed = parseEnvFile("POSTGRES_PASSWORD=aB3#dEf\nURL=https://host/path#frag");
  assert.equal(parsed.POSTGRES_PASSWORD, "aB3#dEf");
  assert.equal(parsed.URL, "https://host/path#frag");
});

test("parseEnvFile unescapes double-quoted values and leaves single quotes literal", () => {
  const parsed = parseEnvFile(['A="line1\\nline2"', "B='raw \\n value'"].join("\n"));
  assert.equal(parsed.A, "line1\nline2");
  assert.equal(parsed.B, "raw \\n value");
});

test("parseEnvFile lets a later duplicate win, like a shell sourcing the file", () => {
  assert.equal(parseEnvFile("LOG_LEVEL=info\nLOG_LEVEL=debug").LOG_LEVEL, "debug");
});

test("parseEnvFile rejects a malformed line without echoing it", () => {
  const error = captureError(
    () => parseEnvFile("VALID=1\nthis is not an assignment\n", "/srv/.env"),
    SecretsFileParseError,
  );

  assert.equal(error.line, 2);
  assert.equal(error.path, "/srv/.env");
  assert.ok(!error.message.includes("this is not an assignment"));
});

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

test("the ambient backend supplies nothing of its own", async () => {
  const backend = new AmbientSecretsBackend();
  assert.equal(backend.name, "env");
  assert.deepEqual(await backend.load(), {});
});

test("the env-file backend returns {} for a missing optional file", async () => {
  const backend = new EnvFileSecretsBackend({
    path: "/srv/.env",
    required: false,
    ...fakeFs({}),
  });
  assert.deepEqual(await backend.load(), {});
});

test("the env-file backend throws for a missing required file", async () => {
  const backend = new EnvFileSecretsBackend({
    path: "/srv/.env",
    required: true,
    ...fakeFs({}),
  });
  await assert.rejects(() => backend.load(), SecretsFileNotFoundError);
});

test("the vault backend fails loudly instead of silently supplying nothing", async () => {
  const backend = new VaultSecretsBackend({ VAULT_ADDR: "https://vault.internal:8200" });

  assert.equal(backend.name, "vault");
  assert.match(backend.describe(), /vault:https:\/\/vault\.internal:8200 \(not implemented\)/);
  assert.deepEqual(backend.configuredVars(), ["VAULT_ADDR"]);

  const error = await captureRejection(() => backend.load(), SecretsBackendNotImplementedError);
  // The error has to tell an operator what to do instead, not just what failed.
  assert.match(error.message, /SECRETS_BACKEND=env-file/);
  assert.match(error.message, /<NAME>_FILE/);
  for (const name of VAULT_ENV_VARS) assert.ok(error.message.includes(name));
});

test("parseSecretsBackend defaults to env and rejects a typo", () => {
  assert.equal(parseSecretsBackend(undefined), DEFAULT_SECRETS_BACKEND);
  assert.equal(parseSecretsBackend(""), "env");
  assert.equal(parseSecretsBackend(" ENV-FILE "), "env-file");
  assert.equal(parseSecretsBackend("vault"), "vault");
  // A typo must not silently degrade to the ambient environment.
  assert.throws(() => parseSecretsBackend("envfile"), UnknownSecretsBackendError);
});

// ---------------------------------------------------------------------------
// _FILE indirection
// ---------------------------------------------------------------------------

test("resolveFileIndirection populates the base variable from disk", () => {
  const env: EnvRecord = { RESOLVER_KEY_FILE: "/run/secrets/resolver" };
  const resolved = resolveFileIndirection(env, fakeFs({ "/run/secrets/resolver": "SBSECRET" }));

  assert.deepEqual(resolved, ["RESOLVER_KEY"]);
  assert.equal(env.RESOLVER_KEY, "SBSECRET");
});

test("resolveFileIndirection strips exactly one trailing newline", () => {
  // `echo secret > file` appends \n; a password with \n on the end fails auth
  // in a way that is very hard to see in a log.
  const env: EnvRecord = { A_FILE: "/a", B_FILE: "/b", C_FILE: "/c" };
  resolveFileIndirection(
    env,
    fakeFs({ "/a": "one\n", "/b": "two\r\n", "/c": "three\n\n" }),
  );

  assert.equal(env.A, "one");
  assert.equal(env.B, "two");
  assert.equal(env.C, "three\n");
});

test("resolveFileIndirection rejects setting both NAME and NAME_FILE", () => {
  const env: EnvRecord = { ORACLE_API_KEY: "inline", ORACLE_API_KEY_FILE: "/run/secrets/api" };
  const error = captureError(
    () => resolveFileIndirection(env, fakeFs({ "/run/secrets/api": "from-file" })),
    SecretsConflictError,
  );

  assert.equal(error.variable, "ORACLE_API_KEY");
  assert.equal(env.ORACLE_API_KEY, "inline", "the conflicting value must be left untouched");
});

test("resolveFileIndirection treats a dangling pointer as a deployment bug", () => {
  const env: EnvRecord = { RESOLVER_KEY_FILE: "/run/secrets/missing" };
  assert.throws(() => resolveFileIndirection(env, fakeFs({})), SecretsFileNotFoundError);
});

test("resolveFileIndirection ignores an empty pointer", () => {
  // `.env.example` spells "not configured" as `NAME_FILE=`.
  const env: EnvRecord = { RESOLVER_KEY_FILE: "" };
  assert.deepEqual(resolveFileIndirection(env, fakeFs({})), []);
  assert.equal(env.RESOLVER_KEY, undefined);
});

// ---------------------------------------------------------------------------
// loadSecrets
// ---------------------------------------------------------------------------

test("loadSecrets under the default backend reads no file but still resolves _FILE", async () => {
  const env: EnvRecord = { POSTGRES_PASSWORD_FILE: "/run/secrets/pg" };
  const result = await loadSecrets({
    env,
    ...fakeFs({ "/run/secrets/pg": "hunter2\n", "/srv/.env": "IGNORED=1" }),
    envFilePath: "/srv/.env",
  });

  assert.equal(result.backend, "env");
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.fromFiles, ["POSTGRES_PASSWORD"]);
  assert.equal(env.POSTGRES_PASSWORD, "hunter2");
  assert.equal(env.IGNORED, undefined, "the env backend must not read the file");
});

test("loadSecrets applies env-file values that the environment does not already have", async () => {
  const env: EnvRecord = { SECRETS_BACKEND: "env-file" };
  const result = await loadSecrets({
    env,
    envFilePath: "/srv/.env",
    ...fakeFs({ "/srv/.env": "POSTGRES_USER=ipredict\nLOG_LEVEL=debug\n" }),
  });

  assert.equal(result.backend, "env-file");
  assert.equal(result.source, "env-file:/srv/.env");
  assert.deepEqual(result.applied, ["LOG_LEVEL", "POSTGRES_USER"]);
  assert.equal(env.POSTGRES_USER, "ipredict");
  assert.equal(env.LOG_LEVEL, "debug");
});

test("loadSecrets lets the ambient environment win over the file, and says so", async () => {
  const env: EnvRecord = { SECRETS_BACKEND: "env-file", LOG_LEVEL: "warn" };
  const result = await loadSecrets({
    env,
    envFilePath: "/srv/.env",
    ...fakeFs({ "/srv/.env": "LOG_LEVEL=debug\nPOLL_INTERVAL_MS=5000\n" }),
  });

  assert.equal(env.LOG_LEVEL, "warn", "docker -e / CI secrets must override the file");
  assert.deepEqual(result.overridden, ["LOG_LEVEL"]);
  assert.deepEqual(result.applied, ["POLL_INTERVAL_MS"]);
});

test("loadSecrets honours a _FILE pointer supplied by the env-file itself", async () => {
  const env: EnvRecord = { SECRETS_BACKEND: "env-file" };
  await loadSecrets({
    env,
    envFilePath: "/srv/.env",
    ...fakeFs({
      "/srv/.env": "RESOLVER_KEY_FILE=/run/secrets/resolver\n",
      "/run/secrets/resolver": "SBRESOLVER\n",
    }),
  });

  assert.equal(env.RESOLVER_KEY, "SBRESOLVER");
});

test("loadSecrets is idempotent — a second call changes nothing", async () => {
  const env: EnvRecord = { SECRETS_BACKEND: "env-file" };
  const fs = fakeFs({ "/srv/.env": "LOG_LEVEL=debug\n" });

  await loadSecrets({ env, envFilePath: "/srv/.env", ...fs });
  const second = await loadSecrets({ env, envFilePath: "/srv/.env", ...fs });

  assert.equal(env.LOG_LEVEL, "debug");
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.overridden, ["LOG_LEVEL"]);
});

test("loadSecrets with apply:false reports without mutating the environment", async () => {
  const env: EnvRecord = { SECRETS_BACKEND: "env-file" };
  const result = await loadSecrets({
    env,
    apply: false,
    envFilePath: "/srv/.env",
    ...fakeFs({ "/srv/.env": "LOG_LEVEL=debug\n" }),
  });

  assert.deepEqual(result.applied, ["LOG_LEVEL"]);
  assert.equal(env.LOG_LEVEL, undefined);
});

test("loadSecrets propagates the vault placeholder rather than starting anyway", async () => {
  await assert.rejects(
    () => loadSecrets({ env: { SECRETS_BACKEND: "vault" }, ...fakeFs({}) }),
    SecretsBackendNotImplementedError,
  );
});

test("loadSecrets rejects an unknown SECRETS_BACKEND", async () => {
  await assert.rejects(
    () => loadSecrets({ env: { SECRETS_BACKEND: "consul" }, ...fakeFs({}) }),
    UnknownSecretsBackendError,
  );
});

test("SECRETS_ENV_FILE_REQUIRED turns a missing file into a boot failure", async () => {
  const env: EnvRecord = {
    SECRETS_BACKEND: "env-file",
    SECRETS_ENV_FILE: "/srv/.env",
    SECRETS_ENV_FILE_REQUIRED: "true",
  };
  await assert.rejects(() => loadSecrets({ env, ...fakeFs({}) }), SecretsFileNotFoundError);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("isSecretName covers the credential-bearing variables in infra/.env.example", () => {
  for (const name of [
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "ORACLE_API_KEY",
    "RESOLVER_KEY",
    "COINGECKO_API_KEY",
    "COUNCIL_MEMBER_SECRET",
    "VAULT_TOKEN",
    "DATABASE_URL",
    "REDIS_URL",
  ]) {
    assert.ok(isSecretName(name), `${name} should be treated as a secret`);
  }

  for (const name of ["LOG_LEVEL", "COUNCIL_SIZE", "POLL_INTERVAL_MS", "API_REPLICAS"]) {
    assert.ok(!isSecretName(name), `${name} should not be redacted`);
  }
});

test("describeSecrets redacts values but keeps the operational ones readable", () => {
  const described = describeSecrets({
    POSTGRES_PASSWORD: "hunter2",
    DATABASE_URL: "postgres://u:p@host/db",
    LOG_LEVEL: "info",
    UNSET: undefined,
  });

  assert.deepEqual(described, {
    DATABASE_URL: REDACTED,
    LOG_LEVEL: "info",
    POSTGRES_PASSWORD: REDACTED,
  });
});

test("summariseSecretsLoad emits counts, never names or values", async () => {
  const env: EnvRecord = { SECRETS_BACKEND: "env-file", LOG_LEVEL: "warn" };
  const result = await loadSecrets({
    env,
    envFilePath: "/srv/.env",
    ...fakeFs({ "/srv/.env": "LOG_LEVEL=debug\nPOSTGRES_PASSWORD=hunter2\n" }),
  });

  const line = summariseSecretsLoad(result);
  assert.equal(
    line,
    "backend=env-file source=env-file:/srv/.env applied=1 overridden=1 from_files=0",
  );
  assert.ok(!line.includes("hunter2"));
});
