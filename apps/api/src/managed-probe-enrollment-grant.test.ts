import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS,
  MANAGED_PROBE_ENROLLMENT_PURPOSE,
  createManagedProbeEnrollmentProof,
  signManagedProbeEnrollmentGrant,
  verifyManagedProbeEnrollmentProof,
  verifyManagedProbeEnrollmentGrant,
  type ManagedProbeEnrollmentGrantClaims,
} from "./managed-probe-enrollment-grant";

const now = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
const { privateKey: ed448PrivateKey, publicKey: ed448PublicKey } = generateKeyPairSync("ed448");

function claims(overrides: Partial<ManagedProbeEnrollmentGrantClaims> = {}): ManagedProbeEnrollmentGrantClaims {
  return {
    version: 1,
    keyId: "synthetic-api-1",
    grantId: randomUUID(),
    region: "eu-central",
    endpointUrl: "https://probe.example.test/api/probe/eu-central",
    purpose: MANAGED_PROBE_ENROLLMENT_PURPOSE,
    credentialVersionId: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    issuedAtMs: now,
    expiresAtMs: now + MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS,
    ...overrides,
  };
}

describe("managed probe enrollment grant signature", () => {
  it("signs and verifies the exact region, endpoint, purpose, credential version, nonce, and expiry", () => {
    const signed = signManagedProbeEnrollmentGrant(claims(), privateKey, now);
    expect(verifyManagedProbeEnrollmentGrant(signed, new Map([["synthetic-api-1", publicKey]]), now)).toEqual(signed.claims);
    expect(verifyManagedProbeEnrollmentGrant(signed, new Map([["synthetic-api-1", otherPublicKey]]), now)).toBeNull();
  });

  it("rejects tampered, extra, or missing envelope and claim fields", () => {
    const signed = signManagedProbeEnrollmentGrant(claims(), privateKey, now);
    expect(verifyManagedProbeEnrollmentGrant({ ...signed, claims: { ...signed.claims, region: "us-west" } }, new Map([["synthetic-api-1", publicKey]]), now)).toBeNull();
    expect(verifyManagedProbeEnrollmentGrant({ ...signed, unexpected: true }, new Map([["synthetic-api-1", publicKey]]), now)).toBeNull();
    expect(verifyManagedProbeEnrollmentGrant({ ...signed, claims: { ...signed.claims, unexpected: true } }, new Map([["synthetic-api-1", publicKey]]), now)).toBeNull();
    expect(verifyManagedProbeEnrollmentGrant({ ...signed, signature: "!".repeat(86) }, new Map([["synthetic-api-1", publicKey]]), now)).toBeNull();
  });

  it.each([
    ["wrong region endpoint", { endpointUrl: "https://probe.example.test/api/probe/us-west" }],
    ["query-bearing endpoint", { endpointUrl: "https://probe.example.test/api/probe/eu-central?x=1" }],
    ["non-HTTPS endpoint", { endpointUrl: "http://probe.example.test/api/probe/eu-central" }],
    ["invalid purpose", { purpose: "probe-admin" as ManagedProbeEnrollmentGrantClaims["purpose"] }],
    ["expired grant", { expiresAtMs: now }],
    ["grant too long", { expiresAtMs: now + MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS + 1 }],
    ["future-issued grant", { issuedAtMs: now + 6_000, expiresAtMs: now + 30_000 }],
    ["malformed nonce", { nonce: "short" }],
  ])("rejects %s", (_name, invalid) => {
    expect(() => signManagedProbeEnrollmentGrant(claims(invalid), privateKey, now)).toThrow("Managed probe enrollment grant is invalid");
  });

  it("fails closed after expiry and when the signing key id is not pinned", () => {
    const signed = signManagedProbeEnrollmentGrant(claims(), privateKey, now);
    expect(verifyManagedProbeEnrollmentGrant(signed, new Map([["synthetic-api-1", publicKey]]), now + MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS)).toBeNull();
    expect(verifyManagedProbeEnrollmentGrant(signed, new Map(), now)).toBeNull();
  });

  it("rejects non-Ed25519 signing and verification keys", () => {
    expect(() => signManagedProbeEnrollmentGrant(claims(), ed448PrivateKey, now)).toThrow("Managed probe enrollment grant is invalid");
    const signed = signManagedProbeEnrollmentGrant(claims(), privateKey, now);
    expect(verifyManagedProbeEnrollmentGrant(signed, new Map([["synthetic-api-1", ed448PublicKey]]), now)).toBeNull();
  });

  it("proves possession of the exact credential against a deterministic request transcript", () => {
    const grant = claims();
    const body = Buffer.from(JSON.stringify({ grantId: grant.grantId, credentialVersionId: grant.credentialVersionId, credential: "synthetic" }));
    const credential = randomBytes(32);
    const proof = createManagedProbeEnrollmentProof(grant, body, credential);
    expect(createManagedProbeEnrollmentProof(grant, body, credential)).toBe(proof);
    expect(verifyManagedProbeEnrollmentProof(grant, body, credential, proof)).toBe(true);
    expect(verifyManagedProbeEnrollmentProof(grant, Buffer.from(`${body.toString()} `), credential, proof)).toBe(false);
    expect(verifyManagedProbeEnrollmentProof(grant, body, randomBytes(32), proof)).toBe(false);
    expect(verifyManagedProbeEnrollmentProof(grant, body, credential, `${proof}x`)).toBe(false);
    expect(verifyManagedProbeEnrollmentProof(grant, Buffer.alloc(16 * 1024 + 1), credential, proof)).toBe(false);
    credential.fill(0);
  });
});
