"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { SLOTS } from "@/lib/slots";

type Row = { id: string; date: string; slotIdx: number };
const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const todayStr = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + 7 * 3600 * 1000 + n * 86400_000).toISOString().slice(0, 10);

// Expand an inclusive date range into YYYY-MM-DD strings (capped).
function rangeDates(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = start; t <= end && out.length < 400; t += 86400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export default function BlockSlots() {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(plusDays(0));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/blocked-slots", { cache: "no-store" });
    if (r.ok) setRows((await r.json()).rows ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (i: number) => setSel((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });

  async function block() {
    const dates = rangeDates(from, to);
    if (!dates.length || sel.size === 0) { setMsg("Pick a date range and at least one time slot."); return; }
    setBusy(true); setMsg("");
    const r = await fetch("/api/blocked-slots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dates, slotIdxs: [...sel] }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg("Failed to block."); return; }
    setMsg(`🚫 Blocked ${d.blocked} slot${d.blocked === 1 ? "" : "s"} (${dates.length} day${dates.length === 1 ? "" : "s"} × ${sel.size}).`);
    setSel(new Set());
    await load();
  }
  async function unblock(id: string) {
    await fetch("/api/blocked-slots", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    await load();
  }

  // group blocked rows by date
  const byDate: [string, Row[]][] = [];
  for (const r of rows) { const g = byDate.find(([d]) => d === r.date); if (g) g[1].push(r); else byDate.push([r.date, [r]]); }

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Block time slots</span></div>
        <div className="nav"><a className="btn sm" href="/">Board</a><a className="btn sm" href="/jobs">Dispatch</a></div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Block availability</h2><span className="hint">No guide is offered or assigned a blocked slot.</span></div>
        <div style={{ padding: 16, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>From
              <input className="search" style={{ width: 160 }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label style={{ display: "grid", gap: 4, fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>To
              <input className="search" style={{ width: 160 }} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 6 }}>Time slots to block</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SLOTS.map((s) => (
                <button key={s.idx} type="button" onClick={() => toggle(s.idx)}
                  className={`btn sm ${sel.has(s.idx) ? "danger" : ""}`}
                  style={sel.has(s.idx) ? { background: "var(--danger-bg)", borderColor: "var(--danger-line)", color: "var(--danger)" } : undefined}>
                  {sel.has(s.idx) ? "🚫 " : ""}{s.start}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn primary" disabled={busy} onClick={block}>{busy ? "…" : "Block selected slots"}</button>
            {msg && <span style={{ fontSize: 13, fontWeight: 600, color: msg.startsWith("🚫") ? "var(--danger)" : "var(--ink-soft)" }}>{msg}</span>}
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head"><h2>Blocked slots</h2><span className="hint">{rows.length} blocked · next 120 days</span></div>
        <div style={{ padding: 14 }}>
          {byDate.length === 0 ? <div className="op-empty">No blocked slots.</div> : byDate.map(([date, items]) => (
            <div key={date} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <b style={{ minWidth: 130 }}>{dShort(date)}</b>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
                {items.sort((a, b) => a.slotIdx - b.slotIdx).map((r) => (
                  <span key={r.id} className="badge" style={{ background: "var(--danger-bg)", borderColor: "var(--danger-line)", color: "var(--danger)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {SLOTS[r.slotIdx]?.start}
                    <button onClick={() => unblock(r.id)} title="Unblock" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--danger)", fontWeight: 700, padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
