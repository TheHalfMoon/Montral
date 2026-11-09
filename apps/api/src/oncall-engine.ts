/**
 * On-call schedule engine: who is on call, and the shifts between two instants. Pure functions only. Nothing here reads
 * the database, the clock or the environment, so the same input always gives the same answer on every server.
 *
 * Model
 * - A schedule has an IANA time zone and ordered layers. Each layer rotates through its members: every handoff passes
 *   the shift to the next person in the list.
 * - Handoffs happen at a local wall-clock time in the schedule's zone (daily, weekly on a weekday, or every N hours of
 *   wall-clock time), starting at `startDate` + `handoffTime`. Before that instant the layer has nobody.
 * - Daylight saving time: a handoff whose local time does not exist (spring forward, e.g. 02:30 in New York) happens at
 *   the next valid instant, the moment the clocks jump. A local time that occurs twice (fall back) is the first
 *   occurrence only, so the handoff happens once.
 * - Restriction windows (e.g. weekdays 09:00-17:00) limit when a layer is active; outside them the layer has nobody.
 *   An end at or before the start crosses midnight; 00:00-00:00 is a whole day.
 * - Layers later in the list take precedence over earlier ones wherever they have someone on call; an earlier layer
 *   shows through the gaps of a later one (its restriction windows, before it starts).
 * - Overrides take precedence over every layer. Where overrides overlap, the latest created wins.
 * - A person who is no longer a member of the workspace (`memberIds` given and not containing them) is skipped: their
 *   rotation shift goes to the next member in the layer's order, and their overrides are ignored.
 */

