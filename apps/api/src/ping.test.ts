import { isIP } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, type CheckInput } from "./checker";
import { configureNetGuard, pingHost, targetProblem, PING_TARGET_PROBLEM } from "./netguard";
import {
  MAX_PING_OUTPUT_BYTES, PING_NO_REPLY, PING_TIMED_OUT, PING_UNAVAILABLE, PING_WORKERS_UNSUPPORTED,
  parsePingOutput, pingCheck, pingCommand, pingEnv, pingTargetProblem, runPing, type PingCommand, type PingRun, type PingRunner,
} from "./ping";
import { resetSelfCheck } from "./selfcheck";

afterEach(() => {
  configureNetGuard({});
  resetSelfCheck();
  vi.unstubAllGlobals();
});

describe("ping command", () => {
  it("builds iputils arguments: one packet, numeric, wait in seconds", () => {
    expect(pingCommand("iputils", "192.0.2.1", 5000)).toEqual({ file: "ping", args: ["-n", "-c", "1", "-W", "5", "192.0.2.1"] });
    expect(pingCommand("iputils", "2001:db8::1", 5000, "/usr/bin/ping")).toEqual({ file: "/usr/bin/ping", args: ["-6", "-n", "-c", "1", "-W", "5", "2001:db8::1"] });
  });

  it("leaves -n out for BusyBox", () => {
    expect(pingCommand("busybox", "192.0.2.1", 10000, "/bin/ping")).toEqual({ file: "/bin/ping", args: ["-c", "1", "-W", "10", "192.0.2.1"] });
    expect(pingCommand("busybox", "2001:db8::1", 10000, "/bin/ping").args).toEqual(["-6", "-c", "1", "-W", "10", "2001:db8::1"]);
  });

  it("uses -t (overall seconds) on macOS and ping6 for IPv6", () => {
    expect(pingCommand("darwin", "192.0.2.1", 3000)).toEqual({ file: "ping", args: ["-n", "-c", "1", "-t", "3", "192.0.2.1"] });
    expect(pingCommand("darwin", "2001:db8::1", 3000)).toEqual({ file: "ping6", args: ["-n", "-c", "1", "2001:db8::1"] });
  });

  it("uses -n count and -w milliseconds on Windows, -6 for IPv6", () => {
    expect(pingCommand("win32", "192.0.2.1", 2500)).toEqual({ file: "ping", args: ["-n", "1", "-w", "2500", "192.0.2.1"] });
    expect(pingCommand("win32", "2001:db8::1", 2500).args).toEqual(["-n", "1", "-w", "2500", "-6", "2001:db8::1"]);
  });

  it("never waits less than one second and keeps the address the last argument", () => {
    for (const f of ["iputils", "busybox", "darwin", "win32"] as const) {
      const c = pingCommand(f, "198.51.100.7", 200);
      expect(c.args.at(-1)).toBe("198.51.100.7");
      expect(c.args.join(" ")).not.toMatch(/\b0\b/);
    }
  });
});

