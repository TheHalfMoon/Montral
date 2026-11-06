# Node local check queue stall detection (engineering qualification)

## Failure mode
The self-hosted Node server has two independent execution paths: the scheduled
tick and its in-process delayed/ready/running check queue. A queue handler may
never resolve after its tick has already finished. The existing tick-only
watchdog cannot detect this. Since reservations include running handlers,
repeated stalls can consume the 512-message capacity while /health and cron
continue operating.

## Change
- Track the monotonic start time of each actively running local handler.
- Expose oldestRunningAgeMs() as a read-only health observation; never count
  delayed or completed queue entries, and clear the observation when a handler
  settles, whether it resolves or rejects.
- In the Node server's 30-second watchdog, exit with a constant, secret-free
  diagnostic if any running handler is older than the same five-minute budget
  used for a hung scheduler tick.
- Do not time out an operation and free its reservation while the underlying
  promise can still write state. Preserve atomic sendBatch and backpressure.

## Qualification and limits
Focused synthetic queue tests use an injected clock for repeatable 800ms and
700ms oldest-handler ages and zero after completion, while keeping delayed
items outside the running metric. Existing backpressure tests must remain
green. Both supported-runtime GitHub CI and source-integrity checks are
required on the exact PR head before merge.

**Not production qualification:** This is restart-based failure detection,
not durable queueing. A crash/restart may still drop an in-flight check until
the next scheduled monitor interval; there is no exactly-once or multi-replica
guarantee. No external monitoring providers, production deployment, paid
services, or customer data were used. Public/commercial release remains NO-GO.