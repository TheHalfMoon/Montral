import { afterEach, describe, expect, it, vi } from "vitest";

/** The resolver the netguard uses, scripted per name: every lookup is counted. */
const answers = new Map<string, string[]>();
const lookups: string[] = [];
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    lookups.push(host);
    const a = answers.get(host);
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

const { configureNetGuard } = await import("./netguard");
const { pingCheck } = await import("./ping");
type Run = { file: string; args: string[] };

afterEach(() => { configureNetGuard({}); answers.clear(); lookups.length = 0; });

const m = (target: string) => ({ target, timeoutMs: 3000 });
function fake() {
  const calls: Run[] = [];
  const runner = async (cmd: Run) => { calls.push(cmd); return { code: 0, output: `64 bytes from ${cmd.args.at(-1)}: icmp_seq=1 ttl=57 time=12.3 ms\n`, timedOut: false }; };
  return { calls, runner };
}

/** The default (no ALLOW_PRIVATE_TARGETS) path, where DNS rebinding matters. */
describe("ping name resolution with private targets refused (default)", () => {
  it("resolves the name exactly once and pings the address that was checked", async () => {
    const name = `rebind-${crypto.randomUUID().slice(0, 8)}.example.com`;
    answers.set(name, ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
    const { calls, runner } = fake();
    const out = await pingCheck(m(name), Date.now(), { runner, flavour: "iputils" });
    expect(out).toMatchObject({ ok: true, latencyMs: 12 });
    expect(lookups.filter((h) => h === name)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.at(-1)).toBe("93.184.215.14"); // IPv4 preferred, a literal, never the name
    expect(calls[0].args.join(" ")).not.toContain(name);
  });

  it("refuses a name if any of its addresses is private, without starting ping", async () => {
    const name = `mixed-${crypto.randomUUID().slice(0, 8)}.example.com`;
    answers.set(name, ["93.184.215.15", "10.0.0.5"]);
    const { calls, runner } = fake();
    await expect(pingCheck(m(name), Date.now(), { runner, flavour: "iputils" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("refuses a name that resolves only to metadata or loopback addresses", async () => {
    for (const addr of ["169.254.169.254", "127.0.0.1", "::1", "fd00:ec2::254"]) {
      const name = `internal-${crypto.randomUUID().slice(0, 8)}.example.com`;
      answers.set(name, [addr]);
      const { calls, runner } = fake();
      await expect(pingCheck(m(name), Date.now(), { runner, flavour: "iputils" }), addr).rejects.toThrow();
      expect(calls, addr).toHaveLength(0);
    }
  });
});
