import { readCapped } from "./netguard";
import { HTTP_REQUEST_CAPABILITY } from "./http-request";
import { JSON_ASSERTION_CAPABILITY } from "./json-assertion";
import type { Monitor, RegionResult, Repo } from "@montral/repo";
import { runCheck, type CheckInput, type CheckOutcome } from "./checker";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signProbe } from "./probe-protocol";
import { AUTO, REGION_ID, REGION_NAMES, effectiveRegions } from "./regions";

/**
 * Remote probes. A region is an HTTP endpoint (apps/probe, deployed to several places) that runs one check on request
 * and answers with its outcome. Which regions exist is deployment configuration:
 *
 *   PROBE_REGIONS = {"us-east":"https://probe.example.app/api/probe/us-east","eu-central":{"url":"…","name":"Frankfurt"}}
 *   PROBE_SECRET  = shared secret the probes verify requests with
 *
 * Nothing configured means only `auto` (the scheduler's own location), exactly as before.
 */
export type ProbeRegion = { id: string; name: string; url: string };

let regions = new Map<string, ProbeRegion>();
let secret = "";
let configured: string | undefined;

/** Parses `PROBE_REGIONS`. Entries that cannot be used are reported in `problems` and left out. */
export function parseProbeRegions(raw: string | undefined): { regions: ProbeRegion[]; problems: string[] } {
  const out: ProbeRegion[] = [];
  const problems: string[] = [];
  if (!raw?.trim()) return { regions: out, problems };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { regions: out, problems: ["PROBE_REGIONS is not valid JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { regions: out, problems: ["PROBE_REGIONS must be a JSON object of region id to URL"] };
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = typeof value === "string" ? { url: value } : (value as { url?: unknown; name?: unknown } | null);
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (id === AUTO || !REGION_ID.test(id)) { problems.push(`${id}: not a valid region id (lowercase letters, digits and dashes, 2 to 24 characters, not "auto")`); continue; }
    let u: URL;
    try { u = new URL(url); } catch { problems.push(`${id}: url is not a valid URL`); continue; }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) { problems.push(`${id}: url must use https`); continue; }
    const name = typeof (entry as { name?: unknown })?.name === "string" && (entry as { name: string }).name.trim() ? (entry as { name: string }).name.trim().slice(0, 60) : (REGION_NAMES[id] ?? id);
    out.push({ id, name, url: u.toString() });
  }
  return { regions: out, problems };
}

/** Env values are constant per deployment, so a module-level config is safe in a Worker isolate; parsed once. */
export function configureProbes(env: { PROBE_REGIONS?: string; PROBE_SECRET?: string }) {
  capable.clear();
  const key = `${env.PROBE_REGIONS ?? ""}\u0000${env.PROBE_SECRET ?? ""}`;
  if (key === configured) return;
  configured = key;
  const parsed = parseProbeRegions(env.PROBE_REGIONS);
  for (const p of parsed.problems) console.warn(`probes: ${p}`);
  secret = env.PROBE_SECRET?.trim() ?? "";
  if (parsed.regions.length && !secret) console.warn("probes: PROBE_REGIONS is set but PROBE_SECRET is not; regions stay disabled");
  regions = new Map(secret ? parsed.regions.map((r) => [r.id, r] as const) : []);
}

/** The regions a monitor may use here, `auto` first. */
export function availableRegions(): { id: string; name: string }[] {
  return [{ id: AUTO, name: "Auto" }, ...[...regions.values()].map(({ id, name }) => ({ id, name }))];
}

export const isRegionConfigured = (id: string) => id === AUTO || regions.has(id);

/** What running a check in one region came to: an outcome, or that the region could not be asked at all. */
export type RegionRun = { region: string; outcome: CheckOutcome } | { region: string; unreachable: string };

