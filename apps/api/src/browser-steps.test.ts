import { describe, expect, it } from "vitest";
import { browserConfigSchema, browserSecretsSchema, globMatch, maskSecrets, MAX_STEPS, missingSecretProblem, SECRET_MASK, secretRefs, stepError, urlMatches } from "./browser-steps";

const goto = { action: "goto", url: "https://example.com/" };
const ok = (steps: unknown[], extra = {}) => browserConfigSchema.safeParse({ steps, ...extra }).success;

describe("browser journey validation", () => {
  it("accepts every step type with its documented arguments and fills defaults", () => {
    const parsed = browserConfigSchema.parse({ steps: [
      goto,
      { action: "click", selector: "button[type=submit]", timeoutMs: 500 },
      { action: "fill", selector: "#user", value: "alice" },
      { action: "fill", selector: "#pass", secretRef: "password" },
      { action: "press", key: "Enter" },
      { action: "press", key: "Control+Shift+A" },
      { action: "waitFor", selector: "#done" },
      { action: "waitFor", text: "Welcome" },
      { action: "assertText", contains: "Welcome" },
      { action: "assertText", selector: "h1", equals: "" },
      { action: "assertUrl", pattern: "/dashboard*" },
      { action: "assertStatus", code: 200 },
    ] });
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.screenshot).toBe("never");
  });

  it("requires 1 to 20 steps, starting with goto", () => {
    expect(ok([])).toBe(false);
    expect(ok([{ action: "click", selector: "#a" }])).toBe(false);
    expect(ok([goto, ...Array(MAX_STEPS - 1).fill({ action: "click", selector: "#a" })])).toBe(true);
    expect(ok([goto, ...Array(MAX_STEPS).fill({ action: "click", selector: "#a" })])).toBe(false);
  });

  it("refuses anything that would run code or reach outside http(s)", () => {
    for (const s of [
      { action: "evaluate", script: "fetch('/x')" },
      { action: "addInitScript", script: "1" },
      { action: "goto", url: "javascript:alert(1)" },
      { action: "goto", url: "file:///etc/passwd" },
      { action: "goto", url: "chrome://settings" },
      { action: "goto", url: "about:config" },
      { action: "goto", url: "ftp://example.com/" },
      { action: "goto", url: "data:text/html,<script>1</script>" },
      { action: "goto", url: "/relative" },
      { action: "click", selector: "#a", script: "x" },
    ]) expect(ok([goto, s]), JSON.stringify(s)).toBe(false);
  });

  it("refuses Playwright's internal and framework selector engines and control characters", () => {
    for (const selector of ["internal:role=button", "INTERNAL:text=x", "_react=App", "_vue=list", "div >> internal:has-text=x", "#a\u0000", "a\nb"]) {
      expect(ok([goto, { action: "click", selector }]), selector).toBe(false);
    }
    for (const selector of ["text=Sign in", "xpath=//button", "css=#a", "role=button[name=\"Go\"]", "#a >> text=Go", "[data-testid=submit]"]) {
      expect(ok([goto, { action: "click", selector }]), selector).toBe(true);
    }
  });

  it("caps lengths and timeouts", () => {
    expect(ok([goto, { action: "click", selector: "a".repeat(501) }])).toBe(false);
    expect(ok([goto, { action: "fill", selector: "#a", value: "v".repeat(1001) }])).toBe(false);
    expect(ok([goto, { action: "waitFor", text: "t".repeat(501) }])).toBe(false);
    expect(ok([{ action: "goto", url: `https://example.com/${"p".repeat(2048)}` }])).toBe(false);
    expect(ok([goto, { action: "click", selector: "#a", timeoutMs: 499 }])).toBe(false);
    expect(ok([goto, { action: "click", selector: "#a", timeoutMs: 30_001 }])).toBe(false);
    expect(ok([goto], { timeoutMs: 60_001 })).toBe(false);
    expect(ok([goto], { timeoutMs: 4_999 })).toBe(false);
    expect(ok([goto], { timeoutMs: 60_000 })).toBe(true);
    expect(ok([goto], { screenshot: "always" })).toBe(false);
  });

  it("needs exactly one of the alternatives where a step has them", () => {
    expect(ok([goto, { action: "fill", selector: "#a" }])).toBe(false);
    expect(ok([goto, { action: "fill", selector: "#a", value: "x", secretRef: "s" }])).toBe(false);
    expect(ok([goto, { action: "waitFor" }])).toBe(false);
    expect(ok([goto, { action: "waitFor", selector: "#a", text: "x" }])).toBe(false);
    expect(ok([goto, { action: "assertText", selector: "#a" }])).toBe(false);
    expect(ok([goto, { action: "assertText", contains: "a", equals: "b" }])).toBe(false);
  });

  it("accepts only plain keys and modifiers", () => {
    for (const key of ["a", "Z", "7", "Enter", "Tab", "Escape", "F12", "ArrowDown", "Shift+Tab", "Meta+a"]) expect(ok([goto, { action: "press", key }]), key).toBe(true);
    for (const key of ["", "Enter Enter", "Ctrl+A", "Control+Control+Control+Control+a", "ab", "F13", "Enter\n"]) expect(ok([goto, { action: "press", key }]), key).toBe(false);
  });

  it("validates secret names and the secrets a journey refers to", () => {
    expect(browserSecretsSchema.safeParse({ password: "x", API_KEY_2: "y", _x: null }).success).toBe(true);
    for (const bad of [{ "1abc": "x" }, { "a-b": "x" }, { "a b": "x" }, { a: "" }, { a: "v".repeat(1001) }, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, "v"]))]) {
      expect(browserSecretsSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    const config = browserConfigSchema.parse({ steps: [goto, { action: "fill", selector: "#a", secretRef: "pw" }, { action: "fill", selector: "#b", secretRef: "pw" }, { action: "fill", selector: "#c", secretRef: "otp" }] });
    expect(secretRefs(config)).toEqual(["pw", "otp"]);
    expect(missingSecretProblem(config, ["pw", "otp"])).toBeNull();
    expect(missingSecretProblem(config, ["pw"])).toBe("Unknown secret: otp");
    expect(missingSecretProblem(config, [])).toBe("Unknown secrets: pw, otp");
  });

  it("formats step errors from fixed reasons only", () => {
    expect(stepError(0, "goto", "blocked")).toBe("Step 1 (goto): blocked by the network policy");
    expect(stepError(4, "assertStatus", "status", " (500, expected 200)")).toBe("Step 5 (assertStatus): unexpected HTTP status (500, expected 200)");
  });
});

