"use client";

import { useCallback, useEffect, useState } from "react";
import { Note } from "@/components/PeakPaymentDialog";
import { SLOTS } from "@/lib/slots";

// "Record who guided" — a day that already happened, every tour on it in one place.
//
// A guide who could not accept the offer (the LINE accept not working, an offer that
// expired) still ran the tour. Offers cannot be sent for the past, so this records the
// assignment directly (POST /api/assignments, audited as assign.recorded_past): the
// tour then counts on Payments and its job sheet can be filled in. A tour that did not
// really run can have its bookings closed instead.

type Slot = {
  slotIdx: number; time: string; pax: number;
  tours: { id: string; name: string }[];
  bookings: { id: string; ref: string; pax: number | null; source: string; status: string }[];
  staffedBy: { guideId: string; name: string }[];
  onSheets: { guideId: string; name: string; slotIdx: number; time: string; jobRef: string | null; refs: string[] }[];
  /** Bookings with no tour connected (the channel sent no product name). */
  unmappedIds: string[];
  suggestTourId: string | null;
};
type TourOption = { id: string; name: string; time: string | null };
type Guide = { guideId: string; name: string; external: boolean };
type Done = { kind: "recorded"; guideId: string; name: string } | { kind: "closed"; count: number } | { kind: "moved"; count: number; date: string; slotIdx: number };

