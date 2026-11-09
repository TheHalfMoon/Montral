import { describe, expect, it, vi } from "vitest";
import {
  auditChanges, auditRetentionDays, csvCell, csvRow, decodeCursor, encodeCursor, exportAuditEvents, listAuditEvents, recordAuditEvent,
  SAFE_VALUE_FIELDS, safeValueField, type Query,
} from "./audit";
import { authAuditEvent, auditAuthCall } from "./audit-auth";

const ID = "00000000-0000-4000-8000-000000000001";

describe("audit changes: field names always, values only from the allowlist", () => {
  it("records the names of every field set and the values of harmless settings", () => {
    expect(auditChanges({ name: "API", paused: true, intervalSec: 60, visibility: "password" })).toEqual({
      fields: ["intervalSec", "name", "paused", "visibility"],
      values: { name: "API", paused: true, intervalSec: 60, visibility: "password" },
    });
  });

  it("never keeps the value of a password, token, key, channel setting, target, header or body", () => {
    const secret = "s3cr3t-value-that-must-not-leak";
    const input = {
      password: secret, accessPasswordHash: secret, token: secret, botToken: secret, routingKey: secret, apiKey: secret, key: secret,
      secret, url: `https://hooks.example.com/${secret}`, config: { url: `https://hooks.example.com/${secret}`, botToken: secret },
      headers: { authorization: `Bearer ${secret}` }, requestBody: secret, target: `https://user:${secret}@example.com`, wsMessage: secret,
      email: "someone@example.com", userKey: secret, webhookUrl: secret, cookie: secret,
    };
    const out = auditChanges(input);
    expect(out.fields).toEqual(Object.keys(input).sort());
    expect(out.values).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain("someone@example.com");
  });

  it("drops undefined fields, odd field names and non-scalar values; long strings are cut", () => {
    const out = auditChanges({ name: "x".repeat(500), monitorIds: [ID], recurrence: { frequency: "daily" }, skipped: undefined, "bad key": 1, "__proto__x": 1 });
    expect(out.fields).toEqual(["__proto__x", "monitorIds", "name", "recurrence"].filter((f) => /^[A-Za-z]/.test(f)));
    expect(out.values).toEqual({ name: "x".repeat(80) });
  });

  it("takes extra values only when they are allowlisted too", () => {
    expect(auditChanges({ role: "admin" }, { role: "admin", password: "nope", count: 3 })).toEqual({ fields: ["role"], values: { role: "admin", count: 3 } });
  });

  it("no allowlisted field looks like a credential, and credential-like names are never allowed", () => {
    for (const f of SAFE_VALUE_FIELDS) expect(safeValueField(f), f).toBe(true);
    for (const f of ["password", "apiKey", "token", "url", "webhookUrl", "headers", "requestBody", "config", "secretName", "authHeader", "email"]) {
      expect(safeValueField(f), f).toBe(false);
    }
  });
});

describe("CSV export escaping", () => {
  it.each([
    ["=1+2", "'=1+2"], ["+1", "'+1"], ["-2", "'-2"], ["@SUM(A1)", "'@SUM(A1)"], ["\tx", "'\tx"], ["\rx", "\"'\rx\""],
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
  ])("neutralises formula cell %j", (input, expected) => expect(csvCell(input)).toBe(expected));

  it("quotes commas, quotes and line breaks, and renders empty, numeric and object cells", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(csvCell({ fields: ["name"] })).toBe('"{""fields"":[""name""]}"');
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvRow(["a", "=b", null])).toBe("a,'=b,\r\n");
  });
});

describe("cursor", () => {
  it("round-trips and rejects anything it did not issue", () => {
    const c = { at: "2026-11-09T10:11:12.123456Z", id: ID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    for (const bad of ["", "not a cursor", encodeCursor({ at: "2026-11-09", id: ID }), encodeCursor({ at: c.at, id: "x" }), btoa(`${c.at}|${ID}|extra`).replace(/=+$/, "")]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
  });
});

describe("retention setting", () => {
  it("defaults to 365 days and accepts whole days from 30 to 3650", () => {
    expect(auditRetentionDays(undefined)).toBe(365);
    expect(auditRetentionDays({})).toBe(365);
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: "90" })).toBe(90);
    for (const v of ["29", "3651", "abc", "90.5", "-1", ""]) expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: v }), v).toBe(365);
  });
});

