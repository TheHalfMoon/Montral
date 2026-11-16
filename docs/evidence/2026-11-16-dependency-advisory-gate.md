# Read-only dependency advisory gate for Montral source integrity — 2026-11-16

**Scope:** a free, fail-closed dependency-advisory check on the **production lockfile graph** in the existing source-integrity GitHub Actions workflow. No live hosted services, production credentials, database, subscriptions, deployment, or repository security settings are modified.

## Why

The repository's native GitHub Dependabot, code-scanning and secret-scanning alerts were unavailable/disabled in the read-only API check tracked in issue #169. Existing source-integrity tests did not independently query the public package-advisory registry. A local pnpm lockfile audit of `main@08c6beb` flagged one **moderate** esbuild development-server advisory (GHSA-67mh-4wv8-2f99). A narrow mitigation is separately qualifying in PR #170; that advisory is **not** a high/critical release-blocker and should be visible while the mitigation proceeds.

## Engineering

- Existing `.github/workflows/source-integrity.yml` (same workflow, same single job) uses official `pnpm/action-setup@v4` with repository-pinned pnpm `10.0.0`, and `actions/setup-node@v4` with supported Node `24.22.1`.
- Run **`node --test scripts/verify-dependency-advisories.test.mjs`** before the actual audit and then **`node scripts/verify-dependency-advisories.mjs`**.
- The gate invokes `pnpm audit --prod --json` against `pnpm-lock.yaml`, without package installation, and reads only advisory count metadata. It reports all info/low/moderate/high/critical counts; returns **1 (fail)** on high or critical. Lower levels are disclosed as notices and require manual triage; the gate does **not** claim they are safe.
- Return **2 (unverified/fail)** if the audit tool cannot run, times out, returns an unexpected code, or emits malformed/incomplete/conflicting JSON. A normal `pnpm audit` exit code of 1 due solely to lower-level advisories is allowed **only after a parseable, complete report**.
- Uses `cmd.exe /d /s /c pnpm.cmd` on Windows because Node 24 does not support direct `spawnSync("pnpm.cmd")` (EINVAL); Linux runners use `pnpm` directly.
- The job's existing `contents: read` permission remains unchanged. No dependency install, database migrations or secrets are required.

## Proof and bounds

- Local Windows Node 24.19.0 (below official project floor), `node --test`: **10/10 pure decision/parse tests passed** for zero, low/moderate, high, critical, missing/incomplete/malformed/inconsistent reports.
- Actual Windows integration on current unmitigated source lock: **exit 0**, printed `info=0 low=0 moderate=1 high=0 critical=0` and `DEPENDENCY_AUDIT_GATE_PASS`. Moderate advisory remains under PR #170; no false all-clear.
- Code syntax and `git diff --check`: pass.
- Full exact-head CI **16/16** plus first-party review and integrated-main push **11/11** are required before merging and treating the gate as active.
- **Not equivalent to native Dependabot alerts, secret scanning, source static analysis, a software bill of materials, penetration testing, production vulnerability scanning, or legal/privacy approval.** Issue #169 remains open until those separate controls exist.

**Release status remains unchanged:** Community publication HOLD until owner's `GREEN LIGHT MONTRAL`; Cloud/BYOC NO-GO pending external provider, security, legal/privacy, real-device and operations gates. This workflow performs no deployment or billable external service.
