import { createPublicKey, generateKeyPairSync } from "node:crypto";
import type { Repo } from "@montral/repo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptedManagedProbeCredential } from "./managed-probe-credential-envelope";
import { createManagedProbeEnrollmentProof } from "./managed-probe-enrollment-grant";

const guardedFetch = vi.fn();
vi.mock("./netguard", async () => {
  const actual = await vi.importActual<typeof import("./netguard")>("./netguard");
  return { ...actual, guardedFetch: (...args: unknown[]) => guardedFetch(...args as Parameters<typeof actual.guardedFetch>) };
});

const { deliverManagedProbeEnrollment } = await import("./managed-probe-enrollment-delivery");

const REGION = "synthetic-retry";
const ENDPOINT = `https://${REGION}.example.test/api/probe/${REGION}`;

afterEach(() => guardedFetch.mockReset());

describe("managed probe enrollment delivery", () => {
  it("retries an ambiguous send with the persisted identical grant and body, then consumes once on proof", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const kek = Buffer.alloc(32, 19);
    const generated = await generateEncryptedManagedProbeCredential(REGION, 7, kek);
    const credential = Buffer.from(generated.credential);
    const grantRows = new Map<string, Record<string, unknown>>();
    let credentialState: "prepared" | "verified" | "revoked" = "prepared";
    const issue = vi.fn(async (row: Record<string, unknown>) => { grantRows.set(String(row.id), row); return "issued" as const; });
    const consume = vi.fn(async () => { credentialState = "verified"; return "consumed" as const; });
    const registration = vi.fn(async () => ({ region: REGION, endpointUrl: ENDPOINT }));
    const repo = {
      issueManagedProbeEnrollmentGrant: issue,
      managedProbeIssuedEnrollmentGrantForDelivery: async () => {
        const row = [...grantRows.values()][0];
        if (!row) return null;
        return {
          id: String(row.id), region: REGION, versionId: generated.credentialVersionId, endpointUrl: ENDPOINT,
          signedEnvelope: row.signedEnvelope, expiresAt: row.expiresAt as Date, state: "issued" as const,
        };
      },
      managedProbeRegistrationForEnrollment: registration,
      managedProbeCredentialState: async () => credentialState,
      preparedManagedProbeCredentialEnvelope: async () => ({
        region: REGION, versionId: generated.credentialVersionId, formatVersion: 1 as const, algorithm: "A256GCM" as const,
        keyVersion: generated.envelope.keyVersion, nonce: generated.envelope.nonce, ciphertext: generated.envelope.ciphertext,
      }),
      consumeManagedProbeEnrollmentGrantById: consume,
    } as unknown as Pick<Repo,
      | "issueManagedProbeEnrollmentGrant"
      | "managedProbeIssuedEnrollmentGrantForDelivery"
      | "managedProbeRegistrationForEnrollment"
      | "preparedManagedProbeCredentialEnvelope"
      | "consumeManagedProbeEnrollmentGrantById"
    >;
    const kekProvider = { getActiveKey: async () => null, getKey: async () => kek };
    const bodies: Buffer[] = [];
    guardedFetch
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(Buffer.from(init.body as Uint8Array));
        throw new TypeError("synthetic connection reset after send");
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(Buffer.from(init.body as Uint8Array));
        throw new TypeError("synthetic process restart before receipt");
      })
      .mockImplementationOnce(async (url: string, init: RequestInit, options: { follow: boolean; protectBody: boolean; publicOnly: boolean }) => {
        expect(options).toEqual({ follow: false, protectBody: true, publicOnly: true });
        expect(init.method).toBe("POST");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const body = Buffer.from(init.body as Uint8Array);
        bodies.push(body);
        const request = JSON.parse(body.toString("utf8")) as { grant: { claims: { grantId: string; credentialVersionId: string } }; credential: string };
        const rawCredential = Buffer.from(request.credential, "base64url");
        const proof = createManagedProbeEnrollmentProof(request.grant.claims as never, body, rawCredential);
        rawCredential.fill(0);
        return {
          res: new Response(JSON.stringify({ grantId: request.grant.claims.grantId, credentialVersionId: request.grant.claims.credentialVersionId, proof }), { status: 200 }),
          url,
        };
      });

    const input = {
      repo, region: REGION, versionId: generated.credentialVersionId, operatorId: "synthetic-operator",
      keyId: "synthetic-key", signingKey: privateKey, kekProvider,
    };
    try {
      expect(await deliverManagedProbeEnrollment(input)).toBe("retryable");
      expect(issue).toHaveBeenCalledTimes(1);
      expect(consume).not.toHaveBeenCalled();
      expect(await deliverManagedProbeEnrollment(input)).toBe("proof_verified");
      expect(issue).toHaveBeenCalledTimes(1);
      expect(consume).toHaveBeenCalledTimes(1);
      expect(await deliverManagedProbeEnrollment(input)).toBe("proof_verified");
      expect(guardedFetch).toHaveBeenCalledTimes(3);
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
      expect(bodies[0]!.byteLength).toBeLessThan(8_192);
      expect(createPublicKey(privateKey).export({ type: "spki", format: "der" })).toEqual(publicKey.export({ type: "spki", format: "der" }));
      expect(bodies[0]!.toString("utf8")).toContain("synthetic-key");
      expect(Object.keys(JSON.parse(bodies[0]!.toString("utf8")) as object).sort()).toEqual(["credential", "grant"]);
    } finally {
      credential.fill(0);
      generated.credential.fill(0);
      generated.envelope.nonce.fill(0);
      generated.envelope.ciphertext.fill(0);
      kek.fill(0);
      for (const body of bodies) body.fill(0);
    }
  });

  it("does not consume a redirected, malformed, or invalid-proof response", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const kek = Buffer.alloc(32, 23);
    const generated = await generateEncryptedManagedProbeCredential(REGION, 8, kek);
    const issued: Record<string, unknown>[] = [];
    const consume = vi.fn(async () => "consumed" as const);
    const repo = {
      issueManagedProbeEnrollmentGrant: async (row: Record<string, unknown>) => { issued.push(row); return "issued" as const; },
      managedProbeIssuedEnrollmentGrantForDelivery: async () => issued[0] ? {
        id: String(issued[0].id), region: REGION, versionId: generated.credentialVersionId, endpointUrl: ENDPOINT,
        signedEnvelope: issued[0].signedEnvelope, expiresAt: issued[0].expiresAt as Date, state: "issued" as const,
      } : null,
      managedProbeRegistrationForEnrollment: async () => ({ region: REGION, endpointUrl: ENDPOINT }),
      managedProbeCredentialState: async () => "prepared" as const,
      preparedManagedProbeCredentialEnvelope: async () => ({
        region: REGION, versionId: generated.credentialVersionId, formatVersion: 1 as const, algorithm: "A256GCM" as const,
        keyVersion: generated.envelope.keyVersion, nonce: generated.envelope.nonce, ciphertext: generated.envelope.ciphertext,
      }),
      consumeManagedProbeEnrollmentGrantById: consume,
    } as unknown as Parameters<typeof deliverManagedProbeEnrollment>[0]["repo"];
    const base = {
      repo, region: REGION, versionId: generated.credentialVersionId, operatorId: "synthetic-operator",
      keyId: "synthetic-key", signingKey: privateKey, kekProvider: { getActiveKey: async () => null, getKey: async () => kek },
    };
    try {
      guardedFetch.mockResolvedValueOnce({ res: new Response("", { status: 307, headers: { location: "http://127.0.0.1/" } }), url: `${ENDPOINT}/enroll` });
      expect(await deliverManagedProbeEnrollment(base)).toBe("retryable");
      guardedFetch.mockResolvedValueOnce({ res: new Response(JSON.stringify({ proof: "wrong" }), { status: 200 }), url: `${ENDPOINT}/enroll` });
      expect(await deliverManagedProbeEnrollment(base)).toBe("retryable");
      expect(consume).not.toHaveBeenCalled();
    } finally {
      generated.credential.fill(0);
      generated.envelope.nonce.fill(0);
      generated.envelope.ciphertext.fill(0);
      kek.fill(0);
    }
  });
});