describe("queries are always bound to the workspace", () => {
  it("lists with the workspace as the first parameter and filters as literal values", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query: Query = async <T,>(sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return [] as T[]; };
    await listAuditEvents(query, "org-a", { action: "status_page_", actorId: "u1", targetType: "monitor", targetId: ID, from: new Date("2026-01-01T00:00:00Z") }, { limit: 50, cursor: { at: "2026-11-09T10:11:12.123456Z", id: ID } });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/WHERE organization_id = \$1::text AND/);
    expect(params[0]).toBe("org-a");
    expect(params).toContain("status\\_page\\_%"); // wildcards in a prefix are escaped
    expect(sql).not.toContain("u1");
    expect(sql).toMatch(/LIMIT 51$/);
  });

  it("refuses an action name outside the dotted lowercase form and keeps an invalid project id out", async () => {
    const query = vi.fn(async () => []) as unknown as Query;
    const base = { orgId: "o", projectId: "not-a-uuid", actor: { type: "user" as const, id: "u", userId: "u" }, targetType: "monitor", targetId: null, changes: null, ip: null };
    await expect(recordAuditEvent(query, { ...base, action: "Monitor Create" })).rejects.toThrow();
    await recordAuditEvent(query, { ...base, action: "monitor.create" });
    const params = (query as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("o");
    expect(params[1]).toBeNull();
  });
});