const outcomeOf = (v: unknown): CheckOutcome | null => {
  const o = v as { ok?: unknown; statusCode?: unknown; latencyMs?: unknown; error?: unknown } | null;
  if (!o || typeof o.ok !== "boolean") return null;
  return {
    ok: o.ok,
    ...(typeof o.statusCode === "number" ? { statusCode: o.statusCode } : {}),
    ...(typeof o.latencyMs === "number" ? { latencyMs: o.latencyMs } : {}),
    ...(typeof o.error === "string" ? { error: o.error.slice(0, 500) } : {}),
  };
};

/** Remote probe JSON should be tiny. Neither an oversized nor incomplete reply
 * may count as a target failure, and streaming it cannot exhaust worker RAM. */
const PROBE_REPLY_MAX_BYTES = 16 * 1024;
class ProbeReplyTooLarge extends Error {}

async function readProbeReply(res: Response, signal: AbortSignal): Promise<unknown> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  let onAbort: (() => void) | undefined;
  // Fetch's AbortSignal also limits body reads if an upstream stream ignores
  // the abort or drips data without ever reaching EOF.
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Probe reply body timed out", "TimeoutError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) { complete = true; break; }
      if (value.byteLength > PROBE_REPLY_MAX_BYTES - size) throw new ProbeReplyTooLarge();
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // Neither a size rejection nor a timeout may await a sender-controlled
    // cancellation promise. Normal EOF needs no cancellation.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return null; }
}

/**
 * Run a check from `region`. A probe that cannot be reached, refuses us or answers nonsense is `unreachable`: that says
 * nothing about the target, so callers must not count it as a failed check.
 */
const CAPABILITY_TTL_MS = 30_000;
/** Per probe URL and capability: until when a positive answer is trusted. */
const capable = new Map<string, number>();
/** Forgets which probes were seen supporting request bodies (tests, and a configuration reload). */
export function resetProbeCapabilities() { capable.clear(); }

export const NOT_CONFIGURED = "Region is not configured on this deployment";
export const DRAINED = "Region is drained by the operator";

export async function runInRegion(region: string, input: CheckInput, repo?: Repo): Promise<RegionRun> {
  if (region === AUTO) {
    const outcome = await runCheck(input, repo);
    return outcome.inconclusive ? { region, unreachable: "This location is offline" } : { region, outcome };
  }
  const probe = regions.get(region);
  if (!probe) return { region, unreachable: NOT_CONFIGURED };
  // a drained region is not asked at all: its monitors confirm from their other regions (see `measure`)
  if ((await drainedRegions(repo)).has(region)) return { region, unreachable: DRAINED };
  const run = await askProbe(probe, input);
  // capability gaps say nothing about the probe's health; anything else is a sign of life, or of trouble
  if ("outcome" in run) noteHealth(repo, region, true);
  else if (!run.unreachable.startsWith("Probe upgrade required")) noteHealth(repo, region, false, run.unreachable);
  return run;
}

/** How long the drained set read from the database is reused by this process. */
const DRAIN_TTL_MS = 15_000;
let drainCache: { at: number; drained: Set<string> } | null = null;
let drainLoad: Promise<Set<string>> | null = null;

/**
 * The regions an operator drained (repo `probeRegionStates`), cached briefly and loaded once for concurrent checks. If
 * the state cannot be read the last known drains stay in force (none before the first read): a database hiccup must
 * neither silence monitoring nor suddenly send checks to a region an operator took out.
 */
export async function drainedRegions(repo?: Repo): Promise<Set<string>> {
  if (!repo?.probeRegionStates) return new Set();
  if (drainCache && Date.now() - drainCache.at < DRAIN_TTL_MS) return drainCache.drained;
  drainLoad ??= repo.probeRegionStates().then(
    (states) => (drainCache = { at: Date.now(), drained: new Set(states.filter((st) => st.drained).map((st) => st.region)) }).drained,
    () => {
      console.warn("probe region state unavailable; last known drains kept");
      return drainCache?.drained ?? new Set<string>();
    },
  ).finally(() => { drainLoad = null; });
  return drainLoad;
}

/**
 * Health writes per region and process: at most one per HEALTH_WRITE_MS while the state holds, and one per
 * HEALTH_FLIP_MS when it flips between answering and unreachable (a flapping probe cannot turn every check into a
 * write). The database applies the same bounds in its upsert, so several processes stay within them too.
 */
