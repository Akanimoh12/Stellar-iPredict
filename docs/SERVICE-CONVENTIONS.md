# Service conventions: config, errors, logging, startup

The backend, oracle and indexer follow the same four conventions. They live in
`@ipredict/shared` (`shared/src/`) so each service uses one implementation.
Tracked in #630, #631, #632 and #633.

## 1. Configuration (`config.ts`)

- Each service declares its own zod schema and keeps its keys and defaults.
- Load it with `parseConfig(service, schema, env)`. It **throws** a `ConfigError`.
- Only the entrypoint exits, by calling `reportStartupFailure(service, error)`
  and then `process.exit(1)`.
- Output for every misconfiguration:

  ```
  [ipredict-indexer] invalid configuration:
    DATABASE_URL: DATABASE_URL must be a valid URL
    START_LEDGER: START_LEDGER is required
  ```

## 2. Errors (`errors.ts`)

Every classified error belongs to one of three categories:

| Class | Category | Retried? |
| --- | --- | --- |
| `TransientError` | transient: may succeed later | yes |
| `PermanentError` | permanent: retrying cannot change the outcome | no |
| `ProgrammingError` | a bug or broken invariant | never |

- Retry logic decides from the type (`classifyFailure` in `retry.ts`), not from
  message text.
- A bare `ReferenceError`, `SyntaxError` or a `TypeError` with no `cause` is
  treated as a programming error. A `TypeError` that carries a `cause` (Node's
  `fetch` network failure) is not.
- The backend's `HttpError` keeps its status and code. HTTP mapping is unchanged.

## 3. Logging (`log.ts`)

Every line uses the same field names (see `LOG_FIELDS`):

| Field | Meaning |
| --- | --- |
| `timestamp` | ISO 8601, UTC |
| `level` | `debug`, `info`, `warn` or `error` (string) |
| `message` | event name |
| `service` | bound per process: `backend`, `oracle-aggregator`, `indexer`, ... |
| `requestId` | HTTP request id (backend) |
| `correlationId` | one id per oracle market attempt (#467) |
| `error` | thrown value, serialised with name, message and stack |

The backend's Fastify (pino) logger maps its output to these names. Before
this change it wrote `msg`, `time`, numeric `level`, `reqId` and `err`. Any
external dashboard or alert that reads those names needs updating.

## 4. Startup (`startup.ts` in the backend)

Initialisation is explicit and ordered. Importing a module has no side effect:
no listeners, no connections, no `process.exit`. The backend's import audit
(`src/import-side-effects.test.ts`) enforces this for every source module.

Backend order: **secrets → config → database driver → server**. The indexer and
oracle follow the same pattern: `loadSecrets()`, then `initConfig()` or
`loadAggregatorConfig()`, then the work.

Startup failures are thrown, reported once at the entrypoint, and exit with 1.
