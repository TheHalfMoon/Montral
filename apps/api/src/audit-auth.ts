import { auditChanges, recordAuditEvent, type AuditChanges, type Query } from "./audit";
import type { Bindings } from "./env";
import { clientIpFromHeaders } from "./ratelimit";

/**
 * Audit records for what Montral delegates to Better Auth: invitations, member roles and removals (organization
 * plugin), workspace renames, and API keys. Better Auth runs these endpoints itself, so its after-hook passes the
 * finished call here. Only ids, roles and names are kept: an API key's value, an invitee's address and request bodies
 * never reach the log.
 */

type Session = { user: { id: string; email?: string | null }; session: { activeOrganizationId?: string | null } } | null;
export type AuthCall = {
  path: string;
  body: unknown;
  /** what the endpoint returned; an error object when it failed */
  returned: unknown;
  headers: Headers | undefined;
  session: Session;
};
/** What a before-hook learned about an API key that is about to be deleted (its row is gone afterwards). */
export type KeyNote = { id: string; orgId: string | null };
/**
 * The acting user was a member of `orgId` just before a call that may end that membership (removing oneself, leaving):
 * afterwards the usual "actor is still a member" check would wrongly drop the event.
 */
export type MemberNote = { userId: string; orgId: string };
/** Calls after which the actor may no longer be a member of the workspace the event belongs to. */
export const MEMBERSHIP_ENDING_PATHS = new Set(["/organization/remove-member", "/organization/leave"]);

export const AUDITED_AUTH_PATHS = new Set([
  "/organization/invite-member", "/organization/cancel-invitation", "/organization/update-member-role", "/organization/remove-member",
  "/organization/update", "/organization/leave", "/api-key/create", "/api-key/delete",
]);

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Error) && !(v instanceof Response) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
const metaOrg = (meta: unknown): string | null => {
  if (typeof meta === "string") {
    try { return str(obj(JSON.parse(meta))?.organizationId); } catch { return null; }
  }
  return str(obj(meta)?.organizationId);
};
const roleOf = (v: unknown) => (Array.isArray(v) ? v.filter((r) => typeof r === "string").join(",") : typeof v === "string" ? v : null);

/** Before Better Auth deletes an API key: remember which workspace it belonged to. */
export async function noteKeyBeforeDelete(query: Query, body: unknown): Promise<KeyNote | null> {
  const id = str(obj(body)?.keyId);
  if (!id) return null;
  const rows = await query<{ metadata: unknown }>("SELECT metadata FROM apikey WHERE id = $1::text", [id]);
  return rows[0] ? { id, orgId: metaOrg(rows[0].metadata) } : null;
}

/** Before a membership-ending call: confirm (in the database) that the acting user is a member of the workspace it names. */
export async function noteMembershipBefore(query: Query, session: Session, body: unknown): Promise<MemberNote | null> {
  if (!session) return null;
  const orgId = str(obj(body)?.organizationId) ?? str(session.session.activeOrganizationId);
  if (!orgId) return null;
  const rows = await query<{ one: number }>("SELECT 1 AS one FROM member WHERE organization_id = $1::text AND user_id = $2::text", [orgId, session.user.id]);
  return rows.length ? { userId: session.user.id, orgId } : null;
}

/** The audit event for one finished Better Auth call, or null when there is nothing to record. */
export function authAuditEvent(call: AuthCall, note: KeyNote | null): { orgId: string; action: string; targetType: string; targetId: string | null; changes: AuditChanges | null } | null {
  if (!AUDITED_AUTH_PATHS.has(call.path) || !call.session) return null;
  const out = obj(call.returned);
  if (!out) return null; // failed calls return an APIError
  const body = obj(call.body) ?? {};
  const active = str(call.session.session.activeOrganizationId);
  switch (call.path) {
    case "/organization/invite-member": {
      const orgId = str(out.organizationId);
      return orgId ? { orgId, action: "member.invite", targetType: "invitation", targetId: str(out.id), changes: auditChanges({ email: body.email, role: body.role }, { role: roleOf(out.role ?? body.role) }) } : null;
    }
    case "/organization/cancel-invitation": {
      const orgId = str(out.organizationId) ?? str(obj(out.invitation)?.organizationId);
      return orgId ? { orgId, action: "member.invite_cancel", targetType: "invitation", targetId: str(body.invitationId), changes: null } : null;
    }
    case "/organization/update-member-role": {
      const orgId = str(out.organizationId);
      return orgId ? { orgId, action: "member.role_change", targetType: "member", targetId: str(out.id) ?? str(body.memberId), changes: auditChanges({ role: body.role }, { role: roleOf(out.role ?? body.role) }) } : null;
    }
    case "/organization/remove-member": {
      const member = obj(out.member);
      const orgId = str(member?.organizationId);
      return orgId ? { orgId, action: "member.remove", targetType: "member", targetId: str(member?.id), changes: auditChanges({}, { role: roleOf(member?.role) }) } : null;
    }
    case "/organization/leave": {
      const orgId = str(out.organizationId);
      return orgId ? { orgId, action: "member.leave", targetType: "member", targetId: str(out.id), changes: auditChanges({}, { role: roleOf(out.role) }) } : null;
    }
    case "/organization/update": {
      const orgId = str(out.id);
      return orgId ? { orgId, action: "workspace.update", targetType: "workspace", targetId: orgId, changes: auditChanges(obj(body.data)) } : null;
    }
    case "/api-key/create": {
      // a key carries its workspace in its metadata (that is what requireOrg reads); without one it follows the session
      const orgId = metaOrg(out.metadata) ?? active;
      const meta = obj(out.metadata);
      return orgId ? {
        orgId, action: "api_key.create", targetType: "api_key", targetId: str(out.id),
        changes: auditChanges({ name: out.name ?? undefined, projectIds: Array.isArray(meta?.projectIds) && meta.projectIds.length ? meta.projectIds : undefined }),
      } : null;
    }
    case "/api-key/delete": {
      if (out.success !== true || !note) return null;
      const orgId = note.orgId ?? active;
      return orgId ? { orgId, action: "api_key.revoke", targetType: "api_key", targetId: note.id, changes: null } : null;
    }
  }
  return null;
}

/**
 * Records a finished Better Auth call. Best effort, like audit(): never fails the call. The actor must still be a
 * member of the workspace the event goes to, so a key whose metadata names someone else's workspace cannot write
 * into that workspace's log.
 */
export async function auditAuthCall(query: Query, env: Pick<Bindings, "TRUST_PROXY">, call: AuthCall, note: KeyNote | null, member: MemberNote | null = null): Promise<void> {
  try {
    const event = authAuditEvent(call, note);
    if (!event || !call.session) return;
    const userId = call.session.user.id;
    await recordAuditEvent(query, {
      orgId: event.orgId,
      projectId: null,
      actor: { type: "user", id: userId, userId, label: call.session.user.email ?? null },
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      changes: event.changes,
      ip: clientIpFromHeaders((name) => call.headers?.get(name), env),
      // membership was confirmed just before a call that may have ended it (removing oneself, leaving)
      requireMember: member && member.userId === userId && member.orgId === event.orgId ? null : userId,
    });
  } catch {
    console.error("audit event could not be recorded; private diagnostics suppressed");
  }
}