export const HEALTH_WRITE_MS = 60_000;
export const HEALTH_FLIP_MS = 10_000;
const healthWritten = new Map<string, { at: number; answered: boolean }>();

/** Record that a probe answered or could not be asked (operator view). Not awaited by the check; never fails it. */
function noteHealth(repo: Repo | undefined, region: string, answered: boolean, reason?: string) {
  if (!repo?.noteProbeHealth) return;
  const last = healthWritten.get(region);
  const since = last ? Date.now() - last.at : Infinity;
  if (since < (last?.answered === answered ? HEALTH_WRITE_MS : HEALTH_FLIP_MS)) return;
  healthWritten.set(region, { at: Date.now(), answered });
  let write: Promise<void>;
  try { write = repo.noteProbeHealth(region, answered, reason); } catch { write = Promise.reject(new Error("health write failed")); }
  void write.catch(() => console.warn("probe health not recorded"));
}

/** Forgets cached drains and health-write throttling (tests, and an operator drain in this process). */
export function resetProbeRegionCache() {
  drainCache = null;
  healthWritten.clear();
}

async function askProbe(probe: ProbeRegion, input: CheckInput): Promise<RegionRun> {
  const region = probe.id;
  const body = JSON.stringify({
    type: input.type, target: input.target, method: input.method, expectedStatus: input.expectedStatus, timeoutMs: input.timeoutMs,
    keyword: input.keyword ?? null, keywordMode: input.keywordMode ?? "contains", expectedLocation: input.expectedLocation ?? null, headers: input.headers ?? {},
    wsMessage: input.wsMessage ?? null, requestBody: input.requestBody ?? null,
    // only sent when set, so the envelope of a monitor without one stays byte-for-byte what older probes know
    ...(input.type === "http" && input.jsonPath ? { jsonPath: input.jsonPath, jsonExpected: input.jsonExpected ?? null, jsonMatch: input.jsonMatch ?? "equals" } : {}),
  });
  try {
    // Old probes ignore unknown fields: verify support BEFORE sending a payload. A positive answer is remembered
    // briefly so every check does not pay for a second request; a rolled-back probe is noticed within CAPABILITY_TTL_MS.
    // A probe without the JSON capability would drop the assertion and report the bare status as a pass.
    const needed = [
      ...(input.type === "http" && (input.requestBody || !["GET", "HEAD", "POST"].includes(input.method)) ? [HTTP_REQUEST_CAPABILITY] : []),
      ...(input.type === "http" && input.jsonPath && input.method !== "HEAD" ? [JSON_ASSERTION_CAPABILITY] : []),
    ].filter((c) => (capable.get(`${probe.url}\0${c}`) ?? 0) <= Date.now());
    if (needed.length) {
      const healthSignal = AbortSignal.timeout(5000);
      const health = await fetch(probe.url, { redirect: "manual", signal: healthSignal });
      const capabilities: unknown = health.ok ? JSON.parse(await readCapped(health, 4096, healthSignal)) : null;
      if (!health.ok) void health.body?.cancel().catch(() => {});
      const advertised = (capabilities as { capabilities?: unknown } | null)?.capabilities;
      const missing = needed.filter((c) => !Array.isArray(advertised) || !advertised.includes(c));
      if (missing.length) {
        for (const c of missing) capable.delete(`${probe.url}\0${c}`);
        return { region, unreachable: missing.includes(HTTP_REQUEST_CAPABILITY) ? "Probe upgrade required for HTTP request bodies and methods" : "Probe upgrade required for JSON assertions" };
      }
      for (const c of needed) capable.set(`${probe.url}\0${c}`, Date.now() + CAPABILITY_TTL_MS);
    }
    const ts = Math.floor(Date.now() / 1000);
    // One time budget applies to both response headers and body consumption.
    const replySignal = AbortSignal.timeout(input.timeoutMs + 8000);
    const res = await fetch(probe.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signProbe(secret, ts, body) },
      body,
      signal: replySignal,
    });
    if (!res.ok) {
      // An unavailable region may send a body that cannot be canceled.
      void res.body?.cancel().catch(() => {});
      return { region, unreachable: `Probe answered ${res.status}` };
    }
    const answer = await readProbeReply(res, replySignal);
    // the probe could not even reach the internet: that says nothing about the target, same as a probe we cannot reach
    if ((answer as { inconclusive?: unknown } | null)?.inconclusive === true) return { region, unreachable: "Probe is offline" };
    const outcome = outcomeOf(answer);
    return outcome ? { region, outcome } : { region, unreachable: "Probe answered with something that is not a result" };
  } catch (e) {
    if (e instanceof ProbeReplyTooLarge) return { region, unreachable: "Probe response exceeded 16 KiB limit" };
    // Fetch exceptions can embed tokens, addresses, proxy headers or URLs.
    // These messages are included in region summaries and scheduler logs.
    return { region, unreachable: (e as Error)?.name === "TimeoutError" ? "Probe did not answer in time" : "Probe unreachable" };
  }
}

