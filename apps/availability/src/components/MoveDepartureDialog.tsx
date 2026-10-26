"use client";
import { useEffect, useState } from "react";
import { SLOTS } from "@/lib/slots";
import { MOVE_REASONS, guestMoveMessage, type MoveReason } from "@/lib/departure-move";

// Move departure (ย้ายรอบ): the chosen guests of this job go to another date or time in one
// act — see lib/departure-move and api/departures/move. The guide fee for this departure is
// not touched here: the operator sets it on the sheet (owner decision 2026-10-25).
// "Join" puts the guests on another guide's job at the new time instead — any tour, with a
// warning when it is not this one (รวมรอบ, owner decision 2026-10-26); a job left with no
// guests comes off its guide.
type Departure = { guideId: string; guideName: string; tourId: string; tourName: string; pax: number };
type Row = { name: string; bookingNo: string; bookedPax: number | null };
type Contact = { whatsapp: string; display: string };

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
const dLong = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function MoveDepartureDialog({ guideId, guideName, date, slotIdx, tourId, tourName, rows, contacts, onClose, onMoved }: {
  guideId: string; guideName: string; date: string; slotIdx: number; tourId: string; tourName: string;
  rows: Row[]; contacts: Record<string, Contact>; onClose: () => void; onMoved: () => void;
}) {
  const movable = rows.filter((r) => r.bookingNo.trim());
  const [picked, setPicked] = useState<Set<string>>(() => new Set(movable.map((r) => r.bookingNo)));
  const [toDate, setToDate] = useState(nextDay(date));
  const [toSlot, setToSlot] = useState(slotIdx);
  const [reason, setReason] = useState<MoveReason>("venue-closed");
  const [reasonText, setReasonText] = useState("");
  const [keepGuide, setKeepGuide] = useState(true);
  const [joinGuide, setJoinGuide] = useState<string | null>(null); // null = a guide of our own at the new time
  const [running, setRunning] = useState<Departure[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<null | { moved: Row[]; guideAssigned: boolean; sheetSkipped: boolean; joined: Departure | null; sourceRemoved: boolean; sourceKept: string[] }>(null);
  const pax = movable.filter((r) => picked.has(r.bookingNo)).reduce((s, r) => s + (r.bookedPax ?? 0), 0);
  // The jobs already running at the chosen time — the ones these guests could join.
  useEffect(() => {
    let live = true;
    setRunning(null); setJoinGuide(null);
    fetch(`/api/departures/move?date=${toDate}&slotIdx=${toSlot}`).then((r) => (r.ok ? r.json() : { departures: [] }))
      .then((d) => { if (live) setRunning((d.departures as Departure[]).filter((x) => !(x.guideId === guideId && toDate === date && toSlot === slotIdx))); })
      .catch(() => { if (live) setRunning([]); });
    return () => { live = false; };
  }, [toDate, toSlot, guideId, date, slotIdx]);
  const joining = running?.find((x) => x.guideId === joinGuide) ?? null;
  const otherTour = !!joining && joining.tourId !== tourId;
  const toggle = (no: string) => setPicked((p) => { const n = new Set(p); if (n.has(no)) n.delete(no); else n.add(no); return n; });

  async function submit() {
    if (otherTour && !confirm(`Join a different tour?\n\n${tourName}\n→ ${joining!.tourName} (${joining!.guideName})\n\nThe guests take that tour and its guide fee.`)) return;
    setBusy(true); setProblems([]);
    try {
      const r = await fetch("/api/departures/move", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ guideId, date, slotIdx, refs: [...picked], to: { date: toDate, slotIdx: toSlot }, reason, reasonText: reasonText.trim() || null, keepGuide, join: joining ? { guideId: joining.guideId } : null }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setProblems(Array.isArray(d.reasons) ? d.reasons : [`Not moved (${r.status}) — reload and try again`]); return; }
      setDone({ moved: movable.filter((x) => picked.has(x.bookingNo)), guideAssigned: !!d.guideAssigned, sheetSkipped: !!d.sheetSkipped,
        joined: joining, sourceRemoved: !!d.sourceRemoved, sourceKept: Array.isArray(d.sourceKept) ? d.sourceKept : [] });
    } catch { setProblems(["The connection dropped — reload to see what moved"]); }
    finally { setBusy(false); }
  }

  const to = { date: toDate, slotIdx: toSlot };
  const finish = () => { onMoved(); onClose(); };
  return (
    <div className="scrim show no-print" onClick={(e) => { if (e.target === e.currentTarget) (done ? finish() : onClose()); }}>
      <div className="modal js-move-departure" role="dialog" aria-modal="true" aria-labelledby="move-h" style={{ width: "min(520px, 100%)" }}>
        <h3 id="move-h">ย้ายรอบ · Move guests</h3>
        <div className="mctx">{tourName} · {dLong(date)} {SLOTS[slotIdx]?.start} · {guideName}</div>
        {done ? (
          <div className="mbody js-move-done">
            <div>✓ {done.moved.length} booking{done.moved.length === 1 ? "" : "s"} moved to <b>{dLong(toDate)} {SLOTS[toSlot]?.start}</b>{done.joined ? ` — joined ${done.joined.guideName}'s ${done.joined.tourName}` : keepGuide ? ` with ${guideName}` : " — waiting for a guide in Bookings"}.</div>
            {done.sourceRemoved && <div className="js-move-source-removed">{guideName}'s job here had no guests left and was removed.</div>}
            {done.sourceKept.length > 0 && <div style={{ color: "var(--danger)" }}>{guideName}'s job here has no guests left but was kept: {done.sourceKept.join("; ")}. Remove it by hand.</div>}
            {done.sheetSkipped && <div style={{ color: "var(--danger)" }}>This sheet changed meanwhile and was not updated — remove the moved guests from it by hand.</div>}
            <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Tell the guests (nothing is sent for you). Set the guide fee for this departure on the sheet.</div>
            {done.moved.map((r) => {
              const c = contacts[r.bookingNo];
              const text = encodeURIComponent(guestMoveMessage({ name: r.name, tourName: done.joined?.tourName ?? tourName, to }));
              return (
                <div key={r.bookingNo} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span><b>{r.name || "—"}</b> <span className="muted">· {r.bookingNo}</span></span>
                  {c ? <a className="btn sm js-move-whatsapp" href={`${c.whatsapp}${c.whatsapp.includes("?") ? "&" : "?"}text=${text}`} target="_blank" rel="noopener noreferrer">WhatsApp new date</a> : <span className="muted" style={{ fontSize: 12 }}>no WhatsApp number</span>}
                </div>
              );
            })}
            {(done.joined || keepGuide) && <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(done.joined?.guideId ?? guideId)}&date=${toDate}&slotIdx=${toSlot}`}>Open the new job sheet →</a>}
          </div>
        ) : (
          <div className="mbody">
            <div>
              <label className="fl">Guests · {picked.size} booking{picked.size === 1 ? "" : "s"} · {pax} pax</label>
              {movable.length ? movable.map((r) => (
                <label key={r.bookingNo} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, margin: "4px 0" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={picked.has(r.bookingNo)} onChange={() => toggle(r.bookingNo)} />
                  <span>{r.name || "—"} <span className="muted">· {r.bookingNo}{r.bookedPax != null ? ` · ${r.bookedPax} pax` : ""}</span></span>
                </label>
              )) : <div className="muted">No guest on this sheet has a booking number to move.</div>}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 150px" }}><label className="fl" htmlFor="move-date">New date</label><input id="move-date" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></div>
              <div style={{ flex: "1 1 110px" }}><label className="fl" htmlFor="move-slot">Time</label>
                <select id="move-slot" value={toSlot} onChange={(e) => setToSlot(Number(e.target.value))}>{SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}</select></div>
            </div>
            <div>
              <label className="fl" htmlFor="move-reason">Reason · เหตุผล</label>
              <select id="move-reason" value={reason} onChange={(e) => setReason(e.target.value as MoveReason)}>
                {(Object.keys(MOVE_REASONS) as MoveReason[]).map((k) => <option key={k} value={k}>{MOVE_REASONS[k]}</option>)}
              </select>
              {reason === "other" && <input style={{ marginTop: 6 }} aria-label="Write the reason" placeholder="เขียนเหตุผล" value={reasonText} onChange={(e) => setReasonText(e.target.value)} maxLength={300} />}
            </div>
            <div>
              <label className="fl">Guide at the new time</label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="radio" style={{ width: "auto" }} name="move-guide" checked={!joinGuide && keepGuide} onChange={() => { setJoinGuide(null); setKeepGuide(true); }} /> {guideName} (same guide)</label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="radio" style={{ width: "auto" }} name="move-guide" checked={!joinGuide && !keepGuide} onChange={() => { setJoinGuide(null); setKeepGuide(false); }} /> Leave for Dispatch</label>
              {running?.map((x) => (
                <label key={x.guideId} className="js-move-join" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                  <input type="radio" style={{ width: "auto" }} name="move-guide" checked={joinGuide === x.guideId} onChange={() => setJoinGuide(x.guideId)} />
                  <span>รวมรอบ · join {x.guideName}'s <b>{x.tourName}</b> <span className="muted">· {x.pax} pax → {x.pax + pax}</span></span>
                </label>
              ))}
              {otherTour && <div className="js-move-other-tour" style={{ color: "var(--warn, #9a6700)", fontSize: 13, marginTop: 4 }}>⚠ A different tour: the guests take {joining!.tourName} and its guide fee.</div>}
            </div>
            {problems.length > 0 && <div className="js-move-problems" role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{problems.map((p) => <div key={p}>• {p}</div>)}</div>}
          </div>
        )}
        <div className="mfoot">
          {done ? <button className="btn primary" onClick={finish}>Done</button> : (<>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary js-move-submit" onClick={submit} disabled={busy || !picked.size || (reason === "other" && reasonText.trim().length < 3)}>{busy ? "Moving…" : joining ? `Join ${joining.guideName} · ${SLOTS[toSlot]?.start ?? ""}` : `Move to ${dLong(toDate)} ${SLOTS[toSlot]?.start ?? ""}`}</button>
          </>)}
        </div>
      </div>
    </div>
  );
}
