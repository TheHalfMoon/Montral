# Contain errors from upstream HTTP response conversion

An attacker controlling a monitored public hostname could return HTTP status 600 through 999. Node's HTTP parser accepts these statuses, but the public Web Response constructor rejects them. The pinned transport constructed Response inside an asynchronous response callback without a catch, so the exception escaped the Promise and terminated the shared Node API process. Caller timeouts and the check's try/catch could not catch it. Workers and explicit private-target/native-fetch paths do not use this sink.

Two child-process regressions reproduced uncaught RangeError and process exit for 600 and 999 on supported Node 24.22.1. The fixture used a synthetic hostname pinned directly to a localhost server; no external host was contacted and production SSRF controls were not disabled.

The callback now rejects invalid statuses before creating response streams and catches conversion errors, destroys the upstream response and rejects using the existing fetch-failure contract. Valid status 599 remains readable. Native fetch itself can accept 600, so this is a controlled transport failure for previously crashing responses, not a claim of complete native-fetch parity. A malformed response is not a connection-establishment error and does not trigger the guarded fetcher's retry.

Validation: all 10 pinned transport tests pass; five transport, guard, checker and HTTP-request suites pass 95/95. API TypeScript, Node API build, source identity and diff checks pass. Hosted qualification is pending. Fresh independent source investigation identified the issue; one fresh independent postpatch review found no bypass or regression and independently passed the 10 nearest tests. No application-wide exception handler, schema change or dependency was added. Existing compression and cancellation behavior is retained.

No release, deployment, external notification or production exploit is claimed. All replicas need the updated code to eliminate the old callback path. The broader managed source audit remains partial.
