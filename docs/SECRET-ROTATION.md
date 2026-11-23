# Secret rotation after a commit

Treat every secret detected in Git history as exposed, even when the commit was
private, short-lived, or removed by a force push. Do not wait for a scan or a
provider alert before rotating it.

## Immediate containment

1. Stop using the exposed credential. Revoke or disable it at its provider;
   for a Stellar secret key, move any funds and update the account's signer or
   resolver configuration before disabling the old key.
2. Generate a replacement in the approved secret manager. Do not paste it into
   an issue, pull request, chat, terminal history, or `.env.example`.
3. Update only the affected deployment secret or mounted `<NAME>_FILE`, then
   restart the service that consumes it. The service mapping is in
   [`infra/README.md`](../infra/README.md#configuration-and-secrets).
4. Verify the replacement with the least-privileged health or provider check,
   and inspect service logs to confirm that no secret value was logged.

## Repository remediation

1. Open an incident record with the time, credential type, affected service,
   revocation time, replacement time, and verification result. Do **not** put
   the secret or its complete value in that record.
2. Remove the value from the working tree and add a regression-safe placeholder
   if documentation needs one. The CI secret scan must pass before merging.
3. Coordinate with maintainers before rewriting shared history. If policy
   requires it, use `git filter-repo` (or GitHub's documented sensitive-data
   removal procedure) to purge the value, force-push the rewritten protected
   branches, and invalidate clones and caches. History rewriting is secondary:
   it does not revoke a copied credential.
4. Search forks, releases, CI logs, artifacts, issue comments, and deployment
   configuration for additional copies. Request removal where possible and
   rotate any related credentials that were exposed together.
5. Record completion only after the old credential is disabled and the new
   deployment is healthy. Monitor the old credential's audit trail for use
   during the provider's available retention period.

## Prevention

CI runs Gitleaks for each change and on the scheduled workflow run with a full
Git checkout. The custom `stellar-secret-key` rule rejects the exact
`S`-prefixed 56-character Stellar secret-key format. Examples and test fixtures
are path-allowlisted, so they should use visibly non-secret placeholders rather
than production-like values.
