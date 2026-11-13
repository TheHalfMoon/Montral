# Operator control plane

Platform staff ("operators") of a hosted Montral deployment can look up workspaces and suspend or unsuspend them, and
see and drain probe regions. This is a minimal, API-only control plane (`/api/operator/*`, implemented in `apps/api/src/operator.ts`). The unlinked platform console is at `/app/operator`, with per-request server verification of a browser session and a recent second-factor sign-in. Its new Platform audit section (proposed pending CI) exposes the same bounded search/filter/cursor controls from `GET /api/operator/audit`; no data is prefetched before the operator session is admitted, and results are discarded on unmount or access denial. This UI grants no new permissions.

## Who is an operator

A request is an operator request only when **all** of these hold:

1. The deployment sets `MONTRAL_OPERATOR_USER_IDS` to a comma-separated list of user ids, and the signed-in user's id is
   in it. Unset or empty means there are no operators, and every operator endpoint answers 403.
2. The request is authenticated by a signed-in **browser session** (the Better Auth session cookie). A request that
   carries an `Authorization` or `x-api-key` header is refused, even with a valid operator session cookie next to it.
   API keys and OAuth/MCP agent tokens can never act as an operator.
3. The user has two-factor authentication enabled (`user.two_factor_enabled`), **and this session was created by a
   second-factor sign-in** within the last 12 hours: password sign-in followed by Better Auth's
   `/two-factor/verify-totp`, `/verify-backup-code` or `/verify-otp`. Better Auth only asks for the second factor on
   the password sign-in endpoints; a GitHub sign-in, an SSO callback or the native one-time-token handoff create full
   sessions without it, so "two-factor is enabled" alone proves nothing about the session. The auth after-hook records
   sessions created by a two-factor verify call during sign-in in `operator_mfa_session` (`apps/api/src/operator-mfa.ts`;
   the row goes with the session). The session that enables two-factor is not recorded: after enrolling, sign out and
   sign in again. A "trusted device" sign-in that skips the second factor is not recorded either.
