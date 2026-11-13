# Unified read-only operator audit timeline — qualification record

**Status:** proposed pending exact-head GitHub CI and review. No production action, new migration, provider, credentials, external event delivery or release was performed.

## Gap and approach

Platform actions were recorded in two separate durable sources: `audit_event` for workspace suspension/unsuspension and `probe_region_drain_event` for region drain/undrain. Per-workspace suspension history and per-region drain history already existed, but operators lacked a single chronologically sorted and target-searchable view.

The new `GET /api/operator/audit` is a **read-only projection** over those existing committed audit events. It accepts `source=all|workspace|probe`, a target-ID/region substring `q` (at most 100 characters), a strict `limit` (1–100; default 50), and a bounded opaque keyset `cursor`. PostgreSQL sorts by event timestamp and source-specific ID, with microsecond UTC cursor precision to avoid duplicated/skipped rows when events share a millisecond.

## Security properties

- The handler inherits the existing `requireOperator`: allowlisted platform browser session, recent second-factor sign-in, database-fresh session checks, rate limits, no-store, nosniff and no-referrer. Non-operators, unauthenticated users, API keys and OAuth/MCP agent tokens cannot read it.
- The workspace source includes **only** verified system actor label `Montral operator`, workspace-target equality, and `workspace.suspend`/`workspace.unsuspend` actions. Ordinary customer audit events, member activity, unrelated notes and private monitor/webhook values do not enter this projection.
- Probe source contains only the append-only `drain`/`undrain` action family. The output includes a probe event's recorded operator ID but **never** its private note.
- For historical workspace suspensions, the customer audit event intentionally stores the operator role, not the operator user's ID. The unified view reports `operatorId: null`; it does not infer or impersonate an actor. A separate future ledger is required to preserve operator identities for new workspace actions.
- Search covers `target` only, not notes, names, email, IP addresses or token-like data. All filter values are SQL parameters, with escaped LIKE wildcards. Pagination cursors are validated before querying, and source-specific ID formats cannot be used to inject SQL.
- Scope limitation: this is **not** a universal platform log, historical restoration, retention-policy change or full organization audit. Deleted/retention-pruned customer audit events remain absent. Operator action writes are unchanged.

## Validation

- Unit tests exercise cursor roundtrip, rejected malformed/wrong-source IDs and tampered payloads.
- The unlinked `/app/operator` console also offers on-demand search, source filter, pagination and refresh with accessible table labels and no client-side persistence. Its API wrapper sends session credentials only and `cache:no-store`; new unit tests assert URL parameter encoding and absence of API keys or localStorage. In-flight data is invalidated on unmount/MFA access denial.
- PostgreSQL E2E extends the real MFA-protected operator flow: rejects non-operators/keys, checks two workspace actions through paginated target-filtered reads, writes one synthetic probe audit row and validates cross-source field privacy plus filtered queries and invalid input refusal. Synthetic probe row is deleted after the test.
- Windows `@montral/api` TypeScript **PASS**, focused Vitest **26 passed / 2 PostgreSQL tests skipped** because no local `TEST_DATABASE_URL`; never describe skipped database E2E as passed. Web operator API Vitest **6/6 PASS**, web Astro typecheck **0 errors / 0 warnings** (3 deprecation hints, including pre-existing mail component; new component changed to `SyntheticEvent` afterward). `git diff --check` PASS. Full hosted PostgreSQL 17/18, macOS ARM64, app/browser/infra jobs and security review are required before merging. Local Node v24.19.0 is below the repository-supported runtime (^24.22.1).
- Community release/publication remains HOLD; Cloud/BYOC remain NO-GO on live provider and external review gates.
