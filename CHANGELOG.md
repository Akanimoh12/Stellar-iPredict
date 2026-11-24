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

### Changed

- Frontend: MAX now sets the whole-XLM spendable balance only when that covers
  the minimum bet and the per-market bet limit has not been reached; otherwise
  it is disabled, with a hint when the balance is too low. (#849)
