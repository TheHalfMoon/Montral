# Incident status draft preservation across asynchronous refresh

## Observed failure

During real Chromium qualification for PR #11, strict persistence assertions
caught a synthetic private incident update written with status `investigating`
instead of the user's previously selected `identified`. The PostgreSQL
update's visibility was correctly `internal` and its text was exact.
This showed that the UI submitted the old status, not a stale API read or an
incorrectly formatted note.

## Mechanism and fix

The IncidentDetail component's `load()` unconditionally synchronized the
editable status selection from the last completed detail response. A request
initiated before the user's selection (such as an acknowledgement reload)
could therefore overwrite a newer draft after it finished. The component now
tracks whether the status has been edited by the user, and preserves that
selection across late detail reloads. After a successful update it clears
the draft-edit flag and reloads the persisted status as before. Failed
updates continue to preserve the user's draft, and navigation to a new
incident clears the edit flag.

## Qualification scope

The real Chromium smoke now selects `identified` while the acknowledgement
refresh may still be in flight and verifies that the draft survives the
acknowledgement before submitting the internal note. It retains strict
PostgreSQL-backed status, visibility, acknowledgement and exact-text checks.
Both full hosted application CI and source-integrity must pass on the exact
PR head before private merge.

This is a browser state-race hardening, not proof of comprehensive
cross-browser accessibility, real external email delivery, failover or live
provider behavior. Repository remains private, with no deployment or billing.