/** The day after `d` ("YYYY-MM-DD"), the usual place a guest who could not come is moved to. */
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
const dLong = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export default function RecordPastTourDialog({ date, onClose, onChanged }: { date: string; onClose: () => void; onChanged: () => void }) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [tours, setTours] = useState<TourOption[]>([]);
  const [tourPick, setTourPick] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [pick, setPick] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<Record<number, Done>>({});
  const [failed, setFailed] = useState<Record<number, string>>({});
  // Moving a departure's bookings to another date / time: which slot's form is open, and its target.
  const [moving, setMoving] = useState<{ slotIdx: number; date: string; to: number } | null>(null);
  const changed = Object.keys(done).length > 0;

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await fetch(`/api/assignments/past?date=${date}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.hint || (d.error === "forbidden" ? "Operator only" : `Could not load ${date} (${r.status})`)); setSlots([]); return; }
      setSlots(d.slots ?? []); setGuides(d.guides ?? []); setTours(d.tours ?? []);
      setTourPick(Object.fromEntries(((d.slots ?? []) as Slot[]).filter((x) => x.unmappedIds.length).map((x) => [x.slotIdx, x.suggestTourId ?? x.tours[0]?.id ?? ""])));
    } catch { setError("Could not reach the server"); setSlots([]); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const close = useCallback(() => { if (busy !== null) return; if (changed) onChanged(); onClose(); }, [busy, changed, onChanged, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  async function record(s: Slot) {
    const guideId = pick[s.slotIdx];
    const chosenTour = tourPick[s.slotIdx];
    if (!guideId || (s.unmappedIds.length && !chosenTour)) return;
    setBusy(s.slotIdx); setFailed((f) => ({ ...f, [s.slotIdx]: "" }));
    const note = `Recorded after the tour: ${s.bookings.map((b) => b.ref).join(", ")}`.slice(0, 280);
    try {
      // Connect the tour first: the bookings that came with no product name get the
      // tour the operator chose, so the job sheet and Payments know what ran.
      for (const id of s.unmappedIds) {
        const u = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update", id, tourId: chosenTour }) });
        if (!u.ok) { setFailed((f) => ({ ...f, [s.slotIdx]: `Could not connect the tour (${u.status}) — nothing was recorded` })); setBusy(null); return; }
      }
      const tourId = s.tours[0]?.id ?? chosenTour;
      const r = await fetch("/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date, slotIdx: s.slotIdx, tourId, pax: s.pax > 0 && s.pax <= 50 ? s.pax : undefined, note, direct: true }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && (d.recorded || d.assigned)) {
        setDone((x) => ({ ...x, [s.slotIdx]: { kind: "recorded", guideId, name: guides.find((g) => g.guideId === guideId)?.name ?? guideId } }));
        // The bookings are connected now: show the tour they got, not "Tour not connected".
        if (s.unmappedIds.length) {
          const t = tours.find((x) => x.id === chosenTour);
          setSlots((all) => (all ?? []).map((x) => x.slotIdx === s.slotIdx
            ? { ...x, unmappedIds: [], tours: x.tours.length ? x.tours : [{ id: chosenTour, name: t?.name ?? chosenTour }] }
            : x));
        }
      }
      else setFailed((f) => ({ ...f, [s.slotIdx]: d.error === "operators only" ? "Operator only" : Array.isArray(d.reasons) && d.reasons.length ? d.reasons.join(" · ") : `Not recorded (${d.error ?? r.status})` }));
    } catch { setFailed((f) => ({ ...f, [s.slotIdx]: "The connection dropped — reopen this day to see whether it was recorded" })); }
    setBusy(null);
  }

  async function closeBookings(s: Slot) {
    if (!confirm(`Close the ${s.bookings.length} booking(s) of ${s.time} on ${dLong(date)}?\n\nOnly if this tour did not really run with a guide. The bookings are kept, marked Archived, and stop asking for a guide.`)) return;
    setBusy(s.slotIdx); setFailed((f) => ({ ...f, [s.slotIdx]: "" }));
    try {
      const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "closePast", ids: s.bookings.map((b) => b.id) }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setDone((x) => ({ ...x, [s.slotIdx]: { kind: "closed", count: Number(d.closed ?? 0) } }));
      else setFailed((f) => ({ ...f, [s.slotIdx]: `Not closed (${d.error ?? r.status})` }));
    } catch { setFailed((f) => ({ ...f, [s.slotIdx]: "The connection dropped — reopen this day to check" })); }
    setBusy(null);
  }

  // The guest changed to another date or time: the bookings go there (pinned, so the channel
  // sync does not drag them back) and stop asking for a guide here.
  async function moveBookings(s: Slot) {
    if (!moving || moving.slotIdx !== s.slotIdx) return;
    const { date: toDate, to } = moving;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || (toDate === date && to === s.slotIdx)) { setFailed((f) => ({ ...f, [s.slotIdx]: "Choose a different date or time to move to" })); return; }
    setBusy(s.slotIdx); setFailed((f) => ({ ...f, [s.slotIdx]: "" }));
    let ok = 0;
    try {
      for (const b of s.bookings) {
        const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update", id: b.id, date: toDate, slotIdx: to }) });
        if (!r.ok) { setFailed((f) => ({ ...f, [s.slotIdx]: `${b.ref} was not moved (${r.status})${ok ? ` — ${ok} already moved` : ""}. Reopen this day to check` })); break; }
        ok++;
      }
      if (ok === s.bookings.length) { setDone((x) => ({ ...x, [s.slotIdx]: { kind: "moved", count: ok, date: toDate, slotIdx: to } })); setMoving(null); }
    } catch { setFailed((f) => ({ ...f, [s.slotIdx]: "The connection dropped — reopen this day to check" })); }
    setBusy(null);
  }

  const open = (slots ?? []).filter((s) => !s.staffedBy.length);
  const staffed = (slots ?? []).filter((s) => s.staffedBy.length);

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recpast-h" style={{ width: "min(640px, 100%)" }}>
        <h3 id="recpast-h">Record who guided · {dLong(date)}</h3>
        <div className="mctx">Tours on this day with guests and no guide on the system. Nobody is notified.</div>
        <div className="mbody" style={{ display: "grid", gap: 12 }}>
          {slots === null && <div className="skel-row" />}
          {error && <Note tone="danger">{error}</Note>}
          {slots !== null && !error && open.length === 0 && <Note tone="ok">Every tour on this day has a guide recorded.</Note>}
          {open.map((s) => {
            const d = done[s.slotIdx];
            return (
              <section key={s.slotIdx} className="recpast-slot" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10, display: "grid", gap: 8, background: d ? "var(--grey-bg, #f6f5f3)" : "var(--surface, #fff)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <b>{s.time}</b>
                  <span style={{ flex: 1, minWidth: 0 }}>{s.tours.length ? s.tours.map((t) => t.name).join(" + ") : <i style={{ color: "var(--danger)" }}>Tour not connected</i>}</span>
                  <span className="num" style={{ color: "var(--ink-soft)", fontSize: 12.5 }}>{s.pax} pax</span>
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {s.bookings.map((b) => <span key={b.id} className="badge" style={{ fontWeight: 600 }}>{b.ref} ×{b.pax ?? "?"} · {b.source}</span>)}
                </div>
                {s.onSheets.map((o, i) => (
                  <Note key={i} tone="warn">
                    {o.refs.join(", ")} {o.refs.length === 1 ? "is" : "are"} already on <b>{o.guideId} {o.name}</b>&rsquo;s {o.time} job sheet{o.jobRef ? ` (${o.jobRef})` : ""}. The booking&rsquo;s time is probably wrong — fix the booking instead of recording a second guide.
                  </Note>
                ))}
                {!d && s.unmappedIds.length > 0 && (
                  <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
                    <span style={{ color: "var(--ink-soft)" }}>{s.unmappedIds.length === s.bookings.length ? "The channel sent no tour name — which tour was this?" : `${s.unmappedIds.length} booking(s) here have no tour connected — which tour?`}{s.suggestTourId ? " (suggested by start time)" : ""}</span>
                    <select aria-label={`Tour for ${s.time}`} className="search" value={tourPick[s.slotIdx] ?? ""} onChange={(e) => setTourPick((p) => ({ ...p, [s.slotIdx]: e.target.value }))} disabled={busy !== null}>
                      <option value="">Choose the tour…</option>
                      {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}{t.time ? ` · ${t.time}` : ""}</option>)}
                    </select>
                  </label>
                )}
                {d?.kind === "recorded" ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} aria-live="polite">
                    <span className="badge active">✓ Recorded {d.guideId} · {d.name}</span>
                    <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(d.guideId)}&date=${date}&slotIdx=${s.slotIdx}`}>Open job sheet →</a>
                  </div>
                ) : d?.kind === "closed" ? (
                  <span className="badge" aria-live="polite">Closed · {d.count} booking{d.count === 1 ? "" : "s"} archived</span>
                ) : d?.kind === "moved" ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} aria-live="polite">
                    <span className="badge active">✓ Moved {d.count} booking{d.count === 1 ? "" : "s"} to {dLong(d.date)} · {SLOTS[d.slotIdx]?.start}</span>
                    <a className="btn sm" href={`/bookings?date=${d.date}`}>Open that day →</a>
                  </div>
                ) : moving?.slotIdx === s.slotIdx ? (
                  <div className="js-move-form" style={{ display: "grid", gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Move {s.bookings.length === 1 ? "this booking" : `these ${s.bookings.length} bookings`} to another date or time · ย้ายบุ๊คกิ้งไปวัน/รอบอื่น. The move is kept even when the channel syncs again.</span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input aria-label="Move to date" name="move-date" type="date" className="search" style={{ flex: "1 1 150px", minWidth: 0 }} value={moving.date} onChange={(e) => setMoving({ ...moving, date: e.target.value })} disabled={busy !== null} />
                      <select aria-label="Move to time" name="move-slot" className="search" style={{ flex: "1 1 110px", minWidth: 0 }} value={moving.to} onChange={(e) => setMoving({ ...moving, to: Number(e.target.value) })} disabled={busy !== null}>
                        {SLOTS.map((x) => <option key={x.idx} value={x.idx}>{x.start}</option>)}
                      </select>
                      <button className="btn sm primary js-move-confirm" onClick={() => moveBookings(s)} disabled={busy !== null || !moving.date}>{busy === s.slotIdx ? "Moving…" : `Move to ${moving.date ? dLong(moving.date) : "…"} · ${SLOTS[moving.to]?.start}`}</button>
                      <button className="btn sm ghost" onClick={() => setMoving(null)} disabled={busy !== null}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <select aria-label={`Guide for ${s.time}`} className="search" style={{ flex: "1 1 200px", minWidth: 0 }} value={pick[s.slotIdx] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [s.slotIdx]: e.target.value }))} disabled={busy !== null}>
                      <option value="">Who guided this tour?</option>
                      {guides.map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.name}{g.external ? " (one-off)" : ""}</option>)}
                    </select>
                    <button className="btn sm primary" onClick={() => record(s)} disabled={!pick[s.slotIdx] || (s.unmappedIds.length > 0 && !tourPick[s.slotIdx]) || busy !== null}>{busy === s.slotIdx ? "Recording…" : "Record guide"}</button>
                    <button className="btn sm ghost" onClick={() => closeBookings(s)} disabled={busy !== null} title="The tour did not really run with a guide — archive its bookings">Didn&rsquo;t run…</button>
                    <button className="btn sm ghost js-move-open" onClick={() => setMoving({ slotIdx: s.slotIdx, date: nextDay(date), to: 0 })} disabled={busy !== null} title="The guest changed to another date or time — move the booking there">Move…</button>
                  </div>
                )}
                {failed[s.slotIdx] && <Note tone="danger">{failed[s.slotIdx]}</Note>}
              </section>
            );
          })}
          {staffed.length > 0 && (
            <div style={{ fontSize: 12.5, color: "var(--ink-soft)", display: "grid", gap: 2 }}>
              <span style={{ fontWeight: 700 }}>Also on this day</span>
              {staffed.map((s) => {
                // A guide is recorded, but some guests still wait: they reached the departure
                // late and never made it onto the job sheet. Fixed on the sheet itself.
                const waiting = s.bookings.filter((b) => b.status === "PENDING" || b.status === "OFFERED");
                return (
                  <span key={s.slotIdx}>{[s.time, s.tours.map((t) => t.name).join(" + "), s.pax > 0 ? `${s.pax} pax` : "", s.staffedBy.map((g) => `${g.guideId} ${g.name}`).join(", ")].filter(Boolean).join(" · ")}
                    {waiting.length > 0 && <> · <b style={{ color: "var(--danger, #b3402f)" }}>{waiting.length} booking{waiting.length === 1 ? "" : "s"} still waiting</b>{s.staffedBy.map((g) => <a key={g.guideId} className="btn sm js-past-waiting" style={{ marginLeft: 6 }} href={`/job-sheet?guideId=${encodeURIComponent(g.guideId)}&date=${date}&slotIdx=${s.slotIdx}`}>Open {g.guideId}&rsquo;s job sheet →</a>)}</>}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="mfoot">
          <a className="btn ghost" href={`/bookings?date=${date}`} style={{ marginRight: "auto" }}>Open in Bookings</a>
          <button className="btn" onClick={close} disabled={busy !== null}>{changed ? "Done" : "Close"}</button>
        </div>
      </div>
    </div>
  );
}
