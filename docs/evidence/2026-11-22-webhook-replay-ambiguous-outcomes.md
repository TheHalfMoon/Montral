# Webhook replay ambiguity feedback

Status: implemented in PR #200 on top of `main@7f1bf0265108842bc513705766e0c5874ca859d0`. Use the PR check record and its merged-main evidence for hosted qualification status.

## Confirmed gap

The replay endpoint increments the existing `admitted_attempts` counter before outbound resolution/fetch. It correctly avoids automatic retries and returns fixed 502/504 errors, but these errors did not carry a machine-readable ambiguous-outcome code. The Webhook UI therefore displayed a generic network error without telling operators that the remote peer may already have processed the request.

## Change

- 502 and timeout 504 replay responses now use `replay_outcome_unknown` and say the target may have received the request. Private-target refusals remain `target_not_allowed`.
- The UI recognizes that code and shows a localized warning to retry only when duplicate delivery is acceptable.
- The monthly counter remains a count of admitted attempts and stays explicitly non-billable; this change does not claim accepted network delivery or exactly-once remote semantics.
- API reference text now documents the ambiguous outcomes and safe retry caveat.

## Regression coverage

A real PostgreSQL replay E2E passed, including a closed-port 502 and a slow local endpoint that consumed the request before timing out at 504; both responses carry `replay_outcome_unknown`. The translation tests passed 14/14. API typecheck passed. Astro reported 0 errors, 0 warnings and 6 informational hints. `git diff --check` passed. Hosted exact-head and merged-main qualification are recorded in PR #200 and its merged-main evidence.