import { describe, expect, it } from "vitest";
import {
  decryptManagedProbeCredential,
  generateEncryptedManagedProbeCredential,
} from "./managed-probe-credential-envelope";
import {
  decryptManagedProbeCredentialWithProvider,
  generateEncryptedManagedProbeCredentialWithProvider,
  type ManagedProbeKekProvider,
} from "./managed-probe-kek-provider";

const region = "probe-west";
const kek = () => crypto.getRandomValues(new Uint8Array(32));
describe("managed probe credential envelope", () => {
  it("generates independent 256-bit credentials and non-secret UUID version ids", async () => {
    const first = await generateEncryptedManagedProbeCredential(region, 1, kek());
    const second = await generateEncryptedManagedProbeCredential(region, 1, kek());
    expect(first.credential).toHaveLength(32);
    expect(second.credential).toHaveLength(32);
    expect(first.credential).not.toEqual(second.credential);
    expect(first.credentialVersionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.credentialVersionId).not.toEqual(second.credentialVersionId);
  });

  it("round-trips a credential and binds it to region, credential version, and KEK version", async () => {
    const key = kek();
    const generated = await generateEncryptedManagedProbeCredential(region, 3, key);
    const envelope = generated.envelope;

    expect(envelope).toMatchObject({ formatVersion: 1, algorithm: "A256GCM", keyVersion: 3 });
    expect(envelope.nonce).toHaveLength(12);
    expect(envelope.ciphertext).toHaveLength(48);
    expect(envelope.ciphertext).not.toEqual(generated.credential);
    expect(await decryptManagedProbeCredential(region, generated.credentialVersionId, key, envelope)).toEqual(generated.credential);
    await expect(decryptManagedProbeCredential(region, "a1b3fbf5-c74f-45c4-88cb-65c3274943d1", key, envelope)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential("probe-east", generated.credentialVersionId, key, envelope)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, kek(), envelope)).rejects.toThrow("Invalid managed probe credential envelope");
  });

  it("uses a fresh nonce for every encryption under the same key", async () => {
    const key = kek();
    const first = await generateEncryptedManagedProbeCredential(region, 1, key);
    const second = await generateEncryptedManagedProbeCredential(region, 1, key);
    expect(first.envelope.nonce).not.toEqual(second.envelope.nonce);
    expect(first.envelope.ciphertext).not.toEqual(second.envelope.ciphertext);
  });

  it("rejects nonce and ciphertext tampering", async () => {
    const key = kek();
    const generated = await generateEncryptedManagedProbeCredential(region, 1, key);
    const envelope = generated.envelope;
    const badNonce = { ...envelope, nonce: Uint8Array.from(envelope.nonce) };
    badNonce.nonce[0] ^= 1;
    const badCiphertext = { ...envelope, ciphertext: Uint8Array.from(envelope.ciphertext) };
    badCiphertext.ciphertext[0] ^= 1;

    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, key, badNonce)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, key, badCiphertext)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, key, { ...envelope, keyVersion: 2 })).rejects.toThrow("Invalid managed probe credential envelope");
  });

  it("rejects malformed key sizes, credential sizes, identities, and envelope fields", async () => {
    const goodKek = kek();
    await expect(generateEncryptedManagedProbeCredential("AUTO", 1, goodKek)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(generateEncryptedManagedProbeCredential("auto", 1, goodKek)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(generateEncryptedManagedProbeCredential(region, 0, goodKek)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(generateEncryptedManagedProbeCredential(null as never, 1, goodKek)).rejects.toThrow("Invalid managed probe credential envelope");

    // Match REGION_ID and the managed registration database constraint, including their accepted trailing hyphen.
    await expect(generateEncryptedManagedProbeCredential("a-", 1, goodKek)).resolves.toBeDefined();
    await expect(generateEncryptedManagedProbeCredential("a", 1, goodKek)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(generateEncryptedManagedProbeCredential("a".repeat(24), 1, goodKek)).resolves.toBeDefined();
    await expect(generateEncryptedManagedProbeCredential("a".repeat(25), 1, goodKek)).rejects.toThrow("Invalid managed probe credential envelope");

    const generated = await generateEncryptedManagedProbeCredential(region, 1, goodKek);
    const envelope = generated.envelope;
    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, new Uint8Array(31), envelope)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, goodKek, { ...envelope, algorithm: "AES-CBC" } as never)).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential(region, generated.credentialVersionId, goodKek, { ...envelope, ciphertext: new Uint8Array(47) })).rejects.toThrow("Invalid managed probe credential envelope");
    await expect(decryptManagedProbeCredential(null as never, generated.credentialVersionId, goodKek, envelope)).rejects.toThrow("Invalid managed probe credential envelope");
  });
});

