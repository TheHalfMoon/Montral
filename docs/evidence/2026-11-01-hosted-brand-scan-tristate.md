# Hosted active-brand source scan — fix a shell false positive

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private GitHub CI and active-code scan only. No donor source snapshots or legal provenance changed.

## Evidence from hosted CI

[GitHub Actions run 41294665718](https://github.com/TheHalfMoon/Montral/actions/runs/41294665718) passed **all** preceding steps: original source integrity, dependencies, TypeScript/Astro, API/PostgreSQL/Edge tests, all three builds, web tests, Node/Postgres smoke, PostgreSQL 17 client installation, **full-table backup/restore**, Chromium real browser journeys and local-sink SMTP incident/verification flows. The last check, `No source brand leaks in active code`, failed without printing any actual matching filename.

The original shell check was `if grep -R ... | head -n 1; then fail; fi`. Under the GitHub step's `bash -e` shell **without `pipefail`**, `head` returns success even if `grep` returns 1 (no matches). This made the guard fail **on clean code**, not on an actual upstream name. Read-only `grep` over `apps` and `packages` on a clean checkout found no occurrences of OpenUptime, UptimeFlare or webhook.site in the active targeted `.ts`, `.tsx`, `.astro` or `.json` files. No actual Montral product branding leak was demonstrated.

## Correction and negative testing

The workflow now calls `bash scripts/verify-active-branding.sh`. This standalone, `set -euo pipefail` scanner directly handles grep's tri-state exit code: 0 means **found a forbidden product name** (print matched filename, fail), 1 means **no match** (pass), other exit values mean **scanner failure** (fail). It checks that both source directories exist and excludes `dist`, `.astro` and `node_modules`; it does not alter or scan the preserved pinned donor snapshots outside apps/packages. The use of `grep -l` reports a filename rather than raw source content. No pipeline's exit code substitutes for the grep result.

**Verified locally on macOS:** clean real Montral active source PASS; isolated synthetic clean source with an ignored `node_modules` donor name PASS; an intentionally introduced `UptimeFlare` in `packages/lib/bad.ts` FAIL with exact file path; an intentionally introduced `Webhook.Site` in `apps/src/bad.astro` FAIL with exact file path. The disposable synthetic fixture directory was removed. `bash -n`, git diff whitespace check and the untouched 638-source integrity check remain mandatory.

## Release limits

A hosted GitHub Actions green result must be confirmed on the new exact commit before this guard is declared fully qualified. Production Cloudflare, external SMTP and billing, managed PostgreSQL PITR, legal/privacy/accessibility review and explicit release approval remain open regardless of this CI result.
