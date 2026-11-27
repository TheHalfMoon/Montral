import type { Repo } from "@montral/repo";
import { generateEncryptedManagedProbeCredentialWithProvider, type ManagedProbeKekProvider } from "./managed-probe-kek-provider";

const UNAVAILABLE = "Managed probe credential preparation failed";

type PrepareOutcome = Awaited<ReturnType<NonNullable<Repo["prepareManagedProbeCredential"]>>>;

/**
 * Generate and persist inactive managed-probe credential material through one controlled internal path.
 * The plaintext and envelope are never returned, and this function does not enable probe execution or delivery.
 */
export async function generateAndPrepareManagedProbeCredential(
  repo: Pick<Repo, "prepareManagedProbeCredential">,
  region: string,
  operatorId: string,
  provider: ManagedProbeKekProvider,
): Promise<PrepareOutcome> {
  const prepare = repo.prepareManagedProbeCredential;
  if (!prepare) throw new Error(UNAVAILABLE);

  let generated: Awaited<ReturnType<typeof generateEncryptedManagedProbeCredentialWithProvider>>;
  try {
    generated = await generateEncryptedManagedProbeCredentialWithProvider(region, provider);
  } catch {
    throw new Error(UNAVAILABLE);
  }

  try {
    return await prepare.call(repo, {
      region,
      versionId: generated.credentialVersionId,
      formatVersion: generated.envelope.formatVersion,
      algorithm: generated.envelope.algorithm,
      keyVersion: generated.envelope.keyVersion,
      nonce: generated.envelope.nonce,
      ciphertext: generated.envelope.ciphertext,
      operatorId,
    });
  } catch {
    // Do not leak database, provider, or caller-supplied error details through future callers of this helper.
    throw new Error(UNAVAILABLE);
  } finally {
    generated.credential.fill(0);
    generated.envelope.nonce.fill(0);
    generated.envelope.ciphertext.fill(0);
  }
}
