# Operator control plane

Platform staff ("operators") of a hosted Montral deployment can look up workspaces and suspend or unsuspend them, and
see and drain probe regions. This is a minimal, API-only control plane (`/api/operator/*`, implemented in `apps/api/src/operator.ts`). There is no
operator UI yet.

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

Operators **cannot** see, through this API: monitor targets, headers or bodies, alert channels and their settings,
incidents, status page contents, webhook payloads, API keys, member lists beyond the count and first owner email, or
the workspace's audit log. They cannot sign in as a customer, change a workspace's data, change plans or billing, or
delete anything.

## Suspending a workspace

`POST /api/operator/workspaces/:id/suspend` with `{"reason": "abuse" | "payment" | "legal" | "operator", "note"?: string}`
(note at most 500 characters, visible only to operators). Suspending an already suspended workspace replaces its reason
and note. `POST /api/operator/workspaces/:id/unsuspend` lifts it; unsuspending a workspace that is not suspended
changes and records nothing. A suspension or unsuspension and its audit event are written in one database
transaction: if the audit event cannot be written, nothing changes and the call fails.

The suspension is one row in `workspace_suspension` (migration `0058_workspace_suspension`). While it exists:

- **Workspace API**: every request that acts in the workspace (`requireOrg` in `apps/api/src/middleware.ts`) gets
  `403 {"error": "...", "code": "workspace_suspended"}`: sessions, API keys and OAuth/MCP agents alike, reads and writes.
  This includes the workspace's own audit log and `/api/me` while that workspace is the active one.
- **Checks**: the scheduler does not claim the workspace's monitors (`claimDue`), so no checks run and no credits are
  used.
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

Remote check regions are deployment configuration (`PROBE_REGIONS`, `PROBE_SECRET`; see [EDGE-PROBE.md](EDGE-PROBE.md)).
What the platform learns about them at run time is stored per region in `probe_region_state` (migration
`0059_probe_region_state`, a new table only):

| Endpoint | Does |
| --- | --- |
| `GET /api/operator/probes` | Every configured region, plus any region with stored state that is no longer configured (`configured: false`): `status` (`up`, `unreachable`, `drained` or `unknown`), `lastAnswerAt`, `lastUnreachableAt`, `lastUnreachableReason`, `unreachableSince`, the drain fields and how many unpaused monitors list the region. `auto.monitors` counts monitors on this deployment's own location. |
| `POST /api/operator/probes/:id/drain` | Body `{"note"?: string}` (at most 200 characters). Only a configured region; `auto` cannot be drained. |
| `POST /api/operator/probes/:id/undrain` | Puts a region back. |

- **Health** is written by the scheduler as it asks probes (scheduled and manual checks, and spot checks): a probe that
  answers sets `lastAnswerAt` and ends an unreachable streak; one that cannot be asked sets `lastUnreachableAt`, the
  reason (one of the fixed strings of `apps/api/src/probes.ts`, never a raw network error) and, at the start of the
  streak, `unreachableSince`. At most one write per region per minute and process, or when it flips. A region is
  `unknown` when it has neither answered in the last 15 minutes nor been seen failing (for example when no monitor uses
  it). A probe that answers but lacks a capability a check needs is not counted either way.
- **Drain** stops the scheduler from asking the region, on every server within 15 seconds (at once on the server that
  took the call). Monitors that list it keep it; the region simply does not vote. If every region of a monitor is
  drained or unreachable, the check runs from the deployment itself, as before. A single remaining region that fails
  is confirmed from the deployment before an incident opens (see "Multi-region confirmation" in EDGE-PROBE.md), so a
  drain does not cause false incidents. Spot checks from a drained region answer `502 probe_unreachable`.
- A drain is a platform action, not a customer change: it is logged as one server line
  (`operator action: drain region=<id> operator=<user id>`) and is not written into any workspace audit log.
- Credentials: all probes share `PROBE_SECRET`. Rotating it is a coordinated redeploy of probes and API (there is no
  overlap window yet); drain a region while its probe is being replaced.

## Limitations

- API only; there is no operator UI, and the web app shows suspended members a generic error rather than a dedicated
  "suspended" screen. Members can still switch to another workspace through the auth API.
- Checks already queued when the suspension is written still run (at most one per monitor). Public status responses
  may be served from the 30-second public cache for that long after suspending. A webhook body that was being read when
  the suspension was written is still stored.
- Operators must sign in with email and password plus a second factor; operator accounts that only have GitHub or SSO
  sign-in cannot act as operators.
- SCIM provisioning (`/api/scim/v2`) of the workspace keeps working, so the customer's identity provider can still
  deprovision users during a suspension.
- Custom-domain verification rechecks still run for the workspace's status pages (their notices are queued but not
  sent until unsuspension). Account mails (password reset, verification) are not affected.
- A `payment` suspension blocks the whole workspace API, including the billing pages and checkout routes the hosted
  edition mounts behind `requireOrg`: the customer cannot settle the bill themselves while suspended. An operator has to
  unsuspend the workspace (for example after payment is arranged out of band). The payment provider's webhook
  (`/api/billing/lemon`) is not behind `requireOrg` and keeps being processed.
- Operator actions are not written to a separate platform-level audit trail; the record is the customer's audit log
  plus the server log line.
- Probe regions are still registered through `PROBE_REGIONS`: there is no API to add or remove one, no per-probe
  credential and no secret rotation window. Credits are charged for every region a monitor's plan allows, including a
  region that was drained or could not be asked for that run.
