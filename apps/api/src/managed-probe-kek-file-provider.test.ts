import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileManagedProbeKekProvider } from "./managed-probe-kek-file-provider";
import {
  decryptManagedProbeCredentialWithProvider,
  generateEncryptedManagedProbeCredentialWithProvider,
  type ManagedProbeKekProvider,
} from "./managed-probe-kek-provider";

const directories: string[] = [];
const syntheticSecrets: Uint8Array[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "montral-kek-test-"));
  directories.push(directory);
  const key1 = crypto.getRandomValues(new Uint8Array(32));
  const key2 = crypto.getRandomValues(new Uint8Array(32));
  syntheticSecrets.push(key1, key2);
  await writeFile(join(directory, "kek-1.bin"), key1);
  await writeFile(join(directory, "kek-2.bin"), key2);
  await writeFile(join(directory, "active-version"), "1\n", "ascii");
  return { directory, key1, key2, provider: createFileManagedProbeKekProvider(directory) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const secret of syntheticSecrets.splice(0)) secret.fill(0);
});

describe("file-backed managed probe KEK provider", () => {
  it("selects the active version, retains exact old versions, and releases returned key bytes", async () => {
    const f = await fixture();
    const leases: Uint8Array[] = [];
    const provider: ManagedProbeKekProvider = {
      getActiveKey: async () => {
        const active = await f.provider.getActiveKey();
        if (active) leases.push(active.key);
        return active;
      },
      getKey: async (version) => {
        const key = await f.provider.getKey(version);
        if (key) leases.push(key);
        return key;
      },
      releaseKey: (key) => f.provider.releaseKey?.(key),
    };
    const generated1 = await generateEncryptedManagedProbeCredentialWithProvider("probe-west", provider);
    syntheticSecrets.push(generated1.credential);
    expect(leases.at(-1)).toEqual(new Uint8Array(32));
    await writeFile(join(f.directory, "active-version"), "2\n", "ascii");
    const generated2 = await generateEncryptedManagedProbeCredentialWithProvider("probe-west", provider);
    syntheticSecrets.push(generated2.credential);
    expect(leases.at(-1)).toEqual(new Uint8Array(32));
    expect(generated1.envelope.keyVersion).toBe(1);
    expect(generated2.envelope.keyVersion).toBe(2);

    await expect(decryptManagedProbeCredentialWithProvider("probe-west", generated1.credentialVersionId, generated1.envelope, provider))
      .resolves.toEqual(generated1.credential);
    expect(leases.at(-1)).toEqual(new Uint8Array(32));
    await expect(decryptManagedProbeCredentialWithProvider("probe-west", generated2.credentialVersionId, generated2.envelope, provider))
      .resolves.toEqual(generated2.credential);
    expect(leases.at(-1)).toEqual(new Uint8Array(32));

    const key = await f.provider.getKey(1);
    expect(key).toEqual(f.key1);
    f.provider.releaseKey?.(key!);
    expect(key).toEqual(new Uint8Array(32));
  });

  it("fails closed for malformed pointers, missing versions, and invalid key file sizes", async () => {
    const f = await fixture();
    expect(() => createFileManagedProbeKekProvider("relative/keys")).toThrow("Managed probe key directory must be absolute");
    await writeFile(join(f.directory, "active-version"), "0001\n", "ascii");
    await expect(f.provider.getActiveKey()).rejects.toThrow("Managed probe key unavailable");
    await writeFile(join(f.directory, "active-version"), "1\r\n", "ascii");
    const windowsPointerKey = await f.provider.getActiveKey();
    expect(windowsPointerKey?.version).toBe(1);
    f.provider.releaseKey?.(windowsPointerKey!.key);
    expect(windowsPointerKey?.key).toEqual(new Uint8Array(32));
    await writeFile(join(f.directory, "active-version"), "3\n", "ascii");
    await expect(f.provider.getActiveKey()).rejects.toThrow("Managed probe key unavailable");
    await writeFile(join(f.directory, "kek-3.bin"), new Uint8Array(33));
    await writeFile(join(f.directory, "active-version"), "3\n", "ascii");
    await expect(f.provider.getActiveKey()).rejects.toThrow("Managed probe key unavailable");
    await expect(f.provider.getKey(0)).rejects.toThrow("Managed probe key unavailable");
  });

  it("does not expose the directory or secret bytes in errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "montral-kek-missing-"));
    directories.push(directory);
    const provider = createFileManagedProbeKekProvider(directory);
    const failure = await provider.getActiveKey().then(() => null, (error: Error) => error);
    expect(failure?.message).toBe("Managed probe key unavailable");
    expect(failure?.message).not.toContain(directory);
    expect(await readFile(join(directory, "active-version")).catch(() => null)).toBeNull();
  });
});
