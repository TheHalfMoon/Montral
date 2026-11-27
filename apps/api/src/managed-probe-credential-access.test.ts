import type { PreparedManagedProbeCredentialEnvelope, Repo } from "@montral/repo";
import { describe, expect, it, vi } from "vitest";
import { generateEncryptedManagedProbeCredential } from "./managed-probe-credential-envelope";
import { withPreparedManagedProbeCredential } from "./managed-probe-credential-access";
import type { ManagedProbeKekProvider } from "./managed-probe-kek-provider";

const region = "probe-west";

async function fixture() {
  const kek = crypto.getRandomValues(new Uint8Array(32));
  const kekBefore = new Uint8Array(kek);
  const generated = await generateEncryptedManagedProbeCredential(region, 11, kek);
  const envelope: PreparedManagedProbeCredentialEnvelope = {
    region,
    versionId: generated.credentialVersionId,
    formatVersion: generated.envelope.formatVersion,
    algorithm: generated.envelope.algorithm,
    keyVersion: generated.envelope.keyVersion,
    nonce: generated.envelope.nonce,
    ciphertext: generated.envelope.ciphertext,
  };
  const repo: Pick<Repo, "preparedManagedProbeCredentialEnvelope"> = {
    preparedManagedProbeCredentialEnvelope: async (foundRegion, versionId) =>
      foundRegion === region && versionId === envelope.versionId ? envelope : null,
  };
  const provider: ManagedProbeKekProvider = {
    getActiveKey: async () => ({ version: 11, key: kek }),
    getKey: async (version) => version === 11 ? kek : null,
  };
  return { kek, kekBefore, generated, envelope, repo, provider };
}

describe("prepared managed probe credential access", () => {
  it("passes plaintext only to the callback and wipes the borrowed buffer after success", async () => {
    const f = await fixture();
    let retained: Uint8Array | undefined;
    try {
      const result = await withPreparedManagedProbeCredential(
        f.repo,
        region,
        f.generated.credentialVersionId,
        f.provider,
        (credential) => {
          retained = credential;
          expect(credential).toEqual(f.generated.credential);
          return "complete";
        },
      );
      expect(result).toBe("complete");
      expect(retained).toBeDefined();
      expect(retained).toEqual(new Uint8Array(f.generated.credential.length));
      expect(f.kek).toEqual(f.kekBefore); // provider retains ownership of its borrowed source array
    } finally {
      f.generated.credential.fill(0);
      f.kek.fill(0);
      f.kekBefore.fill(0);
    }
  });

  it("wipes plaintext after callback failure and sanitizes callback errors", async () => {
    const f = await fixture();
    let retained: Uint8Array | undefined;
    try {
      await expect(withPreparedManagedProbeCredential(
        f.repo,
        region,
        f.generated.credentialVersionId,
        f.provider,
        (credential) => {
          retained = credential;
          throw new Error("synthetic credential bytes must never appear in error text");
        },
      )).rejects.toThrow("Managed probe credential operation failed");
      expect(retained).toBeDefined();
      expect(retained).toEqual(new Uint8Array(f.generated.credential.length));
    } finally {
      f.generated.credential.fill(0);
      f.kek.fill(0);
      f.kekBefore.fill(0);
    }
  });

  it("fails closed before key access for absent rows and sanitizes storage failures", async () => {
    const f = await fixture();
    const getKey = vi.spyOn(f.provider, "getKey");
    const missing: Pick<Repo, "preparedManagedProbeCredentialEnvelope"> = {
      preparedManagedProbeCredentialEnvelope: async () => null,
    };
    const failed: Pick<Repo, "preparedManagedProbeCredentialEnvelope"> = {
      preparedManagedProbeCredentialEnvelope: async () => { throw new Error("database detail"); },
    };
    try {
      await expect(withPreparedManagedProbeCredential(missing, region, f.generated.credentialVersionId, f.provider, vi.fn()))
        .rejects.toThrow("Managed probe credential unavailable");
      await expect(withPreparedManagedProbeCredential(failed, region, f.generated.credentialVersionId, f.provider, vi.fn()))
        .rejects.toThrow("Managed probe credential unavailable");
      expect(getKey).not.toHaveBeenCalled();
    } finally {
      f.generated.credential.fill(0);
      f.kek.fill(0);
      f.kekBefore.fill(0);
    }
  });

  it("fails closed when the recorded KEK version is missing", async () => {
    const f = await fixture();
    const noOldKey: ManagedProbeKekProvider = { getActiveKey: async () => null, getKey: async () => null };
    try {
      await expect(withPreparedManagedProbeCredential(f.repo, region, f.generated.credentialVersionId, noOldKey, vi.fn()))
        .rejects.toThrow("Managed probe credential unavailable");
    } finally {
      f.generated.credential.fill(0);
      f.kek.fill(0);
      f.kekBefore.fill(0);
    }
  });

  it("rejects a repository row for a different region or credential version", async () => {
    const f = await fixture();
    const getKey = vi.spyOn(f.provider, "getKey");
    const mismatched: Pick<Repo, "preparedManagedProbeCredentialEnvelope"> = {
      preparedManagedProbeCredentialEnvelope: async () => ({
        ...f.envelope,
        region: "probe-east",
      }),
    };
    try {
      await expect(withPreparedManagedProbeCredential(mismatched, region, f.generated.credentialVersionId, f.provider, vi.fn()))
        .rejects.toThrow("Managed probe credential unavailable");
      expect(getKey).not.toHaveBeenCalled();

      const wrongVersion: Pick<Repo, "preparedManagedProbeCredentialEnvelope"> = {
        preparedManagedProbeCredentialEnvelope: async () => ({
          ...f.envelope,
          versionId: crypto.randomUUID(),
        }),
      };
      await expect(withPreparedManagedProbeCredential(wrongVersion, region, f.generated.credentialVersionId, f.provider, vi.fn()))
        .rejects.toThrow("Managed probe credential unavailable");
      expect(getKey).not.toHaveBeenCalled();
    } finally {
      f.generated.credential.fill(0);
      f.kek.fill(0);
      f.kekBefore.fill(0);
    }
  });
});
