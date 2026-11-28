import { createHash, createHmac, createPrivateKey, createPublicKey, KeyObject, sign, timingSafeEqual, verify, type KeyLike } from "node:crypto";
import { AUTO, REGION_ID } from "./regions";
import { hostBlocked } from "./netguard";

export const MANAGED_PROBE_ENROLLMENT_PURPOSE = "probe-hmac-signing" as const;
export const MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS = 4 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const GRANT_DOMAIN = "montral:managed-probe-enrollment-grant:v1";
const PROOF_DOMAIN = "montral:managed-probe-enrollment-proof:v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Public, signed bootstrap claims. The signer key stays in the API process; probes receive only a pinned public key. */
export interface ManagedProbeEnrollmentGrantClaims {
  version: 1;
  keyId: string;
  grantId: string;
  region: string;
  endpointUrl: string;
  purpose: typeof MANAGED_PROBE_ENROLLMENT_PURPOSE;
  credentialVersionId: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface SignedManagedProbeEnrollmentGrant {
  claims: ManagedProbeEnrollmentGrantClaims;
  signature: string;
}

function decodeNonce(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value ? bytes : null;
}

function validEndpoint(region: string, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.toString() === value && url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && !value.includes("?") && !value.includes("#") &&
      Boolean(host) && !hostBlocked(host) && !host.includes(":") &&
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && url.pathname === `/api/probe/${region}`;
  } catch {
    return false;
  }
}

function validClaims(value: unknown, nowMs: number): value is ManagedProbeEnrollmentGrantClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  if (Object.keys(claims).sort().join(",") !== [
    "credentialVersionId", "endpointUrl", "expiresAtMs", "grantId", "issuedAtMs", "keyId", "nonce", "purpose", "region", "version",
  ].join(",")) return false;
  const region = claims.region;
  const issuedAtMs = claims.issuedAtMs;
  const expiresAtMs = claims.expiresAtMs;
  const nonce = decodeNonce(claims.nonce);
  const valid = claims.version === 1 && typeof claims.keyId === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(claims.keyId) &&
    typeof region === "string" && region !== AUTO && REGION_ID.test(region) &&
    UUID_V4.test(String(claims.grantId)) && UUID_V4.test(String(claims.credentialVersionId)) &&
    claims.purpose === MANAGED_PROBE_ENROLLMENT_PURPOSE && validEndpoint(region, claims.endpointUrl) &&
    nonce !== null && Number.isSafeInteger(issuedAtMs) && Number.isSafeInteger(expiresAtMs) &&
    (expiresAtMs as number) > (issuedAtMs as number) &&
    (expiresAtMs as number) - (issuedAtMs as number) <= MANAGED_PROBE_ENROLLMENT_GRANT_MAX_AGE_MS &&
    (issuedAtMs as number) <= nowMs + CLOCK_SKEW_MS && (expiresAtMs as number) > nowMs;
  nonce?.fill(0);
  return valid;
}

function canonicalGrant(claims: ManagedProbeEnrollmentGrantClaims): Buffer {
  return Buffer.from(JSON.stringify([
    GRANT_DOMAIN,
    claims.version,
    claims.keyId,
    claims.grantId,
    claims.region,
    claims.endpointUrl,
    claims.purpose,
    claims.credentialVersionId,
    claims.nonce,
    claims.issuedAtMs,
    claims.expiresAtMs,
  ]), "utf8");
}

function isEd25519Key(key: KeyLike, kind: "private" | "public"): boolean {
  try {
    const parsed = key instanceof KeyObject ? key : kind === "private" ? createPrivateKey(key) : createPublicKey(key);
    return parsed.asymmetricKeyType === "ed25519" && parsed.type === kind;
  } catch {
    return false;
  }
}

