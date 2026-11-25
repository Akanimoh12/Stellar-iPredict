# Changelog

All notable changes to iPredict are recorded here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org). How versions are chosen, how a
release is cut and how this file is maintained are described in
[`docs/RELEASING.md`](docs/RELEASING.md).

Add an entry under **Unreleased** in the pull request that makes the change. The
release manager moves the entries under the new version heading when the release
is cut.

No release has been tagged yet. Every package and contract crate declares
`0.1.0`, the unreleased baseline; history before the first tag is in `git log`.

## [Unreleased]

### Added

- Frontend: the betting panel holds the bet button, the MAX button and the
  confirm-and-sign step while the wallet balance is loading or being refreshed
  after a bet, and says "Loading balance…" instead of showing a stale figure.
  (#848)
- Frontend: the betting panel knows the contract's per-user limits (1 XLM
  minimum bet, 20 bets per market) and reads how many bets the user has placed
  through the new `getUserBetCount` service call. Once the limit is reached the
  panel stops offering a bet and says why. (#849)
- Frontend: the confirm-your-bet step warns a first-time bettor that the
  contract allows one side per market, and a user who already holds a side sees
  why the opposite side is locked. (#850)
- Docs: [`docs/RELEASING.md`](docs/RELEASING.md) describes the versioning
  scheme, the release process, hotfixes, the API breaking-change policy and the
  release record; this changelog is introduced. (#628)
- Docs: the README has an architecture diagram showing the contracts, indexer,
  backend, oracle and frontend and how data moves between them. (#978)
- Docs: [`docs/CONTRACTS.md`](docs/CONTRACTS.md) holds the contract function
  reference, inter-contract call flow and reward and fee model, and
  [`docs/USER_VALIDATION.md`](docs/USER_VALIDATION.md) the pre-launch testnet
  validation record, both moved out of the README. (#979)
- Releases: `scripts/release-notes.sh` (also `make release-notes`) prints a
  version's changelog section for the GitHub release notes and fails when it is
  empty. `CONTRIBUTING.md` explains when and how to add changelog entries, and a
  pull request template asks for one. (#980)

### Changed

- Docs: the README is shortened to an overview, a quickstart and an index of
  the detailed docs. Stale hard-coded test counts are removed. (#979)
- Status page: `status-page/snapshot.json` is generated at deploy time by
  `scripts/generate-status-snapshot.sh` and is no longer committed, so the
  5-minute workflow no longer pushes commits and needs only read access to the
  repository. When `/status` is unreachable the deploy carries forward the
  snapshot the live page is serving; set the `STATUS_PAGE_URL` Actions variable
  to enable this. (#976)
- Frontend: MAX now sets the whole-XLM spendable balance only when that covers
  the minimum bet and the per-market bet limit has not been reached; otherwise
  it is disabled, with a hint when the balance is too low. (#849)
