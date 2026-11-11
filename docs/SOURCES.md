# Montral source identity

Montral is maintained as a unified application with its own monitoring API,
web interface, probes, webhook handling, scheduler, and developer interfaces.

There is no duplicate source archive under `vendor/`. The canonical
implementation is under `apps/`, `packages/`, and the Montral deployment
and tooling directories. CI validates the source identity with
`python3 scripts/verify_sources.py` and the active branding guard.

The Montral license is in LICENSE. Historical archived qualifications refer to the repository
state at the time they were recorded; they are not current build requirements.
