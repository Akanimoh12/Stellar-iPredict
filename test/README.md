# Test strategy

Place focused unit tests beside the behavior they cover when the source package
already uses colocated tests. Put root-level cross-package and smoke checks in
this directory, backend helper and integration tests in `backend/test/`, and
indexer integration coverage in `indexer/src/__tests__/integration/`.

| Suite | Location | External services | Run |
| --- | --- | --- | --- |
| Root smoke and cross-package checks | `test/` | Some tests may use the configured RPC endpoint; inspect the test name before running | `npm test` |
| Backend tests | `backend/test/` | Postgres and Redis when a test imports database or cache helpers | `cd backend; npm test` |
| Indexer integration tests | `indexer/src/__tests__/integration/` | Postgres, Redis, and indexed contract fixtures | `cd indexer; npm test` |
| Oracle tests | `oracle/test/` and `oracle/src/**/*.test.ts` | Network access only when explicitly marked as integration/E2E | `cd oracle; npm test` |

Name tests `*.test.ts` or `*.test.tsx`. Keep unit tests deterministic and mock
network clients; tests requiring Postgres, Redis, a local Soroban sandbox, or a
network must state that dependency in the test description or adjacent setup.
Run `./scripts/verify-all.sh` before opening a broad backend, indexer, or oracle
change; it reports the service checks that require the local dependencies.
