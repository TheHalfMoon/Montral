/**
 * ICMP ping checks through the system `ping` binary: one echo request to the target, up with the round-trip time when a
 * reply comes back.
 *
 * Node only (self-hosted server). Cloudflare Workers cannot run processes: there the check is inconclusive (nothing
 * recorded), and the API refuses to create such monitors.
 *
 * Safety:
 * - The target is resolved once through the netguard (`guardedAddress`): private and internal addresses are refused unless
 *   ALLOW_PRIVATE_TARGETS is set, exactly as for TCP monitors, and the binary is handed the validated IP literal only, so
 *   a name cannot be re-resolved to another address between the check and the ping (DNS rebinding).
 * - The process is started with an argument array and no shell; the only argument derived from user input is that IP
 *   literal, re-checked with `net.isIP` before the spawn.
 * - A hard timeout kills the process, and its output is read up to a small cap.
 * - The output is parsed in memory only; stored errors are fixed strings, never the command's output.
 *
 * Docker: the shipped image (node:22-alpine, USER node) uses BusyBox ping, which needs unprivileged ICMP sockets
 * (`net.ipv4.ping_group_range` covering the process's group; Docker's default since 20.10). Without them the binary
 * reports a permission error and the check is inconclusive with PING_UNAVAILABLE (logged once), rather than crashing or
 * alerting on every ping monitor.
 */

import type { CheckInput, CheckOutcome } from "./checker";
import { guardedAddress, isWorkers, pingHost, PING_TARGET_PROBLEM } from "./netguard";

export const PING_WORKERS_UNSUPPORTED = "Ping checks need the self-hosted Node runtime";
/** The binary is missing, cannot be executed, or may not open an ICMP socket (see the module comment). */
export const PING_UNAVAILABLE = "Ping unavailable on this server";
export const PING_NO_REPLY = "No ping reply";
export const PING_TIMED_OUT = "Ping timed out";
/** A ping of one packet prints a few hundred bytes; anything beyond this is not read. */
export const MAX_PING_OUTPUT_BYTES = 16 * 1024;
/** Time the binary gets past its own wait before it is killed (process start-up, printing the summary). */
const KILL_GRACE_MS = 1000;

/** Which ping implementation the arguments are built for. */
export type PingFlavour = "iputils" | "busybox" | "darwin" | "win32";

export type PingCommand = { file: string; args: string[] };

/**
 * The command for one echo request to `ip` (an IP literal) that waits at most about `waitMs` for the reply.
 * - Linux iputils: `ping [-6] -n -c 1 -W <sec> <ip>` (-W: seconds to wait for the reply).
 * - BusyBox: `ping [-6] -c 1 -W <sec> <ip>`; -n is left out (not every BusyBox build accepts it, and an IP literal needs
 *   no lookup anyway).
 * - macOS: `ping -n -c 1 -t <sec> <ip>` (-t is the overall timeout in seconds; -W would be a per-packet wait in ms).
 *   IPv6 uses `ping6 -n -c 1 <ip>`, which has no timeout option: the hard timeout ends it.
 * - Windows: `ping -n 1 -w <ms> [-6] <ip>` (-n is the count there, -w the wait in milliseconds).
 */
export function pingCommand(flavour: PingFlavour, ip: string, waitMs: number, file = "ping"): PingCommand {
  const v6 = ip.includes(":");
  const sec = String(Math.max(1, Math.floor(waitMs / 1000)));
  switch (flavour) {
    case "win32": return { file, args: ["-n", "1", "-w", String(Math.max(1, Math.floor(waitMs))), ...(v6 ? ["-6"] : []), ip] };
    case "darwin": return v6 ? { file: "ping6", args: ["-n", "-c", "1", ip] } : { file, args: ["-n", "-c", "1", "-t", sec, ip] };
    case "busybox": return { file, args: [...(v6 ? ["-6"] : []), "-c", "1", "-W", sec, ip] };
    default: return { file, args: [...(v6 ? ["-6"] : []), "-n", "-c", "1", "-W", sec, ip] };
  }
}

/** The child's whole environment: PATH and a fixed locale (plus what Windows needs to start a system binary). */
export function pingEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? env.Path ?? "", LC_ALL: "C", LANG: "C" };
  if (platform === "win32") for (const k of ["SystemRoot", "windir"]) if (env[k]) out[k] = env[k]!;
  return out;
}