/** One run of a monitor: what each answering region saw, and the single outcome the state machine works with. */
export type Measured = { out: CheckOutcome; results: RegionResult[]; note?: string };

/** A run that could not be carried out from here at all: nothing is recorded for it. */
const inconclusive = (out: CheckOutcome): Measured => ({ out, results: [] });

/**
 * Fold the answers of several regions into one run. With `minFailing` 0 the run fails when a strict majority of the
 * regions that answered failed; otherwise when at least that many did, never asking for more than the regions that
 * answered (so a region that is down itself cannot keep a real outage from alerting). One region's bad route or outage
 * therefore pages nobody unless the monitor asks for it. Regions that could not be asked are left out: that is our
 * problem, not the target's. `null` when nobody answered. `note` says in a few words how the regions voted.
 */
export function combine(runs: RegionRun[], minFailing = 0): Measured | null {
  const answered = runs.flatMap((r) => ("outcome" in r ? [{ region: r.region, ...r.outcome }] : []));
  if (!answered.length) return null;
  const results: RegionResult[] = answered.map((a) => ({ region: a.region, ok: a.ok, statusCode: a.statusCode, latencyMs: a.latencyMs, error: a.error }));
  if (answered.length === 1) {
    const { region: _, ...out } = answered[0];
    return { out, results };
  }
  const failed = answered.filter((a) => !a.ok);
  const needed = minFailing > 0 ? Math.min(minFailing, answered.length) : Math.floor(answered.length / 2) + 1;
  if (failed.length >= needed) {
    const first = failed[0];
    const why = first.error ?? (first.statusCode ? `HTTP ${first.statusCode}` : "Check failed");
    return {
      out: { ok: false, statusCode: first.statusCode, latencyMs: first.latencyMs, error: `Failed from ${failed.length} of ${answered.length} regions (${first.region}: ${why})` },
      results,
      note: `${failed.length} of ${answered.length} regions failed`,
    };
  }
  const lat = answered.filter((a) => a.ok && a.latencyMs != null).map((a) => a.latencyMs!);
  const latencyMs = lat.length ? Math.round(lat.reduce((n, v) => n + v, 0) / lat.length) : undefined;
  const best = answered.find((a) => a.ok)!;
  return {
    out: { ok: true, statusCode: best.statusCode, latencyMs },
    results,
    ...(failed.length ? { note: `${failed.length} of ${answered.length} regions failed, ${needed} needed` } : {}),
  };
}

/**
 * Run a monitor's check from the regions it asks for. A monitor on `auto` (the default) never touches a probe. If no
 * probe answers, the check falls back to this location so a probe outage cannot blind monitoring; if only some answer
 * and their failures fall short of what the monitor's rule asks for, this location confirms first (`needsConfirmation`),
 * so an unreachable or drained probe neither hides an outage nor lets a single region page.
 */
