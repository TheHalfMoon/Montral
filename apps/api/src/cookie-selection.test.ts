import { describe, expect, it } from "vitest";
import { cookieValue } from "./middleware";

/** The dashboard's optional project selector must not make a valid session
 * fail with an unhandled URIError when a client sends malformed cookie bytes. */
describe("project-selection cookie parsing", () => {
  it("reads ordinary and URL-encoded cookie values", () => {
    expect(cookieValue("session=abc; montral_project=all; theme=dark", "montral_project")).toBe("all");
    expect(cookieValue("montral_project=project%2D123", "montral_project")).toBe("project-123");
    expect(cookieValue("other=foo", "montral_project")).toBeUndefined();
  });
  it("ignores malformed percent escapes and invalid UTF-8 rather than raising URIError", () => {
    for (const bad of ["%", "%ZZ", "%E0%A4%A", "%C3%28", "%ED%A0%80"]) {
      expect(cookieValue(`session=abc; montral_project=${bad}; other=value`, "montral_project")).toBeUndefined();
    }
  });
});
