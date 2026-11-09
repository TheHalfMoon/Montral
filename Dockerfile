# syntax=docker/dockerfile:1
# Self-hosted Montral: one Node process serving the API, the web app and the check scheduler.

FROM node:22.23.4-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# web: Node flavour of the Astro build (no Cloudflare bindings)
RUN DEPLOY_TARGET=node pnpm --filter @montral/web build
# api: embed the SQL migrations, then bundle everything into one file
RUN node scripts/gen-migrations.mjs && pnpm --filter @montral/api build:node

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
