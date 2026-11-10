import { describe, expect, it } from "vitest";
import { applySecretUpdate, decryptForRun, decryptSecret, encryptSecret, maskedSecrets } from "./browser-secrets";
import { MASK } from "./secrets";

const KEY = "browser-secrets-unit-test-key-0123456789";
const MON = "7c1f7a7e-1111-4222-8333-944444444444";

describe("browser secret encryption", () => {
  it("round-trips, with a fresh IV every time and no plaintext in the stored form", async () => {
    const a = await encryptSecret(KEY, "org1", MON, "pw", "hunter2-hunter2");
    const b = await encryptSecret(KEY, "org1", MON, "pw", "hunter2-hunter2");
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("hunter2");
    expect(await decryptSecret(KEY, "org1", MON, "pw", a)).toBe("hunter2-hunter2");
    expect(await decryptSecret(KEY, "org1", MON, "pw", await encryptSecret(KEY, "org1", MON, "pw", "ünïcødé ✓"))).toBe("ünïcødé ✓");
  });

  it("is bound to the key, the workspace, the monitor and the secret's name", async () => {
    const c = await encryptSecret(KEY, "org1", MON, "pw", "value");
    expect(await decryptSecret("another-key-another-key-0123456789", "org1", MON, "pw", c)).toBeNull();
    expect(await decryptSecret(KEY, "org2", MON, "pw", c)).toBeNull();
    // copied to another monitor of the same workspace: refused
    expect(await decryptSecret(KEY, "org1", "8d2f8b8f-2222-4333-8444-955555555555", "pw", c)).toBeNull();
    expect(await decryptSecret(KEY, "org1", MON, "other", c)).toBeNull();
  });

  it("rejects tampered and malformed values", async () => {
    const c = await encryptSecret(KEY, "org1", MON, "pw", "value");
    // change one character of the ciphertext (not the last one, whose low bits may be padding) to a different one
    const at = c.lastIndexOf(".") + 3;
    const flipped = c.slice(0, at) + (c[at] === "A" ? "B" : "A") + c.slice(at + 1);
    expect(flipped).not.toBe(c);
    for (const bad of [flipped, "v1.short.x", "v2." + c.slice(3), "", MASK, "plaintext"]) expect(await decryptSecret(KEY, "org1", MON, "pw", bad), bad).toBeNull();
  });

  it("applies updates: values are encrypted, the mask keeps, null and omission delete", async () => {
    const stored = { keep: await encryptSecret(KEY, "o", MON, "keep", "k"), drop: await encryptSecret(KEY, "o", MON, "drop", "d"), omit: await encryptSecret(KEY, "o", MON, "omit", "x") };
    const next = await applySecretUpdate(KEY, "o", MON, { keep: MASK, drop: null, fresh: "new-value", ghost: MASK }, stored);
    expect(Object.keys(next).sort()).toEqual(["fresh", "keep"]);
    expect(next.keep).toBe(stored.keep);
    expect(await decryptSecret(KEY, "o", MON, "fresh", next.fresh)).toBe("new-value");
    expect(await applySecretUpdate(KEY, "o", MON, {}, stored)).toEqual({});
  });

  it("shows names only, and decrypts for a run only what the journey uses", async () => {
    const stored = { b: await encryptSecret(KEY, "o", MON, "b", "bee"), a: await encryptSecret(KEY, "o", MON, "a", "ay"), broken: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" };
    expect(maskedSecrets(stored)).toEqual({ a: MASK, b: MASK, broken: MASK });
    expect(maskedSecrets(null)).toEqual({});
    expect(await decryptForRun(KEY, "o", MON, stored, ["a", "broken", "missing"])).toEqual({ a: "ay" });
  });
});
