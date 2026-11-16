# Pinned offline secret scan with exact synthetic-fixture review — 2026-11-16

**Status:** scoped engineering gate under exact-head CI, not publication or full independent security clearance.

## Gap and scope

GitHub native secret scanning is disabled on this public repository (issue #169). An independent local review using **Gitleaks v8.30.1**, pinned to its official published release checksum, scanned the current checkout at `main@d376f60aa9d9f7bb37f45fa69652a380beedb2cf`. It identified **21 rule matches across 7 files**, all in test fixtures, the synthetic upgrade qualification, and API/regions documentation. They consisted of 10 documentation example `curl-auth-header` matches, 10 `generic-api-key` test/fixture matches, and one `private-key` match that is the runtime-generation **source code** for an ephemeral APNs test key (not a committed private key).

A scanner that simply excludes all `*.test.ts` and docs would leave dangerous blind spots. A source-gate that blocks all 21 currently reviewed synthetic matches would make CI unusable. The middle ground implemented here is **exact-line approval**, without storing or printing token strings.

## Implementation

- Extend the existing `Montral source integrity` workflow; do not create another workflow or job. Download the public MIT-licensed `gitleaks_8.30.1_linux_x64.tar.gz` asset from the official release and **verify its exact SHA-256** `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` before execution.
- Run **Gitleaks locally on the checkout** with redaction, no verbose output, and a 120-second scan timeout; no source payload is uploaded to a remote secret-scanning service.
- `scripts/secret-scan-synthetic-fixtures.json` contains **20 reviewed (file, line, rule, SHA-256 of source line, count, reason) records** representing the 21 matches. It contains **no secret value, matched text, complete fixture source, or raw report**. Every change to a reviewed source line invalidates its approval. Unreviewed matches on other lines, paths or rules also block.
- `scripts/verify-secret-scanner.mjs` uses a private temporary report file in the host temp directory, reads and compares only finding metadata to the reviewed source hashes, and deletes the temporary report in a `finally` block. Logs include only file/line/rule and counts; **no secret values or snippets**. Malformed reports, missing source lines, unexpected scanner status, stale approvals, absent scanner or timeouts fail closed.
- `scripts/verify-secret-scanner.test.mjs` adds dependency-free decision tests. The same Node version used in CI for the dependency advisory gate (24.22.1) runs them.

## Verified locally (Windows, read-only evidence)

- Official Gitleaks v8.30.1 Windows x64 release SHA-256 matched the vendor release manifest; the Linux x64 archive and SHA-256 were independently verified, and the tarball contains the expected `gitleaks` binary.
- Exact source snapshot scan: **21 matches, 21 exact reviewed fixtures, 0 unreviewed, 0 stale**, exit 0.
- `node --test scripts/verify-secret-scanner.test.mjs`: **12/12 PASS** including changed-line hashes, extra match on the same line, stale approvals, changed rule/path, malformed input and duplicate approvals. Script syntax and whitespace checks pass.
- **Adversarial live test:** appended a non-secret marker to the reviewed synthetic `PAGE_PASSWORD` assignment in a temporary isolated worktree. The scanner immediately reported **20 reviewed / 1 unreviewed / 1 stale, exit 1**. Restored the **exact original bytes**, reran the scanner and got **21 reviewed / 0 unreviewed / 0 stale, exit 0**; git status confirmed the fixture had no changes.
- Initial exploratory Gitleaks reports were deleted after processing. No real credentials were printed, copied to the approval file or committed.

## Limits and release gates

This scans the **current checkout directory**, not all prior Git history, private infrastructure, hosted vaults, GitHub secret scanning alerts, mobile binaries or deployed runtime. Its finding quality is limited to **Gitleaks v8.30.1 default rules**; hashed approved test lines must receive review if changed. SHA-256 and pinned binary download reduce but cannot remove supply-chain risks. GitHub native scanning and an independent external security assessment remain outstanding under issue #169.

**Merge requires 16/16 exact-head checks** on this new PR, then **11/11 exact integrated-main push workflows**; historical successes do not qualify a later SHA. The Community release remains **HOLD until explicit owner `GREEN LIGHT MONTRAL`**; Cloud/BYOC stay **NO-GO** pending legal/privacy, security, provider and real-device gates. No deployment, merchant, payment or DNS action was performed.
