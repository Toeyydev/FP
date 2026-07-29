"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";

type Tour = {
  id: string; name: string; time: string; durationMin: number | null;
  meetingPoint: string | null; itinerary: string | null; included: string | null; bring: string | null;
  bookings: number; assignments: number;
};

export default function Tours() {
  const [tours, setTours] = useState<Tour[]>([]);
  const [msg, setMsg] = useState("");
  const [draft, setDraft] = useState<Record<string, Partial<Tour>>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState({ name: "", time: "", durationMin: "" });

  const load = useCallback(async () => {
    const r = await fetch("/api/tours", { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setTours(d.tours ?? []); setDraft({}); } else setMsg("Operators only.");
  }, []);
  useEffect(() => { load(); }, [load]);

  const field = (t: Tour, k: keyof Tour) => (draft[t.id]?.[k] ?? t[k] ?? "") as string | number;
  const set = (id: string, k: keyof Tour, v: string | number | null) => setDraft((d) => ({ ...d, [id]: { ...d[id], [k]: v } }));
  const dirty = (id: string) => !!draft[id] && Object.keys(draft[id]).length > 0;

  async function save(t: Tour) {
    const d = draft[t.id] ?? {};
    const body: Record<string, unknown> = { action: "update", id: t.id };
    for (const k of ["name", "time", "meetingPoint", "itinerary", "included", "bring"] as const) if (d[k] !== undefined) body[k] = d[k];
    if (d.durationMin !== undefined) { const dm = d.durationMin as unknown as string | number | null; body.durationMin = dm === "" || dm == null ? null : Number(dm); }
    const r = await fetch("/api/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setMsg(r.ok ? "✅ Saved" : "Save failed."); if (r.ok) await load();
  }
  async function addTour() {
    if (!adding.name.trim()) return;
    const r = await fetch("/api/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", name: adding.name.trim(), time: adding.time.trim() || undefined, durationMin: adding.durationMin ? Number(adding.durationMin) : undefined }) });
    if (r.ok) { setAdding({ name: "", time: "", durationMin: "" }); setMsg("✅ Tour added"); await load(); } else setMsg("Add failed.");
  }
  async function merge(t: Tour) {
    const others = tours.filter((x) => x.id !== t.id);
    const toId = prompt(`Merge "${t.id} ${t.name}" INTO which tour?\nIts ${t.bookings} bookings + ${t.assignments} assignments move there, then ${t.id} is deleted.\n\nType a tour ID:\n${others.map((o) => `${o.id} · ${o.name}`).join("\n")}`);
    if (!toId) return;
    const target = others.find((o) => o.id === toId.trim().toUpperCase());
    if (!target) { setMsg("No tour with that ID."); return; }
    if (!confirm(`Merge ${t.id} into ${target.id} (${target.name})? This can't be undone.`)) return;
    const r = await fetch("/api/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "merge", fromId: t.id, toId: target.id }) });
    setMsg(r.ok ? `✅ Merged ${t.id} → ${target.id}` : "Merge failed."); if (r.ok) await load();
  }
  async function del(t: Tour) {
    if (!confirm(`Delete ${t.id} ${t.name}?`)) return;
    const r = await fetch("/api/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", id: t.id }) });
    const d = r.ok ? null : await r.json().catch(() => ({}));
    setMsg(r.ok ? "🗑 Deleted" : (d?.message || "Delete failed.")); if (r.ok) await load();
  }

  const inp = { width: "100%", font: "inherit" } as const;

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="tours" />
        <div className="op-main">
      <div id="appBar"><div className="subtabs"><span className="subtab active">Tours</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a></div>
      </div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
          <b style={{ fontSize: 14 }}>Add a tour</b>
          <input className="search" style={{ flex: 1, minWidth: 180 }} placeholder="Tour name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          <input className="search" style={{ width: 90 }} placeholder="Time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} />
          <input className="search" style={{ width: 110 }} type="number" placeholder="Dur (min)" value={adding.durationMin} onChange={(e) => setAdding({ ...adding, durationMin: e.target.value })} />
          <button className="btn sm primary" disabled={!adding.name.trim()} onClick={addTour}>+ Add tour</button>
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--green)", fontWeight: 600 }}>{msg}</span>
        </div>
      </section>

      <section className="panel">
        <div style={{ display: "grid", gap: 10, padding: 4 }}>
          {tours.map((t) => (
            <div key={t.id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", background: "#fffcf6" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="gid">{t.id}</span>
                <input className="search" style={{ flex: 1, minWidth: 200, fontWeight: 700 }} value={field(t, "name") as string} onChange={(e) => set(t.id, "name", e.target.value)} />
                <label style={{ fontSize: 12 }}>Time <input className="search" style={{ width: 80 }} value={field(t, "time") as string} onChange={(e) => set(t.id, "time", e.target.value)} /></label>
                <label style={{ fontSize: 12 }}>Dur <input className="search" style={{ width: 80 }} type="number" value={(field(t, "durationMin") as string) ?? ""} onChange={(e) => set(t.id, "durationMin", e.target.value)} /></label>
                <span className="badge" title="Bookings">{t.bookings} bk</span>
                <span className="badge" title="Assignments">{t.assignments} job</span>
                <button className="btn sm" onClick={() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}>{open[t.id] ? "Less" : "Details"}</button>
                <button className="btn sm primary" disabled={!dirty(t.id)} onClick={() => save(t)}>Save</button>
              </div>
              {open[t.id] && (
                <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                  <label style={{ fontSize: 12.5 }}>Meeting point<input className="search" style={inp} value={(field(t, "meetingPoint") as string) ?? ""} onChange={(e) => set(t.id, "meetingPoint", e.target.value)} placeholder="(set coordinates on Meeting points)" /></label>
                  <label style={{ fontSize: 12.5 }}>Itinerary<textarea className="search" style={{ ...inp, minHeight: 60, resize: "vertical" }} value={(field(t, "itinerary") as string) ?? ""} onChange={(e) => set(t.id, "itinerary", e.target.value)} /></label>
                  <label style={{ fontSize: 12.5 }}>Included<textarea className="search" style={{ ...inp, minHeight: 44, resize: "vertical" }} value={(field(t, "included") as string) ?? ""} onChange={(e) => set(t.id, "included", e.target.value)} /></label>
                  <label style={{ fontSize: 12.5 }}>What to bring<textarea className="search" style={{ ...inp, minHeight: 44, resize: "vertical" }} value={(field(t, "bring") as string) ?? ""} onChange={(e) => set(t.id, "bring", e.target.value)} /></label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn sm" title="Merge this tour into another (moves its bookings)" onClick={() => merge(t)}>🔀 Merge into…</button>
                    <button className="btn sm danger" title={t.bookings || t.assignments ? "Has bookings/assignments — merge instead" : "Delete"} onClick={() => del(t)}>🗑 Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {tours.length === 0 && <div className="op-empty">No tours yet.</div>}
        </div>
      </section>
        </div>
      </div>
    </div>
  );
}
