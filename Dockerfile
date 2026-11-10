# syntax=docker/dockerfile:1
# Self-hosted Montral: one Node process serving the API, the web app and the check scheduler.

FROM node:22.23.4-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# web: Node flavour of the Astro build (no Cloudflare bindings)
RUN DEPLOY_TARGET=node pnpm --filter @montral/web build
# api: embed the SQL migrations, then bundle everything into one file (plus the browser-runner service and its
# per-check worker, which only the optional browser-runner image below copies)
RUN node scripts/gen-migrations.mjs && pnpm --filter @montral/api build:node \
 && pnpm --filter @montral/api build:browser-worker && pnpm --filter @montral/api build:browser-runner

# Optional browser-runner image for browser (multi-step) checks, used by docker-compose.browser.yml next to the default
# app image: `docker compose -f docker-compose.yml -f docker-compose.browser.yml up -d --build`. It contains only the
# runner service, the per-check worker and Chromium: no API server, no web build, and it is given no database URL and
# no app secrets. Debian-based because Playwright ships no Chromium for musl (Alpine). See /docs/self-host#browser-checks.
FROM node:22.23.4-bookworm-slim AS browser-runner
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
# playwright-core pinned to the version apps/api and e2e use (guards/browser-runtime.test.ts keeps them equal); the
# Chromium headless shell and its system libraries come from that version
RUN npm install --no-save --no-package-lock --no-audit --no-fund --ignore-scripts playwright-core@1.64.1 \
 && npx --no-install playwright-core install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/* \
 && chmod -R a+rX /ms-playwright
COPY --from=build /src/apps/api/dist/browser-runner.mjs ./browser-runner.mjs
COPY --from=build /src/apps/api/dist/browser-worker.mjs ./browser-worker.mjs
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8090/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "browser-runner.mjs"]

# Default image (built when no --target is given): no browser, unchanged.
FROM node:22.23.4-alpine
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /src/apps/api/dist/server.mjs ./server.mjs
COPY --from=build /src/apps/web/dist ./web
# Ping monitors run BusyBox /bin/ping (part of the Alpine base) as this unprivileged user, through unprivileged ICMP
# sockets: the container's net.ipv4.ping_group_range must include its group (Docker 20.10+ default "0 2147483647").
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.mjs"]
