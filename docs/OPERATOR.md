# Operator control plane

Platform staff ("operators") of a hosted Montral deployment can look up workspaces and suspend or unsuspend them. This
is a minimal, API-only control plane (`/api/operator/*`, implemented in `apps/api/src/operator.ts`). There is no
operator UI yet.

## Who is an operator

A request is an operator request only when **all** of these hold:

1. The deployment sets `MONTRAL_OPERATOR_USER_IDS` to a comma-separated list of user ids, and the signed-in user's id is
   in it. Unset or empty means there are no operators, and every operator endpoint answers 403.
2. The request is authenticated by a signed-in **browser session** (the Better Auth session cookie). A request that
   carries an `Authorization` or `x-api-key` header is refused, even with a valid operator session cookie next to it.
   API keys and OAuth/MCP agent tokens can never act as an operator.
3. The user has two-factor authentication enabled (`user.two_factor_enabled`). This is read from the database on every
   request, so turning two-factor off ends operator access immediately.
4. Writes (`POST`) come from the web app's own origin (the same cross-site request check as the workspace API).

Anyone else, signed in or not, gets the same `403 {"error":"Forbidden"}`. The response does not say whether operators
exist or which check failed.

Operator routes are rate limited per client address (before the session is looked up) and per operator; suspend and
unsuspend have a tighter per-operator limit. Every operator response is `cache-control: no-store`.

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
changes and records nothing.

The suspension is one row in `workspace_suspension` (migration `0058_workspace_suspension`). While it exists:

- **Workspace API**: every request that acts in the workspace (`requireOrg` in `apps/api/src/middleware.ts`) gets
  `403 {"error": "...", "code": "workspace_suspended"}`: sessions, API keys and OAuth/MCP agents alike, reads and writes.
  This includes the workspace's own audit log and `/api/me` while that workspace is the active one.
- **Checks**: the scheduler does not claim the workspace's monitors (`claimDue`), so no checks run and no credits are
  used.
- **Heartbeats**: pings to the workspace's heartbeat URLs get the same 403 and record nothing.
- **Alerts**: alert deliveries and their retries, incident reminders, escalations, maintenance reminders to status page
  subscribers, unchecked-browser-monitor digests and monthly reports of the workspace are not claimed, so nothing is
  sent.
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

## Limitations

- API only; there is no operator UI, and the web app shows suspended members a generic error rather than a dedicated
  "suspended" screen. Members can still switch to another workspace through the auth API.
- A session created before the user enabled two-factor counts once two-factor is on; operators should sign in again
  after enrolling.
- Checks already queued when the suspension is written still run (at most one per monitor). Public status responses
  may be served from the 30-second public cache for that long after suspending. A webhook body that was being read when
  the suspension was written is still stored.
- Better Auth's own endpoints under `/api/auth/*` (organization membership, invitations, API key management) do not
  pass `requireOrg` and are not blocked; a key created there is still refused by the workspace API.
- SCIM provisioning (`/api/scim/v2`) of the workspace keeps working, so the customer's identity provider can still
  deprovision users during a suspension.
- Custom-domain notices (`domain.*`) and other mails not listed above are not suspended.
- Operator actions are not written to a separate platform-level audit trail; the record is the customer's audit log
  plus the server log line.
