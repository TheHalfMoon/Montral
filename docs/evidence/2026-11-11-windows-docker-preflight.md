# Windows Docker Desktop read-only preflight — 2026-11-11

**Scope:** Authorized Windows 11 development machine, Docker Desktop Linux backend and WSL 2. This is a **blocked prerequisite check**, not an end-to-end Docker/Windows qualification.

## Evidence on the connected machine

At Montral `bf0c9ee` before this documentation change:

- Docker CLI was available, but connecting to its Linux engine failed. The expected Docker Desktop Linux pipe was absent.
- WSL enumeration succeeded. The Ubuntu and docker-desktop WSL distros were stopped.
- System drive free space was below the new preflight's 12 GB advisory minimum; the workspace drive had more than its 15 GB advisory minimum.
- `scripts/qualify-windows-docker-preflight.ps1` returned `MONTRAL_WINDOWS_DOCKER_PREFLIGHT_BLOCKED` and exit code **2**.
- A negative control with both storage minimums set much higher than the available space also returned exit code **2**, identifying both drives as below the selected thresholds.
- `git diff --check` passed; no service startup, Docker image pull, container deletion, WSL state changes or secret writes were performed.

## Current outcome

**Windows Docker Desktop / WSL 2 E2E: NOT QUALIFIED.**

The owner should ensure sufficient system-drive safety headroom and use a supported Docker Desktop data location before starting a resource-heavy build. Re-run the preflight after the Docker daemon is available, then follow `docs/WINDOWS-DOCKER-QUALIFICATION.md` with a disposable, isolated stack and synthetic user data.

Linux CI and macOS coverage cannot substitute for running the actual Windows Desktop/WSL 2 configuration. No production release, live billing, or paid infrastructure was authorized or used.
