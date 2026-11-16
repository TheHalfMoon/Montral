# Fail-closed positive-count advisory report validation — 2026-11-16

**Scope:** focused fix for issue #172 to the existing free, read-only `pnpm audit --prod --json` gate. No dependency, provider, production, deployment or payment changes.

## Finding reproduced on exact main

At `main@d376f60aa9d9f7bb37f45fa69652a380beedb2cf`, `summarizeAdvisoryReport` already refused the contradiction *zero reported vulnerabilities with nonempty advisory records*. It accepted the opposite contradiction: metadata with a positive `moderate` (or other severity) count and an **empty** `advisories: {}`, returned `blocked: false`, and could print `DEPENDENCY_AUDIT_GATE_PASS` for an incomplete report.

This was confirmed by calling the original function with one moderate vulnerability, no advisory records: `GAP_REPRODUCED accepted_total=1 blocked=false`. This was a **validation integrity weakness**, not evidence of a released application vulnerability or known false advisory from the real registry.

## Fix

- Capture the count of advisory records. Preserve the existing refusal of `total === 0` with nonempty records.
- **Also reject `total > 0` when the advisory-record collection is empty**. The existing caller prints `DEPENDENCY_AUDIT_UNVERIFIED` and exits 2, never silently passing the security gate.
- **Do not require the number of advisories to equal vulnerability/dependency count**. An advisory may affect several packages or dependency paths. Valid positive metadata with one record and multiple affected dependencies is accepted.
- No changes to vulnerability severity thresholds (high/critical block; moderate/low/info require triage), lockfile, package-manager commands, output redaction, network access or GitHub Actions workflow.

## Verification

- Before the patch: reproducible acceptance of positive metadata + `advisories: {}`.
- After the patch: the same input is refused with **`pnpm audit metadata reports issues but includes no advisory records`**.
- `node --test scripts/verify-dependency-advisories.test.mjs`: **13/13 PASS**. Added three focused regressions for all five positive severity counts with no advisory rows, one shared lower-severity record covering five affected packages, and one critical record covering mixed-severity affected counts. Prior malformed/negative inputs remain guarded.
- Actual post-#170 workspace `pnpm audit --prod --json` on Windows returned **exit 0, zero issues in all five severities, zero advisory records**. Feeding that exact JSON to the patched parser returned **`REAL_JSON_PASS total=0 blocked=false`**.
- Node syntax, patch whitespace, repository worktree cleanliness after staging and exact-head hosted CI must still be verified before merge. Local Windows Node 24.19.0 remains below the project's configured Node 24.22.1 floor; **16/16 exact-head PR jobs** and **11/11 integrated-main push workflows** remain mandatory.

This fix is deliberately minimal and does not claim a complete registry report schema validator, native Dependabot/secret-scanning coverage, an independent penetration test or a released Cloud service. Community publication stays **HOLD until explicit owner `GREEN LIGHT MONTRAL`**; Cloud/BYOC remain **NO-GO** pending independent legal/privacy/security/provider/operations reviews.
