"use client";

import { useCallback, useEffect, useState } from "react";

type Row = {
  id: string; source: string; confirmationCode: string | null; externalRef: string | null;
  productName: string | null; tourId: string | null; date: string | null; startTime: string | null;
  slotIdx: number | null; pax: number | null; customerName: string | null; status: string;
};
type Tour = { id: string; name: string };

const STATUS_LIST = ["PENDING", "OFFERED", "ASSIGNED", "CANCELLED", "IGNORED"];
const SOURCE_LIST = ["bokun", "viator", "gyg", "klook", "manual", "direct", "agent", "referral"];

function statusBadge(s: string) {
  const cls: Record<string, string> = { PENDING: "pending", OFFERED: "invited", ASSIGNED: "active", CANCELLED: "suspended", IGNORED: "muted" };
  const label: Record<string, string> = { PENDING: "Pending", OFFERED: "Offered", ASSIGNED: "Assigned", CANCELLED: "Cancelled", IGNORED: "Archived" };
  return <span className={`badge ${cls[s] ?? ""}`}>{label[s] ?? s}</span>;
}

// Full Bookings table — the operational source of truth (all sources, all
// statuses, searchable + filterable). Read-only list for now (slice 1).
export default function BookingsTable({ onOpen }: { onOpen?: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "all" });
    if (status) p.set("status", status);
    if (source) p.set("source", source);
    if (q.trim()) p.set("q", q.trim());
    const r = await fetch(`/api/bookings?${p.toString()}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setRows(d.bookings ?? []); setTours(d.tours ?? []); }
  }, [q, status, source]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? (id ?? "—");
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSel((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));

  // Bulk offer: group selected (mapped) bookings by tour+date+slot → one offer each.
  async function offerSelected() {
    const chosen = rows.filter((r) => sel.has(r.id) && r.tourId && r.slotIdx != null && r.date);
    if (!chosen.length) { setMsg("Selected bookings need a tour, date & slot first."); return; }
    const groups: Record<string, Row[]> = {};
    for (const b of chosen) { const k = `${b.tourId}|${b.date}|${b.slotIdx}`; (groups[k] ??= []).push(b); }
    let made = 0;
    for (const [k, items] of Object.entries(groups)) {
      const [tourId, date, slotIdx] = k.split("|");
      const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0) || undefined;
      const note = `${items.length} booking(s): ${items.map((b) => b.confirmationCode || b.customerName || "—").join(", ")}`.slice(0, 280);
      const r = await fetch("/api/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourId, date, slotIdx: Number(slotIdx), pax: pax && pax <= 10 ? pax : undefined, note }) });
      if (r.ok) made++;
    }
    setSel(new Set()); setMsg(`Created ${made} offer(s) from ${chosen.length} booking(s).`); await load();
  }

  function exportCsv() {
    const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Booking #", "Date", "Time", "Tour", "Guest", "Pax", "Source", "Status"];
    const lines = [head.join(",")].concat(rows.map((b) => [b.confirmationCode || b.externalRef || "", b.date || "", b.startTime || "", b.tourId ? tourName(b.tourId) : (b.productName || ""), b.customerName || "", b.pax ?? "", b.source, b.status].map(cell).join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "folkpaths-bookings.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <div className="op-toolbar" style={{ gap: 8 }}>
        <input className="search" placeholder="Search guest, booking #, product…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="search" style={{ flex: "none", width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="search" style={{ flex: "none", width: 140 }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {SOURCE_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn sm" onClick={exportCsv}>↓ Export CSV</button>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{rows.length} bookings</span>
      </div>
      {(sel.size > 0 || msg) && (
        <div className="bulkbar">
          {sel.size > 0 ? <><b>{sel.size} selected</b>
            <button className="btn sm primary" onClick={offerSelected}>Offer selected</button>
            <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button></> : null}
          {msg && <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--green)", fontWeight: 600 }}>{msg}</span>}
        </div>
      )}
      <div className="grid-scroll">
        <table className="acct-table">
          <thead>
            <tr>
              <th style={{ width: 30 }}><input type="checkbox" checked={rows.length > 0 && sel.size === rows.length} onChange={toggleAll} /></th>
              <th>Booking&nbsp;#</th><th>Date</th><th>Tour</th><th>Guest</th><th>Pax</th><th>Source</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="op-empty">No bookings match.</td></tr>
            ) : rows.map((b) => (
              <tr key={b.id} onClick={() => onOpen?.(b.id)} style={{ cursor: onOpen ? "pointer" : "default" }} className={sel.has(b.id) ? "sel" : ""}>
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}><input type="checkbox" checked={sel.has(b.id)} onChange={() => toggle(b.id)} /></td>
                <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{b.confirmationCode || b.externalRef || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{b.date ?? "—"}{b.startTime ? <span style={{ color: "var(--ink-soft)" }}> · {b.startTime}</span> : ""}</td>
                <td>{b.tourId ? tourName(b.tourId) : <span style={{ color: "var(--ink-soft)" }}>{b.productName ?? "unmapped"}</span>}</td>
                <td>{b.customerName ?? "—"}</td>
                <td>{b.pax ?? "—"}</td>
                <td><span className="badge muted">{b.source}</span></td>
                <td>{statusBadge(b.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
