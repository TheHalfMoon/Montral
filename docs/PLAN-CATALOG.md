# Plan catalog (metered cloud deployments)

A metered Montral deployment (`MONTRAL_METERING_ENABLED=true`) reads which plans it offers, and what each plan
allows, from an **operator-supplied plan catalog**. The catalog is deployment configuration, like a secret: keep it
outside this repository and outside any image.

The Community (self-hosted) edition is unmetered and never reads a catalog.

## Supplying it

| Runtime | Variable | Value |
|---|---|---|
| Node / Docker | `MONTRAL_PLAN_CONFIG` | Path of the JSON file, read once at start. Mount it read-only into the container, for example `/run/secrets/montral-plans.json`. |
| Workers, or any secret store | `MONTRAL_PLAN_CONFIG_JSON` | The JSON document itself. |

If neither is set, the built-in **sandbox** catalog applies: the preview limits in
[BILLING-SANDBOX.md](BILLING-SANDBOX.md). These are not a commercial offer.

## Failure behaviour (fail closed)

- **The file cannot be read, or the document is invalid.** The Node server refuses to start. On Workers, every
  metered call fails. A broken catalog is never replaced by a guess, so it can neither grant paid access nor lift a
  limit.
- **A metering call fails at run time** (catalog or ledger unavailable). A metered deployment grants nothing:
  - scheduled checks are skipped and come due again;
  - browser checks do not run (a manual one answers 503 `metering_unavailable` when its browser seconds cannot be
    reserved);
  - the webhook receiver captures nothing and answers 503 `metering_unavailable`;
  - status-report and digest emails are not sent. Incident alert emails are still sent, because they are the product's
    core promise, and they remain bounded by incident deduplication.

  Skipped work is never recorded as a check result. Heartbeat monitors cost nothing and are unaffected. The
  self-hosted edition instead keeps monitoring and logs the gap. In both cases the log names the cause (catalog or
  ledger) at most once a minute.
- **A subscription names a plan that is not in the catalog.** The workspace gets the catalog's `defaultPlan`, and
  one warning is logged.
- **Error messages** name the path of each problem (for example `plans.2.limits.credits`) but never a value found
  there. The server logs only the catalog's `version` label and content hash, never prices or allowances.

## Schema (version 1)

```jsonc
{
  "schemaVersion": 1,
  "version": "2026-11-example",        // operator label; reported with a content hash as "label@hash"
  "defaultPlan": "free",                // the plan for workspaces without a valid subscription (the least one)
  "plans": [
    {
      "id": "free",                      // [a-z][a-z0-9_-]{0,31}
      "name": "Free",
      "limits": {
        "activeMonitors": 3,             // monitors that may be active at once
        "minIntervalSec": 840,           // fastest interval, 60–86400 (API floor; sub-minute intervals are not supported)
        "regions": 1,                    // regions per monitor, 1–64
        "credits": 1000,                 // monthly outbound-check credits (one per regional check attempt)
        "emails": 10,                    // monthly notification emails
        "webhookEvents": 300,            // optional: monthly webhook requests the inbox receiver captures
        "browserSeconds": 1200           // optional: monthly browser-check runtime, in seconds
      },
      "features": []                     // only features Montral enforces: "hideBranding"
    },
    {
      "id": "team",
      "name": "Team",
      "limits": { "activeMonitors": 40, "minIntervalSec": 120, "regions": 2, "credits": 77000, "emails": 400 },
      "features": ["hideBranding"],
      "providerVariants": ["900001", "900002"],  // billing provider variant ids that subscribe to this plan (optional)
      "price": { "amountMinor": 4321, "currency": "EUR", "interval": "month" }    // metadata only
    }
  ],
  "overrides": [                         // per-workspace contracts (enterprise), optional
    { "organizationId": "org_…", "plan": "team", "limits": { "credits": 150000 }, "note": "contract 2026-07" }
  ]
}
```

The numbers above are illustrative and describe no Montral offer.

**Rules.** Every count is a non-negative integer of at most 2,000,000,000. "Unlimited" does not exist: a flat fee
never implies unlimited checks, regions or notifications. Unknown fields are refused. Plan ids are unique.
`defaultPlan` and override plans must exist. Overrides replace the listed limits only, and those limits keep applying
when the workspace's subscription changes (an override without `plan` caps every plan the workspace moves to).
Overrides may also raise limits; record why in `note`.

**Resource meters (`webhookEvents`, `browserSeconds`).** Both are optional, so a catalog written before they existed
stays valid without edits. An absent meter is **never unlimited**: it gets the built-in conservative default
(`METER_DEFAULTS` in `apps/api/src/plan-catalog.ts`, the built-in Free plan's values: 500 webhook events and 1,800
browser seconds a month), whatever the plan. Write the number to give a plan more, or `0` to give it none. An override
may name either meter on its own.

