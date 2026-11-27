import { AUTO, REGION_ID } from "./regions";

/**
 * Envelope encryption primitives for future managed probe credentials.
 *
 * This module does not load a key, persist credentials, expose an API, or enable probe execution. Callers must receive
 * a 32-byte KEK from an external secret source and must keep plaintext credential bytes out of logs and responses.
 */

export const MANAGED_PROBE_CREDENTIAL_BYTES = 32;
export const MANAGED_PROBE_KEK_BYTES = 32;
export const MANAGED_PROBE_ENVELOPE_ALGORITHM = "A256GCM" as const;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AAD_PREFIX = "montral:managed-probe-credential:v1";

export interface ManagedProbeCredentialEnvelope {
  readonly formatVersion: 1;
  readonly algorithm: typeof MANAGED_PROBE_ENVELOPE_ALGORITHM;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  /** AES-GCM ciphertext with its 128-bit authentication tag appended. */
  readonly ciphertext: Uint8Array;
}

function validIdentity(regionId: string, credentialVersionId: string): boolean {
  return typeof regionId === "string" && regionId !== AUTO && REGION_ID.test(regionId) &&
    typeof credentialVersionId === "string" && VERSION_ID.test(credentialVersionId);
}

function validKeyVersion(keyVersion: number): boolean {
  return Number.isSafeInteger(keyVersion) && keyVersion > 0 && keyVersion <= 2_147_483_647;
}

function associatedData(regionId: string, credentialVersionId: string, keyVersion: number): ArrayBuffer {
  // JSON array encoding avoids ambiguous delimiter concatenation. Identity inputs are validated before this is called.
  return toArrayBuffer(new TextEncoder().encode(JSON.stringify([AAD_PREFIX, regionId, credentialVersionId, keyVersion])));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importKek(kek: Uint8Array): Promise<CryptoKey> {
  if (!(kek instanceof Uint8Array) || kek.byteLength !== MANAGED_PROBE_KEK_BYTES) {
    throw new Error("Invalid managed probe credential envelope");
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(kek), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Create a fresh random HMAC credential. It is returned only to the immediate caller. */
function generateManagedProbeCredential(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(MANAGED_PROBE_CREDENTIAL_BYTES));
}

/** Generate a non-secret identifier for one credential version. */
function generateManagedProbeCredentialVersionId(): string {
  return crypto.randomUUID();
}

/** Encrypts one credential with AES-256-GCM and binds it to its region, credential version, and KEK version. */
async function encryptManagedProbeCredential(
  regionId: string,
  credentialVersionId: string,
  keyVersion: number,
  kek: Uint8Array,
  credential: Uint8Array,
): Promise<ManagedProbeCredentialEnvelope> {
  if (!validIdentity(regionId, credentialVersionId) || !validKeyVersion(keyVersion) ||
      !(credential instanceof Uint8Array) || credential.byteLength !== MANAGED_PROBE_CREDENTIAL_BYTES) {
    throw new Error("Invalid managed probe credential envelope");
  }

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await importKek(kek);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: associatedData(regionId, credentialVersionId, keyVersion), tagLength: TAG_BYTES * 8 },
    key,
    toArrayBuffer(credential),
  ));
  return { formatVersion: 1, algorithm: MANAGED_PROBE_ENVELOPE_ALGORITHM, keyVersion, nonce, ciphertext };
}

/**
 * Safe generation entry point: always creates a fresh CSPRNG credential and version ID before encrypting.
 * The plaintext is returned only to the immediate caller for a future explicitly qualified provisioning channel.
 */
export async function generateEncryptedManagedProbeCredential(
  regionId: string,
  keyVersion: number,
  kek: Uint8Array,
): Promise<{ credentialVersionId: string; credential: Uint8Array; envelope: ManagedProbeCredentialEnvelope }> {
  const credentialVersionId = generateManagedProbeCredentialVersionId();
  const credential = generateManagedProbeCredential();
  try {
    const envelope = await encryptManagedProbeCredential(regionId, credentialVersionId, keyVersion, kek, credential);
    return { credentialVersionId, credential, envelope };
  } catch (error) {
    credential.fill(0);
    throw error;
  }
}

/**
 * Decrypt one envelope for an explicitly requested identity. All invalid, mismatched, or tampered inputs fail with the
 * same fixed error so callers cannot turn decryption into an information oracle.
 */
export async function decryptManagedProbeCredential(
  regionId: string,
  credentialVersionId: string,
  kek: Uint8Array,
  envelope: ManagedProbeCredentialEnvelope,
): Promise<Uint8Array> {
  if (!validIdentity(regionId, credentialVersionId) || !envelope || envelope.formatVersion !== 1 ||
      envelope.algorithm !== MANAGED_PROBE_ENVELOPE_ALGORITHM || !validKeyVersion(envelope.keyVersion) ||
      !(envelope.nonce instanceof Uint8Array) || envelope.nonce.byteLength !== NONCE_BYTES ||
      !(envelope.ciphertext instanceof Uint8Array) ||
      envelope.ciphertext.byteLength !== MANAGED_PROBE_CREDENTIAL_BYTES + TAG_BYTES) {
    throw new Error("Invalid managed probe credential envelope");
  }

  try {
    const key = await importKek(kek);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(envelope.nonce), additionalData: associatedData(regionId, credentialVersionId, envelope.keyVersion), tagLength: TAG_BYTES * 8 },
      key,
      toArrayBuffer(envelope.ciphertext),
    ));
    if (plaintext.byteLength !== MANAGED_PROBE_CREDENTIAL_BYTES) throw new Error("invalid length");
    return plaintext;
  } catch {
    throw new Error("Invalid managed probe credential envelope");
  }
}

