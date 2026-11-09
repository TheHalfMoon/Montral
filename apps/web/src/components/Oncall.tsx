import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Channel, type EscalationPolicy, type OncallLayer, type OncallMember, type OncallOverride, type OncallSchedule, type OncallShift, type PolicyStep } from "../lib/api";
import { t } from "../lib/i18n";
import { useBusy } from "../lib/use-busy";

const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Background tints for the timeline bar (decorative: every shift is also listed as text). */
const TINTS = ["#0b7a43", "#2563eb", "#9333ea", "#c2410c", "#0e7490", "#be185d", "#4d7c0f", "#6d28d9"];

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const zones = (() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { return []; } })();
const today = () => new Date().toISOString().slice(0, 10);
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const lang = () => (typeof document !== "undefined" && document.documentElement.lang === "zh-CN" ? "zh-CN" : "en");
/** A date and time in the schedule's zone ("Mon 5 Jan, 09:00"). */
const inZone = (iso: string, timeZone: string) => {
  try { return new Date(iso).toLocaleString(lang(), { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { return new Date(iso).toISOString(); }
};
const conflictText = () => t("Someone else changed this while you were editing. Reload to see their change, then apply yours again.");
const message = (e: unknown) => (e instanceof ApiError && e.status === 409 && e.code === "version_conflict" ? conflictText() : (e as Error).message);

const newLayer = (userId?: string): OncallLayer => ({ name: t("Primary rotation"), userIds: userId ? [userId] : [], rotationType: "weekly", shiftLengthHours: null, handoffTime: "09:00", handoffWeekday: 1, startDate: today(), restrictions: [] });

/** The "On-call" page: who is on call now, schedules and their layers, the next two weeks, overrides, escalation policies and the personal calendar feed. */
export default function Oncall() {
  const [schedules, setSchedules] = useState<OncallSchedule[] | null>(null);
  const [members, setMembers] = useState<OncallMember[]>([]);
  const [me, setMe] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [err, setErr] = useState("");
  const load = async () => {
    const list = await api.oncallSchedules();
    setSchedules(list);
    setSelected((cur) => (cur && (cur === "new" || list.some((s) => s.id === cur)) ? cur : list[0]?.id ?? ""));
  };
  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
    api.oncallMembers().then(setMembers).catch(() => {});
    api.me().then((m) => setMe(m.userId)).catch(() => {});
  }, []);
  const manager = ["owner", "admin"].includes(members.find((m) => m.userId === me)?.role ?? "");
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name || members.find((m) => m.userId === id)?.email || t("Former member");
  const current = schedules?.find((s) => s.id === selected) ?? null;

  return (
    <>
      <div className="ph">
        <div><h1>{t("On-call")}</h1><p className="muted">{t("Schedules decide who is on call; escalation policies decide who is paged, and when, while nobody acknowledges an incident.")}</p></div>
        {manager && <button className="btn primary" onClick={() => setSelected("new")}>{t("+ New schedule")}</button>}
      </div>
      {err && <p className="err" role="alert">{err}</p>}

      <section aria-labelledby="oc-now" style={{ marginBottom: 24 }}>
        <h2 id="oc-now" style={{ fontSize: 18, margin: "0 0 10px" }}>{t("On call now")}</h2>
        <div className="card tbl">
          <div className="tr th" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1.2fr) minmax(0,1fr) 90px" }}><span>{t("Schedule")}</span><span>{t("On call")}</span><span>{t("Until")}</span><span /></div>
          {schedules?.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="muted">{manager ? t("No schedules yet. Create one to start a rotation.") : t("No schedules yet. Ask a workspace owner or admin to create one.")}</span></div>}
          {schedules?.map((s) => (
            <div className="tr" key={s.id} style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1.2fr) minmax(0,1fr) 90px" }}>
              <div><b style={{ fontWeight: 600 }}>{s.name}</b><small>{s.timeZone}</small></div>
              <span>{s.onCallNow ? <>{s.onCallNow.name ?? nameOf(s.onCallNow.userId)}{s.onCallNow.source === "override" && <span className="pill" style={{ marginLeft: 6 }}>{t("override")}</span>}</> : <span className="muted">{t("Nobody")}</span>}</span>
              <span className="muted">{s.onCallNow ? inZone(s.onCallNow.end, s.timeZone) : "—"}</span>
              <span><button className="btn sm" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>{t("Open")}<span className="sr-only"> {s.name}</span></button></span>
            </div>
          ))}
        </div>
      </section>

      {selected === "new" && manager && (
        <ScheduleEditor key="new" members={members} me={me} onSaved={async (s) => { await load(); setSelected(s.id); }} onCancel={() => setSelected(schedules?.[0]?.id ?? "")} />
      )}
      {current && (
        <>
          {manager
            ? <ScheduleEditor key={`${current.id}#${current.version}`} schedule={current} members={members} me={me} onSaved={async () => { await load(); }} onDeleted={async () => { setSelected(""); await load(); }} onReload={load} />
            : <ScheduleSummary schedule={current} nameOf={nameOf} />}
          <Timeline key={`t${current.id}#${current.version}`} schedule={current} nameOf={nameOf} />
          <Overrides key={`o${current.id}`} schedule={current} members={members} me={me} manager={manager} nameOf={nameOf} onChanged={load} />
        </>
      )}

      <Policies members={members} schedules={schedules ?? []} manager={manager} nameOf={nameOf} />
      <CalendarFeed />
    </>
  );
}

