import { describe, expect, it, vi } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "../../api/src/probe-protocol";
import { handleEdgeProbe, safeTarget, type EdgeEnv } from "./edge";

const secret = "a-long-secret-for-montral-edge-probes";
const env: EdgeEnv = { PROBE_SECRET: secret, REGION: "edge-eu", ALLOWED_HOSTS: "example.com,api.example.com" };
const payload = { type: "http", target: "https://example.com/health", method: "GET", timeoutMs: 2000, expectedStatus: 200, keyword: "ready" };
async function signed(value: unknown, password = secret): Promise<Request> {
  const text = JSON.stringify(value);
  const ts = Math.floor(Date.now()/1000);
  return new Request("https://edge.example.invalid/api/probe", { method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(password, ts, text) },
    body: text });
}
const okFetch = vi.fn(async () => new Response("ready", { status: 200 }));

describe("Montral Cloudflare edge probe", () => {
  it("reports capabilities but never runs a schedule on its own", async () => {
    const r = await handleEdgeProbe(new Request("https://edge.example.invalid"), env);
    expect(await r.json()).toMatchObject({ ok: true, region: "edge-eu", capabilities: ["http-request-body-v1"] });
  });
  it("denies targets outside the explicit public HTTPS allowlist", () => {
    expect(safeTarget("http://example.com/", env.ALLOWED_HOSTS!)).toBeNull();
    expect(safeTarget("https://localhost/", "localhost")).toBeNull();
    expect(safeTarget("https://169.254.169.254/", "169.254.169.254")).toBeNull();
    expect(safeTarget("https://internal.example.com/", env.ALLOWED_HOSTS!)).toBeNull();
    expect(safeTarget("https://example.com/", env.ALLOWED_HOSTS!)).not.toBeNull();
    expect(safeTarget("https://example.com:8443/", env.ALLOWED_HOSTS!)).toBeNull();
    expect(safeTarget("https://example.com./", "example.com.")).toBeNull();
    expect(safeTarget("https://example.com:443/", env.ALLOWED_HOSTS!)).not.toBeNull();
    expect(safeTarget("https://example.com@127.0.0.1/", env.ALLOWED_HOSTS!)).toBeNull();
  });
  it("never becomes a public proxy when unsigned, wrongly signed or unconfigured", async () => {
    expect((await handleEdgeProbe(new Request("https://edge.example.invalid", { method: "POST", body: JSON.stringify(payload) }), env)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload, "wrong secret"), env)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload), { PROBE_SECRET: secret })).status).toBe(503);
  });
  it("accepts previous and current signatures during rotation, then refuses old keys", async () => {
    const next = "new-montral-edge-rotation-key-2026";
    const validUntil = new Date(Date.now() + 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiredAt = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const rollingEnv = { ...env, PROBE_SECRET: next, PROBE_PREVIOUS_SECRET: secret, PROBE_PREVIOUS_SECRET_EXPIRES_AT: validUntil };
    okFetch.mockClear();
    expect((await handleEdgeProbe(await signed(payload), rollingEnv, okFetch as never)).status).toBe(200);
    expect((await handleEdgeProbe(await signed(payload, next), rollingEnv, okFetch as never)).status).toBe(200);
    expect(okFetch).toHaveBeenCalledTimes(2);
    expect((await handleEdgeProbe(await signed(payload, "unknown"), rollingEnv, okFetch as never)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload), { ...rollingEnv, PROBE_PREVIOUS_SECRET: undefined }, okFetch as never)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload), { ...rollingEnv, PROBE_PREVIOUS_SECRET_EXPIRES_AT: undefined }, okFetch as never)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload), { ...rollingEnv, PROBE_PREVIOUS_SECRET_EXPIRES_AT: "invalid" }, okFetch as never)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload), { ...rollingEnv, PROBE_PREVIOUS_SECRET_EXPIRES_AT: expiredAt }, okFetch as never)).status).toBe(401);
    expect((await handleEdgeProbe(await signed(payload, next), { ...rollingEnv, PROBE_PREVIOUS_SECRET_EXPIRES_AT: expiredAt }, okFetch as never)).status).toBe(200);
    expect((await handleEdgeProbe(await signed(payload), { ...rollingEnv, PROBE_SECRET: undefined }, okFetch as never)).status).toBe(503);
  });

  it("sends one valid on-demand monitor check back to the main scheduler", async () => {
    okFetch.mockClear();
    const r = await handleEdgeProbe(await signed(payload), env, okFetch as never);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, statusCode: 200 });
    expect(okFetch).toHaveBeenCalledTimes(1);
  });
  it("uses expected-status and must-contain / must-not-contain checks", async () => {
    const failedStatus = await handleEdgeProbe(await signed({ ...payload, expectedStatus: 201 }), env, okFetch as never);
    expect(await failedStatus.json()).toMatchObject({ ok: false, statusCode: 200 });
    const forbidden = await handleEdgeProbe(await signed({ ...payload, keywordMode: "absent" }), env, okFetch as never);
    expect(await forbidden.json()).toMatchObject({ ok: false });
    const missing = await handleEdgeProbe(await signed({ ...payload, keyword: "missing" }), env, okFetch as never);
    expect(await missing.json()).toMatchObject({ ok: false });
  });
  it("refuses a JSON assertion it does not advertise instead of passing without it", async () => {
    okFetch.mockClear();
    const r = await handleEdgeProbe(await signed({ ...payload, jsonPath: "status", jsonExpected: "ok" }), env, okFetch as never);
    expect(r.status).toBe(400);
    expect(okFetch).not.toHaveBeenCalled();
  });
  it("rejects unsupported methods, private types, oversized payloads, and secret headers", async () => {
    const notHttp = await handleEdgeProbe(await signed({ ...payload, type: "tcp" }), env, okFetch as never);
    expect(notHttp.status).toBe(400);
    expect((await handleEdgeProbe(await signed({ ...payload, headers: { authorization: "secret" } }), env, okFetch as never)).status).toBe(400);
    for (const header of ["x-forwarded-for", "cf-connecting-ip", "transfer-encoding", "host", "x-montral-signature", "content-length", "forwarded"]) {
      expect((await handleEdgeProbe(await signed({ ...payload, headers: { [header]: "spoofed" } }), env, okFetch as never)).status).toBe(400);
    }
    expect((await handleEdgeProbe(await signed({ ...payload, target: "http://169.254.169.254" }), env, okFetch as never)).status).toBe(400);
    const oversized = new Request("https://edge.example.invalid", { method: "POST", body: "a".repeat(65 * 1024) });
    expect((await handleEdgeProbe(oversized, env)).status).toBe(413);
  });
});
