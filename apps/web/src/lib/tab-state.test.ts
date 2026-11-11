import { describe, expect, it } from "vitest";
import { ACCOUNT_TAB_KEYS, forgetAccountTabState } from "./tab-state";

describe("signing out forgets the account's tab state", () => {
  it("removes the usage banner and verification bar keys, and nothing else", () => {
    const m = new Map<string, string>([...ACCOUNT_TAB_KEYS.map((k) => [k, "1"] as [string, string]), ["montral_other", "kept"]]);
    forgetAccountTabState({ removeItem: (k: string) => void m.delete(k) });
    expect([...m.keys()]).toEqual(["montral_other"]);
  });
  it("covers the keys the banner and the verification bar actually use", () => {
    expect(ACCOUNT_TAB_KEYS).toEqual(expect.arrayContaining(["montral_usage_alert", "montral_usage_bar_hidden", "montral_verify_pending", "montral_verify_dismissed"]));
  });
  it("works without session storage, or when it throws", () => {
    expect(() => forgetAccountTabState(null)).not.toThrow();
    expect(() => forgetAccountTabState({ removeItem: () => { throw new Error("denied"); } })).not.toThrow();
  });
});
