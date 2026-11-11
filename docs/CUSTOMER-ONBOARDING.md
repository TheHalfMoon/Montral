# Customer onboarding and usage UX

What a customer sees in the web app on first run, as an allowance fills up, when the API refuses work because an
allowance is used up, and when an operator has suspended their workspace. Plan names, allowances and prices are never
part of the web app: they come from the operator's plan catalog through the API ([PLAN-CATALOG.md](PLAN-CATALOG.md)),
and prices only where [BILLING-SANDBOX.md](BILLING-SANDBOX.md) allows (`MONTRAL_BILLING_SHOW_PRICES`).

## Metered and self-hosted

`GET /api/usage` decides. A deployment without plans (community self-hosted, `MONTRAL_METERING_ENABLED` unset) answers
`{"metered": false}`, and the web app then shows **no usage banner, no meters, no upgrade link and no Plan & usage entry**.
Only the hosted edition answers `metered: true`.

| | Self-hosted (`metered: false`) | Hosted (`metered: true`) |
|---|---|---|
| First-run checklist | Yes | Yes |
| Usage banner (≥ 80 % / used up) | Never | Yes |
| Plan & usage page, meters | "No plans or usage limits" | Meters with near-limit and used-up states |
| Quota refusals (402/429) | Never returned | Explained with reset date and upgrade link |
| Suspended-workspace notice | Only if an operator suspends (hosted feature) | Yes |

## First-run checklist

On the Monitors dashboard (`apps/web/src/components/Onboarding.tsx`, logic in `apps/web/src/lib/onboarding.ts`):

1. Create your workspace (always done)
2. Add your first monitor
3. Connect an alert channel
4. Publish a status page (optional)

Each step's state is derived from the workspace's real data (`/api/monitors`, `/api/channels`, `/api/status-pages`);
nothing records progress on the server. The checklist is the empty state of a workspace without monitors. After the
first monitor it stays **below** the list until a monitor **and** an alert channel exist (the status page is optional),
and the customer can hide it with **Hide checklist**. It renders only once the counts and the hidden flag are both known,
and below the list, so arriving late it never moves the list or the controls above it, and never flashes in and out. Hiding is remembered in the browser (`localStorage`, per workspace), not
on the server. The read-only "All projects" view never shows it.

## Usage page and banner

`GET /api/usage` (metered) returns one quota object per meter (`credits`, `emails`, `webhookEvents`, `browserSeconds`;
each `{limit, used, periodStart, periodEnd}`), the plan from the catalog, and `periodEnd`: when the allowances reset.
In this preview every meter counts the calendar month in UTC, so `periodEnd` is 00:00 UTC on the first of next month.

- **Meters** (Plan & usage): a progress bar per meter, amber from 80 % ("Used N%"), red once used up ("Used up", with an
  upgrade link). An allowance of zero (the plan does not include that meter) never counts as used up.
- **Banner** (`UsageBar.tsx`, every app page): shown when any meter is at 80 % or more ("Nearly used up for this period")
  or used up ("Used up for this period", which wins), naming the meters and the reset date (UTC), with links to
  **View usage** (`/app/usage`) and **Upgrade plan** (the plan's `upgradeUrl`, else `/app/billing`, the sandbox billing
  page). Dismissing hides that exact notice for the browser session; a new state (for example near → used up) shows
  again. A quota refusal anywhere in the app refreshes it. The banner sits above the page, so to never push the page
  down under a click on revisits, the tab remembers the notice last shown in `sessionStorage` (state, meter keys,
  reset date, upgrade path; no usage figures) and paints it with the page; usage then confirms, updates or clears it,
  and the memory is cleared once usage is back under 80 % or the workspace changes. Usage is read once per load: the
  shell's early `/usage` read answers both the Plan & usage nav entry and the banner.

## Quota refusals

| Code | Status | Where | `resetsAt` in the body |
|---|---|---|---|
| `credits_exhausted` | 402 | Manual check (`POST /api/monitors/:id/check`) | Yes |
| `browser_quota_exhausted` | 402 | Manual browser check | Yes |
| `webhook_quota_exhausted` | 429 | Webhook receiver (the sender sees it, with `Retry-After`) | No |

`resetsAt` is the end of the period the edition reports for that allowance, else the next UTC month
(`allowanceResetsAt` in `apps/api/src/entitlements.ts`). The web app (`lib/usage-alerts.ts` → `QuotaNotice.tsx`) turns
these codes into a sentence with the reset date and links to usage and billing instead of the API message. A check is
refused when what is left does not cover it (a browser check reserves its whole timeout), so the wording is "not
enough … left this period for this check", with the reset date the refusal gives. Other
refusals (`monitor_limit`, `interval_not_allowed`, `metering_unavailable`, rate limits) keep their existing handling.

## Suspended workspace

While an operator has suspended a workspace ([OPERATOR.md](OPERATOR.md#suspending-a-workspace)) every workspace API call
answers `403 {"code": "workspace_suspended"}`. The web client notices the first such refusal (`lib/api.ts`) and the app
shell replaces the page with a notice (`Suspended.tsx`): the workspace is suspended, nothing is deleted, checks, alerts,
webhook capture and public status pages are paused, everything resumes when the suspension is lifted, contact support.
It never shows the reason or the operator's note (the API does not reveal them) and does not link to billing, which is
also refused while suspended. A refusal counts only for the workspace the request was made in (a late answer from the
previous workspace cannot flag a new one); switching workspace clears the notice, and so does a later workspace call
that succeeds (the suspension was lifted).

## Tests

- Web unit tests: `apps/web/src/lib/usage-alerts.test.ts`, `onboarding.test.ts`, `api-refusals.test.ts`; the zh
  dictionary test covers the new strings.
- API: `apps/api/src/entitlements.test.ts` (reset instant), `montral-metering.e2e.test.ts` (`/usage` fields, `resetsAt` on
  `credits_exhausted` and `browser_quota_exhausted`, PostgreSQL).
- Cross-browser: `e2e/tests/cloud-usage.spec.ts` runs in all five Playwright projects with WCAG 2.1 AA checks. The server
  under test is self-hosted (unmetered), which the test checks first; the metered and suspended states are synthetic API
  responses (`page.route`).

## Limitations

- Hiding the checklist is per browser; another browser or device shows it again until the steps are done.
- The banner reads usage when the app loads, on workspace switches and after a quota refusal; it does not poll.
- On the first load of a tab (nothing remembered yet) the banner still appears once usage arrives; revisits paint it with
  the page. When usage drops back under 80 % the remembered banner disappears, which moves content up, never down.
- An email allowance used up raises the banner and the meter, but no refusal reaches the web app: alert emails past the
  allowance are recorded as skipped in the alert log ("email allowance used up for this period").
- Members who cannot open the billing page (it needs a workspace manager) still see the upgrade link; the billing page
  then explains the refusal.
