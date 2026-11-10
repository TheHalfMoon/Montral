import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export async function dockerFileTransfer(container, args, { stdinFile, stdoutFile, spawnProcess = spawn } = {}) {
  const proc = spawnProcess("docker", ["exec", "-i", container, ...args], {
    stdio: [stdinFile ? "pipe" : "ignore", stdoutFile ? "pipe" : "inherit", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (chunk) => { err = (err + chunk).slice(-4000); });
  const exited = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => code === 0 ? resolve() : reject(new Error(`docker exec ${args[0]} exited ${code}: ${err}`)));
  });
  const transfers = [];
  if (stdinFile) transfers.push(pipeline(createReadStream(stdinFile), proc.stdin));
  if (stdoutFile) transfers.push(pipeline(proc.stdout, createWriteStream(stdoutFile, { flags: "wx" })));
  try {
    await Promise.all([exited, ...transfers]);
  } catch (error) {
    proc.kill();
    await Promise.allSettled([exited, ...transfers]);
    throw error;
  }
}
