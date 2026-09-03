"use client";

import { useCallback, useEffect, useState } from "react";
import { SLOTS } from "@/lib/slots";
import { bookingRef } from "@/lib/booking-ref";

type Row = {
  id: string; source: string; confirmationCode: string | null; externalRef: string | null;
  productName: string | null; tourId: string | null; date: string | null; startTime: string | null;
  slotIdx: number | null; pax: number | null; customerName: string | null; status: string; guide?: string | null;
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
export default function BookingsTable({ onOpen, initialMonth = "" }: { onOpen?: (id: string) => void; initialMonth?: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  // Pre-set when arrived at from a deep link — the dashboard's "Record" on a past
  // unstaffed tour lands here, and the operator must not have to work out which
  // month to pick before they can see the tour they just clicked.
  const [month, setMonth] = useState(initialMonth); // YYYY-MM filter
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "all" });
    if (status) p.set("status", status);
    if (source) p.set("source", source);
    if (month) p.set("month", month);
    if (q.trim()) p.set("q", q.trim());
    const r = await fetch(`/api/bookings?${p.toString()}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setRows(d.bookings ?? []); setTours(d.tours ?? []); }
  }, [q, status, source, month]);
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
    const past: string[] = [];
    for (const [k, items] of Object.entries(groups)) {
      const [tourId, date, slotIdx] = k.split("|");
      const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0) || undefined;
      const note = `${items.length} booking(s): ${items.map((b) => bookingRef(b.externalRef, b.confirmationCode) || b.customerName || "—").join(", ")}`.slice(0, 280);
      const r = await fetch("/api/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourId, date, slotIdx: Number(slotIdx), pax: pax && pax <= 10 ? pax : undefined, note }) });
      if (r.ok) { made++; continue; }
      // This tab is where past bookings live, so a tour that already ran is an easy
      // mis-click. Say so instead of reporting a silent "Created 0 offer(s)".
      const err = await r.json().catch(() => ({}));
      if (err?.error === "past-date" && !past.includes(date)) past.push(date);
    }
    setSel(new Set());
    setMsg(past.length
      ? `${past.join(", ")} already happened — no offer sent. Record the guide on the board instead.`
      : `Created ${made} offer(s) from ${chosen.length} booking(s).`);
    await load();
  }

  // Permanently delete the selected bookings (operator confirms once).
  async function deleteSelected() {
    const n = sel.size;
    if (!n) return;
    if (!confirm(`Delete ${n} booking(s)? This permanently removes them and cannot be undone.`)) return;
    const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", ids: [...sel] }) });
    if (r.ok) { setSel(new Set()); setMsg(`Deleted ${n} booking(s).`); await load(); }
    else setMsg("Delete failed.");
  }

  function exportCsv() {
    const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Booking #", "Date", "Time", "Tour", "Guest", "Pax", "Source", "Status", "Guide"];
    const lines = [head.join(",")].concat(rows.map((b) => [bookingRef(b.externalRef, b.confirmationCode), b.date || "", b.startTime || (b.slotIdx != null ? SLOTS[b.slotIdx]?.start ?? "" : ""), b.tourId ? tourName(b.tourId) : (b.productName || ""), b.customerName || "", b.pax ?? "", b.source, b.status, b.guide || ""].map(cell).join(",")));
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
        <input className="search" style={{ flex: "none", width: 150 }} type="month" value={month} onChange={(e) => setMonth(e.target.value)} title="Show one month" />
        {month && <button className="btn sm ghost" onClick={() => setMonth("")} title="Clear month filter">✕ month</button>}
        <button className="btn sm" onClick={exportCsv}>↓ Export CSV</button>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{rows.length} bookings</span>
      </div>
      {(sel.size > 0 || msg) && (
        <div className="bulkbar">
          {sel.size > 0 ? <><b>{sel.size} selected</b>
            <button className="btn sm primary" onClick={offerSelected}>Offer selected</button>
            <button className="btn sm danger" onClick={deleteSelected}>🗑 Delete</button>
            <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button></> : null}
          {msg && <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--green)", fontWeight: 600 }}>{msg}</span>}
        </div>
      )}
      <div className="grid-scroll">
        <table className="acct-table">
          <thead>
            <tr>
              <th style={{ width: 30 }}><input type="checkbox" checked={rows.length > 0 && sel.size === rows.length} onChange={toggleAll} /></th>
              <th>Booking&nbsp;#</th><th>Date</th><th>Tour</th><th>Guest</th><th>Pax</th><th>Source</th><th>Status</th><th>Guide</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="op-empty">No bookings match.</td></tr>
            ) : rows.map((b) => (
              <tr key={b.id} onClick={() => onOpen?.(b.id)} style={{ cursor: onOpen ? "pointer" : "default" }} className={sel.has(b.id) ? "sel" : ""}>
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}><input type="checkbox" checked={sel.has(b.id)} onChange={() => toggle(b.id)} /></td>
                <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{bookingRef(b.externalRef, b.confirmationCode) || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{b.date ?? "—"}{(b.startTime || (b.slotIdx != null ? SLOTS[b.slotIdx]?.start : "")) ? <span style={{ color: "var(--ink-soft)" }}> · {b.startTime || SLOTS[b.slotIdx!]?.start}</span> : ""}</td>
                <td>{b.tourId ? tourName(b.tourId) : <span style={{ color: "var(--ink-soft)" }}>{b.productName ?? "unmapped"}</span>}</td>
                <td>{b.customerName ?? "—"}</td>
                <td>{b.pax ?? "—"}</td>
                <td><span className="badge muted">{b.source}</span></td>
                <td>{statusBadge(b.status)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{b.guide ? <span style={{ fontWeight: 600 }}>{b.guide}</span> : <span style={{ color: "var(--ink-soft)" }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
