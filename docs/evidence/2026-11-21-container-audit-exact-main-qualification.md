# Container audit and exact-main qualification — 2026-11-21

This is a dated engineering qualification record, not authorization to publish, tag, deploy, sign, charge users, or enable hosted Cloud/BYOC.

## Qualified main revision

`main@d36160b83c261839f8e0ff5e3b3cfcc2a39bf36d` (merge commit for PR [#181](https://github.com/TheHalfMoon/Montral/pull/181)) passed all **12/12 exact-SHA `push` workflows**. Results were collected with `gh run list --commit d36160b83c261839f8e0ff5e3b3cfcc2a39bf36d --event push --limit 100` and accepted by `scripts/verify-main-workflows.py`.

| Workflow | Run | Result |
|---|---:|---|
| Montral source integrity | [44881122430](https://github.com/TheHalfMoon/Montral/actions/runs/44881122430) | SUCCESS |
| Windows Docker prerequisite safety | [44881122317](https://github.com/TheHalfMoon/Montral/actions/runs/44881122317) | SUCCESS (preflight only; not physical Windows Docker qualification) |
| Montral browser checks | [44881122311](https://github.com/TheHalfMoon/Montral/actions/runs/44881122311) | SUCCESS |
| Montral Terraform provider | [44881122388](https://github.com/TheHalfMoon/Montral/actions/runs/44881122388) | SUCCESS |
| Montral upgrade, rollback and disaster recovery | [44881122269](https://github.com/TheHalfMoon/Montral/actions/runs/44881122269) | SUCCESS |
| Montral cross-browser and accessibility | [44881122291](https://github.com/TheHalfMoon/Montral/actions/runs/44881122291) | SUCCESS (hosted engines; not physical iOS Safari or VoiceOver) |
| Montral failover qualification | [44881122277](https://github.com/TheHalfMoon/Montral/actions/runs/44881122277) | SUCCESS |
| Montral Docker Compose qualification | [44881122327](https://github.com/TheHalfMoon/Montral/actions/runs/44881122327) | SUCCESS |
| Montral app CI | [44881122316](https://github.com/TheHalfMoon/Montral/actions/runs/44881122316) | SUCCESS |
| Montral macOS PostgreSQL 18 qualification | [44881122300](https://github.com/TheHalfMoon/Montral/actions/runs/44881122300) | SUCCESS |
| Montral load qualification | [44881122282](https://github.com/TheHalfMoon/Montral/actions/runs/44881122282) | SUCCESS |
| Montral CodeQL code scanning | [44881122281](https://github.com/TheHalfMoon/Montral/actions/runs/44881122281) | SUCCESS |

The exact-main run list was saved as `work/main-runs-d36160b.json`; the verifier reported `PASS: 12 exact-main push workflows successful for d36160b83c261839f8e0ff5e3b3cfcc2a39bf36d`.

## PR #181 changes and evidence

PR #181 added a checksum-verified Trivy 0.76.2 high/critical scan for all four shipped container images. Its PR check passed on the exact PR head: [container image vulnerability audit](https://github.com/TheHalfMoon/Montral/actions/runs/44879232850/job/136770637722). The same run also passed CodeQL and Go dependency auditing. The final hosted scan summary reported zero HIGH/CRITICAL findings in the app, browser-runner, probe, and custom PostgreSQL images.

The implementation also:

- declares the probe's existing `zod` runtime dependency;
- removes npm/Corepack/Yarn from shipped runtime image stages;
- builds the PostgreSQL image from `postgres:18.7-alpine`, applies Alpine updates, and rebuilds upstream `gosu` v1.20 from its exact source commit using a digest-pinned Go builder;
- uses Alpine Chromium in the isolated browser-runner and assigns it a writable `/tmp` home for profile/crashpad helpers;
- qualifies runner startup, network isolation, worker termination/reaping, persistence, and the full Docker Compose stack.

The PR's remaining hosted checks also passed, including both PostgreSQL app CI legs, macOS ARM64, cross-browser/accessibility, failover, rollback/recovery, replicas, BYOC, and the load suite. See [PR #181](https://github.com/TheHalfMoon/Montral/pull/181).

## Limits and release status

This qualification establishes hosted CI and image-scan results for this exact commit. It is not an independent penetration test or exhaustive security audit. Native GitHub security-alert settings remain unavailable under open issue [#169](https://github.com/TheHalfMoon/Montral/issues/169); historical secret-pattern matches remain unresolved as described in the prior evidence. Hosted browser engines do not establish physical Windows Docker, iOS Safari, or VoiceOver coverage. External provider, production infrastructure, legal/privacy, and operational readiness gates remain open. Community publication remains HOLD pending the owner's `GREEN LIGHT MONTRAL`; Cloud and Enterprise BYOC remain NO-GO. No release, tag, deployment, or production secret change was performed.
