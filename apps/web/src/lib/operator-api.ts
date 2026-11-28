/** Session-only operator API. Never cache operator identities or workspace details. */
export type OperatorWorkspace = {
  id: string; name: string; slug: string; createdAt: string;
  memberCount: number; ownerEmail: string | null; monitorCount: number;
  suspended: boolean; plan: string | null;
};
export type OperatorWorkspaceDetail = OperatorWorkspace & {
  suspension: null | { reason: string; note: string | null; suspendedBy: string | null; suspendedAt: string };
  usage: { credits: unknown; emails: unknown };
};
export type OperatorRegion = {
  id: string; name: string; status: "up" | "unreachable" | "drained" | "deactivated" | "unknown";
  configured: boolean; enabled: boolean; drained: boolean; monitors: number;
  lastAnswerAt: string | null; lastUnreachableAt: string | null;
  lastUnreachableReason: string | null; drainedAt: string | null;
};
export type OperatorSuspensionEvent = {
  id: string; action: "workspace.suspend" | "workspace.unsuspend";
  reason: string | null; createdAt: string;
};
export type OperatorProbeAuditEvent = {
  id: number; region: string; action: "drain" | "undrain";
  operatorId: string; note: string | null; createdAt: string;
};
export type OperatorProbeLifecycleEvent = {
  id: number; region: string; action: "activate" | "deactivate"; operatorId: string; createdAt: string;
};
export type OperatorProbeValidation = {
  id: string; validated: true; identity: "reported_match"; credentialProof: "matched"; sourceAttestation: false; capabilities: string[];
};
export type ManagedProbeRegistration = {
  region: string; displayName: string; endpointUrl: string;
  state: "registered" | "suspended" | "revoked"; createdBy: string; updatedBy: string;
  createdAt: string; updatedAt: string; executionEnabled: false;
};
export type ManagedProbeRegistrationEvent = {
  id: number; region: string; action: "register" | "suspend" | "restore" | "revoke";
  operatorId: string; createdAt: string;
};
export type ManagedProbeCredentialAuditEvent = {
  id: string; versionId: string;
  action: "credential.prepare" | "credential.revoke" | "enrollment.issue" | "enrollment.consume" | "enrollment.expire" | "enrollment.revoke";
  actorId: string; createdAt: string;
};
export type OperatorPlatformAuditEvent = {
  source: "workspace" | "probe"; id: string;
  action: "workspace.suspend" | "workspace.unsuspend" | "probe.drain" | "probe.undrain"
    | "probe.activate" | "probe.deactivate" | "probe.validation.validated"
    | "probe.validation.identity_mismatch" | "probe.validation.credential_mismatch" | "probe.validation.unavailable";
  target: string; operatorId: string | null; reason: string | null; createdAt: string;
};
export type SuspensionReason = "abuse" | "payment" | "legal" | "operator";

export class OperatorRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? "Operator access denied" : "Operator request failed");
  }
}

/** No shared app cache, browser cache, bearer token, local storage or raw server error text. */
export function makeOperatorApi(fetcher: typeof fetch = fetch) {
  async function call<T>(path: string, body?: object): Promise<T> {
    const result = await fetcher(`/api/operator${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!result.ok) throw new OperatorRequestError(result.status);
    return result.json() as Promise<T>;
  }
  return {
    listWorkspaces: (q = "", cursor?: string) => {
      const query = new URLSearchParams({ limit: "25" });
      if (q.trim()) query.set("q", q.trim());
      if (cursor) query.set("cursor", cursor);
      return call<{ workspaces: OperatorWorkspace[]; next: string | null }>(`/workspaces?${query}`);
    },
    platformAudit: (q = "", source: "all" | "workspace" | "probe" = "all", cursor?: string) => {
      const params = new URLSearchParams({ source, limit: "25" });
      if (q.trim()) params.set("q", q.trim());
      if (cursor) params.set("cursor", cursor);
      return call<{ events: OperatorPlatformAuditEvent[]; next: string | null }>(`/audit?${params}`);
    },
    workspace: (id: string) => call<OperatorWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}`),
    suspensionHistory: (id: string) => call<{ workspaceId: string; events: OperatorSuspensionEvent[] }>(`/workspaces/${encodeURIComponent(id)}/suspension-history?limit=20`),
    suspend: (id: string, reason: SuspensionReason, note: string) =>
      call<{ id: string; suspended: true }>(`/workspaces/${encodeURIComponent(id)}/suspend`, { reason, note }),
    unsuspend: (id: string) => call<{ id: string; suspended: false }>(`/workspaces/${encodeURIComponent(id)}/unsuspend`, {}),
    probes: () => call<{ auto: { monitors: number }; regions: OperatorRegion[] }>("/probes"),
    managedProbes: (limit = 50, after?: string) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (after) query.set("after", after);
      return call<{ registrations: ManagedProbeRegistration[]; nextCursor: string | null }>(`/managed-probes?${query}`);
    },
    registerManagedProbe: (input: { region: string; displayName: string; endpointUrl: string }) =>
      call<{ registration: ManagedProbeRegistration }>("/managed-probes", input),
    transitionManagedProbe: (id: string, action: "suspend" | "restore" | "revoke") =>
      call<{ registration: ManagedProbeRegistration }>(`/managed-probes/${encodeURIComponent(id)}/${action}`, {}),
    managedProbeAudit: (id: string) => call<{ region: string; events: ManagedProbeRegistrationEvent[] }>(`/managed-probes/${encodeURIComponent(id)}/audit?limit=50`),
    managedProbeCredentialAudit: (id: string) => call<{ region: string; events: ManagedProbeCredentialAuditEvent[] }>(`/managed-probes/${encodeURIComponent(id)}/credential-audit?limit=50`),
    probeAudit: (id: string) => call<{ region: string; events: OperatorProbeAuditEvent[]; lifecycleEvents: OperatorProbeLifecycleEvent[] }>(`/probes/${encodeURIComponent(id)}/audit?limit=50`),
    validateProbe: (id: string) => call<OperatorProbeValidation>(`/probes/${encodeURIComponent(id)}/validate`, {}),
    drain: (id: string, note: string) => call<{ id: string; drained: true }>(`/probes/${encodeURIComponent(id)}/drain`, { note }),
    undrain: (id: string) => call<{ id: string; drained: false }>(`/probes/${encodeURIComponent(id)}/undrain`, {}),
    deactivate: (id: string) => call<{ id: string; enabled: false; changed: boolean }>(`/probes/${encodeURIComponent(id)}/deactivate`, {}),
    activate: (id: string) => call<{ id: string; enabled: true; changed: boolean }>(`/probes/${encodeURIComponent(id)}/activate`, {}),
  };
}

export const operatorApi = makeOperatorApi();

/** Explicit, case-sensitive confirmation prevents accidental writes to a similarly named resource. */
export function operatorActionConfirmed(expected: string, typed: string, note: string, maxNote: number): boolean {
  return expected.length > 0 && typed === expected && note.length <= maxNote;
}
