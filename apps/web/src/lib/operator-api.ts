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
  id: string; name: string; status: "up" | "unreachable" | "drained" | "unknown";
  configured: boolean; drained: boolean; monitors: number;
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
    workspace: (id: string) => call<OperatorWorkspaceDetail>(`/workspaces/${encodeURIComponent(id)}`),
    suspensionHistory: (id: string) => call<{ workspaceId: string; events: OperatorSuspensionEvent[] }>(`/workspaces/${encodeURIComponent(id)}/suspension-history?limit=20`),
    suspend: (id: string, reason: SuspensionReason, note: string) =>
      call<{ id: string; suspended: true }>(`/workspaces/${encodeURIComponent(id)}/suspend`, { reason, note }),
    unsuspend: (id: string) => call<{ id: string; suspended: false }>(`/workspaces/${encodeURIComponent(id)}/unsuspend`, {}),
    probes: () => call<{ auto: { monitors: number }; regions: OperatorRegion[] }>("/probes"),
    probeAudit: (id: string) => call<{ region: string; events: OperatorProbeAuditEvent[] }>(`/probes/${encodeURIComponent(id)}/audit?limit=50`),
    drain: (id: string, note: string) => call<{ id: string; drained: true }>(`/probes/${encodeURIComponent(id)}/drain`, { note }),
    undrain: (id: string) => call<{ id: string; drained: false }>(`/probes/${encodeURIComponent(id)}/undrain`, {}),
  };
}

export const operatorApi = makeOperatorApi();

/** Explicit, case-sensitive confirmation prevents accidental writes to a similarly named resource. */
export function operatorActionConfirmed(expected: string, typed: string, note: string, maxNote: number): boolean {
  return expected.length > 0 && typed === expected && note.length <= maxNote;
}
