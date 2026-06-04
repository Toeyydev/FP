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
  const guideId = sp.get("guideId") || ""; // operator may pass; guides omit (uses own)
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const q = new URLSearchParams({ date, slotIdx: String(slotIdx), ...(guideId ? { guideId } : {}) });
    const r = await fetch(`/api/tour-details?${q}`, { cache: "no-store" });
    if (!r.ok) { setErr(r.status === 404 ? "Not assigned to this job." : "Couldn't load."); return; }
    setD(await r.json());
  }, [date, slotIdx, guideId]);
  useEffect(() => { if (date && slotIdx >= 0) load(); }, [load, date, slotIdx]);

  if (err) return <div className="wrap"><div className="js-bar no-print"><button className="btn ghost" onClick={() => router.back()}>← Back</button></div><section className="panel"><div className="op-empty" style={{ padding: 30 }}>{err}</div></section></div>;
  if (!d) return <div className="wrap"><section className="panel"><div className="op-empty">…</div></section></div>;

  const Row = ({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) =>
    <div className="td-row"><span className="td-ic">{icon}</span><div><div className="td-lab">{label}</div><div className="td-val">{children}</div></div></div>;

  return (
    <div className="wrap">
      <div className="js-bar no-print" style={{ display: "flex", justifyContent: "space-between", padding: "10px 0" }}>
        <button className="btn ghost" onClick={() => router.back()}>← Back</button>
        {guideId && <a className="btn" href={`/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`}>📄 Job sheet</a>}
      </div>
      <section className="panel" style={{ padding: 20 }}>
        <h2 style={{ margin: "0 0 4px", color: "#1b4ef0" }}>{d.tour?.name ?? "Tour"}</h2>
        <div style={{ color: "var(--ink-soft)", fontWeight: 600, marginBottom: 16 }}>{d.date} · {d.time}{d.pax != null ? ` · ${d.pax} pax` : ""}</div>

        <div className="td-grid">
          {d.tour?.meetingPoint && <Row icon="📍" label="Meeting point">{d.tour.meetingPoint}</Row>}
          {d.tour?.itinerary && <Row icon="🗺" label="Itinerary"><span style={{ whiteSpace: "pre-wrap" }}>{d.tour.itinerary}</span></Row>}
          {d.tour?.included && <Row icon="✅" label="Included">{d.tour.included}</Row>}
          {d.tour?.bring && <Row icon="🎒" label="Bring / notes">{d.tour.bring}</Row>}
          {d.note && <Row icon="📝" label="Job note">{d.note}</Row>}
          <Row icon="👥" label={`Customers (${d.bookings.length})`}>
            {d.bookings.length ? (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {d.bookings.map((b, i) => <li key={i}>{b.customerName || "—"} · {b.confirmationCode || "no ref"} · {b.pax ?? "?"} pax <small style={{ color: "var(--ink-soft)" }}>({b.source})</small></li>)}
              </ul>
            ) : <span style={{ color: "var(--ink-soft)" }}>No customer info yet</span>}
          </Row>
          {!d.tour?.meetingPoint && !d.tour?.itinerary && !d.tour?.included && !d.tour?.bring && (
            <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>Tour info hasn&apos;t been added by the operator yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