describe("external managed probe KEK provider", () => {
  it("selects explicit key versions across rotation and key-source recovery", async () => {
    const key1 = kek();
    const key2 = kek();
    const key1Before = new Uint8Array(key1);
    const key2Before = new Uint8Array(key2);
    const keys = new Map([[1, key1], [2, key2]]);
    let activeVersion = 1;
    const provider: ManagedProbeKekProvider = {
      getActiveKey: async () => ({ version: activeVersion, key: keys.get(activeVersion)! }),
      getKey: async (version) => keys.get(version) ?? null,
    };

    const oldVersion = await generateEncryptedManagedProbeCredentialWithProvider(region, provider);
    activeVersion = 2;
    const newVersion = await generateEncryptedManagedProbeCredentialWithProvider(region, provider);
    expect(oldVersion.envelope.keyVersion).toBe(1);
    expect(newVersion.envelope.keyVersion).toBe(2);
    await expect(decryptManagedProbeCredentialWithProvider(region, oldVersion.credentialVersionId, oldVersion.envelope, provider))
      .resolves.toEqual(oldVersion.credential);
    await expect(decryptManagedProbeCredentialWithProvider(region, newVersion.credentialVersionId, newVersion.envelope, provider))
      .resolves.toEqual(newVersion.credential);
    expect(key1).toEqual(key1Before);
    expect(key2).toEqual(key2Before);

    const recoveredProvider: ManagedProbeKekProvider = {
      getActiveKey: async () => ({ version: 2, key: new Uint8Array(key2) }),
      getKey: async (version) => keys.get(version) ? new Uint8Array(keys.get(version)!) : null,
    };
    await expect(decryptManagedProbeCredentialWithProvider(region, oldVersion.credentialVersionId, oldVersion.envelope, recoveredProvider))
      .resolves.toEqual(oldVersion.credential);
    await expect(decryptManagedProbeCredentialWithProvider(region, newVersion.credentialVersionId, newVersion.envelope, recoveredProvider))
      .resolves.toEqual(newVersion.credential);

    keys.delete(1);
    await expect(decryptManagedProbeCredentialWithProvider(region, oldVersion.credentialVersionId, oldVersion.envelope, provider))
      .rejects.toThrow("Managed probe credential unavailable");
    await expect(decryptManagedProbeCredentialWithProvider(region, newVersion.credentialVersionId, newVersion.envelope, provider))
      .resolves.toEqual(newVersion.credential);
  });

  it("fails closed and sanitizes missing keys, malformed keys, and provider errors", async () => {
    const secretBearingProvider: ManagedProbeKekProvider = {
      getActiveKey: async () => { throw new Error("private key material leaked in provider error"); },
      getKey: async () => { throw new Error("private key material leaked in provider error"); },
    };
    const sanitizedEncryptionFailure = await generateEncryptedManagedProbeCredentialWithProvider(region, secretBearingProvider)
      .then(() => null, (error: Error) => error);
    expect(sanitizedEncryptionFailure?.message).toBe("Managed probe credential encryption failed");
    expect(sanitizedEncryptionFailure?.message).not.toContain("private key material");

    const unavailable: ManagedProbeKekProvider = { getActiveKey: async () => null, getKey: async () => null };
    await expect(generateEncryptedManagedProbeCredentialWithProvider(region, unavailable))
      .rejects.toThrow("Managed probe credential encryption failed");

    const generated = await generateEncryptedManagedProbeCredential(region, 4, kek());
    const malformed: ManagedProbeKekProvider = {
      getActiveKey: async () => ({ version: 1, key: new Uint8Array(31) }),
      getKey: async () => new Uint8Array(31),
    };
    await expect(decryptManagedProbeCredentialWithProvider(region, generated.credentialVersionId, generated.envelope, malformed))
      .rejects.toThrow("Managed probe credential unavailable");
    await expect(decryptManagedProbeCredentialWithProvider(region, generated.credentialVersionId, generated.envelope, secretBearingProvider))
      .rejects.toThrow("Managed probe credential unavailable");
  });
});
