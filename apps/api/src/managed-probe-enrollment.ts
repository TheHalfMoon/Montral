import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Repo } from "@montral/repo";
import type { KeyLike } from "node:crypto";
import { signManagedProbeEnrollmentGrant, type SignedManagedProbeEnrollmentGrant } from "./managed-probe-enrollment-grant";

const TOKEN_BYTES = 32;
const NONCE_BYTES = 32;
export const MANAGED_PROBE_ENROLLMENT_GRANT_TTL_MS = 4 * 60 * 1000;

function digest(value: Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function decodeOpaque(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === TOKEN_BYTES && bytes.toString("base64url") === value ? bytes : null;
}

/**
 * Create only a short-lived, one-use authorization. The repository receives SHA-256 digests, never the token or nonce.
 * This internal primitive is not wired to an HTTP endpoint and does not retrieve or deliver a credential.
 */
export async function createManagedProbeEnrollmentGrant(
  repo: Pick<Repo, "issueManagedProbeEnrollmentGrant">,
  input: { region: string; versionId: string; endpointUrl: string; operatorId: string; keyId: string; signingKey: KeyLike },
): Promise<{ id: string; token: string; nonce: string; expiresAt: Date; signedEnvelope: SignedManagedProbeEnrollmentGrant }> {
  const issue = repo.issueManagedProbeEnrollmentGrant;
  if (!issue) throw new Error("Managed probe enrollment is unavailable");
  const tokenBytes = randomBytes(TOKEN_BYTES);
  const nonceBytes = randomBytes(NONCE_BYTES);
  const token = tokenBytes.toString("base64url");
  const nonce = nonceBytes.toString("base64url");
  const expiresAt = new Date(Date.now() + MANAGED_PROBE_ENROLLMENT_GRANT_TTL_MS);
  const id = randomUUID();
  const tokenDigest = digest(tokenBytes);
  const nonceDigest = digest(nonceBytes);
  try {
    const issuedAtMs = Date.now();
    const expiresAtMs = expiresAt.getTime();
    const signedEnvelope = signManagedProbeEnrollmentGrant({
      version: 1, keyId: input.keyId, grantId: id, region: input.region, endpointUrl: input.endpointUrl,
      purpose: "probe-hmac-signing", credentialVersionId: input.versionId, nonce,
      issuedAtMs, expiresAtMs,
    }, input.signingKey, issuedAtMs);
    const outcome = await issue.call(repo, {
      id,
      region: input.region,
      versionId: input.versionId,
      endpointUrl: input.endpointUrl,
      operatorId: input.operatorId,
      tokenDigest,
      nonceDigest,
      signedEnvelope,
      expiresAt,
    });
    if (outcome !== "issued") throw new Error("Managed probe enrollment is unavailable");
    return { id, token, nonce, expiresAt, signedEnvelope };
  } catch {
    throw new Error("Managed probe enrollment is unavailable");
  } finally {
    tokenBytes.fill(0);
    nonceBytes.fill(0);
    tokenDigest.fill(0);
    nonceDigest.fill(0);
  }
}

/** Consume only after the exact persisted grant and a valid credential possession proof have been verified. */
export async function consumeManagedProbeEnrollmentGrantById(
  repo: Pick<Repo, "consumeManagedProbeEnrollmentGrantById">,
  input: { claims: SignedManagedProbeEnrollmentGrant["claims"]; actorId: string },
): Promise<boolean> {
  const consume = repo.consumeManagedProbeEnrollmentGrantById;
  if (!consume) return false;
  const nonce = decodeOpaque(input.claims.nonce);
  if (!nonce) return false;
  const nonceDigest = digest(nonce);
  try {
    try {
      return await consume.call(repo, {
        id: input.claims.grantId, nonceDigest, region: input.claims.region,
        versionId: input.claims.credentialVersionId, endpointUrl: input.claims.endpointUrl, actorId: input.actorId,
      }) === "consumed";
    } catch {
      throw new Error("Managed probe enrollment is unavailable");
    }
  } finally {
    nonce.fill(0);
    nonceDigest.fill(0);
  }
}

/** Consume a one-time authorization without returning or decrypting credential material. */
export async function consumeManagedProbeEnrollmentGrant(
  repo: Pick<Repo, "consumeManagedProbeEnrollmentGrant">,
  input: { token: string; nonce: string; region: string; versionId: string; endpointUrl: string },
): Promise<boolean> {
  const consume = repo.consumeManagedProbeEnrollmentGrant;
  const token = decodeOpaque(input.token);
  const nonce = decodeOpaque(input.nonce);
  if (!consume || !token || !nonce) return false;
  const tokenDigest = digest(token);
  const nonceDigest = digest(nonce);
  try {
    try {
      return await consume.call(repo, {
        tokenDigest,
        nonceDigest,
        region: input.region,
        versionId: input.versionId,
        endpointUrl: input.endpointUrl,
        actorId: "probe-enrollment",
      }) === "consumed";
    } catch {
      throw new Error("Managed probe enrollment is unavailable");
    }
  } finally {
    token.fill(0);
    nonce.fill(0);
    tokenDigest.fill(0);
    nonceDigest.fill(0);
  }
}
