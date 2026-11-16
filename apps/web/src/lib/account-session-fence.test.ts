import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLatestRequestFence } from "./account-session-fence";

describe("account session refresh sequence", () => {
  it("accepts a single current response", () => {
    const fence = createLatestRequestFence();
    const first = fence.start();
    expect(fence.isLatest(first)).toBe(true);
  });

  it("rejects a stale error or response after a newer refresh began", () => {
    const fence = createLatestRequestFence();
    const slow = fence.start();
    const fast = fence.start();
    expect(fence.isLatest(slow)).toBe(false);
    expect(fence.isLatest(fast)).toBe(true);
  });

  it("invalidates in-flight loads when the account component unmounts", () => {
    const fence = createLatestRequestFence();
    const inflight = fence.start();
    fence.invalidate();
    expect(fence.isLatest(inflight)).toBe(false);
  });

  it("wires the fence and clears both identity and rows for network and freshness errors", () => {
    const account = readFileSync(new URL("../components/Account.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const sessions = account.slice(account.indexOf("function Sessions()"), account.indexOf("function PasswordChange()"));
    expect(sessions).toContain("const version = requestFence.current.start()");
    expect(sessions.match(/requestFence\.current\.isLatest\(version\)/g)).toHaveLength(2);
    expect(sessions).toContain("requestFence.current.invalidate()");
    expect(sessions).toContain("setCurrent(null);\n    setList(null);");
    expect(sessions).toContain('if (l.error) {\n        setList([]);');
    expect(sessions).toContain('setCurrent(null);\n      setList([]);\n      setErr(t("Could not load sessions."));');
    expect(sessions).not.toContain("refreshAfterAction");
    expect(sessions).toContain("await load()");
  });
});
