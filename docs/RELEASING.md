# Releasing and Versioning

How iPredict is versioned, how a release is cut, and how API changes are
versioned and announced. It covers the whole repository: the Node packages, the
HTTP API, the Soroban contracts and the database schema.

- [What is versioned](#what-is-versioned)
- [Versioning scheme](#versioning-scheme)
- [API versioning and breaking changes](#api-versioning-and-breaking-changes)
- [Changelog](#changelog)
- [Release process](#release-process)
- [Hotfixes](#hotfixes)
- [Rolling back](#rolling-back)
- [Release record](#release-record)

> **Status.** No release has been tagged yet. Every package and contract crate
> declares `0.1.0`, which is the unreleased baseline. The first tagged release
> will be cut from `implementation-drips` using this process.

---

## What is versioned

A release is one platform version. Several independent version numbers sit
underneath it, and they move for different reasons:

| Surface | Where the version lives | Moves when |
|---|---|---|
| **Platform release** | Git tag `vX.Y.Z`, the `version` of the root `package.json` | Every release |
| **Node packages** (`backend`, `db`, `indexer`, `oracle`, `shared`, `frontend`) | `version` in each `package.json` | Every release, in lockstep with the platform version |
| **HTTP API** | URL major version, `/api/v1` (`API_PREFIX` in `backend/src/api/index.ts`) | An incompatible API change only |
| **OpenAPI document** | `info.version` (defaults to `0.1.0` in `backend/src/api/openapi.ts`) | The API description changes |
| **Contract build** | `version` in `contracts/<name>/Cargo.toml`; `prediction_market` also reports it on-chain through `version()` | That contract's code changes |
| **Contract storage layout** | `SCHEMA_VERSION` in `contracts/prediction_market/src/lib.rs`, returned by `schema_version()` | The on-chain storage layout changes |
| **Database schema** | Numbered files in `db/migrations`, recorded in `schema_migrations` | A migration is added |

The Node packages are private and ship together as one deployment, so they share
the platform version instead of drifting. Contract crates are deployed one at a
time and can go unchanged across many releases, so they are versioned
independently and bumped only when their own code changes.

## Versioning scheme

The platform follows [Semantic Versioning 2.0.0](https://semver.org). While the
major version is `0`, a **MINOR** bump may carry breaking changes, and the
changelog must say so.

| Bump | Use it for | Examples |
|---|---|---|
| **MAJOR** (`1.0.0`, `2.0.0`) | A new API major version is mounted, a contract change requires a fresh deployment instead of an in-place upgrade, or a deprecated surface is retired after its sunset date | Adding `/api/v2`; retiring `/api/v1` |
| **MINOR** (`0.2.0`, `1.1.0`) | Backward-compatible features | A new endpoint or optional field; an additive migration; a contract upgrade that keeps the storage layout |
| **PATCH** (`0.1.1`) | Backward-compatible fixes | A bug fix; a dependency security update; a documentation-only release |

Rules that go with it:

- **0.x:** until `1.0.0`, use MINOR for anything that would be MAJOR after 1.0
  and flag it in the changelog as **BREAKING**.
- **Pre-releases:** release candidates are tagged `vX.Y.Z-rc.N` and are never
  deployed to production.
- **Tags are immutable.** A wrong tag is fixed by a new patch version, never by
  moving the tag.
- **Contract crate versions** use the same MAJOR/MINOR/PATCH meaning. A change
  to the storage layout also bumps `SCHEMA_VERSION` and adds a step to
  `migrate` (see [Contracts](#contracts)).

## API versioning and breaking changes

The full client-facing policy is in [`docs/API.md`](API.md#versioning). This is
the maintainer side of it, built on the mechanism already in
`backend/src/api/index.ts`: every feature router is mounted under one versioned
prefix (`API_PREFIX = /api/${API_VERSION}`), and route files declare paths
relative to that prefix.

### What counts as breaking

Breaking, so a new major version is required:

- removing or renaming an endpoint or a response field;
- changing a field's type or meaning, or the status code or error shape of an
  existing response;
- making an optional input required, or tightening validation of an input that
  was previously accepted;
- changing authentication requirements for an existing route.

Not breaking, so it stays in the current version:

- adding an endpoint, an optional request field or a response field. Clients
  must ignore response fields they do not know;
- adding a new enum value only where the API reference already tells clients to
  tolerate unknown values;
- performance, caching and rate-limit tuning that keeps documented behaviour.

When in doubt, treat the change as breaking.

### Shipping a breaking change

Today `registerApiRoutes` mounts a single version. The pull request that
introduces the first breaking change therefore does the following:

1. **Add a mount beside `v1`; do not edit it.** Extend `registerApiRoutes` so
   `v1` and `v2` are both registered, each from its own list of routers, with
   `v2` routes declared relative to `/api/v2` like the existing files. Leave
   every `v1` route file and response unchanged. Existing versioned paths are
   never silently redirected.
2. **Update the OpenAPI document** and the reference: run
   `npm run test:openapi:update --workspace=backend` and
   `npm run docs:api --workspace=backend`. CI fails on drift via
   `npm run docs:api:check` in `backend/`.
3. **Announce in the same PR.** Add a changelog entry marked **BREAKING** under
   *Added* (the new version) and *Deprecated* (the old one), with migration
   notes. Update [`docs/API.md`](API.md).
4. **Start the deprecation clock** once `v2` is available: `v1` responses carry
   the `Deprecation` and `Sunset` headers and a `Link` header to the successor,
   with the retirement date published in the API reference and the OpenAPI
   document. At least **six months** pass between `v2` being available and `v1`
   being retired, except where a security, legal or data-integrity issue forces
   a shorter period; then notice goes out as early as practical.
5. **Retire** `v1` only after the sunset date, in a MAJOR platform release whose
   changelog lists the removal under *Removed*.

The `/api/markets*`, leaderboard and stats routes are still served at unversioned
paths. They are not part of `/api/v1`, and moving or retiring them follows the
same steps above.

## Changelog

[`CHANGELOG.md`](../CHANGELOG.md) at the repository root is the record of what
changed between releases. It follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

**Who maintains it**

- The **author of a pull request** adds an entry under `## [Unreleased]` for any
  change a user, operator or integrator would notice. Pure refactors, test-only
  changes and CI tweaks do not need one.
- The **release manager** reviews and tidies the entries when cutting a release,
  and moves them under the new version heading.

**Format**

- One bullet per change, written for the reader rather than the diff, ending
  with the issue or PR number, for example `(#848)`.
- Group under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Start a bullet with **BREAKING** when it breaks compatibility, and say what
  to do about it.
- Prefix a bullet with the area when it is not obvious: `API:`, `Contracts:`,
  `DB:`, `Oracle:`, `Frontend:`.
- Contract changes always state the contract, its new build version and whether
  `SCHEMA_VERSION` changed. Migrations name the migration file.
- Each released section is headed `## [X.Y.Z] - YYYY-MM-DD`, newest first, and
  has a comparison link at the bottom of the file.

An entry is not required for security fixes that must stay private until
disclosed; add it when the advisory is published (see
[`SECURITY.md`](../SECURITY.md)).

## Release process

Releases are cut from `implementation-drips`, the branch all work lands on (see
[`CONTRIBUTING.md`](../CONTRIBUTING.md)). One person acts as **release manager**
for the release and is responsible for the checklist below.

### 1. Decide the version

Review what has merged since the previous tag:

```bash
git log --oneline vPREVIOUS..implementation-drips
```

Pick MAJOR, MINOR or PATCH from [the scheme](#versioning-scheme). If this is the
first release, there is no previous tag; review the full history and use
`v0.1.0`.

### 2. Open the release PR

Branch off `implementation-drips` as `chore/release-vX.Y.Z` and make these
changes in one pull request, based on `implementation-drips`:

- **Platform and package versions.** Set `version` to `X.Y.Z` in the root
  `package.json` and in `backend`, `db`, `indexer`, `oracle`, `shared` and
  `frontend`. Refresh the lockfile with `npm install --package-lock-only`.
- **Contracts, only if their code changed.** Bump `version` in the affected
  `contracts/<name>/Cargo.toml`, run `cargo check --workspace` so `Cargo.lock`
  follows, and see [Contracts](#contracts).
- **OpenAPI.** If the API description changed, bump `info.version` and
  regenerate as in [Shipping a breaking change](#shipping-a-breaking-change).
- **Changelog.** Turn `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`, add a
  fresh empty `## [Unreleased]` above it and update the comparison links.

### 3. Verify

All of these must pass before the release PR merges:

- CI is green on the release PR: secret scan, frontend, contracts, backend and
  the Node service jobs.
- `./scripts/verify-all.sh`, plus `npm run lint` and `npm run build` from the
  repository root and `npm run docs:api:check --workspace=backend`.
- For contract changes: `cargo test --workspace`, `cargo fmt --check --workspace`
  and the WASM size check that CI runs.
- A **staging deployment** of the release candidate: push the commit to
  `staging` or `develop`, or run the *Staging Deployment & Production Gate*
  workflow by hand with `run_smoke_tests` enabled (and `deploy_contracts` when a
  contract changed).
- The post-deployment smoke suite exits 0 (`npm run smoke`, or
  `make smoke BASE_URL=…`).
- If the release contains a migration, the
  [staging rollback drill](DEPLOYMENT-GUIDE.md#staging-rollback-drill) has been
  run and recorded. A failed drill blocks the release.

### 4. Merge, tag and publish

After the release PR merges, tag the merge commit and publish the release notes
taken from the changelog:

```bash
git checkout implementation-drips && git pull
git tag -a vX.Y.Z -m "iPredict vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <section-of-CHANGELOG.md>
```

Mark a `-rc` tag as a pre-release with `--prerelease`.

### 5. Deploy

- **Services.** Deploy with immutable image tags that map to the release tag,
  following [`BACKEND_DEPLOYMENT.md`](BACKEND_DEPLOYMENT.md) and
  [`DEPLOYMENT-GUIDE.md`](DEPLOYMENT-GUIDE.md). Never deploy `latest`.
- **Migrations.** Migrations are forward-only and follow the expand/contract
  rules in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md#database-migration-compatibility), so
  the previous release stays runnable against the new schema. A migration that
  contracts the schema ships in a later release than the one that expanded it.
- **Contracts.** See below.
- Run the post-deployment smoke suite against production and keep the deployment
  freeze until error rates have stayed normal for the agreed observation window.

#### Contracts

Contract deployments are immutable. A release that changes a contract does one
of two things:

- **In-place upgrade (preferred, MINOR/PATCH).** The admin calls `upgrade` with
  the new WASM hash, then calls `migrate` once. `migrate` cannot run inside
  `upgrade`, because the new code only executes on the next invocation. Layout
  changes add an `if from < N { … }` step to `migrate` and bump
  `SCHEMA_VERSION`. Follow
  [Contract Upgrade Procedure & Storage Compatibility Rules](DEPLOYMENT-GUIDE.md#contract-upgrade-procedure--storage-compatibility-rules).
- **Fresh deployment (MAJOR).** Used only when storage cannot be migrated in
  place. It changes the contract ID, so it needs a forward-compatible
  application release and a data plan, and is called out as **BREAKING**.

After either, confirm on-chain that `schema_version()` returns the expected
layout version and, for `prediction_market`, that `version()` returns the new
build version, and record both.

### 6. After the release

- Confirm the smoke suite and dashboards are healthy.
- Announce the release with a link to the GitHub release and, for a breaking
  change, to its migration notes.
- Complete the [release record](#release-record).

## Hotfixes

A fix that cannot wait for the next planned release:

1. Branch from the **tag** being fixed: `git checkout -b hotfix/<short-name> vX.Y.Z`.
2. Make the smallest fix, add a changelog entry and a regression test.
3. Open a PR for the fix against `implementation-drips` so it is not lost, and
   cut the release from the same commit.
4. Bump PATCH, then follow steps 3 to 6 above. The staging deployment and smoke
   suite are never skipped, even under time pressure.

## Rolling back

Roll back code, not schema. The procedure, including what to do when a migration
is not backward compatible, is
[Rollback procedure](DEPLOYMENT-GUIDE.md#rollback-procedure). Rolling forward
with a hotfix is usually safer than rolling back across a contract upgrade, and
a rollback never deletes `schema_migrations` rows or reverses a contract
upgrade.

## Release record

Keep one record per release, linked from the GitHub release, with:

| Field | Value |
|---|---|
| Version and tag | `vX.Y.Z` |
| Release manager | |
| Date (UTC) | |
| Image tags deployed | |
| Schema version (latest migration applied) | |
| Contracts changed, with `version()` (where exposed) and `schema_version()` after the release | |
| Breaking changes and migration notes | |
| Staging deployment and smoke result | |
| Staging rollback drill (if a migration shipped) | |
| Production smoke result and observation window | |
| Follow-ups | |
