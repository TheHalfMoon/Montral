import { createPublicKey, type KeyLike } from "node:crypto";
import type { Repo } from "@montral/repo";
import { guardedFetch, readCapped } from "./netguard";
import { withPreparedManagedProbeCredential } from "./managed-probe-credential-access";
import type { ManagedProbeKekProvider } from "./managed-probe-kek-provider";
import { consumeManagedProbeEnrollmentGrantById, createManagedProbeEnrollmentGrant } from "./managed-probe-enrollment";
import {
  verifyManagedProbeEnrollmentGrant,
  verifyManagedProbeEnrollmentProof,
  type SignedManagedProbeEnrollmentGrant,
} from "./managed-probe-enrollment-grant";

const DELIVERY_TIMEOUT_MS = 8_000;
const MAX_DELIVERY_RESPONSE_BYTES = 4_096;
const MAX_DELIVERY_REQUEST_BYTES = 8_192;
const MAX_DELIVERY_ATTEMPTS = 2;

export type ManagedProbeEnrollmentDeliveryOutcome = "proof_verified" | "retryable";

/**
 * Deliver one prepared credential through the registered HTTPS endpoint. The persisted signed envelope makes every
 * retry byte-for-byte stable across API replicas and restarts. A confirmed proof consumes the grant, but leaves the
 * credential prepared and unusable; runtime activation is a separate, unimplemented lifecycle step.
 */
export async function deliverManagedProbeEnrollment(input: {
  repo: Pick<Repo,
    | "issueManagedProbeEnrollmentGrant"
    | "managedProbeIssuedEnrollmentGrantForDelivery"
    | "managedProbeRegistrationForEnrollment"
    | "managedProbeCredentialState"
    | "preparedManagedProbeCredentialEnvelope"
    | "consumeManagedProbeEnrollmentGrantById"
  >;
  region: string;
  versionId: string;
  operatorId: string;
  keyId: string;
  signingKey: KeyLike;
  kekProvider: ManagedProbeKekProvider;
}): Promise<ManagedProbeEnrollmentDeliveryOutcome> {
  let requestBody: Buffer | undefined;
  let secretBytes: Buffer | undefined;
  try {
    const credentialState = await input.repo.managedProbeCredentialState?.(input.region, input.versionId);
    if (credentialState === "verified") return "proof_verified";
    if (credentialState === "revoked" || (input.repo.managedProbeCredentialState && credentialState !== "prepared")) return "retryable";
    let pending = await input.repo.managedProbeIssuedEnrollmentGrantForDelivery?.(input.region) ?? null;
    if (pending && pending.versionId !== input.versionId) return "retryable";
    if (!pending) {
      const registration = await input.repo.managedProbeRegistrationForEnrollment?.(input.region) ?? null;
      if (!registration) return "retryable";
      try {
        await createManagedProbeEnrollmentGrant(input.repo, {
          region: input.region,
          versionId: input.versionId,
          endpointUrl: registration.endpointUrl,
          operatorId: input.operatorId,
          keyId: input.keyId,
          signingKey: input.signingKey,
        });
      } catch {
        // A concurrent request may have issued the unique pending grant. Re-read and reuse that exact envelope.
      }
      pending = await input.repo.managedProbeIssuedEnrollmentGrantForDelivery?.(input.region) ?? null;
    }
    if (!pending || pending.versionId !== input.versionId) return "retryable";

    const envelope = pending.signedEnvelope as SignedManagedProbeEnrollmentGrant;
    const publicKey = createPublicKey(input.signingKey);
    const claims = verifyManagedProbeEnrollmentGrant(envelope, new Map([[input.keyId, publicKey]]));
    if (!claims || claims.grantId !== pending.id || claims.region !== pending.region ||
        claims.credentialVersionId !== pending.versionId || claims.endpointUrl !== pending.endpointUrl) return "retryable";

    return await withPreparedManagedProbeCredential(
      input.repo, pending.region, pending.versionId, input.kekProvider, async (credential) => {
        const currentSecretBytes = Buffer.from(credential);
        secretBytes = currentSecretBytes;
        const currentRequestBody = Buffer.from(JSON.stringify({
          grant: envelope,
          credential: currentSecretBytes.toString("base64url"),
        }), "utf8");
        requestBody = currentRequestBody;
        if (currentRequestBody.byteLength > MAX_DELIVERY_REQUEST_BYTES) return "retryable";

        const url = new URL(`${pending.endpointUrl}/enroll`);
        for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
          const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
          const outboundBody = new Uint8Array(currentRequestBody.byteLength);
          outboundBody.set(currentRequestBody);
          try {
            const { res, url: reached } = await guardedFetch(url.toString(), {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: outboundBody,
              signal,
              cache: "no-store",
            }, { follow: false, protectBody: true, publicOnly: true });
            const responseText = await readCapped(res, MAX_DELIVERY_RESPONSE_BYTES, signal);
            if (reached !== url.toString()) return "retryable";
            if ([502, 503, 504].includes(res.status) && attempt + 1 < MAX_DELIVERY_ATTEMPTS) continue;
            if (res.status !== 200) return "retryable";

            let response: unknown;
            try { response = JSON.parse(responseText) as unknown; } catch { return "retryable"; }
            if (!response || typeof response !== "object" || Array.isArray(response) ||
                Object.keys(response).sort().join(",") !== "credentialVersionId,grantId,proof") return "retryable";
            const proofResponse = response as Record<string, unknown>;
            if (proofResponse.grantId !== claims.grantId || proofResponse.credentialVersionId !== claims.credentialVersionId ||
                !verifyManagedProbeEnrollmentProof(claims, currentRequestBody, credential, proofResponse.proof)) return "retryable";

            const consumed = await consumeManagedProbeEnrollmentGrantById(input.repo, { claims, actorId: "probe-enrollment" });
            return consumed ? "proof_verified" : "retryable";
          } catch {
            // The probe stores the grant/version idempotently; only an identical persisted payload is retried once.
            if (attempt + 1 >= MAX_DELIVERY_ATTEMPTS) return "retryable";
          } finally {
            outboundBody.fill(0);
          }
        }
        return "retryable";
      },
    );
  } catch {
    // Network failures are ambiguous: retain the issued grant and retry only its exact envelope and payload.
    return "retryable";
  } finally {
    requestBody?.fill(0);
    secretBytes?.fill(0);
  }
}
