# Montral: oauth-scope e2e flake (agent saw an empty inbox list)

**Date:** 2026-11-10. **Branch:** `fix/montral-oauth-scope-flake`, based on `origin/main` at `18be31f`. **PR:** #53. Synthetic data only.

## Symptom

CI run https://github.com/TheHalfMoon/Montral/actions/runs/42682311112, attempt 1 (PR #48, job 129379833709, PostgreSQL 17).
`apps/api/src/oauth-scope.e2e.test.ts:116` failed with `expected [] to deeply equal [ Array(1) ]`. An OAuth agent token
was granted `${home.id}|${alpha}` with `mcp:read`. It listed `GET /api/hooks/inboxes` and got 200 with no inboxes,
right after Ada's session had created an inbox with `x-project-id: alpha` and got 201. Attempt 2 passed.

**Frequency.** I scanned every failed job of the last 100 failed runs across all workflows, plus attempt 1 of every
re-run among the last 300 `Montral app CI` runs (2026-11-01 to 2026-11-09). Only this one occurrence turned up.
The vitest summary of the failing job reads `Isolate 130 workers spawned`: one worker per file, so module state such
as `projectCache` is never shared between files. The only state the files share is the database.

## Root cause

There were two defects. Together they made the workspace of Ada's session a per-request guess.

1. **A sign-up session never had an active workspace.** In `apps/api/src/auth.ts` the user's `create.after` hook
   creates the personal workspace, and the session's `create.before` hook stores `preferredWorkspace(userId)` as
   `activeOrganizationId`. Better Auth 1.7.7 runs `/sign-up/email` inside `runWithTransaction`
   (`better-auth/dist/api/routes/sign-up.mjs:144`). `create.after` hooks go through `queueAfterTransactionHook`
   (`better-auth/dist/db/with-hooks.mjs:34`), and that queue is flushed only after the whole endpoint has returned
   (`@better-auth/core/dist/context/transaction.mjs`, `runWithTransaction`). Our drizzle adapter has no real
   transaction (`transaction` defaults to `false`), so it uses an "as-is" transaction, but the hook queue still
   behaves the same way. The order is therefore: user row, **session row (`create.before` finds no membership → `null`)**,
   then the personal workspace. A probe running the real endpoint over the memory adapter printed
   `['session.create.before', 'user.create.after']` and `activeOrganizationId = null`. That probe is kept as
   `apps/api/src/signup-workspace.test.ts`.
2. **The fallback for a session without a workspace was unordered.** `requireOrg` (`apps/api/src/middleware.ts:99`)
   calls `repo.anyWorkspaceOf(userId)` when no workspace is active. The query was
   `SELECT organization_id FROM member WHERE user_id = $1 LIMIT 1`, with **no ORDER BY**. PostgreSQL then returns
   whichever row it reaches first. A sequential scan returns the lowest ctid, and an index scan on `member_userId_idx`
   breaks ties between equal keys by heap TID, so it also returns the lowest ctid. A row inserted later can get a
   lower ctid when it reuses space freed by deleted rows. The CI database is shared by ~130 e2e files running in
   parallel, and several of them `DELETE FROM organization` (the cascade deletes `member` rows), so vacuum keeps
   freeing slots.

How the two combine in the test: Ada signs up, so her session has `activeOrganizationId = null`. She then creates
"Ada other" (line 48), which gives her two `member` rows. On almost every run her home row is physically first, so
each request resolves to `home`. In the failing run the "Ada other" row sat first. Every request from Ada's session
then ran in **the other workspace**, and `resolveProject(other, alpha)` does not find `alpha` there, so it silently
falls back to the other workspace's default project. `POST /hooks/inboxes` answered 201, but the inbox was stored
under `(other, other-default)`. The agent's token is bound to `(home, alpha)` by its grant, so its list was
correctly empty. Nothing in the OAuth path is at fault: grant decoding, `cachedProject` (per-worker, and the key
`home|alpha` resolves to `alpha`), the hooks list query and `pruneExpiredHookEvents` all behave as intended.

### Evidence strength

- **Certain** (from the source and a run of the real library): a sign-up session stores `activeOrganizationId = null`,
  and `anyWorkspaceOf` had no ordering.
