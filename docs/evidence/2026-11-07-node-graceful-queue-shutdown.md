# Node queue graceful shutdown - private engineering qualification

## Failure mode
During SIGTERM, the in-process queue may hold delayed/ready leased monitors and
four running check handlers. The previous server shutdown immediately closed
the database pool, even though running handlers could still persist monitoring
results. Unstarted messages could be lost until another scheduled claim.

## Change
The in-process queue now stops accepting batches, cancels delayed timers,
returns **only never-started** ready/delayed messages, and waits up to a bounded
deadline for running handlers. The Node shutdown path conditionally releases
unstarted claims using the existing database lease tokens before closing the
pool. Running claims are NEVER released while their work may still write,
so no duplicate concurrent execution is created by this shutdown path.
Repeated signals are idempotent. The global hard exit remains bounded.

## Tests and limits
Deterministic focused tests cover mixed running/ready/delayed messages,
claim-token extraction and refusal of malformed/missing tokens, reentrant
shutdown, rejection of new work, canceled delayed timers, running-handler
completion and timeout. Exact-head supported-runtime GitHub app CI and source
integrity checks are mandatory before private merge.

This is NOT durable queueing. A SIGKILL or process crash still loses locally
queued work; a previously begun check may not be replayed, as documented by
the scheduler's at-most-once run semantics. Shutdown token release is
best-effort if the DB itself is down. Real hosted container lifecycle,
multi-replica ownership, failover, DNS/egress, production SMTP and payment
gates remain NO-GO and require separate qualification. No deployment or paid
service was used.