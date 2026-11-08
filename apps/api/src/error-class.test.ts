import { describe, expect, it } from "vitest";
import { errorClass } from "./app";

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