function ScheduleSummary({ schedule, nameOf }: { schedule: OncallSchedule; nameOf: (id: string) => string }) {
  return (
    <section className="card" aria-labelledby="oc-sched" style={{ padding: 24, marginBottom: 24 }}>
      <h2 id="oc-sched" style={{ fontSize: 18, margin: "0 0 4px" }}>{schedule.name}</h2>
      <p className="muted" style={{ margin: "0 0 12px" }}>{t("Time zone")}: {schedule.timeZone}</p>
      {schedule.layers.map((l, i) => (
        <p key={l.id ?? i} style={{ margin: "0 0 6px" }}><b style={{ fontWeight: 600 }}>{l.name}</b>: {l.userIds.map(nameOf).join(" → ")} · {rotationText(l)}</p>
      ))}
      <p className="faint" style={{ margin: 0 }}>{t("Only workspace owners and admins can change schedules. You can add an override for yourself below.")}</p>
    </section>
  );
}

const rotationText = (l: OncallLayer) =>
  l.rotationType === "daily" ? t("Daily handoff at {time}").replace("{time}", l.handoffTime)
    : l.rotationType === "weekly" ? t("Weekly handoff on {day} at {time}").replace("{day}", t(WEEKDAYS[l.handoffWeekday ?? 1])).replace("{time}", l.handoffTime)
      : t("Every {n} hours from {time}").replace("{n}", String(l.shiftLengthHours ?? 12)).replace("{time}", l.handoffTime);

