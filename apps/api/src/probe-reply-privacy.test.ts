import { afterEach, describe, expect, it, vi } from "vitest";
import { configureProbes, runInRegion } from "./probes";

const input = { type: "http" as const, target: "https://example.test/", method: "GET", expectedStatus: 200, timeoutMs: 1000 };
const region = "probe-test";

function configured() {
  configureProbes({ PROBE_REGIONS: '{"probe-test":"https://probe.example.test/api/probe"}', PROBE_SECRET: "synthetic-probe-secret" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  configureProbes({});
});

describe("bounded remote probe replies and network diagnostics", () => {
  it("does not treat a 32 KiB provider reply as a valid check result", async () => {
    configured();
    const fetcher = vi.fn(async () => Response.json({ ok: false, error: "A".repeat(32 * 1024) }));
    vi.stubGlobal("fetch", fetcher);
    const result = await runInRegion(region, input);
    expect(result).toEqual({ region, unreachable: "Probe response exceeded 16 KiB limit" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never exposes a fetch provider exception that could contain a secret", async () => {
    configured();
    const marker = `synthetic-private-header-${crypto.randomUUID()}`;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`Request failed: Authorization ${marker}`); }));
    const result = await runInRegion(region, input);
    expect(result).toEqual({ region, unreachable: "Probe unreachable" });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("cancels a never-ending response within a bounded number of 8 KiB reads", async () => {
    configured();
    let canceled = false;
    let reads = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(8 * 1024).fill(88)); },
      cancel() { canceled = true; },
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await runInRegion(region, input)).toEqual({ region, unreachable: "Probe response exceeded 16 KiB limit" });
    expect(canceled).toBe(true);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("does not wait for an HTTP error stream whose cancellation refuses to settle", async () => {
    configured();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([65])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 503 })));
    const result = await Promise.race([
      runInRegion(region, input),
      new Promise<"still-stalled">(resolve => setTimeout(() => resolve("still-stalled"), 180)),
    ]);
    expect(result).toEqual({ region, unreachable: "Probe answered 503" });
    expect(canceled).toBe(true);
  });

  it("bounds an incomplete sublimit signed probe response even if the fetch stream ignores abort", async () => {
    configured();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(35));
    try {
      const result = await Promise.race([
        runInRegion(region, input),
        new Promise<"still-stalled">(resolve => setTimeout(() => resolve("still-stalled"), 250)),
      ]);
      expect(result).toEqual({ region, unreachable: "Probe did not answer in time" });
      expect(canceled).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("does not await a nonresponsive capability-check HTTP refusal", async () => {
    configured();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([65])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const fetcher = vi.fn(async () => new Response(stream, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await Promise.race([
      runInRegion(region, { ...input, method: "PUT" }),
      new Promise<"still-stalled">(resolve => setTimeout(() => resolve("still-stalled"), 180)),
    ]);
    expect(result).toEqual({ region, unreachable: "Probe upgrade required for HTTP request bodies and methods" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(canceled).toBe(true);
  });

  it("enforces a single capability-check body deadline before sending private request data", async () => {
    configured();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"capabilities":')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const fetcher = vi.fn(async () => new Response(stream));
    vi.stubGlobal("fetch", fetcher);
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(35));
    try {
      const result = await Promise.race([
        runInRegion(region, { ...input, method: "PUT", requestBody: "private-request-fixture" }),
        new Promise<"still-stalled">(resolve => setTimeout(() => resolve("still-stalled"), 250)),
      ]);
      expect(result).toEqual({ region, unreachable: "Probe did not answer in time" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(canceled).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("preserves a small successful response including Unicode and numeric measurements", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, statusCode: 204, latencyMs: 12, error: "café 🎯" })));
    expect(await runInRegion(region, input)).toEqual({ region, outcome: { ok: true, statusCode: 204, latencyMs: 12, error: "café 🎯" } });
  });
});
