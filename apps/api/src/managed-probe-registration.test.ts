import { describe, expect, it } from "vitest";
import { parseManagedProbeRegistrationInput } from "./managed-probe-registration";

describe("parseManagedProbeRegistrationInput", () => {
  const valid = { region: "iad-east", displayName: "  Virginia  ", endpointUrl: "https://probe.example.test/api/probe/iad-east" };

  it("trims metadata and canonicalizes a DNS HTTPS endpoint without making a request", () => {
    expect(parseManagedProbeRegistrationInput(valid)).toEqual({
      ok: true,
      value: { region: "iad-east", displayName: "Virginia", endpointUrl: "https://probe.example.test/api/probe/iad-east" },
    });
  });

  it.each(["auto", "A-region", "x", "region with spaces", "a".repeat(25)])("rejects invalid region id %s", (region) => {
    expect(parseManagedProbeRegistrationInput({ ...valid, region })).toEqual({ ok: false, code: "invalid_region" });
  });

  it.each([
    "http://probe.example.test/api/probe/iad-east",
    "https://user:password@probe.example.test/api/probe/iad-east",
    "https://probe.example.test/api/probe/iad-east?token=secret",
    "https://probe.example.test/api/probe/iad-east#fragment",
    "https://probe.example.test/api/probe/other-region",
    "https://localhost/api/probe/iad-east",
    "https://probe.internal/api/probe/iad-east",
    "https://probe.local/api/probe/iad-east",
    "https://probe/api/probe/iad-east",
    "https://127.0.0.1/api/probe/iad-east",
    "https://[::1]/api/probe/iad-east",
  ])("rejects unsafe or mismatched endpoint %s", (endpointUrl) => {
    expect(parseManagedProbeRegistrationInput({ ...valid, endpointUrl })).toEqual({ ok: false, code: "invalid_endpoint" });
  });

  it("rejects empty, overlong, control-character, and extra-field metadata", () => {
    expect(parseManagedProbeRegistrationInput({ ...valid, displayName: "  " })).toEqual({ ok: false, code: "invalid_name" });
    expect(parseManagedProbeRegistrationInput({ ...valid, displayName: "n".repeat(61) })).toEqual({ ok: false, code: "invalid_name" });
    expect(parseManagedProbeRegistrationInput({ ...valid, displayName: "North\nRegion" })).toEqual({ ok: false, code: "invalid_name" });
    expect(parseManagedProbeRegistrationInput({ ...valid, endpointUrl: "https://probe.example.test/api/probe/iad-east\n" })).toEqual({ ok: false, code: "invalid_endpoint" });
    expect(parseManagedProbeRegistrationInput({ ...valid, credential: "must-not-be-accepted" })).toEqual({ ok: false, code: "invalid_endpoint" });
  });
});
