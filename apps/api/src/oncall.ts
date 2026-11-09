/**
 * Deterministic, UTC-based on-call assignment primitive.
 *
 * This module is intentionally pure: storage, authorization, audit and escalation
 * integration are separate release gates. No untrusted schedule may select a
 * recipient until its inputs have been validated.
 */
export type OnCallRotation = Readonly<{
  anchor: Date;
  shiftMinutes: number;
  participants: readonly string[];
}>;
export type OnCallOverride = Readonly<{
  start: Date;
  end: Date;
  participantId: string;
  /** Higher priority wins; equal priorities with conflicting recipients are rejected. */
  priority: number;
}>;
export type OnCallAssignment = Readonly<{
  participantId: string;
  source: "rotation" | "override";
  validUntil: Date;
}>;

const MAX_SHIFT_MINUTES = 60 * 24 * 31;
const MAX_OVERRIDES = 1000;
const MAX_PARTICIPANTS = 100;

function timestamp(date: Date): number {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new RangeError("Invalid on-call timestamp");
  return date.getTime();
}
function participant(id: string): boolean {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}

/** Fail closed for corrupt or ambiguous schedule data. */
export function validateOnCall(rotation: OnCallRotation, overrides: readonly OnCallOverride[]): void {
  timestamp(rotation.anchor);
  if (!Number.isSafeInteger(rotation.shiftMinutes) || rotation.shiftMinutes < 1 ||
      rotation.shiftMinutes > MAX_SHIFT_MINUTES) throw new RangeError("Invalid rotation shift");
  if (!Array.isArray(rotation.participants) || rotation.participants.length < 1 ||
      rotation.participants.length > MAX_PARTICIPANTS ||
      rotation.participants.some((id) => !participant(id)) ||
      new Set(rotation.participants).size !== rotation.participants.length)
    throw new RangeError("Invalid rotation participants");
  if (!Array.isArray(overrides) || overrides.length > MAX_OVERRIDES)
    throw new RangeError("Too many on-call overrides");
  for (const o of overrides) {
    const start = timestamp(o.start), end = timestamp(o.end);
    if (start >= end || !participant(o.participantId) ||
        !Number.isSafeInteger(o.priority) || o.priority < 0 || o.priority > 1000)
      throw new RangeError("Invalid on-call override");
  }
  // Overlaps are permitted only if priority determines the winner or
  // the same recipient wins both. Otherwise order of DB rows could change paging.
  for (let i = 0; i < overrides.length; i++) {
    for (let j = i + 1; j < overrides.length; j++) {
      const a = overrides[i], b = overrides[j];
      if (a.priority === b.priority && a.participantId !== b.participantId &&
          a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime())
        throw new RangeError("Ambiguous overlapping on-call overrides");
    }
  }
}

/** Half-open [start,end) overrides; boundaries are independent of locale and DST. */
export function resolveOnCall(
  rotation: OnCallRotation,
  overrides: readonly OnCallOverride[],
  at: Date,
): OnCallAssignment {
  validateOnCall(rotation, overrides);
  const now = timestamp(at);
  const shiftMs = rotation.shiftMinutes * 60_000;
  const elapsed = now - rotation.anchor.getTime();
  const index = Math.floor(elapsed / shiftMs);
  if (!Number.isSafeInteger(index)) throw new RangeError("Rotation index overflow");
  const base = rotation.participants[((index % rotation.participants.length) + rotation.participants.length) % rotation.participants.length];
  const boundary = rotation.anchor.getTime() + (index + 1) * shiftMs;
  const active = overrides.filter((o) => o.start.getTime() <= now && now < o.end.getTime())
    .sort((a, b) => b.priority - a.priority);
  const winner = active[0];
  if (winner) {
    // A higher-priority override may expire before the rotation's next shift.
    // A lower-priority override becomes effective at that expiry.
    const nextPreemption = overrides.reduce((min, o) =>
      o.start.getTime() > now && o.priority > winner.priority
        ? Math.min(min, o.start.getTime()) : min, winner.end.getTime());
    return { participantId: winner.participantId, source: "override",
      validUntil: new Date(Math.min(nextPreemption, boundary)) };
  }
  // A future override may start before the normal shift ends.
  const nextOverride = overrides.reduce((min, o) =>
    o.start.getTime() > now ? Math.min(min, o.start.getTime()) : min, boundary);
  return { participantId: base, source: "rotation", validUntil: new Date(Math.min(boundary, nextOverride)) };
}
