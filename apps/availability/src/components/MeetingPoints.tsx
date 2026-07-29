"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";

type Tour = { id: string; name: string; meetingPoint: string | null; meetingLat: number | null; meetingLng: number | null; meetingRadiusM: number | null };

export default function MeetingPoints() {
  const [tours, setTours] = useState<Tour[]>([]);
  const [edit, setEdit] = useState<Record<string, { meetingPoint: string; mapsUrl: string; radiusM: string }>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/meeting-points", { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setTours(d.tours ?? []); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const field = (t: Tour) => edit[t.id] ?? { meetingPoint: t.meetingPoint ?? "", mapsUrl: t.meetingLat != null ? `${t.meetingLat},${t.meetingLng}` : "", radiusM: String(t.meetingRadiusM ?? 150) };
  const set = (id: string, patch: Partial<{ meetingPoint: string; mapsUrl: string; radiusM: string }>) =>
    setEdit((e) => ({ ...e, [id]: { ...field(tours.find((x) => x.id === id)!), ...e[id], ...patch } }));

  async function save(t: Tour) {
    const f = field(t);
    const r = await fetch("/api/meeting-points", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourId: t.id, meetingPoint: f.meetingPoint, mapsUrl: f.mapsUrl, radiusM: Number(f.radiusM) || 150 }) });
    const d = await r.json().catch(() => ({}));
    setMsg((m) => ({ ...m, [t.id]: r.ok ? "Saved ✓" : (d.message || "Error") }));
    if (r.ok) load();
  }

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="meeting-points" />
        <div className="op-main">
      <div id="appBar"><div className="subtabs"><span className="subtab active">Meeting points</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a></div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Meeting points & geofence</h2><span className="hint">Paste a Google Maps link to set coordinates — check-in then verifies the guide is within range.</span></div>
        <div style={{ padding: 14, display: "grid", gap: 14 }}>
          {tours.map((t) => {
            const f = field(t);
            const hasCoords = t.meetingLat != null;
            return (
              <div key={t.id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <b>{t.id} · {t.name}</b>
                  <span style={{ fontSize: 12, fontWeight: 700, color: hasCoords ? "var(--green)" : "var(--ink-soft)" }}>{hasCoords ? "📍 geofenced" : "no location"}</span>
                </div>
                <div className="fld" style={{ marginTop: 10 }}><label>Meeting point name</label>
                  <input value={f.meetingPoint} onChange={(e) => set(t.id, { meetingPoint: e.target.value })} placeholder="e.g. Gate 1, Grand Palace" /></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 10 }}>
                  <div className="fld"><label>Google Maps link or lat,lng</label>
                    <input value={f.mapsUrl} onChange={(e) => set(t.id, { mapsUrl: e.target.value })} placeholder="paste maps link…" /></div>
                  <div className="fld"><label>Radius (m)</label>
                    <input type="number" value={f.radiusM} onChange={(e) => set(t.id, { radiusM: e.target.value })} /></div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: (msg[t.id] || "").includes("✓") ? "var(--green)" : "var(--danger)" }}>{msg[t.id]}</span>
                  <button className="btn sm primary" onClick={() => save(t)}>Save</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
        </div>
      </div>
    </div>
  );
}