export type PingRun = {
  /** Exit code; null when the process was killed or never started. */
  code: number | null;
  /** stdout and stderr together, at most MAX_PING_OUTPUT_BYTES. */
  output: string;
  timedOut: boolean;
  /** The spawn itself failed (ENOENT: no such binary, EACCES: not executable). */
  spawnError?: string;
};

export type PingRunner = (cmd: PingCommand, hardTimeoutMs: number) => Promise<PingRun>;

/** Runs `cmd` without a shell, kills it after `hardTimeoutMs`, and keeps at most `maxBytes` of its output. */
export async function runPing(cmd: PingCommand, hardTimeoutMs: number, maxBytes = MAX_PING_OUTPUT_BYTES): Promise<PingRun> {
  const { spawn } = await import("node:child_process");
  return new Promise<PingRun>((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<PingRun, "output" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, output: Buffer.concat(chunks).toString("utf8"), timedOut });
    };
    let child: import("node:child_process").ChildProcess;
    try {
      // LC_ALL=C keeps Unix ping output in English where the binary is localised; parsing still tolerates other locales
      // Only what ping needs: never the server's secrets (DATABASE_URL, BETTER_AUTH_SECRET, …)
      child = spawn(cmd.file, cmd.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: pingEnv() });
    } catch (e) {
      resolve({ code: null, output: "", timedOut: false, spawnError: String((e as { code?: unknown }).code ?? "ESPAWN") });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, hardTimeoutMs);
    const collect = (d: Buffer) => {
      const room = maxBytes - size;
      if (room <= 0) return;
      const part = d.byteLength > room ? d.subarray(0, room) : d;
      chunks.push(part);
      size += part.byteLength;
      // nothing a single ping prints is this long: stop it instead of reading on
      if (size >= maxBytes) child.kill("SIGKILL");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (e) => finish({ code: null, spawnError: String((e as { code?: unknown }).code ?? "ESPAWN") }));
    child.once("close", (code) => finish({ code }));
  });
}

export type PingParse = {
  /** An echo reply was received. */
  replied: boolean;
  /** Round-trip time from the output, or null when it could not be read (another language, a new format). */
  rttMs: number | null;
  /** The binary may not open an ICMP socket (missing capability, no unprivileged ICMP). */
  denied: boolean;
  /** This machine has no route or no address family for the target (e.g. IPv6 target, no IPv6). */
  noRoute: boolean;
};

/** A reply line: iputils / BusyBox / macOS `ttl=`, macOS ping6 `hlim=`, Windows `TTL=`; IPv6 on Windows prints only a time. */
const REPLY = /\b(?:ttl|hlim)[=:]\s*\d+/i;
/** `time=12.3 ms`, `time<1ms`, `Zeit=12ms`, `temps=12 ms`, `时间<1ms`, `time=12,3 ms`: a number right after = or < and followed by ms. */
const RTT = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms\b/i;
const DENIED = /permission denied|operation not permitted|are you root|must be root|need to be root|cap_net_raw|socktype: sock_raw/i;
// local failures only: "Destination host unreachable" comes from a router on the way and is the target's problem
const NO_ROUTE = /network is unreachable|address family not supported|transmit failed|general failure/i;

/** Reads one ping run's output. Only the reply line is used for the time, so summary lines cannot be mistaken for it. */
export function parsePingOutput(output: string, exitCode: number | null): PingParse {
  const lines = output.split(/\r?\n/);
  const reply = lines.find((l) => REPLY.test(l)) ?? lines.find((l) => RTT.test(l) && !/min|max|avg|mittel|moyenne|平均|最短|最长/i.test(l));
  // Windows exits 0 for "Destination host unreachable" sent by a router: a real reply line is required as well
  const replied = exitCode === 0 && !!reply;
  let rttMs: number | null = null;
  if (replied) {
    const m = RTT.exec(reply);
    const v = m ? Number(m[1].replace(",", ".")) : NaN;
    if (Number.isFinite(v) && v >= 0) rttMs = v;
  }
  return { replied, rttMs, denied: !replied && DENIED.test(output), noRoute: !replied && NO_ROUTE.test(output) };
}

