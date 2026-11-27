import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ManagedProbeKekProvider } from "./managed-probe-kek-provider";

const KEY_BYTES = 32;
const MAX_VERSION = 2_147_483_647;
const UNAVAILABLE = "Managed probe key unavailable";

/**
 * Reads operator-managed, immutable `kek-<version>.bin` files and an `active-version` pointer.
 * This adapter is intentionally not wired to server startup, routes, delivery, or scheduling.
 */
export function createFileManagedProbeKekProvider(directory: string): ManagedProbeKekProvider {
  if (!directory.trim() || !isAbsolute(directory)) throw new Error("Managed probe key directory must be absolute");
  const root = resolve(directory);

  async function readBounded(path: string, maxBytes: number, exactBytes?: number): Promise<Uint8Array> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let bytes: Uint8Array | undefined;
    try {
      file = await open(path, "r");
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > maxBytes || (exactBytes !== undefined && before.size !== exactBytes)) {
        throw new Error(UNAVAILABLE);
      }
      bytes = new Uint8Array(maxBytes);
      const { bytesRead } = await file.read(bytes, 0, maxBytes, 0);
      const after = await file.stat();
      if (bytesRead !== before.size || after.size !== before.size || (exactBytes !== undefined && bytesRead !== exactBytes)) {
        throw new Error(UNAVAILABLE);
      }
      return bytes.subarray(0, bytesRead);
    } catch {
      bytes?.fill(0);
      throw new Error(UNAVAILABLE);
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async function readVersion(): Promise<number> {
    const bytes = await readBounded(join(root, "active-version"), 12);
    try {
      const text = new TextDecoder().decode(bytes);
      const match = /^(?:[1-9][0-9]{0,9})(?:\r?\n)?$/.exec(text);
      if (!match) throw new Error(UNAVAILABLE);
      const version = Number(text.replace(/\r?\n$/, ""));
      if (!Number.isSafeInteger(version) || version > MAX_VERSION) throw new Error(UNAVAILABLE);
      return version;
    } catch {
      throw new Error(UNAVAILABLE);
    } finally {
      bytes.fill(0);
    }
  }

  async function readKey(version: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) throw new Error(UNAVAILABLE);
    return readBounded(join(root, `kek-${version}.bin`), KEY_BYTES, KEY_BYTES);
  }

  return {
    async getActiveKey() {
      try {
        const version = await readVersion();
        return { version, key: await readKey(version) };
      } catch {
        throw new Error(UNAVAILABLE);
      }
    },
    async getKey(version) {
      try {
        return await readKey(version);
      } catch {
        throw new Error(UNAVAILABLE);
      }
    },
    releaseKey(key) {
      key.fill(0);
    },
  };
}
