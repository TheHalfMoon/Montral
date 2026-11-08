import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { listPrecache, stampWorker } from "./src/sw/stamp.mjs";

const API = process.env.API_ORIGIN ?? "http://localhost:8787";
// Inline scripts live in src/inline/ and are rendered byte-for-byte (`set:html` of a ?raw import), so their CSP hashes
// can be computed here once and hold on every page, static or server-rendered. Astro does not hash is:inline scripts.
const INLINE_DIR = new URL("./src/inline/", import.meta.url);
const inlineScriptHashes = readdirSync(INLINE_DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => `sha256-${createHash("sha256").update(readFileSync(new URL(f, INLINE_DIR))).digest("base64")}`);
// DEPLOY_TARGET=node builds the Docker flavour: a Node handler that apps/api serves next to /api (no Cloudflare bindings)
const NODE = process.env.DEPLOY_TARGET === "node";

// Writes /sw.js after the build: the worker template with this build's file list and id stamped in (src/sw/stamp.mjs).
const serviceWorker = {
  name: "montral-service-worker",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const root = fileURLToPath(dir);
      const client = [root, join(root, "client")].find((d) => existsSync(join(d, "_astro")));
      if (!client) throw new Error(`service worker: no client build found under ${root}`);
      const template = readFileSync(new URL("./src/sw/sw.js", import.meta.url), "utf8");
      writeFileSync(join(client, "sw.js"), stampWorker(template, listPrecache(client)));
    },
  },
};

export default defineConfig({
  // the public origin of a deployment that has one (the hosted build sets SITE_ORIGIN); canonical links need it
  site: process.env.SITE_ORIGIN || undefined,
  output: "static",
  adapter: NODE ? node({ mode: "middleware" }) : cloudflare(),
  integrations: [react(), serviceWorker],
  build: { format: "file" }, // /app is served from app.html: no redirect to /app/
  trailingSlash: "never",
  prefetch: false, // the back office is a client-routed SPA; public pages are single hops
  // Content Security Policy as a <meta> on every page: Astro hashes each script it renders (bundled and is:inline,
  // including per-request SSR scripts), so injected markup cannot run script. Styles keep 'unsafe-inline' because React
  // and the pages render style="" attributes. Framing, base-uri and form targets are also sent as HTTP headers by the
  // Node server (web-security-headers.ts), which a <meta> policy cannot express.
  security: {
    csp: {
      algorithm: "SHA-256",
      directives: ["object-src 'none'", "base-uri 'self'"],
      // Cloudflare Turnstile is the only third-party script (the sign-up challenge, when configured)
      scriptDirective: { resources: ["'self'", "https://challenges.cloudflare.com"], hashes: inlineScriptHashes },
      styleDirective: { resources: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"] },
    },
  },
  server: { port: 4321 },
  vite: {
    // the runtime image ships no node_modules: inline every dependency into the server build
    ssr: NODE ? { noExternal: true } : {},
    resolve: NODE ? { alias: { "cloudflare:workers": new URL("./src/lib/cf-stub.ts", import.meta.url).pathname } } : {},
    // same-origin /api in dev, so session cookies just work; in prod route /api/* to the API Worker
    server: { proxy: { "/api": API } },
  },
});
