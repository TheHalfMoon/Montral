import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupBrowserProfile } from "./browser-profile-cleanup.mjs";

test("does not remove a Chrome profile until its child has closed", async () => {
  const profile = await mkdtemp(join(tmpdir(), "montral-chrome-fixture-"));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setTimeout(async () => {
      await writeFile(join(profile, "late-shutdown-file"), "closed");
      child.signalCode = signal;
      child.emit("close", null, signal);
    }, 30);
    return true;
  };
  let checked = false;
  await cleanupBrowserProfile(child, profile, { remove: async (path, options) => {
    assert.equal(await readFile(join(path, "late-shutdown-file"), "utf8"), "closed");
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
    checked = true;
    const { rm } = await import("node:fs/promises");
    await rm(path, options);
  } });
  assert.equal(checked, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  await assert.rejects(access(profile), /ENOENT/);
});

test("escalates only its own unresponsive child after a bounded grace window", async () => {
  const profile = await mkdtemp(join(tmpdir(), "montral-chrome-fixture-"));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
    }
    return true;
  };
  await cleanupBrowserProfile(child, profile, { graceMs: 5 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(access(profile), /ENOENT/);
});

test("removes an already exited or never started profile without signaling unrelated processes", async () => {
  for (const child of [undefined, { exitCode: 0, signalCode: null, kill() { throw new Error("must not kill"); } }]) {
    const profile = await mkdtemp(join(tmpdir(), "montral-chrome-fixture-"));
    await cleanupBrowserProfile(child, profile);
    await assert.rejects(access(profile), /ENOENT/);
  }
});
