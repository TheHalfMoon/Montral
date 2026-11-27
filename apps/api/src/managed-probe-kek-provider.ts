import {
  decryptManagedProbeCredential,
  generateEncryptedManagedProbeCredential,
  MANAGED_PROBE_KEK_BYTES,
  type ManagedProbeCredentialEnvelope,
} from "./managed-probe-credential-envelope";

/**
 * External secret-source boundary. Implementations should return key material from a local secret file,
 * Docker/systemd credential, or another explicitly configured provider; this module persists no keys.
 * Returned arrays are borrowed and remain provider-owned: this module copies and clears only its own copy,
 * then invokes the optional release hook so providers can wipe the borrowed bytes. Providers without that
 * hook must define their own in-memory key lifetime and should return short-lived copies when practical.
 */
export interface ManagedProbeKekProvider {
  getActiveKey(): Promise<{ version: number; key: Uint8Array } | null>;
  getKey(version: number): Promise<Uint8Array | null>;
  /** Best-effort cleanup for provider-owned bytes returned above; implementations must not throw. */
  releaseKey?(key: Uint8Array): void;
}

const ENCRYPTION_ERROR = "Managed probe credential encryption failed";
const DECRYPTION_ERROR = "Managed probe credential unavailable";

function copyKey(key: unknown): Uint8Array | null {
  if (!(key instanceof Uint8Array) || key.byteLength !== MANAGED_PROBE_KEK_BYTES) return null;
  return new Uint8Array(key);
}

function releaseKey(provider: ManagedProbeKekProvider, key: Uint8Array): void {
  try {
    provider.releaseKey?.(key);
  } catch { /* cleanup is best-effort and must not replace a completed crypto operation */ }
}

/** Encrypt with the externally selected current key. Provider errors are sanitized and copied key bytes are cleared. */
export async function generateEncryptedManagedProbeCredentialWithProvider(
  regionId: string,
  provider: ManagedProbeKekProvider,
): Promise<{ credentialVersionId: string; credential: Uint8Array; envelope: ManagedProbeCredentialEnvelope }> {
  let active: { version: number; key: Uint8Array } | null;
  try {
    active = await provider.getActiveKey();
  } catch {
    throw new Error(ENCRYPTION_ERROR);
  }
  if (!active) throw new Error(ENCRYPTION_ERROR);
  const key = copyKey(active.key);
  try {
    if (!Number.isSafeInteger(active.version) || active.version < 1 || active.version > 2_147_483_647 || !key) {
      throw new Error(ENCRYPTION_ERROR);
    }
    return await generateEncryptedManagedProbeCredential(regionId, active.version, key);
  } catch {
    throw new Error(ENCRYPTION_ERROR);
  } finally {
    key?.fill(0);
    if (active.key instanceof Uint8Array) {
      releaseKey(provider, active.key);
    }
  }
}

/** Resolve only the envelope's declared key version. Missing keys and provider/decryption errors fail closed uniformly. */
export async function decryptManagedProbeCredentialWithProvider(
  regionId: string,
  credentialVersionId: string,
  envelope: ManagedProbeCredentialEnvelope,
  provider: ManagedProbeKekProvider,
): Promise<Uint8Array> {
  if (!envelope || !Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1 || envelope.keyVersion > 2_147_483_647) {
    throw new Error(DECRYPTION_ERROR);
  }
  let suppliedKey: Uint8Array | null;
  try {
    suppliedKey = await provider.getKey(envelope.keyVersion);
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
  const key = copyKey(suppliedKey);
  try {
    if (!key) throw new Error(DECRYPTION_ERROR);
    return await decryptManagedProbeCredential(regionId, credentialVersionId, key, envelope);
  } catch {
    throw new Error(DECRYPTION_ERROR);
  } finally {
    key?.fill(0);
    if (suppliedKey instanceof Uint8Array) {
      releaseKey(provider, suppliedKey);
    }
  }
}
