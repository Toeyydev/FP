"use client";
import { useEffect, useState } from "react";
import { SLOTS } from "@/lib/slots";
import { MOVE_REASONS, guestMoveMessage, type MoveReason } from "@/lib/departure-move";

// รวมรอบ from the Bookings inbox: guests nobody guides yet join a job that already runs —
// any tour, with a warning when it is not theirs (owner decision 2026-10-26). The same
// route and rules as Move guests on a job sheet (api/departures/move, with no guideId);
// the departure left empty stops being offered to guides.
type Item = { id: string; label: string; name: string; pax: number | null };
type Departure = { guideId: string; guideName: string; tourId: string; tourName: string; pax: number };

const dLong = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function JoinDepartureDialog({ date, slotIdx, tourId, tourName, items, onClose, onJoined }: {
  date: string; slotIdx: number; tourId: string | null; tourName: string; items: Item[]; onClose: () => void; onJoined: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const [toDate, setToDate] = useState(date);
  const [toSlot, setToSlot] = useState(slotIdx);
  const [reason, setReason] = useState<MoveReason>("other");
  const [reasonText, setReasonText] = useState("รวมรอบ");
  const [running, setRunning] = useState<Departure[] | null>(null);
  const [joinGuide, setJoinGuide] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<null | { joined: Departure; offersClosed: number }>(null);
  const pax = items.filter((i) => picked.has(i.id)).reduce((s, i) => s + (i.pax ?? 0), 0);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  useEffect(() => {
    let live = true;
    setRunning(null); setJoinGuide(null);
    fetch(`/api/departures/move?date=${toDate}&slotIdx=${toSlot}`).then((r) => (r.ok ? r.json() : { departures: [] }))
      .then((d) => { if (live) setRunning(d.departures as Departure[]); })
      .catch(() => { if (live) setRunning([]); });
    return () => { live = false; };
  }, [toDate, toSlot]);
  const joining = running?.find((x) => x.guideId === joinGuide) ?? null;
  const otherTour = !!joining && joining.tourId !== tourId;

  async function submit() {
    if (!joining) return;
    if (otherTour && !confirm(`Join a different tour?\n\n${tourName}\n→ ${joining.tourName} (${joining.guideName})\n\nThe guests take that tour and its guide fee.`)) return;
    setBusy(true); setProblems([]);
    try {
      const r = await fetch("/api/departures/move", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ guideId: null, date, slotIdx, bookingIds: [...picked], to: { date: toDate, slotIdx: toSlot }, reason, reasonText: reasonText.trim() || null, keepGuide: false, join: { guideId: joining.guideId } }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setProblems(Array.isArray(d.reasons) ? d.reasons : [`Not moved (${r.status}) — reload and try again`]); return; }
      setDone({ joined: joining, offersClosed: Number(d.offersClosed) || 0 });
    } catch { setProblems(["The connection dropped — reload to see what moved"]); }
    finally { setBusy(false); }
  }

  const finish = () => { onJoined(); onClose(); };
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) (done ? finish() : onClose()); }}>
      <div className="modal js-join-departure" role="dialog" aria-modal="true" aria-labelledby="join-h" style={{ width: "min(520px, 100%)" }}>
        <h3 id="join-h">รวมรอบ · Join another guide's tour</h3>
        <div className="mctx">{tourName} · {dLong(date)} {SLOTS[slotIdx]?.start} · no guide yet</div>
        {done ? (
          <div className="mbody js-join-done">
            <div>✓ {picked.size} booking{picked.size === 1 ? "" : "s"} joined <b>{done.joined.guideName}'s {done.joined.tourName}</b> · {dLong(toDate)} {SLOTS[toSlot]?.start}.</div>
            {done.offersClosed > 0 && <div>The open offer for {SLOTS[slotIdx]?.start} was closed — it has no guests left.</div>}
            <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Tell the guests — nothing is sent for you. A message to copy:</div>
            {items.filter((i) => picked.has(i.id)).map((i) => (
              <div key={i.id} style={{ display: "grid", gap: 4 }}>
                <span><b>{i.name || "—"}</b> <span className="muted">· {i.label}</span></span>
                <textarea readOnly rows={2} style={{ fontSize: 12.5 }} value={guestMoveMessage({ name: i.name, tourName: done.joined.tourName, to: { date: toDate, slotIdx: toSlot } })} onFocus={(e) => e.target.select()} />
              </div>
            ))}
            <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(done.joined.guideId)}&date=${toDate}&slotIdx=${toSlot}`}>Open {done.joined.guideName}'s job sheet →</a>
          </div>
        ) : (
          <div className="mbody">
            <div>
              <label className="fl">Guests · {picked.size} booking{picked.size === 1 ? "" : "s"} · {pax} pax</label>
              {items.map((i) => (
                <label key={i.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, margin: "4px 0" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                  <span>{i.name || "—"} <span className="muted">· {i.label}{i.pax != null ? ` · ${i.pax} pax` : ""}</span></span>
                </label>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 150px" }}><label className="fl" htmlFor="join-date">Date</label><input id="join-date" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></div>
              <div style={{ flex: "1 1 110px" }}><label className="fl" htmlFor="join-slot">Time</label>
                <select id="join-slot" value={toSlot} onChange={(e) => setToSlot(Number(e.target.value))}>{SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}</select></div>
            </div>
            <div>
              <label className="fl">Join</label>
              {running === null ? <div className="muted">Loading…</div>
                : running.length === 0 ? <div className="muted js-join-none">No guide runs a tour at this time — pick another time.</div>
                : running.map((x) => (
                  <label key={x.guideId} className="js-join-option" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                    <input type="radio" style={{ width: "auto" }} name="join-guide" checked={joinGuide === x.guideId} onChange={() => setJoinGuide(x.guideId)} />
                    <span>{x.guideName}'s <b>{x.tourName}</b> <span className="muted">· {x.pax} pax → {x.pax + pax}</span></span>
                  </label>
                ))}
              {otherTour && <div className="js-join-other-tour" style={{ color: "var(--warn, #9a6700)", fontSize: 13, marginTop: 4 }}>⚠ A different tour: the guests take {joining!.tourName} and its guide fee.</div>}
            </div>
            <div>
              <label className="fl" htmlFor="join-reason">Reason · เหตุผล</label>
              <select id="join-reason" value={reason} onChange={(e) => setReason(e.target.value as MoveReason)}>
                {(Object.keys(MOVE_REASONS) as MoveReason[]).map((k) => <option key={k} value={k}>{MOVE_REASONS[k]}</option>)}
              </select>
              {reason === "other" && <input style={{ marginTop: 6 }} aria-label="Write the reason" placeholder="เขียนเหตุผล" value={reasonText} onChange={(e) => setReasonText(e.target.value)} maxLength={300} />}
            </div>
            {problems.length > 0 && <div className="js-join-problems" role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{problems.map((p) => <div key={p}>• {p}</div>)}</div>}
          </div>
        )}
        <div className="mfoot">
          {done ? <button className="btn primary" onClick={finish}>Done</button> : (<>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary js-join-submit" onClick={submit} disabled={busy || !picked.size || !joining || (reason === "other" && reasonText.trim().length < 3)}>
              {busy ? "Moving…" : joining ? `Join ${joining.guideName} · ${SLOTS[toSlot]?.start ?? ""}` : "Choose a tour to join"}
            </button>
          </>)}
        </div>
      </div>
    </div>
  );
}
