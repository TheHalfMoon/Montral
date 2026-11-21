# Contributing

Montral is free and open-source software intended to be self-hosted. Contributions should preserve that direction and keep public product claims aligned with behavior that is implemented and tested.

## Development setup

- Use Node.js `24.22.1` or a version allowed by the root `package.json` engine range.
- Use pnpm `10.0.0`, as declared by the root `package.json`.
- Install the locked dependencies with `pnpm install --frozen-lockfile`.
- PostgreSQL and Docker are required for the database-backed and container qualification suites. See `docs/self-host` and the workflow files for the supported setup.

## Before opening a pull request

Run the checks relevant to your change:

```sh
pnpm -r typecheck
pnpm --filter @montral/api test
pnpm --filter @montral/mcp-rest test
pnpm --filter @montral/probe test
pnpm --filter @montral/db-pg test
pnpm --filter @montral/web test
```

For changes that touch database behavior, APIs, browser journeys, Docker, or recovery, run the corresponding integration and qualification workflows as well. Add regression coverage for confirmed defects, including a negative control where that helps prove the boundary.

Keep pull requests focused. Describe the user-visible effect, security and compatibility considerations, tests run, and any hardware or service coverage that was unavailable. Never commit credentials, customer data, private scanner output, or real secrets in fixtures; use synthetic values and follow [`SECURITY.md`](SECURITY.md) for vulnerability reports.

Do not publish a release, tag, package, container image, or deployment without the project owner's explicit `GREEN LIGHT MONTRAL` authorization.