- **Strong** (deterministic reproduction): `active-workspace.e2e.test.ts` puts the personal workspace's membership
  behind the second one on disk. It deletes both membership rows and re-inserts them, unchanged, in one `INSERT`
  with the second workspace's row first. One statement fills its target page in order, so this gives both rows new
  heap positions and new index entries in the inverted order. The test then checks the precondition with the exact
  old query: the unordered `LIMIT 1` must now answer the second workspace. Re-inserting only the personal workspace's
  row was not reliable. On the macOS runner (`c9127b1`, job 129429339954) the free-space map put it back on an
  earlier page five times in a row, so the precondition failed before any assertion about the fix was reached. A plain `UPDATE member SET role = role` is not enough. It is a HOT update,
  so the index entry keeps pointing at the original position and the lookup still finds the personal workspace
  first. The first RED run (commit `77364d6`) showed exactly that. On unfixed code the user's session then resolves
  to the second workspace (RED run on `82a1bc1`, recorded on the PR). `any-workspace.test.ts` reproduces the same
  physical order with a fake database.
- **Inferred, not observed directly**: that the failing CI run had exactly this physical order. The run kept no
  database dump. However, the only way for the agent to list nothing while the session's create returned 201 is
  for the two requests to resolve to different (org, project) pairs, and the token's pair is fixed by its signed
  grant. The session's pair is the one that can vary, and the unordered `LIMIT 1` is the only nondeterminism on that
  path.

## Fix

- `packages/db-pg/src/repo.ts` `anyWorkspaceOf`: `ORDER BY member.created_at, member.organization_id`. A session or
  grant without an active workspace now always gets the oldest membership, and that answer does not change as
  memberships are added. For a fresh sign-up the oldest membership is the personal workspace. The OAuth consent
  default (`consentReferenceId`) uses the same function and gets the same stability.
- `apps/api/src/auth.ts` `givePersonalWorkspace`, now used by the user's `create.after` hook: after creating the
  personal workspace, it sets it as the active workspace of that user's sessions that have none
  (`... WHERE active_organization_id IS NULL`). It never overrides a workspace that is already chosen. So the sign-up
  session no longer has to guess at all. For an unverified user the session cookie cache is bypassed, so the change
  takes effect on the next request. A verified (GitHub) sign-up may still see `null` from the signed cookie cache for
  up to 5 minutes, and during that time the deterministic fallback above applies.

Not changed: `resolveProject` still falls back to the workspace's first project when `x-project-id` names a project
of another workspace. `oauth-scope.e2e.test.ts:181` documents that fallback for agents. With the active workspace
now stable, a session no longer ends up in a workspace it did not choose.

## Tests

- `apps/api/src/any-workspace.test.ts` (unit, fake PostgreSQL via `drizzle-orm/pg-proxy`; rows in physical order): it
  checks that the oldest membership wins whatever the order on disk, that a `created_at` tie is broken by id so
  repeated lookups never alternate, and that a user without memberships gets `null`. It fails on the old query
  (`expected 'ada-other' to be 'ada-home'`).
- `apps/api/src/signup-workspace.test.ts` (unit, real Better Auth sign-up over the memory adapter): it pins the
  library's hook order, checks that the sign-up session gets the personal workspace once `givePersonalWorkspace`
  runs, and checks that a session that already has a workspace is never overridden.
- `apps/api/src/active-workspace.e2e.test.ts` (PostgreSQL): checks that the sign-up session stores the personal
  workspace; then, with the active workspace cleared and the membership rows inverted on disk, checks that
  `anyWorkspaceOf` and `/api/workspaces` stay on the personal workspace and that an inbox created with its project
  is stored there.
- `apps/api/src/oauth-scope.e2e.test.ts`: none of its assertions were changed or weakened. One assertion was added:
  after Ada creates her second workspace, her session's current workspace is still `home`. If this ever regresses,
  the test now fails at the cause instead of at the inbox list 60 lines later.

RED/GREEN: the first two commits of #53 contain only tests, and the commit after them contains the fix.
On `77364d6`, PostgreSQL 18 CI failed `any-workspace.test.ts` (`expected 'ada-other' to be 'ada-home'`) and the
sign-up check in the e2e (`expected [ null ] to deeply equal [ Array(1) ]`). The second failure is the stored
`activeOrganizationId` of a fresh sign-up session, observed on real PostgreSQL. On `82a1bc1` (run 42695712956, job 129426898767,
PostgreSQL 18), the precondition held: the old unordered `LIMIT 1` answered the second workspace. Then
`repo.anyWorkspaceOf` returned the second workspace instead of the personal one (`active-workspace.e2e.test.ts:64`,
`expected 'dcc70877-…' to be '4573513e-…'`). This is the flake's mechanism reproduced deterministically on real
PostgreSQL. The fix commit turns both the e2e test and the unit tests green.
