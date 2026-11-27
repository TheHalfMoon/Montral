import { AUTO, REGION_ID } from "./regions";
import { hostBlocked } from "./netguard";

export interface ManagedProbeRegistrationInput {
  region: string;
  displayName: string;
  endpointUrl: string;
}

export type ManagedProbeRegistrationParseResult =
  | { ok: true; value: ManagedProbeRegistrationInput }
  | { ok: false; code: "invalid_region" | "invalid_name" | "invalid_endpoint" };

/** Validate and canonicalize non-secret metadata only; this function performs no DNS lookup or network request. */
export function parseManagedProbeRegistrationInput(value: Record<string, unknown>): ManagedProbeRegistrationParseResult {
  if (Object.keys(value).some((key) => !["region", "displayName", "endpointUrl"].includes(key))) {
    return { ok: false, code: "invalid_endpoint" };
  }
  const region = typeof value.region === "string" ? value.region : "";
  if (!REGION_ID.test(region) || region === AUTO) return { ok: false, code: "invalid_region" };
  const rawDisplayName = typeof value.displayName === "string" ? value.displayName : "";
  const displayName = rawDisplayName.trim();
  if (!displayName || displayName.length > 60 || /[\u0000-\u001f\u007f]/.test(rawDisplayName)) {
    return { ok: false, code: "invalid_name" };
  }
  const rawEndpoint = typeof value.endpointUrl === "string" ? value.endpointUrl : "";
  if (!rawEndpoint || rawEndpoint !== rawEndpoint.trim() || rawEndpoint.length > 2048 || /[\u0000-\u0020\u007f]/.test(rawEndpoint)) {
    return { ok: false, code: "invalid_endpoint" };
  }
  let endpoint: URL;
  try { endpoint = new URL(rawEndpoint); } catch { return { ok: false, code: "invalid_endpoint" }; }
  const hostname = endpoint.hostname.toLowerCase();
  const isIpv4Literal = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || rawEndpoint.includes("?") || rawEndpoint.includes("#") ||
    !hostname || hostBlocked(hostname) || hostname.includes(":") || isIpv4Literal ||
    endpoint.pathname !== `/api/probe/${region}`
  ) return { ok: false, code: "invalid_endpoint" };
  return { ok: true, value: { region, displayName, endpointUrl: endpoint.toString() } };
}
