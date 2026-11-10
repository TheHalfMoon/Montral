import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/**
 * `docker exec -i <container> <args…>` with stdin from a file and/or stdout into a file, resolving only once the
 * process exited 0 AND every byte has been read from the source or flushed to the destination. Fail closed:
 * - any failure (non-zero exit, signal, spawn error, stream error on either side) rejects;
 * - an existing destination is never overwritten (`wx`), so a stale backup can't be mistaken for a fresh one;
 * - a destination this call created is deleted again when the transfer fails, so no partial backup is left behind
 *   for a later step to restore.
 * `spawnProcess` and `openDestination` exist for tests.
 */
export async function dockerFileTransfer(
  container,
  args,
  { stdinFile, stdoutFile, spawnProcess = spawn, openDestination = (path) => createWriteStream(path, { flags: "wx" }) } = {},
) {
  const proc = spawnProcess("docker", ["exec", "-i", container, ...args], {
    stdio: [stdinFile ? "pipe" : "ignore", stdoutFile ? "pipe" : "inherit", "pipe"],
  });
  let err = "";
  proc.stderr?.on("data", (chunk) => { err = (err + chunk).slice(-4000); });
  const exited = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`docker exec ${args[0]} ${signal ? `killed by ${signal}` : `exited ${code}`}: ${err}`)));
  });
  const transfers = [];
  let created = false;
  let failed = false;
  if (stdinFile) transfers.push(pipeline(createReadStream(stdinFile), proc.stdin));
  if (stdoutFile) {
    const destination = openDestination(stdoutFile);
    // only a file this call opened (not one that already existed) may be removed on failure
    destination.once("open", () => {
      created = true;
      // the transfer already failed (bounded wait ran out before the file opened): remove it as soon as it exists
      if (failed) rm(stdoutFile, { force: true }).catch(() => {});
    });
    transfers.push(pipeline(proc.stdout, destination));
  }
  try {
    await Promise.all([exited, ...transfers]);
  } catch (error) {
    failed = true;
    proc.kill?.();
    // a process that ignores the kill must not hang the qualification: wait a bounded time, then fail anyway
    await Promise.race([Promise.allSettled([exited, ...transfers]), new Promise((r) => setTimeout(r, 10_000).unref())]);
    if (stdoutFile && created) await rm(stdoutFile, { force: true });
    throw error;
  }
}
