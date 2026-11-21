# fast-uri dependency remediation - 2026-11-21

## Finding and source evidence

The remediation branch is based on `main@fa3e6e665dc231a75923f292073b7aff708aa8c0`. Dependabot updater run [44888093373](https://github.com/TheHalfMoon/Montral/actions/runs/44888093373) attempted a security update for `fast-uri` from the root npm workspace. Its report identifies `3.1.8` as the latest resolvable release under the current dependency constraints and `3.1.9` as the first non-vulnerable release. The update job failed while targeting `4.2.3`, which cannot satisfy the existing `ajv` 3.x range.

The baseline lockfile contained one copy of `fast-uri@3.1.8`, reached through the development-only tool chain `@astrojs/check` -> Astro/Volar YAML language service -> `yaml-language-server` -> `ajv@8.20.0` -> `fast-uri`. The parent range accepts `3.1.9`. This path is not a known application runtime import. The baseline `pnpm-lock.yaml` SHA-256 was `0C7547544987DF241E54B10DC1486665A3F6175805B2E337205EDBE6879BB530`.

OSV/NPMScan queries for the exact package versions reported `fast-uri@3.1.8` vulnerable (four advisories, highest severity moderate) and `fast-uri@3.1.9` with no known advisory records. The reported affected ranges include `<3.1.9`. No finding is classified as a false positive; this is a dependency-version remediation, not proof of exploitability in Montral.

## Change and validation

The candidate adds a parent- and version-scoped pnpm override, `ajv@8.20.0>fast-uri: 3.1.9`, and updates the single lockfile copy and Ajv snapshot. No application source, direct dependency, or unrelated peer-resolution entry changes.

- `corepack pnpm@10.0.0 install --lockfile-only --ignore-scripts`: pass; the local Node 24.19.0 is below the repository's declared Node 24.22.1 minimum, so this is lockfile-generation evidence only.
- `corepack pnpm@10.0.0 install --lockfile-only --frozen-lockfile --ignore-scripts`: pass; the candidate manifest and lockfile are consistent.
- `node --test scripts/verify-dependency-advisories.test.mjs`: **14/14 pass**, including a regression assertion that Ajv remains pinned to fixed `fast-uri@3.1.9` and no `3.1.8` lock entry returns.
- `corepack pnpm@10.0.0 audit --json`: exit 0; 594 dependencies checked and zero advisory records in the candidate lockfile snapshot. This registry audit does not replace native GitHub alert access or prove zero GitHub alerts.
- The exact-main push qualification on base `fa3e6e6` was still running when this note was prepared. Candidate PR checks and exact merged-main checks must pass before the change is considered integrated.

No local production build or application runtime test was performed: this dependency is in the development-only YAML language-server path. Hosted CI on the exact PR head will install the frozen lockfile and run repository-required qualification. No credential, release, billing, deployment, or production change was made. Community publication remains HOLD; Cloud and BYOC remain NO-GO while issues #169 and #183 are open.
