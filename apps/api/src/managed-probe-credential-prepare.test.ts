import type { Repo } from "@montral/repo";
import { describe, expect, it, vi } from "vitest";
import type { ManagedProbeKekProvider } from "./managed-probe-kek-provider";
import { generateAndPrepareManagedProbeCredential } from "./managed-probe-credential-prepare";

const region = "probe-synthetic";
const operatorId = "synthetic-operator";

function provider(): ManagedProbeKekProvider {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return {
    getActiveKey: async () => ({ version: 7, key }),
    getKey: async (version) => version === 7 ? key : null,
  };
}

describe("generateAndPrepareManagedProbeCredential", () => {
  it("stores a generated encrypted envelope and returns only the repository outcome", async () => {
    let stored: Parameters<NonNullable<Repo["prepareManagedProbeCredential"]>>[0] | undefined;
    const prepare = vi.fn(async (input: NonNullable<typeof stored>) => {
      expect(input.region).toBe(region);
      expect(input.operatorId).toBe(operatorId);
      expect(input.formatVersion).toBe(1);
      expect(input.algorithm).toBe("A256GCM");
      expect(input.keyVersion).toBe(7);
      expect(input.nonce).toHaveLength(12);
      expect(input.ciphertext).toHaveLength(48);
      stored = {
        ...input,
        nonce: new Uint8Array(input.nonce),
        ciphertext: new Uint8Array(input.ciphertext),
      };
      return "prepared" as const;
    });

    const result = await generateAndPrepareManagedProbeCredential(
      { prepareManagedProbeCredential: prepare as NonNullable<Repo["prepareManagedProbeCredential"]> },
      region,
      operatorId,
      provider(),
    );

    expect(result).toBe("prepared");
    expect(prepare).toHaveBeenCalledOnce();
    expect(stored?.versionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(stored?.ciphertext).toHaveLength(48);
    // The buffers passed to persistence are cleared after the awaited transaction settles.
    expect(prepare.mock.calls[0]?.[0].nonce).toEqual(new Uint8Array(12));
    expect(prepare.mock.calls[0]?.[0].ciphertext).toEqual(new Uint8Array(48));
    expect(stored?.ciphertext.some((byte) => byte !== 0)).toBe(true);
  });

  it("does not call persistence when the KEK provider is unavailable", async () => {
    const prepare = vi.fn();
    const noKey: ManagedProbeKekProvider = { getActiveKey: async () => null, getKey: async () => null };
    await expect(generateAndPrepareManagedProbeCredential(
      { prepareManagedProbeCredential: prepare as NonNullable<Repo["prepareManagedProbeCredential"]> },
      region,
      operatorId,
      noKey,
    )).rejects.toThrow("Managed probe credential preparation failed");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("sanitizes persistence failures", async () => {
    const prepare = vi.fn(async () => { throw new Error("synthetic database detail"); });
    await expect(generateAndPrepareManagedProbeCredential(
      { prepareManagedProbeCredential: prepare as NonNullable<Repo["prepareManagedProbeCredential"]> },
      region,
      operatorId,
      provider(),
    )).rejects.toThrow("Managed probe credential preparation failed");
    await expect(generateAndPrepareManagedProbeCredential(
      {}, region, operatorId, provider(),
    )).rejects.toThrow("Managed probe credential preparation failed");
  });
});