export async function measure(m: Monitor, repo?: Repo): Promise<Measured> {
  const regions = effectiveRegions(m);
  if (regions.length === 1 && regions[0] === AUTO) {
    const out = await runCheck(m, repo);
    if (out.inconclusive) return inconclusive(out);
    return { out, results: [{ region: AUTO, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error }] };
  }
  const runs = await Promise.all(regions.map((r) => runInRegion(r, m, repo)));
  // a drained region is the operator's choice, not news: it is left out of the log line
  const lost = runs.flatMap((r) => ("unreachable" in r && r.unreachable !== DRAINED ? [`${r.region}: ${r.unreachable}`] : []));
  if (lost.length) console.warn(`probes unavailable for ${m.id}: ${lost.join("; ")}`);
  const combined = combine(runs, m.minRegionsFailing);
  if (combined) {
    if (!needsConfirmation(regions, combined, m.minRegionsFailing)) return combined;
    // one region failing while the others could not vote: this location's own check is one more vote
    const local = await runCheck(m, repo);
    return confirmLocally(combined, local.inconclusive ? null : local, regions.length, m.minRegionsFailing);
  }
  const out = await runCheck(m, repo);
  if (out.inconclusive) return inconclusive(out);
  return { out, results: [{ region: AUTO, ok: out.ok, statusCode: out.statusCode, latencyMs: out.latencyMs, error: out.error }] };
}

/** Failed regions a monitor listing `regions` regions needs to go down: its own number, or a strict majority. */
export function requiredFailures(regions: number, minFailing = 0): number {
  return minFailing > 0 ? Math.min(minFailing, regions) : Math.floor(regions / 2) + 1;
}

/**
 * Does this failing verdict rest on a single region's view only because the monitor's other regions could not vote
 * (unreachable or drained)? `combine` lowers the bar to the regions that answered, so that a broken probe cannot hide a
 * real outage, and two or more regions that agree still alert that way. But one region's bad route must not page a
 * monitor that asked for more than one region to agree: such a verdict is confirmed from this location first. A monitor
 * that lists `auto` already has this location's vote, so nothing is added.
 */
export function needsConfirmation(regions: string[], combined: Measured, minFailing = 0): boolean {
  if (combined.out.ok || regions.length < 2 || regions.includes(AUTO)) return false;
  if (combined.results.length >= regions.length) return false;
  const failed = combined.results.filter((r) => !r.ok).length;
  return failed === 1 && requiredFailures(regions.length, minFailing) > 1;
}

/**
 * Fold this location's check into a verdict `needsConfirmation` did not trust. With its vote added, the run fails when
 * the monitor's rule holds over the regions that answered plus this location (capped like `combine`); otherwise it
 * passes and the failing regions stay recorded. When this location could not check either (`local` null) the verdict
 * stands: an answer from a region is still evidence, and staying blind is worse than an unconfirmed alert.
 */
export function confirmLocally(combined: Measured, local: CheckOutcome | null, configured: number, minFailing = 0): Measured {
  const answered = combined.results.length;
  const failed = combined.results.filter((r) => !r.ok).length;
  const vote = `${failed} of ${answered} regions failed, ${configured - answered} unavailable`;
  if (!local) return { ...combined, note: `${vote}; this location could not confirm` };
  const results: RegionResult[] = [...combined.results, { region: AUTO, ok: local.ok, statusCode: local.statusCode, latencyMs: local.latencyMs, error: local.error }];
  const failing = failed + (local.ok ? 0 : 1);
  const needed = minFailing > 0 ? Math.min(minFailing, results.length) : Math.floor(results.length / 2) + 1;
  if (failing >= needed) return { out: combined.out, results, note: `${vote}; confirmed from this location` };
  const lat = results.filter((r) => r.ok && r.latencyMs != null).map((r) => r.latencyMs!);
  return {
    out: { ok: true, statusCode: local.statusCode, latencyMs: lat.length ? Math.round(lat.reduce((n, v) => n + v, 0) / lat.length) : undefined },
    results,
    note: `${vote}; not confirmed from this location`,
  };
}
