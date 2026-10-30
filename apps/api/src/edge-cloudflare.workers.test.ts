import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "./probe-protocol";
import { configureProbes, runInRegion, resetProbeCapabilities } from "./probes";
import type { CheckInput } from "./checker";

/**
 * Executes the actual Montral Cloudflare Edge Probe under workerd (Miniflare).
 * A workerd-local fetch stub returns fixed, synthetic upstream responses:
 * no real internet request, Cloudflare account or billing is involved.
 */
const secret = "montral-workerd-qualification-only-2026";
const ENTRY = `
import { handleEdgeProbe } from "../../probe/src/edge";
const env = { PROBE_SECRET: "montral-workerd-qualification-only-2026",
  ALLOWED_HOSTS: "example.com", REGION: "workerd-local" };
export default { fetch(request) {
  return handleEdgeProbe(request, env, async (target, options) => {
    if (new URL(target).hostname !== "example.com") throw Error("Unexpected outbound destination");
    if (options.redirect !== "manual") throw Error("Redirects must never be followed");
    return new Response("ready", { status: new URL(target).pathname === "/error" ? 503 : 200,
      headers: { "content-type": "text/plain" } });
  });
} };
`;
let mf: Miniflare;
beforeAll(async () => {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"], logLevel: "silent",
  });
  mf = new Miniflare({
    workers: [{ config: {
      name: "montral-edge-qualification",
      compatibilityDate: "2026-10-13",
      manifest: { mainModule: "index.js", modules: {
        "index.js": { type: "esm", contents: out.outputFiles[0].text },
      } },
    } }],
  });
}, 60_000);
afterAll(async () => { await mf?.dispose(); });
const input = {
  type: "http", target: "https://example.com/health", method: "GET",
  expectedStatus: 200, keyword: "ready", timeoutMs: 3000,
};
async function send(data: unknown, opts: { valid?: boolean; when?: number; password?: string } = {}) {
  const body = JSON.stringify(data);
  const ts = opts.when ?? Math.floor(Date.now() / 1000);
  return mf.dispatchFetch("http://workerd.local/api/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts),
      [SIGNATURE_HEADER]: opts.valid === false ? "invalid" : await signProbe(opts.password ?? secret, ts, body),
    },
    body,
  });
}
describe("Montral Cloudflare Edge Probe in actual local workerd", () => {
  it("exposes the scheduler's compatible capability contract", async () => {
    const response = await mf.dispatchFetch("http://workerd.local/api/probe");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, region: "workerd-local", capabilities: ["http-request-body-v1"],
    });
  });
  it("executes one signed HTTPS monitor from the Montral scheduler", async () => {
    const response = await send(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, statusCode: 200, latencyMs: expect.any(Number) });
  });
  it("returns the scheduler-compatible failed status/keyword results", async () => {
    const response = await send({ ...input, target: "https://example.com/error" });
    expect(await response.json()).toMatchObject({ ok: false, statusCode: 503 });
    const keyword = await send({ ...input, keyword: "missing" });
    expect(await keyword.json()).toMatchObject({ ok: false, statusCode: 200 });
  });
  it("runs through the real Montral scheduler regional-probe client and workerd", async () => {
    const url = "https://edge-probe.montral.invalid/api/probe";
    configureProbes({
      PROBE_REGIONS: JSON.stringify({ "edge-local": url }),
      PROBE_SECRET: secret,
    });
    resetProbeCapabilities();
    const originalFetch = globalThis.fetch;
    let discovery = 0;
    let checks = 0;
    vi.stubGlobal("fetch", async (target: RequestInfo | URL, init?: RequestInit) => {
      if (String(target) !== url) throw new Error("Unexpected external request from regional check");
      if (init?.method === "POST") checks++;
      else discovery++;
      return mf.dispatchFetch("http://workerd.local/api/probe", {
        method: init?.method || "GET", headers: init?.headers as never, body: init?.body as never,
      });
    });
    try {
      const monitor: CheckInput = {
        type: "http", target: "https://example.com/health",
        method: "POST", requestBody: '{"test":"payload"}',
        expectedStatus: 200, timeoutMs: 2000, keyword: "ready",
        keywordMode: "contains", expectedLocation: null, headers: {},
        wsMessage: null,
      };
      const result = await runInRegion("edge-local", monitor);
      expect(result).toMatchObject({ region: "edge-local", outcome: { ok: true, statusCode: 200 } });
      expect(discovery).toBe(1);
      expect(checks).toBe(1);
      const blocked = await runInRegion("edge-local", { ...monitor, target: "https://localhost/admin" });
      expect(blocked).toMatchObject({ region: "edge-local", unreachable: "Probe answered 400" });
      expect(checks).toBe(2);
      expect(discovery).toBe(1); // capability cached and reused
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      configureProbes({});
      resetProbeCapabilities();
      vi.unstubAllGlobals();
    }
  });

  it("rejects unsigned/expired/cross-signed inputs and unknown destinations", async () => {
    expect((await send(input, { valid: false })).status).toBe(401);
    expect((await send(input, { password: "not-the-scheduler-secret" })).status).toBe(401);
    expect((await send(input, { when: Math.floor(Date.now() / 1000) - 120 })).status).toBe(401);
    expect((await send({ ...input, target: "https://127.0.0.1/admin" })).status).toBe(400);
    expect((await send({ ...input, target: "https://example.com:8443/private" })).status).toBe(400);
    expect((await send({ ...input, headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(400);
  });
});
