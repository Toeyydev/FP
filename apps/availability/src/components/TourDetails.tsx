"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Data = {
  date: string; slotIdx: number; time: string; pax: number | null; note: string | null;
  tour: { id: string; name: string; time: string; meetingPoint: string | null; itinerary: string | null; included: string | null; bring: string | null } | null;
  bookings: { customerName: string | null; confirmationCode: string | null; pax: number | null; source: string }[];
};

export default function TourDetails() {
  const router = useRouter();
  const sp = useSearchParams();
  const date = sp.get("date") || "";
  const slotIdx = Number(sp.get("slotIdx") ?? "-1");
  const guideId = sp.get("guideId") || "";
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const q = new URLSearchParams({ date, slotIdx: String(slotIdx), ...(guideId ? { guideId } : {}) });
    const r = await fetch(`/api/tour-details?${q}`, { cache: "no-store" });
    if (!r.ok) { setErr(r.status === 404 ? "You're not assigned to this job (yet)." : "Couldn't load."); return; }
    setD(await r.json());
  }, [date, slotIdx, guideId]);
  useEffect(() => { if (date && slotIdx >= 0) load(); }, [load, date, slotIdx]);

  if (err) return <div className="wrap"><div className="js-bar no-print"><button className="btn ghost" onClick={() => router.back()}>← Back</button></div><section className="panel"><div className="op-empty" style={{ padding: 30 }}>{err}</div></section></div>;
  if (!d) return <div className="wrap"><section className="panel"><div className="op-empty">…</div></section></div>;

  const totalPax = d.bookings.reduce((s, b) => s + (b.pax ?? 0), 0) || d.pax || 0;
  const hasInfo = d.tour?.meetingPoint || d.tour?.itinerary || d.tour?.included || d.tour?.bring;

  return (
    <div className="wrap jobsheet">
      <div className="js-bar no-print">
        <button className="btn ghost" onClick={() => router.back()}>← Back</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => window.print()}>🖨 Print</button>
          {guideId && <a className="btn" href={`/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`}>📄 Full job sheet</a>}
        </div>
      </div>

      <section className="panel js-sheet" style={{ padding: 18 }}>
        {/* header */}
        <div className="js-head">
          <div className="js-brand"><b>FOLKPATHS</b><div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Job details</div></div>
          <table className="js-meta"><tbody>
            <tr><td>Tour ID</td><td><b>{d.tour?.id ?? "—"}</b></td></tr>
            <tr><td>Date</td><td>{d.date}</td></tr>
            <tr><td>Time</td><td><b style={{ color: "#1b4ef0" }}>{d.tour?.time || d.time}</b></td></tr>
            <tr><td>Pax</td><td>{totalPax || "—"}</td></tr>
          </tbody></table>
        </div>

        <h2 style={{ margin: "6px 0 14px", color: "#1b4ef0" }}>{d.tour?.name ?? "Tour"}</h2>

        {/* customers */}
        <h3 className="js-section">Your customers ({d.bookings.length})</h3>
        <table className="js-table">
          <thead><tr><th>No.</th><th>Name</th><th>Booking ref</th><th>Pax</th><th>Channel</th></tr></thead>
          <tbody>
            {d.bookings.length ? d.bookings.map((b, i) => (
              <tr key={i}><td>{i + 1}</td><td>{b.customerName || "—"}</td><td>{b.confirmationCode || "—"}</td><td>{b.pax ?? "?"}</td><td>{b.source}</td></tr>
            )) : <tr><td colSpan={5} style={{ color: "var(--ink-soft)", textAlign: "center" }}>No customer list attached to this job.</td></tr>}
          </tbody>
        </table>
        {d.note && <div style={{ marginTop: 8, fontSize: 13 }}>📝 <b>Note:</b> {d.note}</div>}

        {/* tour info */}
        <h3 className="js-section" style={{ background: "#fff8c4", marginTop: 18 }}>Tour information</h3>
        {hasInfo ? (
          <div className="td-grid" style={{ padding: "10px 4px" }}>
            {d.tour?.meetingPoint && <div className="td-row"><span className="td-ic">📍</span><div><div className="td-lab">Meeting point</div><div className="td-val">{d.tour.meetingPoint}</div></div></div>}
            {d.tour?.itinerary && <div className="td-row"><span className="td-ic">🗺</span><div><div className="td-lab">Itinerary</div><div className="td-val" style={{ whiteSpace: "pre-wrap" }}>{d.tour.itinerary}</div></div></div>}
            {d.tour?.included && <div className="td-row"><span className="td-ic">✅</span><div><div className="td-lab">Included</div><div className="td-val">{d.tour.included}</div></div></div>}
            {d.tour?.bring && <div className="td-row"><span className="td-ic">🎒</span><div><div className="td-lab">Bring / notes</div><div className="td-val">{d.tour.bring}</div></div></div>}
          </div>
        ) : <div style={{ padding: "10px 4px", color: "var(--ink-soft)", fontSize: 13 }}>Meeting point & itinerary not added yet — check with operations.</div>}
      </section>
    </div>
  );
}
