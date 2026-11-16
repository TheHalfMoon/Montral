# Transitive esbuild development-server advisory — 2026-11-16

**Status:** targeted dependency mitigation under full hosted CI; not production deployment or release authorization.

## Baseline / scope

A read-only `pnpm audit --prod --json` at `main@08c6bebb77af624a87384911baa2278184b8cf6c` using local pnpm 9.12.0 reported **one moderate advisory**, no high or critical findings, in the checked lockfile: `esbuild@0.18.20`, [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), affecting versions `<=0.24.2` with a patched release starting at `0.25.0`. The advisory concerns permissive cross-origin access to the **esbuild development server**; there is no evidence this server is running on a public Montral deployment.

The exact dependency graph is `packages/db-pg` **devDependency** `drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader@2.6.5` → `@esbuild-kit/core-utils@3.3.2` → `esbuild@0.18.20`. These upstream esbuild-kit packages are deprecated; `drizzle-kit@0.31.11` is the current published stable version at check time. This is **not** a direct runtime API or probe import, even though the workspace-level `--prod` audit flags it. The workspace already used `esbuild@0.25.12` and `0.28.2` through other paths.

## Focused mitigation

- Add a single pnpm override, `"@esbuild-kit/core-utils>esbuild": "0.25.12"`, affecting **only this deprecated core-utils dependency**. Other esbuild paths and dependencies remain on their existing versions.
- Regenerate `pnpm-lock.yaml` using the repository's pinned **pnpm 10.0.0** with `--lockfile-only --ignore-scripts --no-frozen-lockfile`, without installing packages as part of the lock-refresh step.
- The lock diff adds the override and removes the previously locked `esbuild@0.18.20` package and its obsolete platform-specific packages. It does **not** change the versions of `drizzle-kit`, `drizzle-orm`, API, database schema or billing libraries.

## Local verification

- Node JSON parse of `package.json`, `git diff --check`, and exact-file inspection: **PASS**.
- A second `pnpm 10.0.0 audit --prod --json` returned **exit 0**, with `info=0, low=0, moderate=0, high=0, critical=0` in that lockfile at the time of the scan. This is **not** a claim that all source and deployed software are vulnerability-free or that disabled GitHub scanners are clear (tracked separately in issue #169).
- Focused `pnpm 10.0.0 install --filter @montral/db-pg... --frozen-lockfile --ignore-scripts` resolved and installed **84 packages**, and `pnpm --filter @montral/db-pg exec drizzle-kit check` completed successfully: **"Everything's fine"** after loading the actual `packages/db-pg/drizzle.config.ts`. Only the intended two tracked lock/config files remained modified.
- Existing workspace warning: `@better-auth/core` and `@better-auth/api-key` expect `@better-auth/utils@0.4.2` while `0.5.0` is resolved. This warning is not introduced by the esbuild override and is outside this change's remediation scope.

**Qualification limits:** Local Windows Node `24.19.0` is below the project's supported floor `24.22.1`; these are compatibility/lockfile checks rather than a qualified full application build. Full **16/16 exact-head PR checks**, first-party source review and **11/11 integrated-main push workflows** remain required before treating the engineering change as integrated. Because this is a major-version override outside core-utils' original declared `~0.18.20` range, migration/config loading and application CI must remain release gates.

No packages, public website, Cloud instance, DNS, production customer data, payments or release artifacts are published. Community stays **HOLD until explicit `GREEN LIGHT MONTRAL`**; Cloud/BYOC remain **NO-GO** pending independent external gates.