4. The session is read from the database on every request (never from Better Auth's 5-minute cookie cache), so a
   revoked session, an expired second-factor sign-in or two-factor turned off ends operator access immediately.
5. Writes (`POST`) come from the web app's own origin (the same cross-site request check as the workspace API).

Anyone else, signed in or not, gets the same `403 {"error":"Forbidden"}`. The response does not say whether operators
exist or which check failed.

Operator routes are rate limited per client address when the deployment can tell it (before the session is looked
up), per session, and per operator; suspend and unsuspend have a tighter per-operator limit. Without a trusted proxy
there is no shared "unknown address" bucket, so nobody can lock operators out by exhausting it. Every operator response is `cache-control: no-store`.

## What operators can see

| Endpoint | Returns |
| --- | --- |
| `GET /api/operator/workspaces?q=&limit=&cursor=` | Workspaces, newest first: id, name, slug, creation time, member count, the first owner's email, monitor count, whether it is suspended, and the plan id (null when the deployment has no plans). `q` matches name, slug, exact id, or a member's email (case-insensitive substring). `limit` is 1–100 (default 50); `next` is an opaque cursor. |
| `GET /api/operator/workspaces/:id` | The same fields, plus the suspension (reason, note, operator user id, time) and the current period's credit and email usage when the deployment meters usage (null otherwise). |
| `GET /api/operator/workspaces/:id/suspension-history?limit=20` | Up to 50 newest retained workspace suspension/unsuspension audit events (default 20), including action, safe reason and timestamp. Does **not** return notes, operator identity, unrelated customer activity or other workspaces' audit logs. |
| `GET /api/operator/audit?source=all&q=&limit=50&cursor=` | **Proposed, pending exact-head CI:** unified platform-only action timeline from existing workspace suspension and probe drain audit tables. `source` is `all`, `workspace` or `probe`; `q` searches target ID/region only, not notes or email; `limit` 1–100; `cursor` uses UTC-microsecond keyset pagination. Returns action, source, target, timestamp and safe reason (workspace) or operator ID (probe) without notes, customer audit details, or workspace operator identity that was never stored. |

Operators **cannot** see, through this API: monitor targets, headers or bodies, alert channels and their settings,
incidents, status page contents, webhook payloads, API keys, member lists beyond the count and first owner email, or
the workspace's audit log. They cannot sign in as a customer, change a workspace's data, change plans or billing, or
delete anything.

## Suspending a workspace

The unlinked console also shows each selected workspace's retained suspension history. It reuses append-only `audit_event` records already written atomically with the suspend/unsuspend mutation; no extra migrations or writes are needed. Every read requires the same allowlisted browser operator session and fresh MFA. The response intentionally has no operator ID or private suspension note. The proposed unified read-only platform audit (pending CI) additionally includes existing probe drain/undrain actions from the separate append-only table. It is still **not** a universal platform event log: only the two operator action families that currently persist evidence are included. Workspace operator identities are not stored in the customer audit log; the unified timeline reports them as null rather than guessing.


`POST /api/operator/workspaces/:id/suspend` with `{"reason": "abuse" | "payment" | "legal" | "operator", "note"?: string}`
(note at most 500 characters, visible only to operators). Suspending an already suspended workspace replaces its reason
and note. `POST /api/operator/workspaces/:id/unsuspend` lifts it; unsuspending a workspace that is not suspended
changes and records nothing. A suspension or unsuspension and its audit event are written in one database
transaction: if the audit event cannot be written, nothing changes and the call fails.

The suspension is one row in `workspace_suspension` (migration `0058_workspace_suspension`). While it exists:

- **Workspace API**: every request that acts in the workspace (`requireOrg` in `apps/api/src/middleware.ts`) gets
  `403 {"error": "...", "code": "workspace_suspended"}`: sessions, API keys and OAuth/MCP agents alike, reads and writes.
  This includes the workspace's own audit log and `/api/me` while that workspace is the active one.
- **Checks**: the scheduler does not claim or start **new** runs for suspended workspaces (`claimDue`, `beginRuns`).
  A check already running when suspension begins may still finish its outbound request and consume the credits
  reserved before suspension. On updated instances, its observation is refused if suspension has already committed;
  this does not cancel an external request or undo an existing meter charge.
- **Heartbeats**: pings to the workspace's heartbeat URLs get the same 403 and record nothing.
- **Workspace changes through Better Auth** (`/api/auth/*`, which does not pass `requireOrg`): inviting or accepting
  invitations, renaming, changing roles, removing members, deleting the workspace, and creating or changing API keys
  for it get `403` with code `workspace_suspended` (`apps/api/src/auth.ts` before-hook). Reading the workspace, listing
  workspaces, switching the active workspace, leaving it, creating a new workspace and deleting API keys still work.
  Deleting the account of an owner of a suspended workspace is refused, and the database refuses to delete a suspended
  workspace at all (`workspace_suspension` references it with `ON DELETE RESTRICT`), so the suspension cannot be
  removed by deleting the workspace. **Deleting a suspended workspace, or the account of its owner, requires an operator
  to unsuspend it first.** An account deletion removes all of the owner's sole-member workspaces in one statement, so a
  suspension written at the same moment makes the whole deletion fail rather than leave it half done.
  The workspace a call is checked against follows Better Auth's own rule: the `organizationId` where Better Auth reads
  it (the body of a POST, the query string of a GET), else the session's active workspace; an `organizationId` in the
  other place, and any workspace an invitation or slug in the call points to, are checked as well. If the session cannot
  be read the call is refused; an invitation or slug that
  does not exist gets `400`.
- **On-call calendar feeds** of the workspace's members answer 404.
- **Alerts and mail**: alert deliveries and their retries, incident reminders, escalations, maintenance reminders to
  status page subscribers, unchecked-browser-monitor digests, custom-domain notices and monthly reports of the workspace
  are not claimed, so nothing is sent.
- **Webhook inboxes** (hosted edition): the public receiver answers 403 for the workspace's inboxes after verifying the
  secret URL and before reading or storing the request body. A wrong secret still gets the ordinary 404.
- **Public status pages**: the page, its summary, incident history, maintenance list, RSS, iCalendar and `llms.txt`
  feeds, the public MCP tools that read them, and the subscription form answer 404, as for a page that does not exist
  (the public lookup by slug, `statusPageBySlug`, does not find pages of suspended workspaces). Share links and password
  unlock fail as for a missing page. The status badge shows "unknown", as it does for a missing page. Unsubscribe links
  keep working.

**Nothing is deleted.** Monitors, incidents, history, members, keys and pages stay as they were. Unsuspending deletes the
row and everything works again: monitors that fell behind restart from the next scheduler tick (they do not catch up
missed checks), and alerts that were due while suspended are sent then.

## What the customer sees

Each suspend and unsuspend writes an event into the **suspended workspace's own audit log**:
`workspace.suspend` / `workspace.unsuspend`, actor type `system`, actor label "Montral operator", target the workspace,
and `changes.values.reason`. The operator's identity and the note are not written to the customer's log. Because the
whole workspace API is refused while suspended, the customer can read these events once the workspace is unsuspended.

The server also logs one line per action (`operator action: suspend workspace=<id> operator=<user id> reason=<reason>`),
without the note.

## Probe regions

The restricted, unlinked platform console at `/app/operator` can display the latest 50 drain/undrain events for each configured or formerly configured region, including the timestamp, action, operator identity and private note. This read-only view uses the existing MFA-protected audit API and never makes events available to customer workspaces.


Remote check regions are deployment configuration (`PROBE_REGIONS`, `PROBE_SECRET` and optional private `PROBE_SECRETS`; see [EDGE-PROBE.md](EDGE-PROBE.md)).
What the platform learns about them at run time is stored per region in `probe_region_state` (migration
`0059_probe_region_state`, augmented by `0060_probe_region_operator_audit`). Operator drain and undrain history is
stored in an append-only `probe_region_drain_event` table in migration `0060`:

| Endpoint | Does |
| --- | --- |
| `GET /api/operator/probes` | Every configured region, plus any region with stored state that is no longer configured (`configured: false`): `status` (`up`, `unreachable`, `drained` or `unknown`), `lastAnswerAt`, `lastUnreachableAt`, `lastUnreachableReason`, `unreachableSince`, the drain fields and how many unpaused monitors list the region. `auto.monitors` counts monitors on this deployment's own location. |
| `POST /api/operator/probes/:id/drain` | Body `{"note"?: string}` (at most 200 characters). Only a configured region; `auto` cannot be drained. |
| `POST /api/operator/probes/:id/undrain` | Puts a region back and saves `lastUndrainedBy` and `lastUndrainedAt`. Both write routes refuse a body that is not a JSON object (400) or is over 2 KiB (413); an empty body is fine. |
| `GET /api/operator/probes/:id/audit?limit=50` | Latest 1 to 100 (default 50) drain and undrain actions in descending event ID order, with action, operator ID, timestamp and optional note. Customer sessions, API keys and non-MFA operator sessions get 403. |

- **Health** is written by the scheduler as it asks probes (scheduled and manual checks, and spot checks): a probe that
  answers sets `lastAnswerAt` and ends an unreachable streak; one that cannot be asked sets `lastUnreachableAt`, the
  reason (one of the fixed strings of `apps/api/src/probes.ts`, never a raw network error) and, at the start of the
  streak, `unreachableSince`. Writes are not awaited by the check (a failure is logged and dropped) and are throttled
  twice: per process, and in the database by a conditional upsert, to at most one write per region per minute, or per
  10 seconds when the region flips between answering and unreachable. A region is
  `unknown` when it has neither answered in the last 15 minutes nor been seen failing (for example when no monitor uses
  it). A probe that answers but lacks a capability a check needs is not counted either way.
- **Drain** stops the scheduler from asking the region, on every server within 15 seconds (at once on the server that
  took the call). Monitors that list it keep it; the region simply does not vote. If every region of a monitor is
  drained or unreachable, the check runs from the deployment itself, as before. A single remaining region that fails
  is confirmed from the deployment before an incident opens (see "Multi-region confirmation" in EDGE-PROBE.md), so
  draining one region of a multi-region monitor does not let the remaining region page on its own. This is not a
  guarantee against every false incident: when **every** region of a monitor is drained (or unreachable) and its target
  only accepts traffic from the probes, the fallback check from the deployment itself can fail and page, exactly as
  when all probes are unreachable. Spot checks from a drained region answer `502 probe_unreachable` and take no credit.
- Drains and undrains are platform actions, not customer changes. The region state update and an append-only
  `probe_region_drain_event` with the operator user ID, timestamp, action and drain note commit in **one transaction**;
  a failed audit insert rolls the state change back. The latest operator to lift a drain is preserved on the state row.
  The action is also logged as a server line (without the note), but not placed in any customer's audit log.
  Only the verified platform operator API exposes the event history. Repeating an action records another operator
  command; direct internal seed calls with no operator ID do not generate impersonated audit events.
- Credentials: the merged #118 supports staged rotation of a shared `PROBE_SECRET` (there is not yet a registration API). Proposed separate per-region keys (pending exact-head CI) may be stored privately in API `PROBE_SECRETS`; a per-region key takes precedence over the shared fallback, and an invalid credential map fails closed. The staged rotation uses a temporary old `PROBE_PREVIOUS_SECRET` **only until `PROBE_PREVIOUS_SECRET_EXPIRES_AT`**: deploy every probe with new primary + old previous and bounded UTC expiry, switch the API signing key only once every probe is ready, and remove the old key after in-flight checks drain. Expiry is enforced automatically, but revocation across old deployments is not. A key-isolation config is not operator registration, attestation or managed key storage. See [probe rotation instructions](../apps/probe/README.md#staged-signing-key-rotation).

## Limitations

- The unlinked operator console at `/app/operator` supports workspace and probe controls; the operator API still enforces authentication, MFA, rate limits and audit writes. Members of a suspended workspace see a dedicated notice in the web app instead
  of the page (what is paused, that nothing is deleted, to contact support; never the reason or note), triggered by
  the first `workspace_suspended` refusal; see [CUSTOMER-ONBOARDING.md](CUSTOMER-ONBOARDING.md#suspended-workspace).
  Members can still switch to another workspace from the workspace menu (the auth API).
- Previously queued checks are refused when a suspension is visible before monitor load or start (#109). The merged in-flight observation fence (#116, 16/16 exact-head PR checks) locks the organization row `FOR KEY SHARE` inside the result transaction before checking suspension; the operator's `FOR UPDATE` suspension lock serializes the two. Once suspension commits, even an already-started check or heartbeat cannot persist a new observation on the updated backend. The external probe may already have run and consumed credits before suspension, and an already-claimed alert delivery or legacy/older replica may still race. This is not cancellation of an outbound request.
- Montral-owned cached status responses are bypassed after a missing or suspended slug is detected (#107); already-delivered external browser/CDN responses may live until their original TTL.
- A webhook body that started streaming before suspension is rechecked at the final PostgreSQL insert boundary. A
  capture takes an organization key-share lock that conflicts with the operator's suspension lock: if suspension
  commits first, the event is not stored. If the capture takes the lock first, it commits before suspension can
  commit. This applies to both capture SQL versions. Mid-flight refusals appear as a generic 404 and refund the
  reserved webhook-event meter charge. Older app replicas must be upgraded before this guarantee applies.
- Operators must sign in with email and password plus a second factor; operator accounts that only have GitHub or SSO
  sign-in cannot act as operators.
- **Workspace SSO**: starting a new `/api/auth/sso/start` flow for a suspended workspace returns the same generic 404 as an unconfigured connection, without naming the suspension. An already-started `/api/auth/sso/callback` flow is refused before provider token exchange, user linking, session creation or JIT provisioning. JIT provisioning and first-time identity linking lock the organization row before checking suspension inside their respective write transactions, serialized against the operator's suspension write. Existing identities also recheck suspension after provider exchange. Instance-wide SSO remains available for other workspaces. A suspension committed between the final SSO check and creation of an existing user's general session can leave an authenticated session, but it cannot grant access to the suspended workspace because its API/credentials are independently blocked by the suspension gate. The SSO refusal code is generic `connection_disabled` and never returns an operator reason or note.
- **SCIM 2.0** (`/api/scim/v2`) bearer authentication, metadata and user reads still work during a suspension. New
  user provisioning (`POST /Users`) and reactivation or attribute-only updates (`PUT`/`PATCH` without `active=false`)
  are refused with a SCIM-formatted 403. A provider may still deactivate an existing user (`PUT` or `PATCH` with
  `active=false`) or delete an existing SCIM user record (`DELETE /Users/:id`), ending membership, sessions and pinned
  keys. The suspended workspace's operator reason and note are never returned. SCIM writes lock the organization row
  before inspecting suspension within their transaction, serialized with operator suspension. Historical read-only SCIM
  data remains available for the provider to reconcile removals.
- Custom-domain verification rechecks still run for the workspace's status pages (their notices are queued but not
  sent until unsuspension). Account mails (password reset, verification) are not affected.
- A `payment` suspension blocks the whole workspace API, including the billing pages and checkout routes the hosted
  edition mounts behind `requireOrg`: the customer cannot settle the bill themselves while suspended. An operator has to
  unsuspend the workspace (for example after payment is arranged out of band). The payment provider's webhook
  (`/api/billing/lemon`) is not behind `requireOrg` and keeps being processed.
- Workspace suspension actions are still recorded in the affected customer's audit log and the server log,
  not in a general platform audit table. Probe drain/undrain actions now have their own append-only platform audit
  history; the operator plane still has no unified audit history across all other actions.
- Probe regions are still registered through `PROBE_REGIONS`: there is no API to add or remove one, no per-probe
  credential and no secret rotation window. Probe-region credits are reserved up front and unused credits from
  regions that returned no result are refunded after measurement; there are no persistent customer-facing counters
  of usage by region yet.
