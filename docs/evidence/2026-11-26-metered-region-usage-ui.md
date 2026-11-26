# Metered regional usage in the customer UI

## Gap

The metered `/api/usage` response already included persistent per-region reservations and settlements, but the Plan & usage page displayed only workspace-wide meters. Customers could not see how reserved, completed, unavailable, unverified, charged, and refunded regional work contributed to the aggregate credit balance.

## Change

The metered Plan & usage page now displays the existing current UTC-month region summary per region. It shows planned checks, observed results, failed results, unavailable results, active reservations, unverified reservations, credits charged, and credits refunded. It also explains that an unavailable or unverified result cannot prove that no remote work occurred and that unverified reservations are not automatically refunded. An empty month has an explicit empty state.

The unmetered Community view remains unchanged. The display does not infer remote acceptance, retroactively change balances, or turn operational counters into charges. Historical per-region reconciliation remains unsupported because the aggregate ledger lacks the necessary regional outcome evidence.

## Regression coverage

The web component test verifies the full breakdown, UTC month label, uncertainty/refund explanation, and empty state. The hosted usage browser journey uses synthetic metered data to verify the customer view and accessibility, and asserts that the unmetered Community usage page has no regional meter.
