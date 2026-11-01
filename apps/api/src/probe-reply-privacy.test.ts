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

  it("preserves a small successful response including Unicode and numeric measurements", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, statusCode: 204, latencyMs: 12, error: "café 🎯" })));
    expect(await runInRegion(region, input)).toEqual({ region, outcome: { ok: true, statusCode: 204, latencyMs: 12, error: "café 🎯" } });
  });
});
