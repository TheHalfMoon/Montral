# Optional Edge probe upload deadline

Status: local implementation and independent review complete; hosted qualification and merge remain required.

## Finding and scope

A configured optional Edge Worker read up to 64 KiB before checking HMAC, but had no elapsed upload deadline. An unauthenticated caller reaching that configured Worker could keep a small POST incomplete. The checked-in example is disabled/unconfigured and no production exposure or platform-scale denial of service is claimed.

Incoming envelopes now reuse the original-stream byte/deadline reader introduced by the JSON-budget change. The 64 KiB limit and a fixed 10-second total upload window run before authentication. The direct Worker maps 413 and 408 to private JSON responses; unknown errors retain their existing propagation. It does not wait for cancellation. The original nonfatal text decoding, exact signed string, whitespace, Unicode, previous-key rotation and no-content-type behavior remain intact. GET, method refusal and unconfigured rejection remain before body consumption.

The outgoing response reader is deliberately unchanged: native fetch already receives its existing check timeout, and no separate upstream-body exploit was established. No new workspace or external package dependency was added; the probe follows its existing direct imports of shared API source. This branch depends on the shared-reader change in PR #136.

## Evidence

- Three new regressions fail on the old handler: empty/partial incomplete uploads have no 408 after 10 seconds, and synthetic nonsettling cancellation prevents an oversized stream from returning 413.
- Node 24.22.1 probe TypeScript and complete probe package suite pass: 31/31 across four files. Added controls cover a single deadline despite periodic chunks, UTF-8 byte limits at exactly 64 KiB and one extra byte, and signed whitespace/Unicode without a content-type requirement.
- Edge production bundle passes (11.7 KiB). Local real `workerd`/Miniflare qualification passes 5/5 with the scheduler client and fake outbound fetch; no internet target, provider or deployment is involved.
- Independent fresh-context pre-patch investigation and one bypass/regression review ran under `codex-security:fix-finding`; no concrete new bypass or regression remained.

No deployment, publication, credentials, external notification or paid infrastructure was activated. Cloud/BYOC production gates and external security assessment remain separate.