function canonicalProof(claims: ManagedProbeEnrollmentGrantClaims, method: "POST", path: string, body: Uint8Array): Buffer {
  const digest = createHash("sha256").update(body).digest("base64url");
  const transcript = Buffer.from(JSON.stringify([
    PROOF_DOMAIN,
    claims.version,
    method,
    path,
    claims.keyId,
    claims.grantId,
    claims.region,
    claims.endpointUrl,
    claims.purpose,
    claims.credentialVersionId,
    claims.nonce,
    claims.issuedAtMs,
    claims.expiresAtMs,
    digest,
  ]), "utf8");
  return transcript;
}

/** Sign a short-lived grant for transport to one configured probe. Not mounted by any HTTP route. */
export function signManagedProbeEnrollmentGrant(
  claims: ManagedProbeEnrollmentGrantClaims,
  privateKey: KeyLike,
  nowMs = Date.now(),
): SignedManagedProbeEnrollmentGrant {
  if (!validClaims(claims, nowMs) || !isEd25519Key(privateKey, "private")) throw new Error("Managed probe enrollment grant is invalid");
  const transcript = canonicalGrant(claims);
  try {
    return { claims: { ...claims }, signature: sign(null, transcript, privateKey).toString("base64url") };
  } catch {
    throw new Error("Managed probe enrollment grant is unavailable");
  } finally {
    transcript.fill(0);
  }
}

/** Verify a pinned API signature and every grant binding before a probe accepts credential bytes. */
export function verifyManagedProbeEnrollmentGrant(
  value: unknown,
  publicKeys: ReadonlyMap<string, KeyLike>,
  nowMs = Date.now(),
): ManagedProbeEnrollmentGrantClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "claims,signature" || !validClaims(envelope.claims, nowMs) ||
      typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) return null;
  const signature = Buffer.from(envelope.signature, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== envelope.signature) return null;
  const key = publicKeys.get(envelope.claims.keyId);
  if (!key || !isEd25519Key(key, "public")) return null;
  const transcript = canonicalGrant(envelope.claims);
  try {
    return verify(null, transcript, key, signature) ? { ...envelope.claims } : null;
  } catch {
    return null;
  } finally {
    transcript.fill(0);
    signature.fill(0);
  }
}

/** Create a deterministic proof over the exact request body and signed grant, using raw stored credential bytes. */
export function createManagedProbeEnrollmentProof(
  claims: ManagedProbeEnrollmentGrantClaims,
  requestBody: Uint8Array,
  credential: Uint8Array,
): string {
  if (!(requestBody instanceof Uint8Array) || requestBody.byteLength > 16 * 1024 ||
      !(credential instanceof Uint8Array) || credential.byteLength !== 32) throw new Error("Managed probe enrollment proof is invalid");
  const path = `/api/probe/${claims.region}/enroll`;
  const transcript = canonicalProof(claims, "POST", path, requestBody);
  try {
    return createHmac("sha256", credential).update(transcript).digest("base64url");
  } finally {
    transcript.fill(0);
  }
}

/** Verify the receiver's possession proof in constant time. The grant must already pass signature and expiry checks. */
export function verifyManagedProbeEnrollmentProof(
  claims: ManagedProbeEnrollmentGrantClaims,
  requestBody: Uint8Array,
  credential: Uint8Array,
  proof: unknown,
): boolean {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
      !(credential instanceof Uint8Array) || credential.byteLength !== 32 ||
      !(requestBody instanceof Uint8Array) || requestBody.byteLength > 16 * 1024) return false;
  const supplied = Buffer.from(proof, "base64url");
  if (supplied.byteLength !== 32 || supplied.toString("base64url") !== proof) return false;
  const transcript = canonicalProof(claims, "POST", `/api/probe/${claims.region}/enroll`, requestBody);
  try {
    const expected = createHmac("sha256", credential).update(transcript).digest();
    try { return timingSafeEqual(expected, supplied); } finally { expected.fill(0); }
  } catch {
    return false;
  } finally {
    transcript.fill(0);
    supplied.fill(0);
  }
}
