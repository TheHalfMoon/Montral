# Dependency security triage (2026-11-15)

**Status:** remediation branch under qualification, not approved for release.

## Baseline and coverage

A read-only npm-registry/OSV audit of `main@816cde77c550f9b8c4cbb7959ed35ba8a2fed8ba` found **10 dependency versions with known vulnerability advisories** in the pnpm lockfile. Its coverage is **partial**: 566 of 569 third-party entries checked for advisories, 100 detailed for license/install scripts, no license violations among the inspected subset, and one flagged install-script signal. These are *known-version matches*, not proof that each vulnerable code path is reachable or exploitable in Montral.

## Targeted remediation

Only dependency and lockfile changes, no application behavior changes:

- API manifest minimums: Hono >=4.13.16, `@hono/node-server` >=2.1.6, Zod >=4.6.6 and Nodemailer >=10.1.4. Lockfile selection resolves to Hono 4.13.18, Node server 2.1.8, Zod 4.6.7, Nodemailer 10.5.0.
- Web manifest minimums: Astro >=7.4.7, `@astrojs/node` >=11.1.13. Lockfile resolves Astro 7.4.12 and adapter 11.1.13.
- Major-scoped pnpm overrides ensure every Hono 4 and Zod 4 instance uses these patched versions and `undici` 7 and 8 resolve to 7.30.1 and 8.12.4. No generic major-version override is used.

Upgrade simulation against registry metadata reported these resolved versions as patched, with no known OSV advisories at the time of the check. Astro's minor update was **review-recommended** because its minimum Node version increased; the repository already requires Node 22.23.4+/24.22.1+, consistent with that requirement. Simulation is not a substitute for application tests.

## Candidate lockfile re-audit

A second registry/OSV audit of the uploaded branch head `f39bc6c4f3b728568f411f9083b3ab4063895ec0` checked **606 of 609** entries and reported **2 known-vulnerable dependency versions** (down from 10 of 566 checked on the baseline). The remaining findings were exactly `fast-uri@3.1.8` and `esbuild@0.18.20`. The audit remains **partial**: only 100 entries received full license/install-script detail, and three entries were not advisory-checked. This is a decrease in known-vulnerable versions, not a guarantee of exploitability or a complete security assessment.

## Residual and blocked items

- `fast-uri@3.1.8` has advisory matches; its traced lockfile path is `@astrojs/check` -> Astro/Volar language service -> `volar-service-yaml` -> `yaml-language-server` -> `ajv@8.20.0` -> `fast-uri`. Astro check is a **development** dependency, not a known HTTP runtime import. The upstream AJV version still requires `fast-uri@^3.0.1`; fully patched 4.x is a breaking major. Do not override it blindly. Validate built artifacts before accepting the residual exposure.
- `esbuild@0.18.20` remains alongside newer versions. Its traced lockfile path is `drizzle-kit@0.31.11` -> deprecated `@esbuild-kit/esm-loader` -> `@esbuild-kit/core-utils` -> `esbuild@0.18.20`. `drizzle-kit` is only a **development** dependency of `@montral/db-pg`. The advisory concerns access to a development server; Montral must never expose dev servers. Replacing the deprecated loader via a Drizzle migration-tool upgrade needs separate migration testing, not a forced incompatible esbuild override.
- Audit coverage is not complete, so it cannot certify all dependencies, transitive license compliance or supply-chain provenance.
- `pnpm install --lockfile-only --ignore-scripts` regenerated the lockfile without executing dependency lifecycle scripts. The local engineering PC has Node 24.19.0, below the repository's declared minimum; local results are **not** runtime qualification.

## Required acceptance

1. A clean `pnpm install --frozen-lockfile` and no unauthorized install-script execution in hosted CI.
2. Typechecks and API/React/Astro/probe builds, PostgreSQL 17 and 18 security E2E, cross-browser accessibility journeys, backup/restore, Docker/replicas, load, failover and source-integrity checks.
3. Re-audit the **exact final lockfile**, distinguish unresolved advisories from changed versions, and review any newly introduced dependencies before merge.
4. Merge only after required 16 constituent GitHub jobs pass on the exact head; repeat integrated-main qualification after merge.
5. No release/tag/deployment, external provider contact or paid service. The owner must explicitly authorize `GREEN LIGHT MONTRAL`; Cloud and enterprise BYOC retain independent security and operational gates.
