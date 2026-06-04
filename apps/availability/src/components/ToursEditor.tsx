"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Tour = {
  id: string; name: string; time: string;
  meetingPoint: string | null; itinerary: string | null; included: string | null; bring: string | null; durationMin: number | null;
};

export default function ToursEditor() {
  const [tours, setTours] = useState<Tour[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/tours", { cache: "no-store" });
    if (r.ok) setTours((await r.json()).tours);
    else setMsg("Operator only.");
  }, []);
  useEffect(() => { load(); }, [load]);

  const upd = (id: string, p: Partial<Tour>) => setTours((ts) => ts.map((t) => t.id === id ? { ...t, ...p } : t));

  async function save(t: Tour) {
    const r = await fetch("/api/tours", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: t.id, meetingPoint: t.meetingPoint ?? "", itinerary: t.itinerary ?? "", included: t.included ?? "", bring: t.bring ?? "", durationMin: t.durationMin }),
    });
    setMsg(r.ok ? `Saved ${t.id} ✓` : "Save failed.");
  }

  const ta = { width: "100%", boxSizing: "border-box" as const, padding: "7px 9px", border: "1px solid var(--line,#ddd)", borderRadius: 8, font: "inherit", marginTop: 4 };

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Tours info</span></div></div>
      <section className="panel">
        <div className="panel-head"><h2>Tour details (shown to assigned guides)</h2>
          <span style={{ color: "var(--ink-soft)", fontWeight: 600, fontSize: 13 }}>{msg}</span>
        </div>
        <div style={{ padding: 14 }}>
          {tours.map((t) => (
            <div key={t.id} className="op-toolbar" style={{ display: "block", borderRadius: 12, border: "1.5px solid var(--line)", marginBottom: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <b><span className="gid">{t.id}</span>{t.name} <span style={{ color: "var(--ink-soft)", fontWeight: 500 }}>· {t.time}</span></b>
                <span>{open === t.id ? "▲" : "▼"}{t.meetingPoint || t.itinerary ? " ✓" : ""}</span>
              </div>
              {open === t.id && (
                <div style={{ marginTop: 10 }}>
                  <label className="fl">📍 Meeting point</label>
                  <input style={ta} value={t.meetingPoint ?? ""} onChange={(e) => upd(t.id, { meetingPoint: e.target.value })} placeholder="e.g. Gate 3, 09:45" />
                  <label className="fl" style={{ marginTop: 8, display: "block" }}>🗺 Itinerary</label>
                  <textarea style={{ ...ta, minHeight: 80 }} value={t.itinerary ?? ""} onChange={(e) => upd(t.id, { itinerary: e.target.value })} placeholder="Grand Palace → Wat Pho → ..." />
                  <label className="fl" style={{ marginTop: 8, display: "block" }}>✅ Included</label>
                  <input style={ta} value={t.included ?? ""} onChange={(e) => upd(t.id, { included: e.target.value })} placeholder="water, transport, tickets" />
                  <label className="fl" style={{ marginTop: 8, display: "block" }}>🎒 Things to bring / notes</label>
                  <input style={ta} value={t.bring ?? ""} onChange={(e) => upd(t.id, { bring: e.target.value })} placeholder="modest dress, hat, sunscreen" />
                  <label className="fl" style={{ marginTop: 8, display: "block" }}>⏱ Default duration (minutes)</label>
                  <input style={{ ...ta, width: 120 }} type="number" min={0} value={t.durationMin ?? ""} onChange={(e) => upd(t.id, { durationMin: e.target.value ? Number(e.target.value) : null })} placeholder="180" />
                  <div style={{ marginTop: 10 }}><button className="btn sm primary" onClick={() => save(t)}>Save {t.id}</button></div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
