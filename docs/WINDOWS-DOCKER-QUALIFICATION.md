# Montral Windows Docker Desktop / WSL 2 qualification

Montral runs as a Linux container on Windows Docker Desktop; native Windows
server operation is not a supported production deployment mode.

## Read-only prerequisite gate

On Windows PowerShell 5.1+:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/qualify-windows-docker-preflight.ps1
```

The command only reads the available drive space, WSL registration, and Docker
daemon status. It never starts Docker, WSL, downloads dependencies, writes
secrets, or changes existing containers, images, networks or volumes.

- Exit 0: basic preflight passed. **Not** proof of Windows deployment readiness.
- Exit 2: one or more prerequisites blocked. Do not start a large Docker build.
- Exit 1: the preflight itself failed unexpectedly.

Default advisory reserve: at least 12 GB free on the system drive and 15 GB
on the working drive. These are cautious local-engineering thresholds, not
benchmarked storage requirements or production service guarantees. Override
them for a documented environment with measured requirements only.

If Docker Desktop is stopped or disk capacity is insufficient, record the
blocker. Do not automatically launch Docker, compact/move WSL virtual disks,
delete images, remove volumes, change Docker storage settings, or disable other
projects. Docker data location must be reviewed in its supported configuration
UI before heavy image builds.

## Windows qualification procedure (only after preflight passes)

Use a disposable, isolated Compose project and synthetic accounts, not an
existing developer Compose environment. Avoid exposed public ports; bind
temporary published ports to 127.0.0.1 through a verified Compose overlay.
Never reuse any production environment or shared PostgreSQL volume.

1. Verify Docker Desktop is using the Linux backend and WSL 2. Record version.
2. Run `docker compose config --quiet` with an environment file placed outside
   the repository. Provide a randomly generated PostgreSQL password and auth
   secret. Never commit or print secrets to logs.
3. Bring up Montral and PostgreSQL with a **unique project name** and explicit
   disposable volumes. Test health, registration, first login, creating a
   heartbeat monitor, incident workflow, and webhook capture.
4. Restart the Montral application container. Verify that the monitor,
   incident and webhook metadata persist in the isolated PostgreSQL volume.
5. Run the project's backup/restore checks with a different disposable
   database. Verify the restore and data integrity, without touching any
   customer data or existing Docker volumes.
6. Save diagnostics without private tokens. Stop only the test project and
   remove only that project's disposable resources when validation finishes.
7. Record the Windows version, Docker/Compose/WSL versions, tested commit,
   actual steps/results, and any limitations in a dated evidence report.

Do not claim the Windows gate passed on Linux CI, macOS tests or this preflight
alone. No public release, new paid resources or live billing is authorized by
this document.