/** The ping implementation on this machine. On Linux, `ping` on the PATH that is a link to BusyBox is BusyBox. */
let detected: { flavour: PingFlavour; file: string } | undefined;
async function localPing(): Promise<{ flavour: PingFlavour; file: string }> {
  if (detected) return detected;
  if (process.platform === "win32") {
    // the absolute System32 path: a bare "ping" would be searched in the working directory before PATH
    const path = await import("node:path");
    const fs = await import("node:fs");
    const sys = path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "PING.EXE");
    return (detected = { flavour: "win32", file: fs.existsSync(sys) ? sys : "ping" });
  }
  if (process.platform === "darwin") return (detected = { flavour: "darwin", file: "ping" });
  const fs = await import("node:fs");
  const path = await import("node:path");
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, "ping");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      return (detected = { flavour: path.basename(real) === "busybox" ? "busybox" : "iputils", file: candidate });
    } catch { /* not here */ }
  }
  // no ping on the PATH: the spawn reports ENOENT, which becomes PING_UNAVAILABLE
  return (detected = { flavour: "iputils", file: "ping" });
}

let unavailableLogged = false;
function unavailable(): CheckOutcome {
  if (!unavailableLogged) {
    unavailableLogged = true;
    console.error("ping: this server cannot send ICMP (binary missing or not permitted); ping monitors stay unchecked, see /docs/self-host");
  }
  return { ok: false, inconclusive: true, error: PING_UNAVAILABLE };
}

/** Why a ping target is malformed, or null. */
export function pingTargetProblem(target: string): string | null {
  return pingHost(target) ? null : PING_TARGET_PROBLEM;
}

/** What the check needs from its surroundings; tests replace them. */
export type PingDeps = { runner?: PingRunner; flavour?: PingFlavour; file?: string };

/**
 * One ping check. A reply is up, with the round-trip time from the output (the wall time of the run when the output
 * cannot be read). No reply and timeouts are thrown with fixed messages, so the caller can tell a target fault from a
 * prober fault as for TCP; a missing or forbidden binary is an inconclusive check with PING_UNAVAILABLE.
 */
export async function pingCheck(m: Pick<CheckInput, "target" | "timeoutMs">, started = Date.now(), deps: PingDeps = {}): Promise<CheckOutcome> {
  if (isWorkers()) return { ok: false, inconclusive: true, error: PING_WORKERS_UNSUPPORTED };
  const host = pingHost(m.target);
  if (!host) return { ok: false, error: PING_TARGET_PROBLEM };
  const until = started + m.timeoutMs;
  // resolved and validated once; only this literal reaches the binary
  const checked = await guardedAddress(host);
  // an IPv4-mapped IPv6 address (::ffff:192.0.2.1) is the IPv4 address it carries: ping it as IPv4, not over IPv6
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(checked);
  const ip = mapped ? mapped[1] : checked;
  const net = await import("node:net");
  if (!net.isIP(ip) || ip.startsWith("-")) throw new Error(PING_NO_REPLY); // cannot happen: guardedAddress returns literals
  const local = deps.flavour ? { flavour: deps.flavour, file: deps.file ?? "ping" } : await localPing();
  const waitMs = Math.max(1000, until - Date.now());
  const cmd = pingCommand(local.flavour, ip, waitMs, local.file);
  const spawnedAt = Date.now();
  const run = await (deps.runner ?? runPing)(cmd, waitMs + KILL_GRACE_MS);
  const wall = Date.now() - spawnedAt;
  // This server cannot ping at all (no binary, no ICMP permission, a local firewall): the prober's fault, not the
  // target's. Inconclusive, so a host without ICMP never pages anyone for every ping monitor; said once in the log.
  if (run.spawnError) return unavailable();
  if (run.timedOut) throw Object.assign(new Error(PING_TIMED_OUT), { code: "ETIMEDOUT" });
  const parsed = parsePingOutput(run.output, run.code);
  if (parsed.replied) {
    // a time beyond the whole check's budget cannot be right: the measured time is used instead
    const rtt = parsed.rttMs != null && parsed.rttMs <= m.timeoutMs + KILL_GRACE_MS ? parsed.rttMs : wall;
    return { ok: true, latencyMs: Math.round(rtt) };
  }
  if (parsed.denied) return unavailable();
  // no route from here (no IPv6, network down): a prober-side failure, judged like ENETUNREACH on a socket
  if (parsed.noRoute) throw Object.assign(new Error(PING_NO_REPLY), { code: "ENETUNREACH" });
  throw new Error(PING_NO_REPLY);
}
