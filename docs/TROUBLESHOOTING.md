# Local development troubleshooting

Find the error text you see below, then follow its fix. Each entry gives the cause, the fix, and the commands that confirm it. If your message is not here, run `make ps` and `make logs` and check the first error line, not the last.

Start with the quickstart in [QUICKSTART.md](./QUICKSTART.md) if you have not finished it.

## Quick diagnostics

Run these first. They show whether the containers are up and what each service sees.

```bash
make ps                      # container status
make logs SERVICE=postgres   # Postgres log
make logs SERVICE=redis      # Redis log
make wait                    # exits 0 only when Postgres accepts connections
```

## `DATABASE_URL is required`

**Where you see it:** the backend or indexer exits right after `npm run dev`, before it listens on any port. The message comes from `backend/src/config/index.ts`.

**Cause:** the service reads `DATABASE_URL` from its `.env` at startup, and the variable is missing or empty. `make env` copies the example, but the example leaves the value blank.

**Fix:** set the value in the service's `.env`:

```bash
DATABASE_URL=postgres://ipredict:ipredict@localhost:5432/ipredict
```

Use the credentials from `infra/docker-compose.dev.yml` if they differ.

**Confirm:**

```bash
grep -E '^DATABASE_URL=.+' backend/.env
```

A printed line means the value is set.

## `ECONNREFUSED 127.0.0.1:5432`

**Where you see it:** the backend or indexer logs a connection error to Postgres on port `5432`.

**Cause:** Postgres is not running, or it is on a different port than the one in `DATABASE_URL`.

**Fix:** start the containers and wait for Postgres:

```bash
make up
make wait
```

If `make ps` shows the `postgres` container is not running, check its log with `make logs SERVICE=postgres`.

**Confirm:** `make wait` prints `ready`.

## `ECONNREFUSED 127.0.0.1:6379`

**Where you see it:** the backend logs a connection error to Redis on port `6379`.

**Cause:** Redis is not running. The backend uses Redis for its cache and rate limiting.

**Fix:** `make up` starts Redis with Postgres. If Redis still refuses connections, check `make logs SERVICE=redis`. Another process on port `6379` can also block it; see [Port already in use](#eaddrinuse-port-already-in-use).

**Confirm:**

```bash
docker compose -f infra/docker-compose.dev.yml exec -T redis redis-cli ping
```

Expected output: `PONG`.

## Postgres did not become ready

**Where you see it:** `make wait` or `make up` prints `Postgres did not become ready in 60s`.

**Cause:** the container failed to start. Usual causes are a port conflict on `5432`, or a volume left behind by an older Postgres version.

**Fix:** read the Postgres log:

```bash
make logs SERVICE=postgres
```

If the log mentions a version mismatch or corrupt data, and the database holds nothing you need, reset it:

```bash
make db-reset
```

`make db-reset` deletes the database volume. Do not run it against data you want to keep.

**Confirm:** `make wait` prints `ready`.

## `EADDRINUSE: address already in use`

**Where you see it:** a dev server exits at startup with `EADDRINUSE` and a port number.

**Cause:** another process already listens on that port. The defaults are `4000` for the backend (set by `PORT`), `3000` for the frontend, and `5432` and `6379` for the containers.

**Fix:** find the process and stop it, or change the port in that service's `.env`.

macOS and Linux:

```bash
lsof -i :4000
```

Windows (PowerShell):

```powershell
netstat -ano | findstr :4000
```

**Confirm:** the port now has no listener, and the service starts.

## A migration fails

**Where you see it:** `make migrate` exits non-zero and prints an SQL error that names a file in `db/migrations`.

**Cause:** the failing file does not apply cleanly to the current schema. Migrations are forward-only, so a half-applied file can leave the database in a state the next run will not fix by itself.

**Fix:**

1. Read the first error line, and note the migration file and the statement.
2. Check which migrations ran:

   ```bash
   make db-shell
   ```

   then at the `psql` prompt run `SELECT name FROM schema_migrations ORDER BY name;`. Type `\q` to leave.

3. If your local database holds no data you need, rebuild it from scratch:

   ```bash
   make db-reset
   ```

Do not edit an applied migration file to make the error go away. Add a new migration instead. See the compatibility rules in [CONTRIBUTING.md](../CONTRIBUTING.md).

**Confirm:** `make migrate` exits 0 and `make db-shell` lists the expected tables.

## `npm install` fails on a native module

**Where you see it:** `make install` stops with a build error for a package such as `sharp`, `bcrypt` or a `node-gyp` dependency, or with `gyp ERR!`.

**Cause:** native modules need build tools, and the Node version may not match the prebuilt binaries.

**Fix:**

1. Use Node 22 or newer: `node --version`.
2. Install the build tools for your OS. On macOS, `xcode-select --install`. On Debian or Ubuntu, `sudo apt install build-essential python3`. On Windows, the "Desktop development with C++" workload from Visual Studio Build Tools.
3. Remove partial installs and try again:

   ```bash
   rm -rf node_modules
   make install
   ```

**Confirm:** `make install` exits 0.

## `Cannot find module` at startup

**Where you see it:** a service exits with `Cannot find module '…'` or `Cannot find package`.

**Cause:** dependencies were not installed for that workspace, or an older install is out of date after a pull.

**Fix:** run `make install` from the repo root, then restart the service.

**Confirm:** the module path resolves: `ls node_modules | head`.

## Frontend shows no markets

**Where you see it:** the page loads, but the market list is empty.

**Cause:** the database has no seeded rows, or the frontend is calling a backend URL that is not running.

**Fix:**

```bash
make seed
curl -s http://localhost:4000/healthz
```

Then check `frontend/.env.local` for the backend URL it uses.

**Confirm:** `make db-shell` and `SELECT count(*) FROM markets;` returns a number above zero, and the health check responds.

## Indexer keeps retrying the RPC

**Where you see it:** the indexer log repeats a network error about the Stellar RPC.

**Cause:** the RPC URL in `indexer/.env` is wrong, or the network is blocking the request.

**Fix:** check `SOROBAN_RPC_URL` in `indexer/.env` and try the URL with `curl -I <url>`. The indexer keeps its checkpoint in the database, so a restart resumes where it stopped.

**Confirm:** the log shows successful ledger reads after a restart.

## Tests fail only on your machine

**Where you see it:** `make test` passes in CI but fails locally with a database or timing error.

**Cause:** usually a stale database, a `.env` that differs from the example, or Postgres not being ready when the suite starts.

**Fix:**

```bash
make wait
make db-reset
make test
```

**Confirm:** `make test` passes.

## Still stuck

Collect this before you ask for help:

```bash
make ps
make logs > logs.txt
node --version
docker compose version
```

Share the first error line from the failing service, not the whole log. Do not paste `.env` files, since they hold secrets. Run `make secrets-check` to confirm none of them is tracked by git.