- **`webhookEvents`**: one per request the public receiver (`/api/hooks/receive/…`) accepts, charged *before* the
  event is stored. When the allowance is used up the receiver answers **429** with code `webhook_quota_exhausted` and
  `Retry-After` set to the seconds until the **actual webhook-meter period end** reported by the edition,
  plus an ISO `resetsAt` response field. The hosted preview still uses calendar months (00:00 UTC on the 1st);
  when the balance is unavailable or stale the receiver falls back to that UTC boundary. It stores nothing. A capture that
  then stores nothing (the inbox was deleted meanwhile, or the database failed) gives its event back. The per-inbox
  rate limit still applies first, and a rate-limited request costs nothing.
- **`browserSeconds`**: each browser check reserves its journey's configured total timeout (`browser.timeoutMs`,
  rounded up to whole seconds), at the same instant its credits are taken. After the run the unused seconds (the
  reservation minus the run's wall time, rounded up, never negative) are refunded to the month of that instant, so a
  check that straddles midnight on the 1st never inflates the new month. A deferred check, or one the browser runtime
  could not run, refunds everything. A check the remaining seconds cannot cover does not run: its credits and any
  partial grant are given back, and the attempt counts on the monitor's deferral streak (a visible `deferred` run at
  most once per interval; after 3 intervals the monitor is shown as unchecked and its owners and admins are told).
  It is never recorded as a check result. A manual check answers **402** `browser_quota_exhausted`.

Both meters show on the Usage page and in `GET /api/usage` (`webhookEvents`, `browserSeconds`).

**Release note (upgrading).** An existing operator catalog without `webhookEvents`/`browserSeconds` keeps loading, but
from this release **every plan in it, paid plans included, gets the Free defaults above for both meters** until the
operator adds the fields. Add them to each plan before (or right after) upgrading a metered deployment.

**Known accounting gaps (bounded).**
- A process killed between a browser check's reservation and its refund (crash, deploy, OOM) keeps that check's
  reservation charged: at most one journey timeout's worth of seconds per check in flight. Nothing reconciles it later.
- A webhook capture is charged before it is stored. If the process dies after the charge and before the insert (or the
  refund after a failed insert fails too), the event stays charged although nothing was stored: at most one event per
  request in flight.
- A metering outage refuses browser checks without recording a result, but each refusal counts on the monitor's
  deferral streak (reason "Usage metering unavailable"), so after 3 intervals the monitor is shown as unchecked and its
  owners and admins are told.

**Billing: provider variants.** `providerVariants` lists the billing provider's variant ids (Lemon Squeezy variant
ids, written as decimal strings) that subscribe a workspace to the plan. Rules: each id is a positive decimal number of
at most 24 digits; an id may appear only once in the whole catalog (one variant, one plan); the `defaultPlan` cannot
list variants (it is what a workspace without a subscription gets, so it is never sold). The field is optional, and a
catalog without it stays valid (schema version 1 is unchanged for existing catalogs).

- **Catalog-driven (any plan lists `providerVariants`).** Billing maps every signed provider event's variant to a plan
  through the catalog. A test checkout can be opened for every plan that lists at least one variant (it uses the
  plan's first variant); any other plan id is refused (400). A `subscription_updated` event naming another plan's
  variant moves the workspace to that plan (upgrade or downgrade), in provider order. An event naming a variant no
  plan lists still applies its status, deadline and ordering (a cancellation or expiry always takes effect), but the
  plan change is refused: the stored plan and variant stay. `LEMONSQUEEZY_VARIANT_PRO`/`_BUSINESS` are ignored.
- **Environment fallback (no plan lists variants, e.g. the built-in sandbox catalog).** `LEMONSQUEEZY_VARIANT_PRO` and
  `LEMONSQUEEZY_VARIANT_BUSINESS` map to the plan ids `pro` and `business`, so the catalog must define both; a
  catalog without them is refused (every metered call fails) rather than silently moving paying workspaces to the
  default plan.

Removing a variant from the catalog does not move existing subscribers: their stored plan id stays, and their
cancellations and expiries still apply. The Node server logs a start-up warning with the number of live subscriptions
using unlisted variants or plan ids the catalog no longer defines. Removing a plan does: a subscription naming a plan the catalog no longer has gets the default
plan (see Failure behaviour).

**Prices.** `price` is metadata. `GET /api/billing/plans` returns it only when the deployment sets
`MONTRAL_BILLING_SHOW_PRICES=true` (off by default: no price field at all), so prices stay private until the owner
publishes them.

## Changing plans and allowances

Limits are read when the usage is taken. A changed catalog (after a restart, or a new secret on Workers) therefore
applies at once:

- **Lowering an allowance mid-period** grants nothing beyond the new limit. Usage already counted stays counted.
- **Moving a workspace to another plan** (through its subscription or an override) applies from its next metered
  action.

Usage periods are calendar months in UTC.

Each replica reports the catalog it loaded as `label@hash` in its start log. If two replicas show different hashes,
they are serving different catalogs.
