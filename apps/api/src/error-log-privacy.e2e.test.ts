import { openDatabase } from "@montral/db-pg";
import { createMiddleware } from "hono/factory";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { community } from "./edition";
import type { AppEnv } from "./env";

const url = process.env.TEST_DATABASE_URL;
const base = "http://localhost:8787";

describe.skipIf(!url)("server error log privacy", () => {
  it("returns a generic 500 and logs no untrusted exception details", async () => {
    const marker = `synthetic-private-diagnostic-${crypto.randomUUID()}`;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(openDatabase, { edition: {
      ...community,
      requestMiddleware: createMiddleware<AppEnv>(async () => { throw new Error(marker); }),
    } });
    try {
      const res = await app.fetch(new Request(base + "/health"), {
        DATABASE_URL: url,
        BETTER_AUTH_SECRET: "test-only-nonproduction-secret",
        BETTER_AUTH_URL: base,
        WEB_ORIGIN: base,
      } as never);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal error" });
      const logged = spy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("Unhandled API error");
      expect(logged).not.toContain(marker);
    } finally {
      spy.mockRestore();
    }
  });
});
