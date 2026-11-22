# Custom-domain rechecks while a workspace is suspended

## Behavior

The periodic custom-domain recheck claim now excludes status pages whose workspace has a `workspace_suspension` row. A suspended workspace's due timestamp and current domain-verification state remain untouched, and no DNS lookup is started for a page excluded at claim time. After unsuspension, the old due timestamp makes the check eligible again.

This change prevents routine rechecks from doing work for workspaces already suspended. It does not cancel a DNS lookup claimed before a concurrent suspension; that lookup may complete and its result may still be recorded. DNS lookups involve public verification records and carry no customer credential. This is not a complete suspension transaction fence.

## Regression coverage

The PostgreSQL-backed recheck suite suspends a synthetic workspace before its due check, verifies that the resolver is not called and the due timestamp is unchanged, then removes the synthetic suspension and verifies that the overdue check runs. No live domains, probes, credentials or external services are used.
