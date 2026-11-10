import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { dockerFileTransfer } from "./docker-file-transfer.mjs";

function fakeSpawn({ bytes = "backup-data", exitCode = 0, early = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdout.destroy(); child.stdin.destroy(); };
  queueMicrotask(() => {
    if (early) {
      child.emit("close", exitCode);
      child.stdout.end(bytes);
    } else {
      child.stdout.end(bytes);
      child.emit("close", exitCode);
    }
  });
  return child;
}

test("complete backup bytes are flushed before success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "montral-transfer-"));
  try {
    const file = join(dir, "backup.dump");
    await dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: () => fakeSpawn({ early: true }) });
    assert.equal(readFileSync(file, "utf8"), "backup-data");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing backup is never overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "montral-transfer-"));
  try {
    const file = join(dir, "backup.dump");
    writeFileSync(file, "original");
    await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: file, spawnProcess: () => fakeSpawn() }), { code: "EEXIST" });
    assert.equal(readFileSync(file, "utf8"), "original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nonzero Docker exit rejects even with valid output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "montral-transfer-"));
  try {
    await assert.rejects(dockerFileTransfer("fake", ["pg_dump"], { stdoutFile: join(dir, "backup.dump"), spawnProcess: () => fakeSpawn({ exitCode: 17 }) }), /exited 17/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("destination write failure rejects rather than reporting a valid backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "montral-transfer-"));
  try {
    // Opening a directory as a file fails on supported CI platforms.
    await assert.rejects(
      dockerFileTransfer("fake", ["pg_dump"], {
        stdoutFile: dir,
        spawnProcess: () => fakeSpawn({ early: true }),
      }),
      { code: "EISDIR" },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
