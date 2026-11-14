# Request-body observation revision

An HTTP body-only edit changed what the monitor checks without advancing the existing observation coverage revision. An older in-flight result could therefore be admitted under the new configuration. This is an authorized manager's own-monitor correctness defect; no cross-tenant security impact is claimed.

Include `requestBody` in the repository's existing measurement-field comparison. Actual body changes and explicit clearing invalidate old snapshots and create the usual unknown boundary. Unchanged bodies and metadata-only edits preserve coverage. The existing locked update and observation revision check remain the enforcement mechanism; no migration or new state is needed. Older replicas retain their previous behavior until upgraded.

RED: a body-only edit left the revision at zero instead of advancing it. GREEN: all 19 PostgreSQL coverage tests pass, including old-body result rejection, current-body admission, unchanged-body/metadata controls, explicit null clearing and absence of stale down time. Nearby API time-coverage, JSON assertion and HTTP request suites pass 17/17. Independent review found no correctness, parsimony or product issue. PostgreSQL TypeScript, source identity and diff checks pass. Node 24.22.1 and a disposable localhost PostgreSQL 17 database were used.

All 16 latest-head hosted checks and 11 integrated-main workflows remain required before qualifying the merged revision. No production action or publication.
