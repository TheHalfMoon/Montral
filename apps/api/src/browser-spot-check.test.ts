/**
 * Spot checks (POST /monitors/:id/check with a region, MCP run_check with region) never hand out a browser run: they are
 * refused for browser monitors (e2e), and whatever outcome any spot check returns is reduced to its verdict fields, so
 * no screenshot bytes, steps or other nested objects are ever serialised into a response.
 */
import { describe, expect, it } from "vitest";
import { spotCheckResult } from "./routes/monitors";

describe("spot check results", () => {
  it("keep only ok, statusCode, latencyMs and error", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const out = spotCheckResult({ ok: false, statusCode: 200, latencyMs: 12, error: "Step 2 (fill): timed out", browser: { screenshotPng: png, steps: [{ action: "fill", ms: 5, ok: false }], usedSecrets: true } } as never);
    expect(out).toEqual({ ok: false, statusCode: 200, latencyMs: 12, error: "Step 2 (fill): timed out" });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/screenshot|steps|"0":137|usedSecrets/);
  });

  it("drop fields of the wrong type instead of passing them through", () => {
    expect(spotCheckResult({ ok: "yes", statusCode: "200", latencyMs: null, error: { html: "<b>" } } as never)).toEqual({ ok: false });
  });

  it("MCP run_check is the same REST call, so the browser refusal and the reduction apply to agents too", async () => {
    const { TOOLS } = await import("./mcp");
    const tool = TOOLS.find((t) => t.name === "run_check")!;
    expect(tool.build({ id: "7c1f7a7e-1111-4222-8333-944444444444", region: "auto" } as never)).toEqual({ method: "POST", path: "/api/monitors/7c1f7a7e-1111-4222-8333-944444444444/check", body: { region: "auto" } });
  }, 60_000);
});
