import { describe, expect, it, vi } from "vitest";
import { MAX_JSON_PATH_DEPTH, jsonAssertionError, jsonPathProblem, jsonStringForm, jsonValueMatches, parseJsonPath, resolveJsonPath } from "./json-assertion";
import { configureProbes, resetProbeCapabilities, runInRegion } from "./probes";
import { jsonAssertionProblem, monitorCreateSchema, monitorPatchSchema } from "./routes/monitors";

const segments = (path: string) => {
  const r = parseJsonPath(path);
  if ("error" in r) throw new Error(r.error);
  return r.segments;
};

describe("JSON path parser", () => {
  it("reads dot keys, bracket indexes and an optional $. prefix", () => {
    expect(segments("status")).toEqual(["status"]);
    expect(segments("data.items[0].state")).toEqual(["data", "items", 0, "state"]);
    expect(segments("$.data.items[12]")).toEqual(["data", "items", 12]);
    expect(segments("$[0].id")).toEqual([0, "id"]);
    expect(segments("[3][0]")).toEqual([3, 0]);
    expect(segments("a-b.c_d.$ref.0")).toEqual(["a-b", "c_d", "$ref", "0"]);
    // `$` followed by a key character is a key, not the root
    expect(segments("$id")).toEqual(["$id"]);
  });
  it("reads quoted bracket keys with JSON escapes", () => {
    expect(segments('["key with space"]')).toEqual(["key with space"]);
    expect(segments('$["a.b"]["c]d"].e')).toEqual(["a.b", "c]d", "e"]);
    expect(segments('data["\\"quoted\\""]')).toEqual(["data", '"quoted"']);
    expect(segments('["caf\\u00e9"]')).toEqual(["café"]);
    expect(segments('[""]')).toEqual([""]);
  });
  it.each([
    ["", /empty/], ["$", /after \$/], ["$.", /empty/], ["a..b", /key needs/], ["a.", /key needs/], [".a", /key needs/],
    ["a b", /expected \. or \[/], [" a", /key needs/], ["a[", /\[0\]/], ["a[0", /\[0\]/], ["a[-1]", /\[0\]/], ["a[01]", /\[0\]/],
    ["a[*]", /\[0\]/], ["a[1.5]", /\[0\]/], ["a['x']", /\[0\]/], ['a["x"', /expected \]/], ['a["x]', /\[0\]/], ["a[0]b", /expected \. or \[/],
    ["a.b()", /expected \. or \[/], ["$..a", /key needs/], ["a[?(@.x)]", /\[0\]/], ["a[0:2]", /\[0\]/],
  ])("rejects %j", (path, why) => {
    const r = parseJsonPath(path);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(why);
  });
  it(`allows ${MAX_JSON_PATH_DEPTH} segments and refuses one more`, () => {
    expect(segments(Array(MAX_JSON_PATH_DEPTH).fill("a").join("."))).toHaveLength(MAX_JSON_PATH_DEPTH);
    expect(parseJsonPath(Array(MAX_JSON_PATH_DEPTH + 1).fill("a").join("."))).toEqual({ error: `JSON path is deeper than ${MAX_JSON_PATH_DEPTH} segments` });
    expect(parseJsonPath("[0]".repeat(MAX_JSON_PATH_DEPTH + 1))).toHaveProperty("error");
  });
  it("refuses paths longer than 200 characters", () => {
    expect(parseJsonPath("a".repeat(201))).toHaveProperty("error");
    expect(segments("a".repeat(200))).toEqual(["a".repeat(200)]);
  });
  it("treats null and empty as no path", () => {
    expect(jsonPathProblem(null)).toBeNull();
    expect(jsonPathProblem("")).toBeNull();
    expect(jsonPathProblem("a..b")).toMatch(/Invalid JSON path at character 3/);
  });
});

describe("JSON path resolution", () => {
  const doc = JSON.parse('{"data":{"items":[{"state":"ready","n":0}],"empty":null},"list":[1,2],"__proto__":{"x":1},"a.b":true}');
  it("follows own keys and in-range indexes only", () => {
    expect(resolveJsonPath(doc, segments("data.items[0].state"))).toBe("ready");
    expect(resolveJsonPath(doc, segments("data.items[0].n"))).toBe(0);
    expect(resolveJsonPath(doc, segments("data.empty"))).toBeNull();
    expect(resolveJsonPath(doc, segments('["a.b"]'))).toBe(true);
    expect(resolveJsonPath(doc, segments("__proto__.x"))).toBe(1);
    expect(resolveJsonPath(doc, segments("data.items[1]"))).toBeUndefined();
    expect(resolveJsonPath(doc, segments("data.missing"))).toBeUndefined();
    expect(resolveJsonPath(doc, segments("data.empty.x"))).toBeUndefined();
  });
  it("never reaches inherited properties or crosses array/object kinds", () => {
    expect(resolveJsonPath(doc, segments("list.length"))).toBeUndefined();
    expect(resolveJsonPath(doc, segments("list.0"))).toBeUndefined();
    expect(resolveJsonPath(doc, segments("data[0]"))).toBeUndefined();
    expect(resolveJsonPath(doc, segments("data.constructor"))).toBeUndefined();
    expect(resolveJsonPath(doc, segments("data.toString"))).toBeUndefined();
    expect(resolveJsonPath("text", segments("length"))).toBeUndefined();
  });
});

describe("JSON value comparison", () => {
  it("compares strings as they are and other values as JSON", () => {
    expect(jsonStringForm("ok")).toBe("ok");
    expect(jsonStringForm(42)).toBe("42");
    expect(jsonStringForm(true)).toBe("true");
    expect(jsonStringForm(null)).toBe("null");
    expect(jsonStringForm({ a: [1, "x"] })).toBe('{"a":[1,"x"]}');
  });
  it("equals", () => {
    expect(jsonValueMatches("ok", "equals", "ok")).toBe(true);
    expect(jsonValueMatches("ok", "equals", '"ok"')).toBe(false);
    expect(jsonValueMatches(42, "equals", "42")).toBe(true);
    expect(jsonValueMatches("42", "equals", "42")).toBe(true);
    expect(jsonValueMatches(42.5, "equals", "42")).toBe(false);
    expect(jsonValueMatches(true, "equals", "true")).toBe(true);
    expect(jsonValueMatches(false, "equals", "true")).toBe(false);
    expect(jsonValueMatches(null, "equals", "null")).toBe(true);
    expect(jsonValueMatches("", "equals", "")).toBe(true);
    expect(jsonValueMatches([1, 2], "equals", "[1,2]")).toBe(true);
    expect(jsonValueMatches(undefined, "equals", "undefined")).toBe(false);
  });
  it("contains and exists", () => {
    expect(jsonValueMatches("all systems ok", "contains", "ok")).toBe(true);
    expect(jsonValueMatches(1234, "contains", "23")).toBe(true);
    expect(jsonValueMatches({ region: "eu" }, "contains", '"eu"')).toBe(true);
    expect(jsonValueMatches("fine", "contains", "ok")).toBe(false);
    expect(jsonValueMatches(null, "exists", null)).toBe(true);
    expect(jsonValueMatches(0, "exists", "ignored")).toBe(true);
    expect(jsonValueMatches(undefined, "exists", null)).toBe(false);
  });
  it("reports failures without echoing more than 80 characters", () => {
    expect(jsonAssertionError('{"status":"ok"}', { jsonPath: "status", jsonMatch: "equals", jsonExpected: "ok" })).toBeNull();
    expect(jsonAssertionError("<html>", { jsonPath: "status", jsonExpected: "ok" })).toBe("Response is not valid JSON");
    expect(jsonAssertionError('{"data":{}}', { jsonPath: "data.x", jsonExpected: "ok" })).toBe("JSON path data.x not found");
    expect(jsonAssertionError('{"n":41}', { jsonPath: "n", jsonExpected: "42" })).toBe('JSON path n is 41, expected "42"');
    const long = "y".repeat(5000);
    const error = jsonAssertionError(JSON.stringify({ s: long }), { jsonPath: "s", jsonMatch: "contains", jsonExpected: "z".repeat(500) })!;
    expect(error).toBe(`JSON path s is "${"y".repeat(78)}…, which does not contain "${"z".repeat(78)}…`);
  });
});

describe("JSON assertion validation", () => {
  it("defaults on create and keeps PATCH partial", () => {
    expect(monitorCreateSchema.parse({ name: "x", target: "https://example.com" })).toMatchObject({ jsonPath: null, jsonExpected: null, jsonMatch: "equals" });
    expect(monitorPatchSchema.parse({ name: "x" })).not.toHaveProperty("jsonMatch");
    expect(monitorPatchSchema.parse({ jsonPath: "" })).toEqual({ jsonPath: null });
    expect(monitorPatchSchema.parse({ jsonPath: null })).toEqual({ jsonPath: null });
    for (const bad of [{ jsonMatch: "regex" }, { jsonPath: "a".repeat(201) }, { jsonExpected: "x".repeat(501) }, { jsonPath: 3 }]) expect(monitorPatchSchema.safeParse(bad).success).toBe(false);
  });
  it("allows the assertion on http monitors only, with a valid path and an expected value where one is compared", () => {
    expect(jsonAssertionProblem({ type: "http", jsonPath: "status", jsonMatch: "equals", jsonExpected: "ok" })).toBeNull();
    expect(jsonAssertionProblem({ type: "http", jsonPath: "status", jsonMatch: "equals", jsonExpected: "" })).toBeNull();
    expect(jsonAssertionProblem({ type: "http", jsonPath: "status", jsonMatch: "exists", jsonExpected: null })).toBeNull();
    expect(jsonAssertionProblem({ type: "http", jsonPath: null, jsonMatch: "equals", jsonExpected: null })).toBeNull();
    expect(jsonAssertionProblem({ type: "http", jsonPath: "status", jsonMatch: "contains", jsonExpected: null })).toMatch(/jsonExpected is required/);
    expect(jsonAssertionProblem({ type: "http", jsonPath: "a[*]", jsonMatch: "exists" })).toMatch(/Invalid JSON path/);
    expect(jsonAssertionProblem({ type: "websocket", jsonPath: "status", jsonMatch: "exists" })).toMatch(/HTTP monitors only/);
    expect(jsonAssertionProblem({ type: "tcp", jsonPath: null, jsonExpected: "x" })).toMatch(/HTTP monitors only/);
    expect(jsonAssertionProblem({ type: "tcp", jsonPath: null, jsonExpected: null, jsonMatch: "equals" })).toBeNull();
  });
});

describe("JSON assertions on remote probes", () => {
  it("never lets a probe without the capability pass the check, and sends the assertion to one that has it", async () => {
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    resetProbeCapabilities();
    const input = { type: "http" as const, target: "https://example.com/", method: "GET", expectedStatus: 200, timeoutMs: 1000, jsonPath: "status", jsonExpected: "ok", jsonMatch: "equals" };
    const sent: Record<string, unknown>[] = [];
    let advertised = ["http-request-body-v1"];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ ok: true, capabilities: advertised });
      sent.push(JSON.parse(init.body as string));
      return Response.json({ ok: true, statusCode: 200, latencyMs: 5 });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await runInRegion("test", input)).toEqual({ region: "test", unreachable: "Probe upgrade required for JSON assertions" });
      expect(sent).toEqual([]);
      advertised = ["http-request-body-v1", "http-json-assertion-v1"];
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true } });
      expect(sent.at(-1)).toMatchObject({ jsonPath: "status", jsonExpected: "ok", jsonMatch: "equals" });
      // HEAD skips the assertion everywhere, so it does not need the capability
      resetProbeCapabilities();
      advertised = [];
      expect(await runInRegion("test", { ...input, method: "HEAD" })).toMatchObject({ outcome: { ok: true } });
      // a monitor without an assertion keeps the envelope older probes know
      expect(await runInRegion("test", { ...input, jsonPath: null })).toMatchObject({ outcome: { ok: true } });
      expect(sent.at(-1)).not.toHaveProperty("jsonPath");
    } finally { vi.unstubAllGlobals(); configureProbes({}); resetProbeCapabilities(); }
  });
});
