# Secrets

How every service in the backend stack gets its configuration and its
credentials. Implemented in [`shared/src/secrets.ts`](../shared/src/secrets.ts)
and used by all four entrypoints (api, indexer, oracle-aggregator,
oracle-monitor).

For *handling* rules — rotation, permissions, what may never be logged — see
[Secret handling](../infra/README.md#secret-handling) in the infra README. This
document is about where the values come from.

## The contract has not changed

Every service still reads `process.env`, and the Zod schemas in
[`backend/src/config`](../backend/src/config/index.ts),
[`indexer/src/config`](../indexer/src/config/index.ts),
[`oracle/src/aggregator/config.ts`](../oracle/src/aggregator/config.ts) and
[`oracle/src/monitor/config.ts`](../oracle/src/monitor/config.ts) are still the
source of truth for what each one needs. What is new is a step *before* them:
each entrypoint calls `loadSecrets()`, which resolves the configured source
into `process.env` and then gets out of the way.

That ordering is the whole design. Adding a secrets backend costs one file and
changes nothing downstream — no config schema, no service, no test learns about
files, tokens, or HTTP.

## Backends

Selected with `SECRETS_BACKEND`:

| Value | Behaviour |
|---|---|
| `env` | **Default.** Ambient environment only — what Compose, systemd, or your shell already set |
| `env-file` | Additionally reads `SECRETS_ENV_FILE` (default `.env`) as a dotenv file |
| `vault` | Reserved. Fails at startup with instructions — see [Vault](#vault-and-other-managed-stores) |

A typo in `SECRETS_BACKEND` is a startup error, not a silent fall back to
`env`. `SECRETS_BACKEND=envfile` would otherwise start a service that quietly
ignores its secrets file.

## Precedence

1. A variable already present and non-empty in the ambient environment
2. `<NAME>_FILE`, read from disk
3. The backend's own values (the env-file)

Ambient wins so `docker run -e ORACLE_API_KEY=…` and a CI job's secret store
override a checked-out file rather than being silently ignored. The load
reports which names were overridden, so "the file was read and deliberately not
used" is distinguishable from "the file was never read".

Setting both `<NAME>` and `<NAME>_FILE` is an error rather than a precedence
rule. It always means someone believes the wrong one is in effect.

## `<NAME>_FILE` indirection

Works under **every** backend, including the default `env`:

```bash
POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password
ORACLE_API_KEY_FILE=/run/secrets/oracle_api_key
RESOLVER_KEY_FILE=/run/secrets/resolver_key
```

The file's contents become the value, with one trailing newline stripped —
`echo secret > file` appends one, and a password with `\n` on the end fails
authentication in a way that is very hard to see in a log.

A pointer at a path that does not exist is a startup error. An explicit pointer
is never an opt-out.

This is the Docker and Kubernetes secret convention, which is why it is the
supported path to a managed store today: Docker secrets, a Kubernetes secret
mounted as a volume, the Vault Agent Injector, and the Secrets Store CSI driver
all present secrets as files.

## Local development

Nothing to configure. The default backend is `env`, so a service run with
`npm run dev` after `cp .env.example .env` behaves exactly as it did before —
`make env` creates all four files at once.

To have a service read a dotenv file itself rather than relying on your shell:

```bash
SECRETS_BACKEND=env-file SECRETS_ENV_FILE=.env npm run dev
```

## Compose stack

Keep `SECRETS_BACKEND=env`. Compose already interpolates `infra/.env` and hands
each service only the variables it reads, which is what keeps `RESOLVER_KEY`
out of the API container and out of the read-only monitor — see the least
privilege table in
[infra/README.md](../infra/README.md#configuration-and-secrets). Pointing every
service at the same env-file would undo that.

To move a single secret out of `infra/.env` and onto a mounted file, replace it
with its `_FILE` form for the one service that needs it:

```yaml
  oracle-aggregator:
    environment:
      RESOLVER_KEY_FILE: /run/secrets/resolver_key
    secrets:
      - resolver_key
```

## Vault and other managed stores

`SECRETS_BACKEND=vault` is wired end to end — recognised by the config parser,
constructed by the factory, covered by tests — but `load()` throws
`SecretsBackendNotImplementedError` rather than returning nothing. A secrets
backend that silently supplies zero values is indistinguishable from a working
one right up until a service starts with a default password, so it fails at
boot with a message naming the supported alternative.

Implementing it is one file: fetch `VAULT_SECRET_PATH` from `VAULT_ADDR` and
return the flat map. Precedence, `_FILE` indirection, redaction, the load
report, and all four entrypoints already work against the `SecretsBackend`
interface and need no edit. The recognised variables are reserved now so the
names do not change later: `VAULT_ADDR`, `VAULT_NAMESPACE`, `VAULT_TOKEN`,
`VAULT_TOKEN_FILE`, `VAULT_ROLE`, `VAULT_SECRET_PATH`.

Until then, the `_FILE` path covers Vault, AWS Secrets Manager, and SOPS
equally well — have the agent write the value to a path and point at it.

## Logging

`loadSecrets()` returns variable **names** only. Each entrypoint logs the
counts:

```
[ipredict-oracle] secrets: backend=env-file source=env-file:/srv/ipredict/.env applied=23 overridden=2 from_files=1
```

`describeSecrets()` redacts anything whose name matches `SECRET`, `PASSWORD`,
`TOKEN`, `KEY`, `CREDENTIAL`, `PRIVATE`, `SEED`, `AUTH`, `DSN`, or ends in
`_URL` — `DATABASE_URL` and `REDIS_URL` carry passwords inline. Non-secret
values pass through, which is what makes the output worth logging at all.

## Checking a checkout

```bash
make secrets-check
```

Fails if any `.env` file is tracked by git, and lists the untracked ones with
their permissions. `chmod 600` anything holding a signing key.

## Reference

| Variable | Default | Meaning |
|---|---|---|
| `SECRETS_BACKEND` | `env` | `env`, `env-file`, or `vault` |
| `SECRETS_ENV_FILE` | `.env` | Path read when the backend is `env-file` |
| `SECRETS_ENV_FILE_REQUIRED` | `false` | Treat a missing env-file as a startup error |
| `<NAME>_FILE` | — | Read `<NAME>` from this path. Works under every backend |

### Supported dotenv syntax

```sh
# a comment
NAME=value
export NAME=value          # `export` prefix is tolerated
NAME=                      # empty — "declared but not configured"
NAME="quoted value"        # \n \r \t \\ \" are unescaped
NAME='raw $value'          # single quotes are literal
NAME=value  # trailing     # stripped only outside quotes
```

Multi-line values and `${VAR}` interpolation are deliberately unsupported.
Compose does its own interpolation before a process starts, and a second,
subtly different implementation here would be a source of "works in compose,
not on the host" bugs. A malformed line is a startup error naming the line
number — never the line, which may be the secret.