export type RotationType = "daily" | "weekly" | "custom";
/** `days`: 0 = Sunday … 6 = Saturday, local to the schedule's zone; `start` and `end` are "HH:MM". */
export type Restriction = { days: number[]; start: string; end: string };
export interface LayerSpec {
  id: string;
  /** rotation order */
  userIds: string[];
  rotationType: RotationType;
  /** custom rotations only: wall-clock hours per shift (1 to 2016) */
  shiftLengthHours?: number | null;
  /** local "HH:MM" */
  handoffTime: string;
  /** weekly rotations: 0 = Sunday … 6 = Saturday; null/undefined = the weekday of `startDate` */
  handoffWeekday?: number | null;
  /** local "YYYY-MM-DD": the first shift starts on this date at `handoffTime` */
  startDate: string;
  restrictions?: Restriction[] | null;
}
export interface OverrideSpec {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}
export interface ScheduleSpec {
  timeZone: string;
  /** lowest precedence first */
  layers: LayerSpec[];
  overrides?: OverrideSpec[];
  /** current members of the workspace; null/undefined = everyone counts as a member */
  memberIds?: Iterable<string> | null;
}
export interface Shift {
  userId: string;
  start: Date;
  end: Date;
  source: "layer" | "override";
  layerId: string | null;
  overrideId: string | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The longest range one call computes; the REST API allows far less (90 days). */
export const MAX_RANGE_MS = 400 * DAY;
export const MAX_SHIFT_HOURS = 2016;

// ── time zones ──────────────────────────────────────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", era: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for a zone name this runtime knows (IANA names such as "Europe/London", and "UTC"). */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's UTC offset at an exact instant, read from Intl (slow: one formatToParts call). */
function rawOffset(ms: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const era = parts.find((p) => p.type === "era")?.value;
  const year = era === "BC" || era === "B" ? 1 - get("year") : get("year");
  const d = new Date(Date.UTC(2000, get("month") - 1, get("day"), get("hour"), get("minute"), get("second")));
  d.setUTCFullYear(year);
  return d.getTime() - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * Offsets are cached per 15-minute bucket of UTC time. Every offset in the IANA database since standard time is a
 * multiple of 15 minutes and transitions happen at local minute boundaries, so a transition always falls on a bucket
 * boundary and the offset is constant inside a bucket. This keeps a 90-day range of hourly handoffs at a few thousand
 * Intl calls instead of hundreds of thousands.
 */
const BUCKET = 15 * 60_000;
const offsetCache = new Map<string, Map<number, number>>();
function offsetAt(ms: number, timeZone: string): number {
  let zone = offsetCache.get(timeZone);
  if (!zone) offsetCache.set(timeZone, (zone = new Map()));
  const bucket = Math.floor(ms / BUCKET);
  let o = zone.get(bucket);
  if (o === undefined) {
    if (zone.size > 200_000) zone.clear();
    o = rawOffset(bucket * BUCKET, timeZone);
    zone.set(bucket, o);
  }
  return o;
}

/** The local wall-clock time of an instant, expressed as milliseconds of the same reading in UTC. */
export function wallOf(ms: number, timeZone: string): number {
  return ms + offsetAt(ms, timeZone);
}

/**
 * The instant at which the zone's clocks read `wall`. A reading that occurs twice (fall back) gives the first one; a
 * reading that never occurs (spring forward) gives the next valid instant: the moment the clocks jump past it.
 */
export function instantOf(wall: number, timeZone: string): number {
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const candidates = [...new Set([before, after])].map((o) => wall - o).filter((t) => wallOf(t, timeZone) === wall).sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  // In a gap: the offset grows from `before` to `after` somewhere between these two instants. Find the jump.
  let lo = wall - Math.max(before, after);
  let hi = wall - Math.min(before, after);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, timeZone) === offsetAt(lo, timeZone)) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ── parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minutes after midnight of an "HH:MM" time, or null. */
export function parseTime(s: unknown): number | null {
  const m = typeof s === "string" ? HHMM.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Midnight of a "YYYY-MM-DD" calendar date as UTC milliseconds, or null for a date that does not exist. */
export function parseDate(s: unknown): number | null {
  const m = typeof s === "string" ? DATE.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

/** Why a layer cannot be used, or null when it is valid. */
export function layerProblem(l: LayerSpec): string | null {
  if (!Array.isArray(l.userIds) || l.userIds.length === 0) return "A layer needs at least one person";
  if (new Set(l.userIds).size !== l.userIds.length) return "A person appears twice in a layer's rotation";
  if (!["daily", "weekly", "custom"].includes(l.rotationType)) return "Unknown rotation type";
  if (l.rotationType === "custom" && !(Number.isInteger(l.shiftLengthHours) && l.shiftLengthHours! >= 1 && l.shiftLengthHours! <= MAX_SHIFT_HOURS)) return `A custom rotation needs a shift length of 1 to ${MAX_SHIFT_HOURS} hours`;
  if (parseTime(l.handoffTime) === null) return "Handoff time must be HH:MM";
  if (l.handoffWeekday != null && !(Number.isInteger(l.handoffWeekday) && l.handoffWeekday >= 0 && l.handoffWeekday <= 6)) return "Handoff weekday must be 0 (Sunday) to 6 (Saturday)";
  if (parseDate(l.startDate) === null) return "Start date must be a real YYYY-MM-DD date";
  for (const r of l.restrictions ?? []) {
    if (!Array.isArray(r.days) || !r.days.length || r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "A restriction window needs weekdays 0 (Sunday) to 6 (Saturday)";
    if (parseTime(r.start) === null || parseTime(r.end) === null) return "Restriction windows use HH:MM times";
  }
  return null;
}

// ── layers ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Segment = { start: number; end: number; userId: string; key: string };

/**
 * Instants of a layer's rotation boundaries: shift k runs from at(k) to at(k + 1); index(t) is a k whose shift starts
 * at or before t (possibly one early, near a DST change).
 *
 * Daily, weekly and custom rotations of 24 hours or more hand off at local wall-clock times. Custom rotations shorter
 * than 24 hours are measured in elapsed time from the first handoff instead: on a spring-forward night a 1-hour
 * rotation still gives everyone a full hour (on the wall clock two handoffs would land on the same instant and
 * someone's slot would vanish), and on a fall-back night nobody gets two hours.
 */
function rotation(l: LayerSpec, timeZone: string) {
  const anchorWall = parseDate(l.startDate)! + parseTime(l.handoffTime)! * MIN;
  if (l.rotationType === "custom" && l.shiftLengthHours! < 24) {
    const anchor = instantOf(anchorWall, timeZone);
    const step = l.shiftLengthHours! * HOUR;
    return { anchor, at: (k: number) => anchor + k * step, index: (t: number) => Math.floor((t - anchor) / step) };
  }
  let boundary: (k: number) => number;
  let indexOf: (wall: number) => number;
  if (l.rotationType === "weekly") {
    const weekday = l.handoffWeekday ?? new Date(anchorWall).getUTCDay();
    const first = anchorWall + (((weekday - new Date(anchorWall).getUTCDay() + 7) % 7) || 7) * DAY;
    boundary = (k) => (k === 0 ? anchorWall : first + (k - 1) * WEEK);
    indexOf = (wall) => (wall < first ? 0 : 1 + Math.floor((wall - first) / WEEK));
  } else {
    const step = l.rotationType === "daily" ? DAY : l.shiftLengthHours! * HOUR;
    boundary = (k) => anchorWall + k * step;
    indexOf = (wall) => Math.floor((wall - anchorWall) / step);
  }
  return { anchor: instantOf(anchorWall, timeZone), at: (k: number) => instantOf(boundary(k), timeZone), index: (t: number) => indexOf(wallOf(t, timeZone)) - 1 };
}

/** The layer's rotation shifts overlapping [from, to), before restriction windows; each carries its rotation index. */
function rotationShifts(l: LayerSpec, timeZone: string, from: number, to: number, active: (userId: string) => boolean): Segment[] {
  const users = l.userIds;
  if (!users.length) return [];
  const r = rotation(l, timeZone);
  const out: Segment[] = [];
  let k = Math.max(0, r.index(from));
  let start = r.at(k);
  for (let guard = 0; start < to && guard < 200_000; guard++, k++) {
    const end = r.at(k + 1);
    if (end > start && end > from) {
      let userId: string | null = null;
      for (let j = 0; j < users.length; j++) {
        const candidate = users[(k + j) % users.length];
        if (active(candidate)) { userId = candidate; break; }
      }
      if (userId) out.push({ start: Math.max(start, from), end: Math.min(end, to), userId, key: `${l.id}#${k}` });
    }
    start = Math.max(start, end);
  }
  return out;
}

/** The instants inside [from, to) covered by a layer's restriction windows, merged and sorted. */
function windows(restrictions: Restriction[], timeZone: string, from: number, to: number): [number, number][] {
  const first = Math.floor(wallOf(from, timeZone) / DAY) * DAY - 2 * DAY;
  const last = Math.floor(wallOf(to, timeZone) / DAY) * DAY + DAY;
  const raw: [number, number][] = [];
  for (let day = first; day <= last; day += DAY) {
    const weekday = new Date(day).getUTCDay();
    for (const r of restrictions) {
      if (!r.days.includes(weekday)) continue;
      const s = parseTime(r.start)!;
      const e = parseTime(r.end)!;
      const start = instantOf(day + s * MIN, timeZone);
      const end = instantOf(day + (e > s ? e : e + 24 * 60) * MIN, timeZone);
      if (end > start && end > from && start < to) raw.push([Math.max(start, from), Math.min(end, to)]);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of raw) {
    const prev = merged[merged.length - 1];
    if (prev && w[0] <= prev[1]) prev[1] = Math.max(prev[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  return merged;
}

function layerSegments(l: LayerSpec, timeZone: string, from: number, to: number, active: (userId: string) => boolean): Segment[] {
  const shifts = rotationShifts(l, timeZone, from, to, active);
  if (!l.restrictions?.length) return shifts;
  const open = windows(l.restrictions, timeZone, from, to);
  const out: Segment[] = [];
  let w = 0;
  for (const s of shifts) {
    while (w < open.length && open[w][1] <= s.start) w++;
    for (let i = w; i < open.length && open[i][0] < s.end; i++) {
      const start = Math.max(s.start, open[i][0]);
      const end = Math.min(s.end, open[i][1]);
      if (end > start) out.push({ ...s, start, end });
    }
  }
  return out;
}

// ── combining ───────────────────────────────────────────────────────────────────────────────────────────────────

type ActiveOverride = { id: string; userId: string; s: number; e: number; created: number };
/** Precedence among overrides: the latest created first; ties go to the larger id, so input order never matters. */
const beats = (a: ActiveOverride, b: ActiveOverride) => a.created > b.created || (a.created === b.created && a.id > b.id);

/** A binary max-heap of overrides by precedence (used with lazy removal of expired entries). */
class OverrideHeap {
  private items: ActiveOverride[] = [];
  push(x: ActiveOverride) {
    const a = this.items;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!beats(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  top(): ActiveOverride | undefined { return this.items[0]; }
  pop() {
    const a = this.items;
    const last = a.pop();
    if (!a.length || !last) return;
    a[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && beats(a[l], a[m])) m = l;
      if (r < a.length && beats(a[r], a[m])) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  }
}

/**
 * Who is on call from `from` until `to` (exclusive): consecutive shifts, clipped to the range, with gaps where nobody
 * is. A shift ends at every rotation handoff and wherever an override or a higher layer takes over.
 *
 * One sweep over the sorted boundaries: layers advance a cursor each, overrides enter a precedence heap when they start
 * and leave it (lazily) when they end, so the cost is O((L + O) log(L + O)) for L layer segments and O overrides.
 */
export function shiftsBetween(schedule: ScheduleSpec, fromDate: Date, toDate: Date): Shift[] {
  const from = fromDate.getTime();
  const to = toDate.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError("Invalid range");
  if (to <= from) return [];
  if (to - from > MAX_RANGE_MS) throw new RangeError("Range too long");
  if (!isValidTimeZone(schedule.timeZone)) throw new RangeError("Unknown time zone");
  const members = schedule.memberIds == null ? null : new Set(schedule.memberIds);
  const active = (userId: string) => !members || members.has(userId);

  const layers = schedule.layers.filter((l) => layerProblem(l) === null).map((l) => ({ id: l.id, segments: layerSegments(l, schedule.timeZone, from, to, active) }));
  const overrides: ActiveOverride[] = (schedule.overrides ?? [])
    .filter((o) => active(o.userId) && o.endsAt.getTime() > from && o.startsAt.getTime() < to && o.endsAt > o.startsAt)
    .map((o) => ({ id: o.id, userId: o.userId, s: Math.max(o.startsAt.getTime(), from), e: Math.min(o.endsAt.getTime(), to), created: o.createdAt.getTime() }))
    .sort((a, b) => a.s - b.s);

  const points: number[] = [from, to];
  for (const l of layers) for (const s of l.segments) points.push(s.start, s.end);
  for (const o of overrides) points.push(o.s, o.e);
  points.sort((a, b) => a - b);

  const cursor = layers.map(() => 0);
  const heap = new OverrideHeap();
  let nextOverride = 0;
  const out: (Shift & { key: string })[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    while (nextOverride < overrides.length && overrides[nextOverride].s <= a) heap.push(overrides[nextOverride++]);
    // an override that already ended is dropped when it surfaces; every boundary is a point, so the top one covers [a, b)
    while (heap.top() && heap.top()!.e <= a) heap.pop();
    let pick: { userId: string; key: string; source: Shift["source"]; layerId: string | null; overrideId: string | null } | null = null;
    const best = heap.top();
    if (best) pick = { userId: best.userId, key: `override:${best.id}`, source: "override", layerId: null, overrideId: best.id };
    for (let li = layers.length - 1; li >= 0; li--) {
      const segs = layers[li].segments;
      while (cursor[li] < segs.length && segs[cursor[li]].end <= a) cursor[li]++;
      if (pick) continue;
      const s = segs[cursor[li]];
      if (s && s.start <= a && s.end >= b) pick = { userId: s.userId, key: s.key, source: "layer", layerId: layers[li].id, overrideId: null };
    }
    if (!pick) continue;
    const prev = out[out.length - 1];
    if (prev && prev.key === pick.key && prev.end.getTime() === a) prev.end = new Date(b);
    else out.push({ userId: pick.userId, start: new Date(a), end: new Date(b), source: pick.source, layerId: pick.layerId, overrideId: pick.overrideId, key: pick.key });
  }
  return out.map(({ key: _key, ...s }) => s);
}

/** How far around `at` whoIsOnCall looks, at most, to report the start and end of the current shift. */
export const ON_CALL_HORIZON_MS = 14 * DAY;

/** The person on call at exactly `at` (no shift bounds): the cheapest question, used when paging. */
export function onCallAt(schedule: ScheduleSpec, at: Date): string | null {
  return shiftsBetween(schedule, at, new Date(at.getTime() + 1))[0]?.userId ?? null;
}

/**
 * The shift on call at `at`, or null when nobody is. It looks a day either side first and widens only while the shift
 * reaches the edge of the window, so short rotations stay cheap; start and end are the real handoffs when they are
 * within ON_CALL_HORIZON_MS of `at`, otherwise clipped to that horizon.
 */
export function whoIsOnCall(schedule: ScheduleSpec, at: Date): Shift | null {
  const t = at.getTime();
  for (let span = DAY; ; span = Math.min(span * 2, ON_CALL_HORIZON_MS)) {
    const shift = shiftsBetween(schedule, new Date(t - span), new Date(t + span)).find((s) => s.start.getTime() <= t && s.end.getTime() > t) ?? null;
    if (!shift || span >= ON_CALL_HORIZON_MS || (shift.start.getTime() > t - span && shift.end.getTime() < t + span)) return shift;
  }
}
