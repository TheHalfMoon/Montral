import { HTTP_REQUEST_CAPABILITY, HTTP_METHODS, requestBodyProblem } from "../../api/src/http-request";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyProbe } from "../../api/src/probe-protocol";

/**
 * A small, HTTP-only Cloudflare Worker probe. Reuses the request validation and
 * keyword/status checks that motivated the Cloudflare monitoring source, but does NOT run
 * its scheduled loop, keep a second incident database, or alert customers.
 * The Montral scheduler is the single source of truth for a check.
 */
export type EdgeEnv = { PROBE_SECRET?: string; ALLOWED_HOSTS?: string; REGION?: string };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const MAX_SIGNED_BODY = 64 * 1024;
const MAX_RESPONSE = 128 * 1024;

export function safeTarget(raw: string, allowedHosts: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!url.hostname || url.hostname.includes(":") || /^\d+(\.\d+){3}$/.test(url.hostname)) return null;
  if (url.hostname === "localhost" || /\.(local|internal|localhost|test|invalid)$/.test(url.hostname)) return null;
  const allow = allowedHosts.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes(url.hostname.toLowerCase())) return null;
  return url;
}

async function readBytes(req: Request | Response, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function handleEdgeProbe(request: Request, env: EdgeEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const region = env.REGION || "cloudflare";
  if (request.method === "GET") return json(200, { ok: true, region, capabilities: [HTTP_REQUEST_CAPABILITY] });
  if (request.method !== "POST") return json(405, { error: "POST a signed check" });
  if (!env.PROBE_SECRET || env.PROBE_SECRET.length < 16 || !env.ALLOWED_HOSTS?.trim()) return json(503, { error: "Edge probe not configured" });
  const body = await readBytes(request, MAX_SIGNED_BODY);
  if (body === null) return json(413, { error: "Request too large" });
  if (!await verifyProbe(env.PROBE_SECRET, {
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
    body,
  })) return json(401, { error: "Invalid signed request" });

  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return json(400, { error: "Invalid JSON" }); }
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return json(400, { error: "Invalid input" });
  if (value.type !== "http" || typeof value.target !== "string") return json(400, { error: "HTTP checks only" });
  const target = safeTarget(value.target, env.ALLOWED_HOSTS);
  if (!target) return json(400, { error: "Target not in the configured public HTTPS allowlist" });
  const method = value.method ?? "GET";
  if (typeof method !== "string" || !(HTTP_METHODS as readonly string[]).includes(method)) return json(400, { error: "Unsupported method" });
  const requestBody = value.requestBody ?? null;
  if (requestBody !== null && typeof requestBody !== "string") return json(400, { error: "Invalid requestBody" });
  const problem = requestBodyProblem({ type: "http", method, requestBody });
  if (problem) return json(400, { error: problem });
  const expectedStatus = value.expectedStatus ?? 200;
  if (!Number.isInteger(expectedStatus) || (expectedStatus as number) < 100 || (expectedStatus as number) > 599) return json(400, { error: "Invalid expectedStatus" });
  const timeoutMs = value.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 30000) return json(400, { error: "Invalid timeout" });
  const headers = value.headers ?? {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return json(400, { error: "Invalid headers" });
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > 25 || entries.some(([k,v]) => !/^[a-z0-9-]{1,80}$/i.test(k) || typeof v !== "string" || v.length > 512 || /^(host|cookie|authorization|proxy-authorization)$/i.test(k))) {
    // Sensitive headers or host overrides should use the Node probe, never the constrained public edge.
    return json(400, { error: "Unsupported headers on the public edge probe" });
  }
  const keyword = value.keyword;
  if (keyword != null && (typeof keyword !== "string" || keyword.length > 500)) return json(400, { error: "Invalid keyword" });
  if (!["contains", "absent"].includes(String(value.keywordMode ?? "contains"))) return json(400, { error: "Invalid keyword mode" });

  const started = Date.now();
  try {
    const response = await fetcher(target, {
      method, headers: Object.fromEntries(entries) as Record<string,string>, body: requestBody || undefined,
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs as number),
    });
    let error: string | undefined;
    if (response.status !== expectedStatus) error = `Expected HTTP ${expectedStatus}, received ${response.status}`;
    const expectedLocation = value.expectedLocation;
    if (expectedLocation != null) {
      if (typeof expectedLocation !== "string" || expectedLocation.length > 2048) return json(400, { error: "Invalid expectedLocation" });
      const got = response.headers.get("location");
      const expected = new URL(expectedLocation, target).toString();
      if (!got || new URL(got, target).toString() !== expected) error = "Unexpected redirect location";
    }
    if (!error && keyword) {
      const valueBody = await readBytes(response, MAX_RESPONSE);
      if (valueBody === null) return json(200, { ok: false, inconclusive: true, error: "Body limit exceeded on edge" });
      const found = valueBody.includes(keyword as string);
      if (value.keywordMode === "absent" ? found : !found) error = "Response keyword condition failed";
    } else {
      await response.body?.cancel().catch(() => {});
    }
    return json(200, { ok: !error, statusCode: response.status, latencyMs: Date.now() - started, ...(error ? { error } : {}) });
  } catch {
    return json(200, { ok: false, inconclusive: true, error: "Edge probe request failed or timed out" });
  }
}

export default { fetch: (request: Request, env: EdgeEnv) => handleEdgeProbe(request, env) };
