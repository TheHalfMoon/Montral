# macOS Chromium profile teardown reliability (2026-11-12)

## Observed failure
Exact-head PR #106 CI (`cd733f6`) failed on macOS runner after its PostgreSQL/RESTORE/browser acceptance passed. The script printed `BROWSER_E2E_PASS`, `CSP_PASS`, `STATUS_PASSWORD_PASS`, then Node.js failed to remove `/tmp/montral-browser-profile-11878/Default` with `ENOTEMPTY`. The error happened in the browser smoke's `finally` cleanup, not in the SCIM or browser assertions.

## Fix
- Move single-process, local-profile lifecycle cleanup into `scripts/browser-profile-cleanup.mjs`. It sends SIGTERM only to the fixture browser process, waits up to four seconds for its `close` event, escalates only that process to SIGKILL if still alive, and waits for its close again. Already exited/never started processes are not signaled.
- Recursively remove only the dedicated Chromium profile directory using Node fs `rm` with `force:true`, `maxRetries:12`, `retryDelay:200` for transient macOS `ENOTEMPTY` and related filesystem retry conditions.
- The app server's existing SIGTERM/shutdown negative control remains unchanged, as does the scope of the synthetic PostgreSQL and browser qualification.
- Add three deterministic isolated Node tests of the helper to the macOS CI workflow: late file write during browser shutdown, bounded escalation of a simulated hung child, and absence/already-terminated child.
- Local Windows: `node --test scripts/browser-profile-cleanup.test.mjs` 3/3 PASS; `node --check` both JavaScript modules PASS; migration integrity 62 PASS; whitespace check PASS. Full macOS qualification remains a CI gate.

## Boundaries
No production browser changes, production data, secrets, unrelated processes or Docker/WSL changes. No deployment or release. If a real macOS runner still fails, inspect its current job log, not just the previous ENOTEMPTY.
