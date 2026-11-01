import { describe, expect, it } from "vitest";
import { grantCookie } from "./auth";

describe("OAuth workspace picker cookie parsing", () => {
  const challenge = "synthetic-pkce-challenge";

  it("accepts only a valid choice bound to the current PKCE challenge", () => {
    expect(grantCookie(`other=ok; montral_grant=${encodeURIComponent(challenge + "~*")}`, challenge)).toBe("*");
    expect(grantCookie(`montral_grant=${encodeURIComponent(challenge + "~org-id|proj-id")}`, challenge)).toBe("org-id|proj-id");
    expect(grantCookie(`montral_grant=${encodeURIComponent("prior-pkce~*")}`, challenge)).toBeUndefined();
    expect(grantCookie(`montral_grant=${encodeURIComponent(challenge + "~")}`, challenge)).toBeUndefined();
    expect(grantCookie("unrelated=ok", challenge)).toBeUndefined();
  });

  it("fails closed instead of throwing on malformed percent escapes or UTF-8", () => {
    for (const cookie of ["%", "%ZZ", "%E0%A4%A", "%C3%28", "%ED%A0%80", "%F0%80%80%80"]) {
      expect(grantCookie(`montral_grant=${cookie}`, challenge)).toBeUndefined();
      expect(grantCookie(`session=present; montral_grant=${cookie}`, challenge)).toBeUndefined();
    }
  });
});