function ScheduleEditor({ schedule, members, me, onSaved, onCancel, onDeleted, onReload }: {
  schedule?: OncallSchedule; members: OncallMember[]; me: string;
  onSaved: (s: OncallSchedule) => Promise<void>; onCancel?: () => void; onDeleted?: () => Promise<void>; onReload?: () => Promise<void>;
}) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? browserZone());
  const [layers, setLayers] = useState<OncallLayer[]>(schedule?.layers.map((l) => ({ ...l, restrictions: l.restrictions.map((r) => ({ ...r, days: [...r.days] })) })) ?? [newLayer(me)]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, run] = useBusy();
  const id = schedule?.id ?? "new";
  const setLayer = (i: number, p: Partial<OncallLayer>) => setLayers((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const move = <T,>(xs: T[], i: number, d: number) => { const ys = [...xs]; const [x] = ys.splice(i, 1); ys.splice(i + d, 0, x); return ys; };

  const save = (e: React.SyntheticEvent) => {
    e.preventDefault();
    setErr(""); setNote("");
    return run(async () => {
      try {
        const body = { name, timeZone, layers: layers.map((l) => ({ ...l, shiftLengthHours: l.rotationType === "custom" ? l.shiftLengthHours ?? 12 : null, handoffWeekday: l.rotationType === "weekly" ? l.handoffWeekday ?? 1 : null })) };
        const saved = schedule ? await api.updateOncallSchedule(schedule.id, { version: schedule.version, ...body }) : await api.createOncallSchedule(body);
        setNote(t("Saved"));
        await onSaved(saved);
      } catch (x) { setErr(message(x)); }
    });
  };
  const remove = () => run(async () => {
    if (!schedule || !confirm(t("Delete this schedule? Escalation steps can no longer page whoever is on call on it."))) return;
    try { await api.deleteOncallSchedule(schedule.id, schedule.version); await onDeleted?.(); } catch (x) { setErr(message(x)); }
  });

  return (
    <form className="card" aria-labelledby={`oc-edit-${id}`} style={{ padding: 24, display: "grid", gap: 14, marginBottom: 24 }} onSubmit={save}>
      <h2 id={`oc-edit-${id}`} style={{ fontSize: 18, margin: 0 }}>{schedule ? t("Edit schedule") : t("New schedule")}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
        <label className="fld">{t("Name")}<input className="in" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Platform on-call")} /></label>
        <label className="fld">{t("Time zone")}<input className="in" required list={`oc-zones-${id}`} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Europe/London" />
          <datalist id={`oc-zones-${id}`}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t("Handoffs follow the local clock in this zone, also across daylight saving changes. A later layer covers the ones above it wherever it has someone on call.")}</p>
      {layers.map((l, i) => (
        <fieldset key={i} className="card" style={{ padding: 16, display: "grid", gap: 10, border: "1px solid var(--line)" }}>
          <legend style={{ fontWeight: 600, padding: "0 6px" }}>{t("Layer {n}").replace("{n}", String(i + 1))}</legend>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
            <label className="fld">{t("Layer name")}<input className="in" required maxLength={80} value={l.name} onChange={(e) => setLayer(i, { name: e.target.value })} /></label>
            <label className="fld">{t("Rotation")}<select className="in" value={l.rotationType} onChange={(e) => setLayer(i, { rotationType: e.target.value as OncallLayer["rotationType"] })}>
              <option value="daily">{t("Daily")}</option><option value="weekly">{t("Weekly")}</option><option value="custom">{t("Custom length")}</option>
            </select></label>
            <label className="fld">{t("Starts on")}<input className="in" type="date" required value={l.startDate} onChange={(e) => setLayer(i, { startDate: e.target.value })} /></label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
            <label className="fld">{t("Handoff time")}<input className="in" type="time" required value={l.handoffTime} onChange={(e) => setLayer(i, { handoffTime: e.target.value })} /></label>
            {l.rotationType === "weekly" && <label className="fld">{t("Handoff day")}<select className="in" value={l.handoffWeekday ?? 1} onChange={(e) => setLayer(i, { handoffWeekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, n) => <option key={d} value={n}>{t(d)}</option>)}
            </select></label>}
            {l.rotationType === "custom" && <label className="fld">{t("Shift length (hours)")}<input className="in" type="number" min={1} max={2016} required value={l.shiftLengthHours ?? 12} onChange={(e) => setLayer(i, { shiftLengthHours: Number(e.target.value) })} /></label>}
          </div>
          <div className="fld"><span id={`oc-people-${id}-${i}`}>{t("People, in rotation order")}</span>
            <ol aria-labelledby={`oc-people-${id}-${i}`} style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 4 }}>
              {l.userIds.map((u, k) => {
                const who = members.find((m) => m.userId === u)?.name || members.find((m) => m.userId === u)?.email || t("Former member");
                return (
                  <li key={u}><span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{who}
                    <button type="button" className="btn sm" disabled={k === 0} aria-label={t("Move {name} up").replace("{name}", who)} onClick={() => setLayer(i, { userIds: move(l.userIds, k, -1) })}>↑</button>
                    <button type="button" className="btn sm" disabled={k === l.userIds.length - 1} aria-label={t("Move {name} down").replace("{name}", who)} onClick={() => setLayer(i, { userIds: move(l.userIds, k, 1) })}>↓</button>
                    <button type="button" className="btn sm" aria-label={t("Remove {name} from the rotation").replace("{name}", who)} onClick={() => setLayer(i, { userIds: l.userIds.filter((x) => x !== u) })}>{t("Remove")}</button>
                  </span></li>
                );
              })}
            </ol>
            <label className="sr-only" htmlFor={`oc-add-${id}-${i}`}>{t("Add a person to the rotation")}</label>
            <select id={`oc-add-${id}-${i}`} className="in" value="" onChange={(e) => e.target.value && setLayer(i, { userIds: [...l.userIds, e.target.value] })}>
              <option value="">{t("+ Add a person…")}</option>
              {members.filter((m) => !l.userIds.includes(m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
            </select>
          </div>
          <div className="fld"><span>{t("Active only during")} <span className="faint">({t("none = always")})</span></span>
            {l.restrictions.map((r, k) => (
              <fieldset key={k} style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <legend className="sr-only">{t("Window {n}").replace("{n}", String(k + 1))}</legend>
                {SHORT_DAYS.map((d, n) => (
                  <label key={d} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 14 }}>
                    <input type="checkbox" checked={r.days.includes(n)} onChange={(e) => setLayer(i, { restrictions: l.restrictions.map((x, j) => (j === k ? { ...x, days: e.target.checked ? [...x.days, n].sort() : x.days.filter((y) => y !== n) } : x)) })} />{t(d)}
                  </label>
                ))}
                <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{t("from")}<input className="in" type="time" style={{ width: 120 }} value={r.start} onChange={(e) => setLayer(i, { restrictions: l.restrictions.map((x, j) => (j === k ? { ...x, start: e.target.value } : x)) })} /></label>
                <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{t("to")}<input className="in" type="time" style={{ width: 120 }} value={r.end} onChange={(e) => setLayer(i, { restrictions: l.restrictions.map((x, j) => (j === k ? { ...x, end: e.target.value } : x)) })} /></label>
                <button type="button" className="btn sm" onClick={() => setLayer(i, { restrictions: l.restrictions.filter((_, j) => j !== k) })}>{t("Remove window")}</button>
              </fieldset>
            ))}
            {l.restrictions.length < 7 && <div><button type="button" className="btn sm" onClick={() => setLayer(i, { restrictions: [...l.restrictions, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] })}>{t("+ Add a time window")}</button></div>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn sm" disabled={i === 0} onClick={() => setLayers(move(layers, i, -1))}>{t("Move layer up")}</button>
            <button type="button" className="btn sm" disabled={i === layers.length - 1} onClick={() => setLayers(move(layers, i, 1))}>{t("Move layer down")}</button>
            <button type="button" className="btn sm" onClick={() => setLayers(layers.filter((_, j) => j !== i))}>{t("Remove layer")}</button>
          </div>
        </fieldset>
      ))}
      {layers.length < 10 && <div><button type="button" className="btn sm" onClick={() => setLayers([...layers, newLayer()])}>{t("+ Add layer")}</button></div>}
      <div aria-live="polite">{err && <p className="err">{err}{err === conflictText() && onReload && <> <button type="button" className="btn sm" onClick={() => onReload()}>{t("Reload")}</button></>}</p>}{note && <p className="ok-note">{note}</p>}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" disabled={busy}>{busy ? t("Saving…") : schedule ? t("Save schedule") : t("Create schedule")}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>}
        {schedule && <button type="button" className="btn" disabled={busy} onClick={remove}>{t("Delete schedule")}</button>}
      </div>
    </form>
  );
}

