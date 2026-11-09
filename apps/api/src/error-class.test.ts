import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorClass, handleApiError } from "./app";
import type { AppEnv } from "./env";

describe("errorClass", () => {
  it("reports PostgreSQL SQLSTATEs and Node system codes, never messages", () => {
    expect(errorClass(Object.assign(new Error("sorry, too many clients for user montral password=hunter2"), { code: "53300" }))).toBe("53300");
    expect(errorClass(Object.assign(new Error("connect ECONNRESET 10.0.0.5:5432"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(errorClass(new TypeError("cannot read secret-token of undefined"))).toBe("TypeError");
  });
  it("refuses codes or names that could smuggle data", () => {
    expect(errorClass({ code: "postgres://user:pass@host/db" })).toBe("Object");
    expect(errorClass({ code: "53300 extra" })).toBe("Object");
    expect(errorClass(null)).toBe("unknown");
    expect(errorClass(Object.create(null))).toBe("unknown");
    expect(errorClass({ get code() { throw new Error("boom"); } })).toBe("unknown");
    expect(errorClass(new Proxy({}, { get() { throw new Error("trap"); } }))).toBe("unknown");
    expect(errorClass({ code: "CONNECTION_CLOSED" })).toBe("CONNECTION_CLOSED");
    expect(errorClass({ code: "lowercase_code" })).toBe("Object");
  });
});

describe("handleApiError", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const secretMessage = "deadlock detected: Process 4242 waits for AccessExclusiveLock on relation 16384 of database montral password=hunter2";
  function appThrowing(err: unknown) {
    const app = new Hono<AppEnv>();
    app.get("/boom", () => { throw err; });
    app.onError(handleApiError);
    return app;
  }

  it.each(["40P01", "40001"])("maps PostgreSQL %s to a retryable 503 with Retry-After and a fixed body", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await appThrowing(Object.assign(new Error(secretMessage), { code })).request("/boom");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Temporarily unavailable, please retry" });
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(code);
    // Logging keeps only the safe classifier, never the driver message.
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain(`(${code})`);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("16384");
  });

  it("keeps other database and runtime errors as a generic 500 without Retry-After", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const err of [
      Object.assign(new Error(secretMessage), { code: "23505" }),
      Object.assign(new Error(secretMessage), { code: "40P02" }),
      Object.assign(new Error(secretMessage), { code: "40p01" }),
      new TypeError(secretMessage),
    ]) {
      const response = await appThrowing(err).request("/boom");
      expect(response.status).toBe(500);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toEqual({ error: "Internal error" });
    }
    expect(log.mock.calls.map(call => String(call[0])).join(" | ")).not.toContain("hunter2");
  });

  it("passes HTTPException through unchanged", async () => {
    const response = await appThrowing(new HTTPException(418, { message: "teapot" })).request("/boom");
    expect(response.status).toBe(418);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ error: "teapot" });
  });
});
