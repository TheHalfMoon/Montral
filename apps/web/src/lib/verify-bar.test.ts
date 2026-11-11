import { describe, expect, it } from "vitest";
import { verifyBarAtFirstPaint, verifyBarStorage } from "./verify-bar";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("email verification bar", () => {
  it("is hidden at first paint until the account was seen unverified, then painted with the page on later loads", () => {
    const store = memory();
    expect(verifyBarAtFirstPaint(verifyBarStorage(store))).toEqual({ pending: false, dismissed: false });
    verifyBarStorage(store).setPending(true);
    expect(verifyBarAtFirstPaint(verifyBarStorage(store))).toEqual({ pending: true, dismissed: false });
  });

  it("forgets the account once it is verified, and remembers a dismissal", () => {
    const store = memory();
    verifyBarStorage(store).setPending(true);
    verifyBarStorage(store).dismiss();
    expect(verifyBarAtFirstPaint(verifyBarStorage(store)).dismissed).toBe(true);
    verifyBarStorage(store).setPending(false);
    expect(verifyBarAtFirstPaint(verifyBarStorage(store))).toEqual({ pending: false, dismissed: false });
    // A later unverified account in the same tab must not inherit the prior dismissal.
    verifyBarStorage(store).setPending(true);
    expect(verifyBarAtFirstPaint(verifyBarStorage(store))).toEqual({ pending: true, dismissed: false });
    verifyBarStorage(store).dismiss();
    expect(verifyBarAtFirstPaint(verifyBarStorage(store)).dismissed).toBe(true);
  });

  it("stores a flag, never the address", () => {
    const store = memory();
    verifyBarStorage(store).setPending(true);
    expect([...store.m.values()].every((v) => v === "1")).toBe(true);
  });

  it("works without session storage, or when it throws", () => {
    expect(verifyBarAtFirstPaint(verifyBarStorage(null))).toEqual({ pending: false, dismissed: false });
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    const s = verifyBarStorage(throwing);
    expect(() => { s.setPending(true); s.dismiss(); }).not.toThrow();
    expect(s.read()).toEqual({ pending: false, dismissed: false });
  });
});
