import type { PreparedManagedProbeCredentialEnvelope, Repo } from "@montral/repo";
import { decryptManagedProbeCredentialWithProvider, type ManagedProbeKekProvider } from "./managed-probe-kek-provider";

const UNAVAILABLE = "Managed probe credential unavailable";
const USE_FAILED = "Managed probe credential operation failed";

/**
 * Decrypt one prepared credential for a single internal callback, then wipe the plaintext buffer.
 * This helper does not authorize operators, deliver credentials, or prevent a concurrent later revocation.
 * Callers must bound their operation and establish fresh authorization/revocation semantics before use.
 */
export async function withPreparedManagedProbeCredential<T>(
  repo: Pick<Repo, "preparedManagedProbeCredentialEnvelope">,
  region: string,
  versionId: string,
  provider: ManagedProbeKekProvider,
  useCredential: (credential: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const read = repo.preparedManagedProbeCredentialEnvelope;
  if (!read) throw new Error(UNAVAILABLE);

  let envelope: PreparedManagedProbeCredentialEnvelope | null;
  try {
    envelope = await read.call(repo, region, versionId);
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (!envelope) throw new Error(UNAVAILABLE);
  if (envelope.region !== region || envelope.versionId !== versionId) throw new Error(UNAVAILABLE);

  let credential: Uint8Array;
  try {
    credential = await decryptManagedProbeCredentialWithProvider(
      envelope.region,
      envelope.versionId,
      envelope,
      provider,
    );
  } catch {
    throw new Error(UNAVAILABLE);
  }

  try {
    return await useCredential(credential);
  } catch {
    throw new Error(USE_FAILED);
  } finally {
    credential.fill(0);
  }
}
