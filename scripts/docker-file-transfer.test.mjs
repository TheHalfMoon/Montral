import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { dockerFileTransfer } from "./docker-file-transfer.mjs";

/**
 * A fake `docker exec` child. `script(child)` drives it; the default writes `bytes` to stdout and exits 0.
 * Real files are used for the destination in every test: only the Docker process is faked.
 */
function fakeSpawn(script) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  // like a real killed process: streams end and `close` fires with the signal
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    child.stdout.destroy();
    child.stdin.destroy();
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
  };
  queueMicrotask(() => script(child));
  return () => child;
}
const writesThenExits = (bytes, code = 0, signal = null) => (child) => { child.stdout.end(bytes); child.emit("close", code, signal); };
const exitsBeforeFlushing = (bytes) => (child) => { child.emit("close", 0, null); setTimeout(() => child.stdout.end(bytes), 20); };

function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "montral-transfer-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test("complete backup bytes are flushed before success, even when the process exits first", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  const big = "x".repeat(4 * 1024 * 1024) + "END";
  await dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: fakeSpawn(exitsBeforeFlushing(big)) });
  const written = readFileSync(file, "utf8");
  assert.equal(written.length, big.length);
  assert.ok(written.endsWith("END"));
}));

test("an existing destination is never overwritten and is left intact", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  writeFileSync(file, "original");
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: fakeSpawn(writesThenExits("new")) }), { code: "EEXIST" });
  assert.equal(readFileSync(file, "utf8"), "original");
}));

test("a destination that cannot be created rejects and leaves nothing behind", withDir(async (dir) => {
  const file = join(dir, "missing-parent", "backup.dump");
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: fakeSpawn(writesThenExits("data")) }), { code: "ENOENT" });
  assert.equal(existsSync(file), false);
}));

test("a write failure part-way through (partial write) rejects and removes the partial backup", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  let writes = 0;
  const openDestination = (path) => {
    const real = createWriteStream(path, { flags: "wx" });
    const original = real._write.bind(real);
    real._write = (chunk, enc, cb) => (++writes === 2 ? cb(Object.assign(new Error("disk full"), { code: "ENOSPC" })) : original(chunk, enc, cb));
    return real;
  };
  const spawnProcess = fakeSpawn((child) => {
    child.stdout.write("first-chunk-");
    setTimeout(() => { child.stdout.write("second-chunk"); child.stdout.end(); child.emit("close", 0, null); }, 10);
  });
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess, openDestination }), { code: "ENOSPC" });
  assert.equal(existsSync(file), false, "a partial backup must not remain");
}));

test("a non-zero Docker exit rejects even with plausible output, and removes it", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: fakeSpawn(writesThenExits("PGDMP-looks-valid", 17)) }), /exited 17/);
  assert.equal(existsSync(file), false);
}));

test("early termination by a signal rejects and removes the truncated output", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: fakeSpawn(writesThenExits("PGDMP-half", null, "SIGKILL")) }), /killed by SIGKILL/);
  assert.equal(existsSync(file), false);
}));

test("a truncated source stream (stdout error mid-transfer) rejects and removes the output", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  const spawnProcess = fakeSpawn((child) => {
    child.stdout.write("PGDMP-partial");
    setTimeout(() => child.stdout.destroy(Object.assign(new Error("connection reset"), { code: "ECONNRESET" })), 10);
  });
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess }), { code: "ECONNRESET" });
  assert.equal(existsSync(file), false);
}));

test("a spawn failure (docker missing) rejects without creating a backup", withDir(async (dir) => {
  const file = join(dir, "backup.dump");
  const spawnProcess = fakeSpawn((child) => { child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })); child.stdout.destroy(); });
  await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess }), { code: "ENOENT" });
  assert.equal(existsSync(file), false);
}));

test("restore from a missing backup file rejects (no silent empty restore)", withDir(async (dir) => {
  const spawnProcess = fakeSpawn((child) => { child.stdin.resume(); child.stdin.on("end", () => child.emit("close", 0, null)); });
  await assert.rejects(dockerFileTransfer("fake", ["pg_restore"], { stdinFile: join(dir, "nope.dump"), spawnProcess }), { code: "ENOENT" });
}));

test("restore input that the process stops reading (stdin broken) rejects", withDir(async (dir) => {
  const src = join(dir, "backup.dump");
  writeFileSync(src, "y".repeat(2 * 1024 * 1024));
  const spawnProcess = fakeSpawn((child) => {
    setTimeout(() => { child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); child.emit("close", 1, null); }, 5);
  });
  await assert.rejects(dockerFileTransfer("fake", ["pg_restore"], { stdinFile: src, spawnProcess }));
  assert.equal(readFileSync(src).length, 2 * 1024 * 1024, "the source backup is never modified");
}));

test("a complete restore resolves only after the whole file was sent and the process exited 0", withDir(async (dir) => {
  const src = join(dir, "backup.dump");
  const payload = "z".repeat(3 * 1024 * 1024);
  writeFileSync(src, payload);
  let received = 0;
  const spawnProcess = fakeSpawn((child) => {
    child.stdin.on("data", (c) => { received += c.length; });
    child.stdin.on("end", () => child.emit("close", 0, null));
  });
  await dockerFileTransfer("fake", ["pg_restore"], { stdinFile: src, spawnProcess });
  assert.equal(received, payload.length);
}));
