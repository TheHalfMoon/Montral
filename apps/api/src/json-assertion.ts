/**
 * JSON response-body assertions for HTTP monitors: one value, picked out of the parsed body by a small path, compared
 * with an expected text. The path language is a deliberately tiny, safe subset of JSONPath (no filters, wildcards,
 * slices, recursion or script): dot keys, bracket indexes and quoted bracket keys. It is parsed here by hand; nothing is
 * evaluated and no JSONPath library is involved. Kept identical for REST, MCP, imports, local checks and remote probes.
 */

export const JSON_MATCH_MODES = ["equals", "contains", "exists"] as const;
export type JsonMatch = (typeof JSON_MATCH_MODES)[number];
export const MAX_JSON_PATH_LENGTH = 200;
export const MAX_JSON_EXPECTED_LENGTH = 500;
/** Segments one path may have; a deeper value cannot be asserted on. */
export const MAX_JSON_PATH_DEPTH = 32;
/** Probes advertise this once they run JSON assertions; older ones would ignore the fields and pass every check. */
export const JSON_ASSERTION_CAPABILITY = "http-json-assertion-v1";
/** How much of a value (or path, or expected text) an error message shows: a response body must not leak into it. */
const SHOWN = 80;

/** A key of an object (string) or an index into an array (number). */
export type JsonPathSegment = string | number;

/** Unquoted keys: letters, digits, `_`, `-` and `$`. Anything else (spaces, dots, brackets…) needs `["…"]`. */
const BARE = /^[A-Za-z0-9_$-]+/;
/** A JSON string literal: the quoted key of `["…"]`, decoded with JSON.parse so escapes mean what they mean in JSON. */
const QUOTED = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"/;
/** An array index: 0, or digits without a leading zero. */
const INDEX = /^(?:0|[1-9][0-9]{0,8})\]/;

/**
 * The segments of `path`, or why it is not a path this subset accepts. Grammar: optional `$` (then `.` or `[`), a first
 * bare key or bracket, then any of `.key`, `[index]`, `["quoted key"]`. `status`, `$.data.items[0].state` and
 * `["key with space"].ok` are paths; `$` alone, `a..b`, `a.`, `[-1]`, `[*]`, `['x']` and `a[0` are not.
 */
export function parseJsonPath(path: string): { segments: JsonPathSegment[] } | { error: string } {
  if (path.length > MAX_JSON_PATH_LENGTH) return { error: `JSON path is longer than ${MAX_JSON_PATH_LENGTH} characters` };
  let rest = path;
  if (rest.startsWith("$")) {
    // `$` followed by a bare key character is the key `$…`, not the root
    if (rest.startsWith("$.")) rest = rest.slice(2);
    else if (rest.startsWith("$[")) rest = rest.slice(1);
    else if (rest === "$") return { error: "JSON path must name a key or index after $" };
  }
  const segments: JsonPathSegment[] = [];
  const bad = (why: string) => ({ error: `Invalid JSON path at character ${path.length - rest.length + 1}: ${why}` });
  let first = true;
  while (rest.length) {
    if (rest.startsWith("[")) {
      rest = rest.slice(1);
      const quoted = QUOTED.exec(rest);
      if (quoted) {
        rest = rest.slice(quoted[0].length);
        if (!rest.startsWith("]")) return bad('expected ] after the quoted key');
        segments.push(JSON.parse(quoted[0]) as string);
        rest = rest.slice(1);
      } else {
        const index = INDEX.exec(rest);
        if (!index) return bad('use [0] for an index or ["key"] for a key');
        segments.push(Number(index[0].slice(0, -1)));
        rest = rest.slice(index[0].length);
      }
    } else {
      // a bare key opens the path, or follows a dot
      if (!first) {
        if (!rest.startsWith(".")) return bad("expected . or [");
        rest = rest.slice(1);
      }
      const key = BARE.exec(rest);
      if (!key) return bad('a key needs letters, digits, _, - or $; quote others as ["key"]');
      segments.push(key[0]);
      rest = rest.slice(key[0].length);
    }
    first = false;
    if (segments.length > MAX_JSON_PATH_DEPTH) return { error: `JSON path is deeper than ${MAX_JSON_PATH_DEPTH} segments` };
  }
  if (!segments.length) return { error: "JSON path is empty" };
  return { segments };
}