/** The next two weeks: a bar for orientation (decorative) and the same shifts as a table. */
function Timeline({ schedule, nameOf }: { schedule: OncallSchedule; nameOf: (id: string) => string }) {
  const [shifts, setShifts] = useState<OncallShift[] | null>(null);
  const [err, setErr] = useState("");
  const range = useMemo(() => { const from = new Date(); from.setMinutes(0, 0, 0); return { from, to: new Date(from.getTime() + 14 * DAY) }; }, []);
  useEffect(() => { api.oncallShifts(schedule.id, range.from.toISOString(), range.to.toISOString()).then((r) => setShifts(r.shifts)).catch((e) => setErr((e as Error).message)); }, [schedule.id]);
  const people = [...new Set((shifts ?? []).map((s) => s.userId))];
  const span = range.to.getTime() - range.from.getTime();
  return (
    <section className="card" aria-labelledby="oc-next" style={{ padding: 24, marginBottom: 24 }}>
      <h2 id="oc-next" style={{ fontSize: 18, margin: "0 0 4px" }}>{t("Next two weeks")}</h2>
      <p className="muted" style={{ margin: "0 0 12px" }}>{t("Times in {zone}.").replace("{zone}", schedule.timeZone)}</p>
      {err && <p className="err">{err}</p>}
      {shifts && shifts.length > 0 && (
        <div aria-hidden="true" style={{ position: "relative", height: 22, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden", marginBottom: 6 }}>
          {shifts.map((s) => {
            const left = ((new Date(s.start).getTime() - range.from.getTime()) / span) * 100;
            const width = ((new Date(s.end).getTime() - new Date(s.start).getTime()) / span) * 100;
            return <span key={`${s.userId}${s.start}`} title={`${s.name ?? nameOf(s.userId)}: ${inZone(s.start, schedule.timeZone)} – ${inZone(s.end, schedule.timeZone)}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: `${width}%`, background: TINTS[people.indexOf(s.userId) % TINTS.length], borderRight: "1px solid var(--surface)" }} />;
          })}
          {Array.from({ length: 13 }, (_, d) => <span key={d} style={{ position: "absolute", top: 0, bottom: 0, left: `${((d + 1) / 14) * 100}%`, width: 1, background: "var(--line-2)" }} />)}
        </div>
      )}
      {shifts && people.length > 0 && (
        <p className="faint" aria-hidden="true" style={{ margin: "0 0 10px", display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
          {people.map((p, i) => <span key={p} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><span style={{ width: 10, height: 10, borderRadius: 3, background: TINTS[i % TINTS.length] }} />{nameOf(p)}</span>)}
        </p>
      )}
      {shifts?.length === 0 && <p className="muted">{t("Nobody is on call in the next two weeks.")}</p>}
      {shifts && shifts.length > 0 && (
        // scrolls sideways on phones: focusable and named so keyboard users can scroll it too (WCAG 2.1.1)
        <div className="audit-wrap" tabIndex={0} role="region" aria-label={t("Shifts of {name} in the next two weeks").replace("{name}", schedule.name)}>
        <table className="audit-tbl">
          <caption className="sr-only">{t("Shifts of {name} in the next two weeks").replace("{name}", schedule.name)}</caption>
          <thead><tr><th scope="col" style={{ textAlign: "left" }}>{t("On call")}</th><th scope="col" style={{ textAlign: "left" }}>{t("Starts")}</th><th scope="col" style={{ textAlign: "left" }}>{t("Until")}</th><th scope="col" style={{ textAlign: "left" }}>{t("Source")}</th></tr></thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={`${s.userId}${s.start}`}>
                <td>{s.name ?? nameOf(s.userId)}</td><td>{inZone(s.start, schedule.timeZone)}</td><td>{inZone(s.end, schedule.timeZone)}</td>
                <td>{s.source === "override" ? t("Override") : (schedule.layers.find((l) => l.id === s.layerId)?.name ?? t("Rotation"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

function Overrides({ schedule, members, me, manager, nameOf, onChanged }: { schedule: OncallSchedule; members: OncallMember[]; me: string; manager: boolean; nameOf: (id: string) => string; onChanged: () => Promise<void> }) {
  const [items, setItems] = useState<OncallOverride[] | null>(null);
  const [f, setF] = useState({ userId: me, startsAt: local(new Date()), endsAt: local(new Date(Date.now() + 8 * 3600_000)) });
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const load = () => api.oncallOverrides(schedule.id, new Date().toISOString(), new Date(Date.now() + 90 * DAY).toISOString()).then(setItems).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, [schedule.id]);
  useEffect(() => { if (!f.userId && me) setF((x) => ({ ...x, userId: me })); }, [me]);
  const add = (e: React.SyntheticEvent) => {
    e.preventDefault();
    setErr("");
    return run(async () => {
      try {
        await api.createOncallOverride(schedule.id, { userId: manager ? f.userId : me, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString() });
        await load(); await onChanged();
      } catch (x) { setErr(message(x)); }
    });
  };
  return (
    <section className="card" aria-labelledby="oc-ovr" style={{ padding: 24, marginBottom: 24, display: "grid", gap: 12 }}>
      <h2 id="oc-ovr" style={{ fontSize: 18, margin: 0 }}>{t("Overrides")}</h2>
      <p className="muted" style={{ margin: 0 }}>{t("An override puts someone on call for a while, above every layer (a swap, covering a holiday). Where overrides overlap, the latest one counts. Members can add overrides for themselves.")}</p>
      {items?.length === 0 && <p className="muted" style={{ margin: 0 }}>{t("No upcoming overrides.")}</p>}
      {items && items.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          {items.map((o) => (
            <li key={o.id}>{nameOf(o.userId)}: {inZone(o.startsAt, schedule.timeZone)} → {inZone(o.endsAt, schedule.timeZone)}
              {(manager || (o.userId === me && o.createdBy === me)) && <> <button className="btn sm" onClick={() => run(async () => { try { await api.deleteOncallOverride(schedule.id, o.id); await load(); await onChanged(); } catch (x) { setErr(message(x)); } })}>{t("Remove")}<span className="sr-only"> {t("override of {name}").replace("{name}", nameOf(o.userId))}</span></button></>}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, alignItems: "end" }}>
        <label className="fld">{t("Person")}
          <select className="in" value={manager ? f.userId : me} disabled={!manager} onChange={(e) => setF({ ...f, userId: e.target.value })}>
            {(manager ? members : members.filter((m) => m.userId === me)).map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
          </select>
        </label>
        <label className="fld">{t("Starts")}<input className="in" type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
        <label className="fld">{t("Ends")}<input className="in" type="datetime-local" required value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
        <div><button className="btn primary" disabled={busy}>{t("Add override")}</button></div>
      </form>
      <p className="faint" style={{ margin: 0 }}>{t("Start and end use your browser time zone.")}</p>
      <div aria-live="polite">{err && <p className="err">{err}</p>}</div>
    </section>
  );
}

const blankStep = (): PolicyStep => ({ timeoutMin: 15, channelIds: [], userIds: [], scheduleIds: [] });

function Policies({ members, schedules, manager, nameOf }: { members: OncallMember[]; schedules: OncallSchedule[]; manager: boolean; nameOf: (id: string) => string }) {
  const [items, setItems] = useState<EscalationPolicy[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<(Omit<EscalationPolicy, "id" | "version" | "projectId"> & { id?: string; version?: number }) | null>(null);
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  const load = () => api.escalationPolicies().then(setItems).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); api.channels().then(setChannels).catch(() => {}); }, []);
  const setStep = (i: number, p: Partial<PolicyStep>) => editing && setEditing({ ...editing, steps: editing.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const save = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!editing) return;
    setErr("");
    return run(async () => {
      try {
        if (editing.id) await api.updateEscalationPolicy(editing.id, { version: editing.version!, name: editing.name, steps: editing.steps, repeatCount: editing.repeatCount });
        else await api.createEscalationPolicy({ name: editing.name, steps: editing.steps, repeatCount: editing.repeatCount });
        setEditing(null);
        await load();
      } catch (x) { setErr(message(x)); }
    });
  };
  const describeStep = (s: PolicyStep) => [
    ...s.scheduleIds.map((id) => t("on call for {name}").replace("{name}", schedules.find((x) => x.id === id)?.name ?? "?")),
    ...s.userIds.map(nameOf),
    ...s.channelIds.map((id) => channels.find((c) => c.id === id)?.name ?? "?"),
  ].join(", ");

  return (
    <section className="card" aria-labelledby="oc-pol" style={{ padding: 24, marginBottom: 24, display: "grid", gap: 12 }}>
      <h2 id="oc-pol" style={{ fontSize: 18, margin: 0 }}>{t("Escalation policies")}</h2>
      <p className="muted" style={{ margin: 0 }}>{t("A policy pages its first step as soon as an incident opens, then the next step whenever nobody acknowledges within the step's timeout. Acknowledging stops it; resolving stops everything. Choose a policy in a monitor's settings; monitors without one use the project's escalation levels.")}</p>
      {items?.length === 0 && <p className="muted" style={{ margin: 0 }}>{t("No escalation policies yet.")}</p>}
      {items?.map((p) => (
        <div key={p.id} className="route" style={{ alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <b style={{ fontWeight: 600 }}>{p.name}</b>
            <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
              {p.steps.map((s, i) => <li key={i}>{describeStep(s)} <span className="faint">· {t("then wait {n} min").replace("{n}", String(s.timeoutMin))}</span></li>)}
            </ol>
            {p.repeatCount > 0 && <small className="faint">{t("Repeats {n} more times after the last step").replace("{n}", String(p.repeatCount))}</small>}
          </div>
          {manager && <span style={{ display: "flex", gap: 6 }}>
            <button className="btn sm" onClick={() => setEditing({ ...p, steps: p.steps.map((s) => ({ ...s })) })}>{t("Edit")}<span className="sr-only"> {p.name}</span></button>
            <button className="btn sm" disabled={busy} onClick={() => run(async () => { if (!confirm(t("Delete this policy? Monitors using it go back to their project's escalation levels."))) return; try { await api.deleteEscalationPolicy(p.id, p.version); await load(); } catch (x) { setErr(message(x)); } })}>{t("Delete")}<span className="sr-only"> {p.name}</span></button>
          </span>}
        </div>
      ))}
      {manager && !editing && <div><button className="btn sm" onClick={() => setEditing({ name: "", steps: [blankStep()], repeatCount: 0 })}>{t("+ New policy")}</button></div>}
      {editing && (
        <form onSubmit={save} style={{ display: "grid", gap: 12 }} aria-label={editing.id ? t("Edit escalation policy") : t("New escalation policy")}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)", gap: 10 }}>
            <label className="fld">{t("Policy name")}<input className="in" required maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label className="fld">{t("After the last step")}<select className="in" value={editing.repeatCount} onChange={(e) => setEditing({ ...editing, repeatCount: Number(e.target.value) })}>
              <option value={0}>{t("Stop")}</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{t("Start over ({n} more times)").replace("{n}", String(n))}</option>)}
            </select></label>
          </div>
          {editing.steps.map((s, i) => (
            <fieldset key={i} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
              <legend style={{ fontWeight: 600, padding: "0 6px" }}>{t("Step {n}").replace("{n}", String(i + 1))}</legend>
              {schedules.length > 0 && <div role="group" aria-label={t("Notify whoever is on call on")} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="faint">{t("On call for")}:</span>
                {schedules.map((x) => <button type="button" key={x.id} className={`btn sm ${s.scheduleIds.includes(x.id) ? "primary" : ""}`} aria-pressed={s.scheduleIds.includes(x.id)} onClick={() => setStep(i, { scheduleIds: toggle(s.scheduleIds, x.id) })}>{x.name}</button>)}
              </div>}
              <div role="group" aria-label={t("Notify these people")} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="faint">{t("People")}:</span>
                {members.map((m) => <button type="button" key={m.userId} className={`btn sm ${s.userIds.includes(m.userId) ? "primary" : ""}`} aria-pressed={s.userIds.includes(m.userId)} onClick={() => setStep(i, { userIds: toggle(s.userIds, m.userId) })}>{m.name || m.email}</button>)}
              </div>
              {channels.length > 0 && <div role="group" aria-label={t("Notify these channels")} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="faint">{t("Channels")}:</span>
                {channels.map((c) => <button type="button" key={c.id} className={`btn sm ${s.channelIds.includes(c.id) ? "primary" : ""}`} aria-pressed={s.channelIds.includes(c.id)} onClick={() => setStep(i, { channelIds: toggle(s.channelIds, c.id) })}>{c.name}</button>)}
              </div>}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
                <label className="fld">{t("Minutes to acknowledge before the next step")}<input className="in" type="number" min={1} max={1440} required style={{ width: 120 }} value={s.timeoutMin} onChange={(e) => setStep(i, { timeoutMin: Number(e.target.value) })} /></label>
                {editing.steps.length > 1 && <button type="button" className="btn sm" onClick={() => setEditing({ ...editing, steps: editing.steps.filter((_, j) => j !== i) })}>{t("Remove step")}</button>}
              </div>
            </fieldset>
          ))}
          {editing.steps.length < 10 && <div><button type="button" className="btn sm" onClick={() => setEditing({ ...editing, steps: [...editing.steps, blankStep()] })}>{t("+ Add step")}</button></div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={busy}>{busy ? t("Saving…") : t("Save policy")}</button>
            <button type="button" className="btn" onClick={() => { setEditing(null); setErr(""); }}>{t("Cancel")}</button>
          </div>
        </form>
      )}
      <div aria-live="polite">{err && <p className="err">{err}</p>}</div>
    </section>
  );
}

function CalendarFeed() {
  const [state, setState] = useState<{ active: boolean; createdAt: string | null } | null>(null);
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, run] = useBusy();
  useEffect(() => { api.oncallCalendar().then(setState).catch(() => {}); }, []);
  return (
    <section className="card" aria-labelledby="oc-cal" style={{ padding: 24, marginBottom: 24, display: "grid", gap: 10 }}>
      <h2 id="oc-cal" style={{ fontSize: 18, margin: 0 }}>{t("Your shifts in your calendar")}</h2>
      <p className="muted" style={{ margin: 0 }}>{t("Subscribe to a private iCalendar link with your shifts on every schedule (past week and next 60 days). Anyone with the link can read them; replace or turn it off at any time.")}</p>
      {link && <p style={{ margin: 0 }}><label className="fld">{t("Calendar link (shown once)")}<input className="in mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} /></label></p>}
      {state?.active && !link && <p className="faint" style={{ margin: 0 }}>{t("A link is active since {date}.").replace("{date}", state.createdAt ? new Date(state.createdAt).toLocaleDateString() : "—")}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn sm" disabled={busy} onClick={() => run(async () => {
          if (state?.active && !confirm(t("Replace the link? Your current link stops working at once."))) return;
          try { const r = await api.createOncallCalendar(!!state?.active); setLink(r.url); setNote(r.replaced ? t("New link created. Your previous link has stopped working.") : ""); setState({ active: true, createdAt: r.createdAt }); } catch (x) { setErr(message(x)); }
        })}>{state?.active ? t("Replace link") : t("Create link")}</button>
        {state?.active && <button className="btn sm" disabled={busy} onClick={() => run(async () => { try { await api.revokeOncallCalendar(); setLink(""); setState({ active: false, createdAt: null }); } catch (x) { setErr(message(x)); } })}>{t("Turn off link")}</button>}
      </div>
      <div aria-live="polite">{note && <p className="ok-note">{note}</p>}{err && <p className="err">{err}</p>}</div>
    </section>
  );
}
