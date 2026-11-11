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
  - browser checks do not run;
  - notification emails are not sent.

  Skipped work is never recorded as a check result. Heartbeat monitors cost nothing and are unaffected. The
  self-hosted edition instead keeps monitoring and logs the gap.
- **A subscription names a plan that is not in the catalog.** The workspace gets the catalog's `defaultPlan`, and
  one warning is logged.
- **Error messages** name the path of each problem (for example `plans.2.limits.credits`) but never a value found
  there. The server logs only the catalog's `version` label and content hash, never prices or allowances.

## Schema (version 1)

```jsonc
{
  "schemaVersion": 1,
  "version": "2026-11-example",        // operator label; reported with a content hash as "label@hash"
  "defaultPlan": "trial",               // the plan for workspaces without a valid subscription (the least one)
  "plans": [
    {
      "id": "trial",                     // [a-z][a-z0-9_-]{0,31}; stored on subscriptions
      "name": "Trial",
      "limits": {
        "activeMonitors": 3,             // monitors that may be active at once
        "minIntervalSec": 840,           // fastest interval, 10–86400
        "regions": 1,                    // regions per monitor, 1–64
        "credits": 1000,                 // monthly outbound-check credits (one per regional check attempt)
        "emails": 10                     // monthly notification emails
      },
      "features": [],                    // only features Montral enforces: "hideBranding"
      "providerVariants": []             // billing provider variant ids that subscribe to this plan
    },
    {
      "id": "team",
      "name": "Team",
      "limits": { "activeMonitors": 40, "minIntervalSec": 120, "regions": 2, "credits": 77000, "emails": 400 },
      "features": ["hideBranding"],
      "price": { "amountMinor": 4321, "currency": "EUR", "interval": "month" },   // metadata only
      "providerVariants": ["123456"]
    }
  ],
  "overrides": [                         // per-workspace contracts (enterprise), optional
    { "organizationId": "org_…", "plan": "team", "limits": { "credits": 150000 }, "note": "contract 2026-07" }
  ]
}
```

The numbers above are illustrative and describe no Montral offer.

**Rules.** Every count is a non-negative integer of at most 2,000,000,000. "Unlimited" does not exist: a flat fee
never implies unlimited checks, regions or notifications. Unknown fields are refused. Plan ids are unique. A
provider variant maps to exactly one plan. `defaultPlan` and override plans must exist. Overrides replace the listed
limits only.

## Changing plans and allowances

Limits are read when the usage is taken. A changed catalog (after a restart, or a new secret on Workers) therefore
applies at once:

- **Lowering an allowance mid-period** grants nothing beyond the new limit. Usage already counted stays counted.
- **Moving a workspace to another plan** (through its subscription or an override) applies from its next metered
  action.

Usage periods are calendar months in UTC.

Each replica reports the catalog it loaded as `label@hash` in its start log. If two replicas show different hashes,
they are serving different catalogs.