/** Problem with a monitor's JSON path, or null (null and empty mean "no assertion"). */
export function jsonPathProblem(path: string | null | undefined): string | null {
  if (path == null || path === "") return null;
  const parsed = parseJsonPath(path);
  return "error" in parsed ? parsed.error : null;
}

/**
 * The value at `segments` in `root`, or undefined when it is not there. Only own properties of objects and in-range
 * indexes of arrays are followed: a key never reaches an array (`items.0` is a key "0"; write `items[0]`), an index
 * never reaches an object, and nothing inherited (`length`, `__proto__`, `constructor`) is visible.
 */
export function resolveJsonPath(root: unknown, segments: readonly JsonPathSegment[]): unknown {
  let at: unknown = root;
  for (const s of segments) {
    if (typeof s === "number") {
      if (!Array.isArray(at) || s >= at.length) return undefined;
      at = at[s];
    } else {
      if (at === null || typeof at !== "object" || Array.isArray(at) || !Object.prototype.hasOwnProperty.call(at, s)) return undefined;
      at = (at as Record<string, unknown>)[s];
    }
  }
  return at;
}

/** The text a value is compared as: a string as it is, anything else (number, boolean, null, object, array) as compact JSON. */
export const jsonStringForm = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** At most SHOWN characters of `s`, with an ellipsis when cut. */
export const clip = (s: string): string => (s.length > SHOWN ? `${s.slice(0, SHOWN - 1)}…` : s);

/**
 * Whether `value` (undefined: the path was not found) satisfies the assertion. equals: its string form is exactly
 * `expected` (so "true" matches true, "42" matches 42, "null" matches null, "ok" matches "ok"); contains: its string
 * form includes `expected`; exists: it is there at all, whatever it is (null included), and `expected` is ignored.
 */
export function jsonValueMatches(value: unknown, match: JsonMatch, expected: string | null | undefined): boolean {
  if (value === undefined) return false;
  if (match === "exists") return true;
  // a number outside double range parses to ±Infinity, which JSON.stringify would turn into "null"
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  const form = jsonStringForm(value);
  return match === "contains" ? form.includes(expected ?? "") : form === (expected ?? "");
}

export type JsonAssertion = { jsonPath: string; jsonMatch?: string | null; jsonExpected?: string | null };

/**
 * Error for a response `body` that fails the assertion, or null when it passes. Messages name the path and show at most
 * SHOWN characters of anything taken from the body or the configuration.
 */
export function jsonAssertionError(body: string, a: JsonAssertion): string | null {
  const parsed = parseJsonPath(a.jsonPath);
  if ("error" in parsed) return clip(parsed.error);
  let root: unknown;
  try { root = JSON.parse(body); } catch { return "Response is not valid JSON"; }
  const value = resolveJsonPath(root, parsed.segments);
  const path = clip(a.jsonPath);
  if (value === undefined) return `JSON path ${path} not found`;
  const match = (JSON_MATCH_MODES as readonly string[]).includes(a.jsonMatch ?? "") ? (a.jsonMatch as JsonMatch) : "equals";
  if (match !== "exists" && typeof value === "number" && !Number.isFinite(value)) return `JSON path ${path} holds a number out of range`;
  let matched: boolean;
  let got: string;
  try {
    matched = jsonValueMatches(value, match, a.jsonExpected);
    // JSON.stringify shows a string value quoted and a number bare, so "42" and 42 can be told apart in the message
    got = matched ? "" : clip(JSON.stringify(value) ?? String(value));
  } catch {
    // JSON.parse accepts nesting that JSON.stringify cannot walk back (stack overflow): fail with a clear reason
    return `JSON path ${path} holds a value too deeply nested to compare`;
  }
  if (matched) return null;
  const want = clip(JSON.stringify(a.jsonExpected ?? ""));
  return match === "contains" ? `JSON path ${path} is ${got}, which does not contain ${want}` : `JSON path ${path} is ${got}, expected ${want}`;
}