describe("assertUrl patterns", () => {
  it("matches * wildcards against the whole URL, or path and query with a leading /", () => {
    expect(urlMatches("https://example.com/dashboard", "https://example.com/dashboard")).toBe(true);
    expect(urlMatches("https://example.com/*", "https://example.com/a/b?c=1")).toBe(true);
    expect(urlMatches("*example.com*", "https://www.example.com/")).toBe(true);
    expect(urlMatches("/dashboard", "https://example.com/dashboard")).toBe(true);
    expect(urlMatches("/dashboard", "https://example.com/dashboard?x=1")).toBe(false);
    expect(urlMatches("/dashboard*", "https://example.com/dashboard?x=1")).toBe(true);
    expect(urlMatches("/items/*/edit", "https://example.com/items/42/edit")).toBe(true);
    expect(urlMatches("https://example.com/", "https://evil.example/https://example.com/")).toBe(false);
    // regex syntax is literal
    expect(urlMatches("/a.c", "https://x/abc")).toBe(false);
    expect(urlMatches("/(a+)+$", "https://x/(a+)+$")).toBe(true);
  });

  it("stays fast on adversarial patterns (no backtracking blow-up)", () => {
    const subject = "a".repeat(2048);
    const t0 = performance.now();
    expect(globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", subject)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe("secret masking", () => {
  it("replaces every occurrence of every secret, longest first", () => {
    expect(maskSecrets("user=alice pass=hunter2 again hunter2", ["hunter2"])).toBe(`user=alice pass=${SECRET_MASK} again ${SECRET_MASK}`);
    expect(maskSecrets("token abc123xyz", ["abc", "abc123xyz"])).toBe(`token ${SECRET_MASK}`);
    expect(maskSecrets(JSON.stringify({ error: "Step 2 (fill): s3cr3t" }), ["s3cr3t"])).not.toContain("s3cr3t");
    expect(maskSecrets("nothing here", [""])).toBe("nothing here");
  });
});
