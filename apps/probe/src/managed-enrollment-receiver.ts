import { timingSafeEqual, type KeyLike } from "node:crypto";
import {
  createManagedProbeEnrollmentProof,
  verifyManagedProbeEnrollmentGrant,
} from "../../api/src/managed-probe-enrollment-grant";
import type { ManagedProbeCredentialStore } from "./managed-credential-store";

const MAX_ENROLLMENT_BODY_BYTES = 8 * 1024;
const NO_STORE_HEADERS = { "cache-control": "no-store", "content-type": "application/json" };

export interface ManagedProbeEnrollmentReceiverConfig {
  region: string;
  endpointUrl: string;
  /** API Ed25519 verification keys pinned out-of-band by the probe operator. */
  apiPublicKeys: ReadonlyMap<string, KeyLike>;
  credentialStore: ManagedProbeCredentialStore;
}

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });

async function readLimitedBody(req: Request, limit: number): Promise<Buffer | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > limit) return null;
  }
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } catch {
    return null;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function decodeCredential(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const credential = Buffer.from(value, "base64url");
  if (credential.byteLength !== 32 || credential.toString("base64url") !== value) {
    credential.fill(0);
    return null;
  }
  return credential;
}

/**
 * Receive a signed, synthetic enrollment request. This handler is not mounted by the default probe startup;
 * callers must explicitly inject a store and pinned API keys. The HTTP caller must require verified HTTPS.
 */
export async function handleManagedProbeEnrollment(
  req: Request,
  config: ManagedProbeEnrollmentReceiverConfig,
  encryptedTransport: boolean,
): Promise<Response> {
  let body: Buffer | undefined;
  let credential: Buffer | undefined;
  try {
    if (!encryptedTransport) return response(426, { error: "Enrollment requires verified HTTPS" });
    if (req.method !== "POST") return response(405, { error: "Enrollment requires POST" });
    const url = new URL(req.url);
    if (url.search || url.hash || url.pathname !== `/api/probe/${config.region}/enroll`) {
      return response(404, { error: "Enrollment unavailable" });
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type") ?? "")) {
      return response(415, { error: "Enrollment content type is not supported" });
    }
    if (req.headers.has("content-encoding")) return response(415, { error: "Enrollment encoding is not supported" });
    body = await readLimitedBody(req, MAX_ENROLLMENT_BODY_BYTES) ?? undefined;
    if (!body) return response(413, { error: "Enrollment request too large or unreadable" });

    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { return response(400, { error: "Enrollment request is invalid" }); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "credential,grant") {
      return response(400, { error: "Enrollment request is invalid" });
    }
    const envelope = parsed as { grant: unknown; credential: unknown };
    const claims = verifyManagedProbeEnrollmentGrant(envelope.grant, config.apiPublicKeys);
    if (!claims || claims.region !== config.region || claims.endpointUrl !== config.endpointUrl ||
        claims.purpose !== "probe-hmac-signing") return response(401, { error: "Enrollment authorization is invalid" });
    credential = decodeCredential(envelope.credential) ?? undefined;
    if (!credential) return response(400, { error: "Enrollment credential is invalid" });

    const staged = await config.credentialStore.stagePreparedCredential({
      versionId: claims.credentialVersionId,
      credential,
    });
    if (staged === "credential_exists") return response(409, { error: "Probe credential state conflicts with enrollment" });

    const proof = await config.credentialStore.withPreparedCredential(claims.credentialVersionId, (stored) => {
      if (stored.byteLength !== credential!.byteLength || !timingSafeEqual(stored, credential!)) return null;
      return createManagedProbeEnrollmentProof(claims, body!, stored);
    });
    if (!proof) return response(409, { error: "Probe credential could not be verified after persistence" });
    return response(200, { grantId: claims.grantId, credentialVersionId: claims.credentialVersionId, proof });
  } catch {
    return response(503, { error: "Managed probe enrollment is unavailable" });
  } finally {
    credential?.fill(0);
    body?.fill(0);
  }
}
