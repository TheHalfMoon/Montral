import type { OncallOverride, OncallSchedule, Repo, WorkspaceMember } from "@montral/repo";
import { shiftsBetween, whoIsOnCall, ON_CALL_HORIZON_MS, type ScheduleSpec, type Shift } from "./oncall-engine";

/** Longest range GET /oncall/schedules/:id/shifts answers. */
export const MAX_SHIFT_RANGE_DAYS = 90;
const DAY = 86_400_000;

/** The engine's view of a stored schedule. */
export function specOf(s: OncallSchedule, overrides: OncallOverride[], memberIds: Iterable<string>): ScheduleSpec {
  return { timeZone: s.timeZone, layers: s.layers, overrides: overrides.filter((o) => o.scheduleId === s.id), memberIds };
}

export type ShiftView = { userId: string; name: string | null; start: string; end: string; source: Shift["source"]; layerId: string | null; overrideId: string | null };
export type OnCallNow = { scheduleId: string; scheduleName: string; projectId: string | null; timeZone: string; onCall: ShiftView | null };

const view = (s: Shift, members: Map<string, WorkspaceMember>): ShiftView => ({
  userId: s.userId, name: members.get(s.userId)?.name || members.get(s.userId)?.email || null,
  start: s.start.toISOString(), end: s.end.toISOString(), source: s.source, layerId: s.layerId, overrideId: s.overrideId,
});

/** Who is on call on each schedule at `at`, with the current shift's start and end. */
export async function onCallNow(repo: Repo, orgId: string, schedules: OncallSchedule[], at = new Date()): Promise<OnCallNow[]> {
  if (!schedules.length) return [];
  const members = new Map((await repo.listMembers(orgId)).map((m) => [m.userId, m]));
  const overrides = await repo.listOncallOverrides(orgId, schedules.map((s) => s.id), new Date(at.getTime() - ON_CALL_HORIZON_MS), new Date(at.getTime() + ON_CALL_HORIZON_MS));
  return schedules.map((s) => {
    let onCall: ShiftView | null = null;
    try {
      const shift = whoIsOnCall(specOf(s, overrides, members.keys()), at);
      onCall = shift ? view(shift, members) : null;
    } catch {
      console.error("on-call schedule could not be evaluated");
    }
    return { scheduleId: s.id, scheduleName: s.name, projectId: s.projectId, timeZone: s.timeZone, onCall };
  });
}

/** One schedule's shifts in [from, to). */
export async function scheduleShifts(repo: Repo, orgId: string, s: OncallSchedule, from: Date, to: Date): Promise<ShiftView[]> {
  const members = new Map((await repo.listMembers(orgId)).map((m) => [m.userId, m]));
  const overrides = await repo.listOncallOverrides(orgId, [s.id], from, to);
  return shiftsBetween(specOf(s, overrides, members.keys()), from, to).map((x) => view(x, members));
}

/** Parses ?from=&to= (ISO 8601). Defaults: now and two weeks later. At most MAX_SHIFT_RANGE_DAYS. */
export function shiftRange(fromRaw: string | undefined, toRaw: string | undefined, now = new Date()): { from: Date; to: Date } | { error: string } {
  const from = fromRaw ? new Date(fromRaw) : now;
  const to = toRaw ? new Date(toRaw) : new Date(from.getTime() + 14 * DAY);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return { error: "from and to must be ISO 8601 date-times" };
  if (to <= from) return { error: "to must be after from" };
  if (to.getTime() - from.getTime() > MAX_SHIFT_RANGE_DAYS * DAY) return { error: `The range can be at most ${MAX_SHIFT_RANGE_DAYS} days` };
  return { from, to };
}

// ── iCalendar ───────────────────────────────────────────────────────────────────────────────────────────────────

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and line breaks. */
export const icsText = (s: string) => s.replace(/[\\;,]/g, (ch) => `\\${ch}`).replace(/\r?\n/g, "\\n");
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Folds a content line at 75 octets (continuation lines start with a space), never inside a UTF-8 sequence. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += size;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** A person's shifts across the workspace's schedules as an iCalendar feed (UTC times; a client shows them locally). */
export function icsFeed(shifts: { scheduleId: string; scheduleName: string; start: Date; end: Date; source: Shift["source"] }[], now = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Montral//On-call//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Montral on-call", "REFRESH-INTERVAL;VALUE=DURATION:PT1H"];
  for (const s of shifts) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.scheduleId}-${icsTime(s.start)}@oncall.montral`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(s.start)}`,
      `DTEND:${icsTime(s.end)}`,
      `SUMMARY:${icsText(`On call: ${s.scheduleName}${s.source === "override" ? " (override)" : ""}`)}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/**
 * The person's shifts on every schedule of the workspace from 7 days ago to 60 days ahead, for their calendar feed.
 * Only their own shifts are listed. Every schedule of the workspace counts: a signed-in member can read all of the
 * workspace's projects (project limits apply to API keys and agents, which cannot create a feed link), so schedule names
 * never reach someone who could not already read them.
 */
export async function personalShifts(repo: Repo, orgId: string, userId: string, now = new Date()) {
  const from = new Date(now.getTime() - 7 * DAY);
  const to = new Date(now.getTime() + 60 * DAY);
  const schedules = await repo.listOncallSchedules(orgId, null);
  if (!schedules.length) return [];
  const members = (await repo.listMembers(orgId)).map((m) => m.userId);
  const overrides = await repo.listOncallOverrides(orgId, schedules.map((s) => s.id), from, to);
  const out: { scheduleId: string; scheduleName: string; start: Date; end: Date; source: Shift["source"] }[] = [];
  for (const s of schedules) {
    try {
      for (const shift of shiftsBetween(specOf(s, overrides, members), from, to)) {
        if (shift.userId === userId) out.push({ scheduleId: s.id, scheduleName: s.name, start: shift.start, end: shift.end, source: shift.source });
      }
    } catch {
      console.error("on-call schedule could not be evaluated");
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** SHA-256 hex of a feed token: only the hash is stored. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
