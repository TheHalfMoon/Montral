# Channel project authority

## Boundary

Two distinct findings share this fix: scoped channel-delete conflicts disclosed other projects' monitor identities, and explicit monitor channel references could select another project's destination. Workspace-wide channels remain shared recipients. Project-bound channels may receive only events from their own project and organization.

DELETE now checks the channel's mutation authority before querying dependencies. A project grant cannot mutate a workspace channel even though it may read/use it. Unauthorized or absent resources retain the idempotent 204 response. Authorized channels with any hidden consumer return a fixed 409 without names, IDs or counts; unrestricted managers retain the existing conflict details and public response shape.

Monitor create validates channel references against the destination project; PATCH uses the stored monitor project rather than the active project header. Missing, foreign-workspace and other-project references share a generic 400. Duplicate IDs, shared channels, clearing references and unrelated edits to legacy records remain supported.

Repository selection applies the project predicate to explicit references as well as automatic selection. Fanout filters before queueing, disabled-channel logs and locale resolution. Escalations filter before duplicate notices and timeline text. The common execution boundary also skips historical invalid retries before quota/provider work. Personal escalation channels remain workspace-wide. No historical delivery metadata cleanup is claimed.

## Validation

- RED: four delivery tests sent four recipients instead of the two authorized controls through durable fanout, no-row fallback, retries and escalation notices. Database tests accepted cross-project writes/selection and returned 409 with dependencies to a forbidden DELETE.
- GREEN: focused alert suites passed 96 tests; database authority and real OAuth grants passed 5/5. Controls exercise shared/same-project channels, duplicate references, stored-versus-active project, clearing, legacy unrelated edits, generic hidden-consumer refusal and unrestricted manager conflict details.
- API and PostgreSQL package TypeScript, Node production bundle, source identity and whitespace checks passed.
- One independent fresh prepatch boundary investigation and one independent postpatch bypass/regression review completed. Postpatch review found no actionable remaining issue; its focused unit verification passed 109 tests with five database-gated skips.
- First full API run: 1,591 passed, four failed, 31 skipped. Failures were signup rate limiting, delayed-response timing and operator/SSO timeouts. Isolated rerun and resource-bounded full qualification remain pending; these failures are not counted as passes.

All tests use synthetic recipients and a disposable localhost database. No production notifications, deployment, release or publication. Hosted qualification requires all 16 checks on the latest PR head and all 11 integrated-main workflows after merge.
