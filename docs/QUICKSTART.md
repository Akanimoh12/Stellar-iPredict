# Quickstart: clone to a running system

This gets you from a fresh clone to a running stack: Postgres and Redis in Docker, the database migrated and seeded, and the backend, indexer and frontend on your host. Each stage ends with a check. Run the check before moving on, because a stage that fails silently is what strands people later.

For the reasoning behind each step and the other targets, see [LOCAL_DEV.md](./LOCAL_DEV.md). When something fails, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Before you start

You need:

| Tool | Version | Check |
|---|---|---|
| Node.js | 22 or newer | `node --version` |
| npm | comes with Node | `npm --version` |
| Docker with Compose | recent | `docker compose version` |
| make | any | `make --version` |

Rust is only needed if you rebuild the contracts. You do not need it for this quickstart.

Check that Docker is running before you continue:

```bash
docker info > /dev/null && echo "docker ok"
```

Expected output: `docker ok`. If you see a connection error, start Docker Desktop or the Docker daemon first.

## 1. Clone

```bash
git clone https://github.com/Akanimoh12/Stellar-iPredict.git
cd Stellar-iPredict
git checkout implementation-drips
```

The backend work lives on `implementation-drips`, not `main`.

**Check:** `git branch --show-current` prints `implementation-drips`.

## 2. Install dependencies

```bash
make install
```

This installs the workspace packages, the `db` package and the frontend.

**Check:** the command exits with status 0, and `ls node_modules` lists packages. If it fails on a native module, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#npm-install-fails-on-a-native-module).

## 3. Create the local environment files

```bash
make env
```

This copies each `.env.example` to its `.env` (or `.env.local` for the frontend), and leaves existing files alone.

**Check:** the output lists `created` or `exists` for `backend/.env`, `indexer/.env`, `oracle/.env` and `frontend/.env.local`.

Open `backend/.env` and make sure `DATABASE_URL` and `REDIS_URL` point at the local containers. The defaults in the example match the dev compose file. The backend refuses to start without `DATABASE_URL`.

**Check:** `grep -E '^DATABASE_URL=.+' backend/.env` prints a line. An empty value here causes the startup error described in [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#database_url-is-required).

## 4. Start Postgres and Redis

```bash
make up
```

This starts both containers and waits until Postgres accepts connections.

**Check:** run `make ps` and confirm `postgres` and `redis` both show `running` or `healthy`. Then confirm Postgres answers:

```bash
make wait
```

Expected output: `ready`. If it times out after 60 seconds, run `make logs SERVICE=postgres` and see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#postgres-did-not-become-ready).

## 5. Apply migrations

```bash
make migrate
```

This applies every file in `db/migrations` that has not run yet.

**Check:** the command exits with status 0. To confirm the schema exists:

```bash
make db-shell
```

then, at the `psql` prompt, run `\dt` and check that the `markets` and `bets` tables are listed. Type `\q` to leave.

If a migration fails, do not re-run `make migrate` in a loop. Read the first error line, then see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#a-migration-fails).

## 6. Load seed data

```bash
make seed
```

This loads sample markets, bets and leaderboard rows so the frontend has something to show.

**Check:** the output reports the number of rows inserted, and running `make db-shell` followed by `SELECT count(*) FROM markets;` returns a number greater than zero.

## 7. Start the services

Open one terminal per service and leave each running.

```bash
make dev-backend
```

```bash
make dev-indexer
```

```bash
make dev-frontend
```

The oracle is optional for the first run. Start it with `make dev-oracle` only if you are working on oracle features.

**Check the backend.** The API listens on the port in `PORT` (default `4000`):

```bash
curl -s http://localhost:4000/healthz
```

Expected: a JSON response with a healthy status, and no connection error. If you get `Connection refused`, the backend is not running. Check its terminal for the first error.

**Check the indexer.** Its terminal should show a line about connecting to the RPC and starting from a ledger. It should not repeat the same error more than a few times.

**Check the frontend.** Open `http://localhost:3000` in a browser. The market list should show the seeded markets.

## 8. Run the test suites

```bash
make test
```

**Check:** every suite finishes with a passing summary. A failing suite lists the test name and the file. If a test fails only on your machine, compare your `.env` files with the examples.

## Verified state

When every check above passes, you have:

- Postgres and Redis running in Docker
- the migrated and seeded database
- the backend answering on `/healthz`
- the indexer connected to the RPC
- the frontend showing the seeded markets

If you stop here and come back later, run `make up` and then the three `make dev-*` targets again. `make down` stops the containers and keeps their volumes. `make db-reset` destroys the database volume and rebuilds it from migrations and seed data.