describe("ping output", () => {
  const ok = (out: string, code: number | null = 0) => parsePingOutput(out, code);

  it("reads Linux iputils output", () => {
    const out = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 12.300/12.300/12.300/0.000 ms`;
    expect(ok(out)).toEqual({ replied: true, rttMs: 12.3, denied: false, noRoute: false });
    expect(ok("64 bytes from 2606:4700:4700::1111: icmp_seq=1 ttl=57 time=9.87 ms").rttMs).toBe(9.87);
  });

  it("reads BusyBox output", () => {
    const out = `PING 127.0.0.1 (127.0.0.1): 56 data bytes
64 bytes from 127.0.0.1: seq=0 ttl=64 time=0.071 ms

--- 127.0.0.1 ping statistics ---
1 packets transmitted, 1 packets received, 0% packet loss
round-trip min/avg/max = 0.071/0.071/0.071 ms`;
    expect(ok(out)).toMatchObject({ replied: true, rttMs: 0.071 });
  });

  it("reads macOS ping and ping6 output", () => {
    expect(ok(`PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=58 time=14.512 ms

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 14.512/14.512/14.512/0.000 ms`)).toMatchObject({ replied: true, rttMs: 14.512 });
    expect(ok("16 bytes from ::1, icmp_seq=0 hlim=64 time=0.077 ms")).toMatchObject({ replied: true, rttMs: 0.077 });
  });

  it("reads Windows output, including time<1ms and IPv6 replies without TTL", () => {
    expect(ok(`\r\nPinging 1.1.1.1 with 32 bytes of data:\r\nReply from 1.1.1.1: bytes=32 time=12ms TTL=57\r\n\r\nPing statistics for 1.1.1.1:\r\n    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),\r\nApproximate round trip times in milli-seconds:\r\n    Minimum = 12ms, Maximum = 12ms, Average = 12ms\r\n`))
      .toMatchObject({ replied: true, rttMs: 12 });
    expect(ok("Reply from 127.0.0.1: bytes=32 time<1ms TTL=128")).toMatchObject({ replied: true, rttMs: 1 });
    expect(ok(`Pinging ::1 with 32 bytes of data:\r\nReply from ::1: time<1ms \r\n\r\nPing statistics for ::1:\r\n    Minimum = 0ms, Maximum = 0ms, Average = 0ms`)).toMatchObject({ replied: true, rttMs: 1 });
  });

  it("reads localised output", () => {
    expect(ok("Antwort von 1.1.1.1: Bytes=32 Zeit=15ms TTL=57").rttMs).toBe(15); // German Windows
    expect(ok("Réponse de 1.1.1.1 : octets=32 temps=16 ms TTL=57").rttMs).toBe(16); // French Windows
    expect(ok("来自 1.1.1.1 的回复: 字节=32 时间=17ms TTL=57").rttMs).toBe(17); // Chinese Windows
    expect(ok("来自 127.0.0.1 的回复: 字节=32 时间<1ms TTL=128").rttMs).toBe(1);
    expect(ok("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12,5 ms").rttMs).toBe(12.5); // decimal comma
    // a reply whose time cannot be read (Cyrillic unit): replied, the caller falls back to the measured time
    expect(ok("Ответ от 1.1.1.1: число байт=32 время=18мс TTL=57")).toEqual({ replied: true, rttMs: null, denied: false, noRoute: false });
  });

  it("does not take a Windows 'destination host unreachable' (exit 0) for a reply", () => {
    const out = "Pinging 10.9.9.9 with 32 bytes of data:\r\nReply from 192.168.1.1: Destination host unreachable.\r\n\r\nPing statistics for 10.9.9.9:\r\n    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),";
    expect(ok(out, 0)).toMatchObject({ replied: false, rttMs: null });
    expect(ok("Request timed out.\r\n", 1).replied).toBe(false);
  });

  it("requires a successful exit status", () => {
    expect(ok("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms", 1).replied).toBe(false);
    expect(ok("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms", null).replied).toBe(false);
    expect(ok("PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.\n\n--- 192.0.2.1 ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss, time 0ms\n", 1))
      .toEqual({ replied: false, rttMs: null, denied: false, noRoute: false });
  });

  it("recognises a ping that may not open an ICMP socket", () => {
    expect(ok("ping: permission denied (are you root?)\n", 1).denied).toBe(true); // BusyBox
    expect(ok("ping: socket: Operation not permitted\n", 2).denied).toBe(true); // iputils without capability
  });

  it("recognises a local network problem", () => {
    expect(ok("ping: connect: Network is unreachable\n", 2).noRoute).toBe(true);
    expect(ok("ping: socket: Address family not supported by protocol\n", 2).noRoute).toBe(true);
    expect(ok("PING: transmit failed. General failure. \r\n", 1).noRoute).toBe(true);
  });

  it("handles garbage without throwing", () => {
    for (const out of ["", "\u0000\u0001\u0002", "x".repeat(MAX_PING_OUTPUT_BYTES), "time=abc ms TTL=", "= ms"]) {
      expect(() => parsePingOutput(out, 0)).not.toThrow();
    }
    expect(parsePingOutput("", 0).replied).toBe(false);
    expect(parsePingOutput("time=abc ms TTL=", 0).replied).toBe(false);
  });
});

describe("running the binary", () => {
  const node = (code: string): PingCommand => ({ file: process.execPath, args: ["-e", code] });

  it("kills the process at the hard timeout", async () => {
    const t = Date.now();
    const r = await runPing(node("setTimeout(() => {}, 30000)"), 300);
    expect(r).toMatchObject({ timedOut: true, code: null });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("reads at most the output cap and stops a process that prints more", async () => {
    const r = await runPing(node("const s = 'x'.repeat(65536); setInterval(() => process.stdout.write(s), 1)"), 10000, 4096);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(4096);
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
  });

  it("collects stdout and stderr and the exit code", async () => {
    const r = await runPing(node("process.stdout.write('out '); process.stderr.write('err'); process.exit(3)"), 10000);
    expect(r).toMatchObject({ code: 3, timedOut: false });
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await runPing({ file: "montral-no-such-ping-binary", args: [] }, 5000);
    expect(r.spawnError).toBe("ENOENT");
  });

  it("does not run arguments through a shell", async () => {
    // an argument a shell would expand stays one literal argument
    const r = await runPing({ file: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "$(echo hi);ls"] }, 10000);
    expect(JSON.parse(r.output)).toEqual(["$(echo hi);ls"]);
  });
});

describe("ping checks", () => {
  const m = (target: string, timeoutMs = 3000): CheckInput => ({ type: "ping", target, timeoutMs, method: "GET", expectedStatus: 200 });
  const reply = (out = "64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.4 ms"): PingRun => ({ code: 0, output: out, timedOut: false });
  /** A runner that records what it was asked to run. */
  const fake = (result: PingRun | (() => PingRun | Promise<PingRun>)) => {
    const calls: PingCommand[] = [];
    const runner: PingRunner = async (cmd) => { calls.push(cmd); return typeof result === "function" ? result() : result; };
    return { calls, runner };
  };

  it("is up with the round-trip time from the output and passes only the validated literal", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { calls, runner } = fake(reply("64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=7.6 ms"));
    expect(await pingCheck(m("127.0.0.1"), Date.now(), { runner, flavour: "iputils" })).toEqual({ ok: true, latencyMs: 8 });
    expect(calls).toHaveLength(1);
    expect(calls[0].args.at(-1)).toBe("127.0.0.1");
  });

  it("resolves a name once and pings an IP literal, never the name", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { calls, runner } = fake(reply());
    expect((await pingCheck(m("localhost"), Date.now(), { runner, flavour: "busybox" })).ok).toBe(true);
    const last = calls[0].args.at(-1)!;
    expect(isIP(last)).not.toBe(0);
    expect(calls[0].args.join(" ")).not.toContain("localhost");
  });

  it("falls back to the measured time when the output has no readable time", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { runner } = fake(async () => { await new Promise((r) => setTimeout(r, 30)); return reply("Ответ от 127.0.0.1: число байт=32 время<1мс TTL=128"); });
    const out = await pingCheck(m("127.0.0.1"), Date.now(), { runner, flavour: "win32" });
    expect(out.ok).toBe(true);
    expect(out.latencyMs).toBeGreaterThanOrEqual(20);
    // a time longer than the whole check could have taken is not believed either
    const absurd = fake(reply("64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=999999 ms"));
    expect((await pingCheck(m("127.0.0.1"), Date.now(), { runner: absurd.runner, flavour: "iputils" })).latencyMs).toBeLessThan(3000);
  });

  it("refuses private and loopback targets by default, before anything runs", async () => {
    const { calls, runner } = fake(reply());
    for (const target of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1", "[::1]", "fd00::1", "localhost", "db.internal", "router"]) {
      await expect(pingCheck(m(target), Date.now(), { runner, flavour: "iputils" }), target).rejects.toThrow(/private or internal/);
    }
    expect(calls).toHaveLength(0);
    // through runCheck it is a failed check with the guard's message, not an inconclusive one
    const out = await runCheck(m("127.0.0.1"));
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/private or internal/) });
    expect(out.inconclusive).toBeUndefined();
  });

  it("allows private targets with ALLOW_PRIVATE_TARGETS", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { calls, runner } = fake(reply());
    for (const target of ["127.0.0.1", "10.1.2.3", "::1"]) expect((await pingCheck(m(target), Date.now(), { runner, flavour: "iputils" })).ok, target).toBe(true);
    expect(calls.map((c) => c.args.at(-1))).toEqual(["127.0.0.1", "10.1.2.3", "::1"]);
    expect(calls[2].args[0]).toBe("-6");
  });

  it("refuses malformed targets without running anything", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { calls, runner } = fake(reply());
    for (const target of ["", "https://example.com", "example.com:80", "1.1.1.1:80", "example.com/path", "-c 100 1.1.1.1", "--help", "a b", "user@example.com", "2130706433", "fe80::1%eth0", "exa_mple.com"]) {
      expect(await pingCheck(m(target), Date.now(), { runner, flavour: "iputils" }), target).toEqual({ ok: false, error: PING_TARGET_PROBLEM });
    }
    expect(calls).toHaveLength(0);
  });

  it("a missing or forbidden binary is the server's problem: inconclusive with a fixed message, never an alert", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = fake({ code: null, output: "", timedOut: false, spawnError: "ENOENT" });
    expect(await pingCheck(m("127.0.0.1"), Date.now(), { runner: missing.runner, flavour: "busybox" })).toEqual({ ok: false, inconclusive: true, error: PING_UNAVAILABLE });
    const denied = fake({ code: 1, output: "ping: permission denied (are you root?)\n", timedOut: false });
    expect(await pingCheck(m("127.0.0.1"), Date.now(), { runner: denied.runner, flavour: "busybox" })).toEqual({ ok: false, inconclusive: true, error: PING_UNAVAILABLE });
    const firewalled = fake({ code: 2, output: "ping: sendmsg: Operation not permitted\n", timedOut: false });
    expect(await pingCheck(m("127.0.0.1"), Date.now(), { runner: firewalled.runner, flavour: "iputils" })).toMatchObject({ inconclusive: true, error: PING_UNAVAILABLE });
    expect(log.mock.calls.length).toBeLessThanOrEqual(1); // said once per process, not per check
    log.mockRestore();
  });

  it("gives the ping process PATH and a locale only, never the server's secrets", () => {
    const env = { PATH: "/usr/bin", DATABASE_URL: "postgres://u:hunter2@db/montral", BETTER_AUTH_SECRET: "s3cret", SystemRoot: "C:\\Windows" };
    expect(pingEnv(env, "linux")).toEqual({ PATH: "/usr/bin", LC_ALL: "C", LANG: "C" });
    expect(pingEnv(env, "win32")).toEqual({ PATH: "/usr/bin", LC_ALL: "C", LANG: "C", SystemRoot: "C:\\Windows" });
  });

  it("pings an IPv4-mapped IPv6 target as the IPv4 address it carries", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { calls, runner } = fake(reply());
    await pingCheck(m("::ffff:127.0.0.1"), Date.now(), { runner, flavour: "iputils" });
    expect(calls[0].args.at(-1)).toBe("127.0.0.1");
    expect(calls[0].args).not.toContain("-6");
  });

  it("refuses multicast, broadcast, metadata and option-like single tokens by default", async () => {
    configureNetGuard({});
    const { calls, runner } = fake(reply());
    for (const target of ["224.0.0.1", "255.255.255.255", "ff02::1", "0.0.0.0", "169.254.169.254"]) {
      await expect(pingCheck(m(target), Date.now(), { runner, flavour: "iputils" }), target).rejects.toThrow();
    }
    for (const target of ["-x", "-f", "-6"]) {
      expect(await pingCheck(m(target), Date.now(), { runner, flavour: "iputils" }), target).toEqual({ ok: false, error: PING_TARGET_PROBLEM });
    }
    expect(calls).toHaveLength(0);
  });

  it("fails without a reply, with a fixed message and none of the command output", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const secret = "From 10.0.0.1 icmp_seq=1 Destination Host Unreachable <script>";
    const { runner } = fake({ code: 1, output: secret, timedOut: false });
    const message = await pingCheck(m("10.0.0.2"), Date.now(), { runner, flavour: "iputils" }).then(() => "resolved", (e: Error) => e.message);
    expect(message).toBe(PING_NO_REPLY);
    expect(message).not.toContain("<script>");
  });

  it("throws a fixed timeout message when the process had to be killed", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { runner } = fake({ code: null, output: "partial", timedOut: true });
    await expect(pingCheck(m("127.0.0.1"), Date.now(), { runner, flavour: "darwin" })).rejects.toThrow(PING_TIMED_OUT);
  });

  it("gives the binary the check timeout and kills it shortly after", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const seen: number[] = [];
    const runner: PingRunner = async (cmd, hard) => { seen.push(hard); expect(cmd.args).toContain("-W"); return reply(); };
    await pingCheck(m("127.0.0.1", 4000), Date.now(), { runner, flavour: "iputils" });
    expect(seen[0]).toBeGreaterThan(3000);
    expect(seen[0]).toBeLessThanOrEqual(5000);
  });

  it("treats a local network failure as the prober's fault (inconclusive)", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const { runner } = fake({ code: 2, output: "ping: connect: Network is unreachable\n", timedOut: false });
    const e = await pingCheck(m("127.0.0.1"), Date.now(), { runner, flavour: "iputils" }).catch((x: Error & { code?: string }) => x);
    expect(e).toMatchObject({ message: PING_NO_REPLY, code: "ENETUNREACH" });
  });

  it("is inconclusive on Cloudflare Workers", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    expect(await runCheck(m("1.1.1.1"))).toEqual({ ok: false, inconclusive: true, error: PING_WORKERS_UNSUPPORTED });
  });
});

describe("ping targets", () => {
  it("accepts hostnames and IP literals only", () => {
    for (const t of ["example.com", "Example.COM.", "a-b.example", "1.1.1.1", "2606:4700:4700::1111", "[2606:4700:4700::1111]", "::ffff:1.2.3.4"]) expect(pingTargetProblem(t), t).toBeNull();
    expect(pingHost("Example.COM.")).toBe("example.com");
    expect(pingHost("[2001:DB8::1]")).toBe("2001:db8::1");
    for (const t of ["", " ", "http://example.com", "example.com:443", "[::1]:80", "example.com/x", "exa mple.com", "-example.com", "example-.com", "1.2.3.256", "0x7f.1", "127.1", "a".repeat(64) + ".com", "fe80::1%25eth0", "ex;ample.com", "ex$(id).com"]) {
      expect(pingTargetProblem(t), t).toBe(PING_TARGET_PROBLEM);
    }
  });

  it("refuses private targets when monitors are created, unless ALLOW_PRIVATE_TARGETS is set", async () => {
    for (const t of ["127.0.0.1", "::1", "[::1]", "10.0.0.1", "localhost", "printer.local", "nas"]) expect(await targetProblem("ping", t), t).toMatch(/private or internal/);
    expect(await targetProblem("ping", "1.1.1.1")).toBeNull();
    expect(await targetProblem("ping", "2606:4700:4700::1111")).toBeNull();
    expect(await targetProblem("ping", "1.1.1.1:80")).toBe(PING_TARGET_PROBLEM);
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    for (const t of ["127.0.0.1", "::1", "localhost", "nas"]) expect(await targetProblem("ping", t), t).toBeNull();
    // the shape is still enforced with private targets allowed
    expect(await targetProblem("ping", "https://127.0.0.1")).toBe(PING_TARGET_PROBLEM);
  });
});

describe("real ping", () => {
  it("pings 127.0.0.1 with ALLOW_PRIVATE_TARGETS when a ping binary is usable", async (ctx) => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const out = await runCheck({ type: "ping", target: "127.0.0.1", timeoutMs: 5000, method: "GET", expectedStatus: 200 });
    if (out.error === PING_UNAVAILABLE) {
      // GitHub's Linux runners have a usable ping: there a missing one is a broken test environment, not a skip
      if (process.env.CI && process.platform === "linux") throw new Error("ping is unavailable on this CI runner");
      ctx.skip();
    }
    expect(out).toMatchObject({ ok: true });
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.latencyMs).toBeLessThan(5000);
  });
});
