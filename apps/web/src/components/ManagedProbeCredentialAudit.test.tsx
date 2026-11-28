import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManagedProbeCredentialAuditEvent } from "../lib/operator-api";
import { ManagedProbeCredentialAuditView } from "./ManagedProbeRegistrations";

describe("managed probe credential audit view", () => {
  it("shows lifecycle metadata while explaining the secret and execution boundary", () => {
    const events: ManagedProbeCredentialAuditEvent[] = [{
      id: "enrollment-1", versionId: "synthetic-version", action: "enrollment.consume", actorId: "probe-enrollment", createdAt: "2026-11-28T00:00:00.000Z",
    }];
    const html = renderToStaticMarkup(createElement(ManagedProbeCredentialAuditView, { region: "iad-east", events, error: "" }));
    expect(html).toContain("Credential lifecycle history");
    expect(html).toContain("enrollment.consume");
    expect(html).toContain("synthetic-version");
    expect(html).toContain("never displays credentials, ciphertext, encryption nonces, or enrollment tokens");
    expect(html).toContain("history does not mean monitoring is enabled");
  });

  it("shows a bounded empty state and safe errors", () => {
    expect(renderToStaticMarkup(createElement(ManagedProbeCredentialAuditView, { region: "iad-east", events: [], error: "" })))
      .toContain("No credential lifecycle events found for iad-east.");
    expect(renderToStaticMarkup(createElement(ManagedProbeCredentialAuditView, { region: "iad-east", events: [], error: "History unavailable" })))
      .toContain('role="alert"');
  });
});
