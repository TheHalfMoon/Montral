# Bounded project-selection cache

Status: local implementation and independent review complete; hosted qualification and merge remain required.

## Finding and change

Authenticated callers could vary `x-project-id` or the project cookie indefinitely. The process cache retained every requested string even when it was malformed and the repository resolved the ordinary fallback. Expiry affected reads but did not bound retained entries.

Canonicalize selections inside the cache, after the existing scoped-default selection: valid UUIDs use lowercase keys, all other hints use the existing repository fallback. Keep live membership, suspension and SSO checks before cache access and the project-grant check afterwards. This does not reinterpret a malformed explicit selector as a scoped default.

The cache holds at most 1,024 completed string answers. Expired hits are removed, and every insertion enforces capacity synchronously after database resolution, so concurrent misses cannot overfill it. Organization-specific invalidation remains intact. No cross-request promises, timers, generation maps or external dependency were introduced.

## Evidence

- Before the fix, two regression tests failed: 100 malformed selections caused 100 resolutions instead of one, and the first selection remained cached after 1,025 unique UUID requests. Three compatibility controls passed after correcting the test harness's missing auth URL.
- Node 24.22.1 focused tests: 10/10 passed across project-cache, cookie-selection and existing TTL-cache tests. Coverage includes concurrent delayed misses, expiry, organization invalidation, header precedence, malformed cookies, scoped defaults, unknown selections, uppercase UUIDs and current membership revocation.
- Combined focused tests with a fresh disposable PostgreSQL 17.7 database: 17/17 passed across six files, including membership, All projects and OAuth scope.
- Independent fresh-context boundary investigation and one bypass/regression review ran under `codex-security:fix-finding`. No actionable new bypass or regression remained.
- Pre-existing limitation: a resolution already in progress can repopulate after project invalidation. This does not defeat the size bound; changing stale-resolution behavior is outside this memory-retention fix. Existing authorization checks still run for every request.

No production resource, provider call, paid dependency, deployment or publication was used. Historical integrated-main qualification is separate from this branch's pending qualification.

## Hosted qualification diagnosis

The first browser failure was a hero-note contrast issue corrected in main by #139; this branch incorporates that main revision. The next mobile-WebKit failure sampled eyebrow/lead text during the finite reveal transition: the reported blended foreground was #76756e rather than the final #56554e token. The landing check now waits for the hero heading's final opacity and for visible revealed hero elements to finish before axe runs. It changes neither product styling nor axe rules, thresholds or retry policy. E2E TypeScript and discovery of all five engine/viewport cases pass locally; actual browser validation remains a hosted gate (no local browser binaries were available).
