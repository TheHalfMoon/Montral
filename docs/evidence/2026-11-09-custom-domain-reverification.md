# Custom domain re-verification

**Date:** 2026-11-09. Synthetic data, disposable databases, stub DNS. No release.

## Defect

A custom domain stayed verified forever once its TXT record matched. If the
record was later removed (the domain changed hands, the owner left, a DNS zone
was rebuilt), the old page kept being served on that hostname until another
page proved it or an admin removed it. This was listed as open security item 2
in `docs/FINAL-REPORT.md`.

## Change

- Migration `0050_status_page_domain_recheck` adds four columns to
  `status_page`: `custom_domain_checked_at`, `custom_domain_failing_since`,
  `custom_domain_failures` and `custom_domain_check_error`.
- `recheckCustomDomains` (`apps/api/src/custom-domain.ts`) runs from the Node
  scheduler every 5 minutes, independently of monitor checks. It claims due
  rows with `FOR UPDATE SKIP LOCKED`, at most 10 per run, with 4 lookups in
  parallel.
- **Policy** (`DOMAIN_RECHECK`):
  - **Re-check interval:** every 6 h while the record matches; every 30 min
    once a check failed.
  - **`missing` or `mismatch`:** verification is withdrawn after 24 h *and* at
    least 3 failed checks.
  - **`lookup_failed`** (timeouts, SERVFAIL): verification is withdrawn after
    7 days, so a resolver outage does not take a status page offline.
  - **Recovery:** any matching check ends the streak.
- **Race safety:** each write is bound to the row's `(id, domain, token)` and
  to `verified_at IS NOT NULL`. A domain that was set again, removed, verified
  again or taken over during the lookup is therefore never changed by a stale
  result. The withdrawal is decided inside the same `UPDATE` from the stored
  streak.
- **Cache:** a withdrawal purges the domain cache on the server that made it.
  Other servers follow within the existing 60 s TTL.
- **Visibility:** the API exposes the four fields. The editor shows the last
  confirmation, a failing streak with its grace period, or the reason for a
  withdrawal. A manual Verify, PUT or DELETE resets the streak.
- Workers deployments have no custom domains and do not run the job.

## Tests

`apps/api/src/custom-domain-recheck.e2e.test.ts` runs on real PostgreSQL 17
and 18 in CI, with an explicit clock and per-test page scoping. It covers:

- The healthy interval, and that a match keeps the domain.
- A brief disappearance: the page stays served, is re-checked sooner, and the
  streak clears.
- Withdrawal at 24 h, but not at 23 h 59 min. The page is no longer routed and
  the reason appears in the API.
- Verifying again after a withdrawal restores the domain.
- 24 h alone is not enough: a scheduler outage still needs 3 failed checks.
- A mismatch counts like a missing record.
- Unreachable DNS keeps the domain for 7 days, then withdraws it. An answer in
  between starts a new streak.
- Races: the domain is set again, or taken over by another workspace, while a
  lookup is in flight. Neither page is changed by the stale write.
- Three concurrent servers: each domain is looked up exactly once per round.

## Not demonstrated

- Real public DNS resolvers. The tests use a stub resolver; the system
  resolver path is unchanged from PR #29.
- Notifying owners by email when a domain is withdrawn. Only the editor shows
  it today.
