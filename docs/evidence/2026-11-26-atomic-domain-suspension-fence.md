# Atomic custom-domain suspension fence

## Finding

The existing `NOT EXISTS (workspace_suspension)` predicate stopped a DNS outcome when suspension was already visible as the result statement began. It did not serialize that result statement with the operator's suspension transaction. A result update could therefore run concurrently with suspension and commit after the suspension had committed.

## Change

After DNS resolves, both matching and failing result updates now run in a PostgreSQL transaction. The transaction locks the workspace's `organization` row with `FOR UPDATE`, matching the lock used by the operator suspend route, checks `workspace_suspension`, and applies the status-page update before releasing the lock.

This establishes an order between the two operations. If the DNS update acquires the organization lock first, it commits before suspension can commit. If suspension acquires the lock first, the DNS update waits, then sees the committed suspension and discards its result. A resolver already in flight is not canceled. Resolver outcome counters still count observations; they do not claim that every observed result changed page state.

## Regression coverage

The PostgreSQL E2E test holds the operator's organization lock and inserts a synthetic suspension in an open transaction. It starts a failing DNS result, waits until PostgreSQL reports the result transaction blocked on that lock, commits the suspension, and verifies the result is discarded without changing the stored failure state. The focused suite passed 12/12 on disposable PostgreSQL 18.7. API typecheck, Node build, and `git diff --check` passed.

The local Node runtime is below the repository's declared engine version; hosted CI remains the supported runtime qualification for the PR head.

No production domains, external probes, mail providers, billing, deployments, or production credentials were used.