describe("export stream", () => {
  const row = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, project_id: null, actor_type: "api_key", actor_id: "k1", actor_label: i === 0 ? "=cmd" : "key",
    action: "monitor.create", target_type: "monitor", target_id: "m", changes: { fields: ["name"] }, ip: null,
    created_at: new Date(Date.UTC(2026, 10, 9, 0, 0, 100 - i)), cursor_at: `2026-11-09T00:01:${String(40 - i).padStart(2, "0")}.000000Z`,
  });
  const fake = (total: number): Query => async <T,>(_sql: string, params: unknown[] = []) => {
    const limit = Number(/LIMIT (\d+)/.exec(_sql)![1]);
    const after = params.length >= 2 && typeof params[params.length - 1] === "string" && /^0{8}-/.test(params[params.length - 1] as string)
      ? Number((params[params.length - 1] as string).slice(-12)) + 1 : 0;
    return Array.from({ length: Math.max(0, Math.min(limit, total - after)) }, (_, k) => row(after + k)) as T[];
  };
  const read = async (s: ReadableStream<Uint8Array>) => new Response(s).text();

  it("writes a header and escaped rows, reads page by page, stops at the cap and signals the end once", async () => {
    const done = vi.fn();
    const text = await read(exportAuditEvents(fake(7), "o", {}, "csv", { cap: 5, pageSize: 2, done }));
    const lines = text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("created_at,id,action,actor_type,actor_id,actor_label,target_type,target_id,project_id,ip,changes");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain(",'=cmd,");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("writes JSON Lines and ends when the data does", async () => {
    const done = vi.fn();
    const text = await read(exportAuditEvents(fake(3), "o", {}, "jsonl", { pageSize: 2, done }));
    const events = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.actorLabel)).toEqual(["=cmd", "key", "key"]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("reports a failed read as a stream error with a fixed log line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const done = vi.fn();
    const failing: Query = async () => { throw new Error("connection to postgres://user:secret@db failed"); };
    await expect(read(exportAuditEvents(failing, "o", {}, "jsonl", { done }))).rejects.toThrow();
    expect(error).toHaveBeenCalledWith("audit export failed; private diagnostics suppressed");
    expect(done).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("Better Auth calls in the audit log", () => {
  const session = { user: { id: "u1", email: "owner@example.com" }, session: { activeOrganizationId: "org-a" } };
  const base = { headers: new Headers(), session };

  it("records an API key by id and name, never its value", () => {
    const e = authAuditEvent({ ...base, path: "/api-key/create", body: { name: "CI" }, returned: { id: "key1", name: "CI", key: "montral_supersecretvalue", metadata: { organizationId: "org-b", projectIds: [ID] } } }, null);
    expect(e).toEqual({ orgId: "org-b", action: "api_key.create", targetType: "api_key", targetId: "key1", changes: { fields: ["name", "projectIds"], values: { name: "CI" } } });
    expect(JSON.stringify(e)).not.toContain("supersecret");
  });

  it("records invitations without the invitee's address, role changes and removals", () => {
    const invite = authAuditEvent({ ...base, path: "/organization/invite-member", body: { email: "new@example.com", role: "member" }, returned: { id: "inv1", organizationId: "org-a", email: "new@example.com", role: "member" } }, null);
    expect(invite).toMatchObject({ action: "member.invite", targetId: "inv1", changes: { fields: ["email", "role"], values: { role: "member" } } });
    expect(JSON.stringify(invite)).not.toContain("new@example.com");
    expect(authAuditEvent({ ...base, path: "/organization/update-member-role", body: { memberId: "m1", role: "admin" }, returned: { id: "m1", organizationId: "org-a", role: "admin" } }, null))
      .toMatchObject({ action: "member.role_change", targetType: "member", targetId: "m1", changes: { values: { role: "admin" } } });
    expect(authAuditEvent({ ...base, path: "/organization/remove-member", body: { memberIdOrEmail: "x@example.com" }, returned: { member: { id: "m2", organizationId: "org-a", role: "member" } } }, null))
      .toMatchObject({ action: "member.remove", targetId: "m2" });
  });

  it("records a key revocation only when it succeeded, in the key's workspace", () => {
    const note = { id: "key1", orgId: "org-b" };
    expect(authAuditEvent({ ...base, path: "/api-key/delete", body: { keyId: "key1" }, returned: { success: true } }, note)).toMatchObject({ orgId: "org-b", action: "api_key.revoke", targetId: "key1" });
    expect(authAuditEvent({ ...base, path: "/api-key/delete", body: { keyId: "key1" }, returned: { success: false } }, note)).toBeNull();
    expect(authAuditEvent({ ...base, path: "/api-key/delete", body: { keyId: "key1" }, returned: { success: true } }, null)).toBeNull();
  });

  it("ignores failed calls, other endpoints and calls without a session", () => {
    expect(authAuditEvent({ ...base, path: "/organization/invite-member", body: {}, returned: new Error("FORBIDDEN") }, null)).toBeNull();
    expect(authAuditEvent({ ...base, path: "/sign-in/email", body: { password: "x" }, returned: { token: "t" } }, null)).toBeNull();
    expect(authAuditEvent({ ...base, session: null, path: "/api-key/create", body: {}, returned: { id: "k" } }, null)).toBeNull();
  });

  it("writes with a membership condition and never fails the call", async () => {
    const calls: unknown[][] = [];
    const query: Query = async <T,>(_sql: string, params: unknown[] = []) => { calls.push(params); return [] as T[]; };
    await auditAuthCall(query, {}, { ...base, path: "/api-key/create", body: {}, returned: { id: "k", name: "n", metadata: { organizationId: "org-b" } } }, null);
    expect(calls[0][0]).toBe("org-b");
    expect(calls[0][13]).toBe("u1"); // requireMember: the actor must belong to the workspace written to
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: Query = async () => { throw new Error("relation audit_event does not exist"); };
    await expect(auditAuthCall(broken, {}, { ...base, path: "/api-key/create", body: {}, returned: { id: "k" } }, null)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("audit event could not be recorded; private diagnostics suppressed");
    error.mockRestore();
  });
});

describe("MCP tool", () => {
  it("list_audit_events is a read-only call of the REST endpoint (owner/admin and the read scope are enforced there)", async () => {
    const { TOOLS } = await import("./mcp");
    const tool = TOOLS.find((t) => t.name === "list_audit_events")!;
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBeFalsy();
    expect(tool.build({ action: "monitor", limit: 10, cursor: undefined } as never)).toEqual({ method: "GET", path: "/api/audit-events?action=monitor&limit=10" });
    expect(tool.build({} as never)).toEqual({ method: "GET", path: "/api/audit-events" });
  });
});

describe("review follow-ups", () => {
  it.each([
    [" =HYPERLINK(\"http://x\",\"y\")", `"' =HYPERLINK(""http://x"",""y"")"`],
    ["\n=1+1", "\"'\n=1+1\""],
    ["  +1", "'  +1"],
    ["\t @x", "'\t @x"],
    [" plain", " plain"],
  ])("neutralises %j even after leading whitespace", (input, expected) => expect(csvCell(input)).toBe(expected));

  const session = { user: { id: "u1", email: "admin@example.com" }, session: { activeOrganizationId: "org-a" } };
  it("records leaving a workspace as member.leave", () => {
    expect(authAuditEvent({ headers: undefined, session, path: "/organization/leave", body: { organizationId: "org-a" }, returned: { id: "m9", organizationId: "org-a", role: "member" } }, null))
      .toEqual({ orgId: "org-a", action: "member.leave", targetType: "member", targetId: "m9", changes: { fields: [], values: { role: "member" } } });
  });

  it("drops the membership condition only when membership was confirmed for that workspace before the call", async () => {
    const calls: unknown[][] = [];
    const query: Query = async <T,>(_sql: string, params: unknown[] = []) => { calls.push(params); return [] as T[]; };
    const removed = { headers: undefined, session, path: "/organization/remove-member", body: {}, returned: { member: { id: "m1", organizationId: "org-a", role: "admin" } } };
    await auditAuthCall(query, {}, removed, null, { userId: "u1", orgId: "org-a" });
    expect(calls[0][13]).toBeNull();
    await auditAuthCall(query, {}, removed, null, { userId: "u1", orgId: "org-b" });
    expect(calls[1][13]).toBe("u1");
    await auditAuthCall(query, {}, removed, null, { userId: "someone-else", orgId: "org-a" });
    expect(calls[2][13]).toBe("u1");
  });
});
