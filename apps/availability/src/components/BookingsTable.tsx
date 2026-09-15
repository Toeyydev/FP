"use client";

import { useCallback, useEffect, useState } from "react";
import { SLOTS } from "@/lib/slots";
import { bookingRef } from "@/lib/booking-ref";

type Row = {
  id: string; source: string; confirmationCode: string | null; externalRef: string | null;
  productName: string | null; tourId: string | null; date: string | null; startTime: string | null;
  slotIdx: number | null; pax: number | null; customerName: string | null; status: string; guide?: string | null;
};
type Tour = { id: string; name: string; time?: string | null };

const STATUS_LIST = ["PENDING", "OFFERED", "ASSIGNED", "CANCELLED", "IGNORED"];

function statusBadge(s: string) {
  const cls: Record<string, string> = { PENDING: "pending", OFFERED: "invited", ASSIGNED: "active", CANCELLED: "suspended", IGNORED: "muted" };
  const label: Record<string, string> = { PENDING: "Pending", OFFERED: "Offered", ASSIGNED: "Assigned", CANCELLED: "Cancelled", IGNORED: "Archived" };
  return <span className={`badge ${cls[s] ?? ""}`}>{label[s] ?? s}</span>;
}

// Full Bookings table — the operational source of truth (all sources, all
// statuses, searchable + filterable). Read-only list for now (slice 1).
export default function BookingsTable({ onOpen, initialMonth = "", onRecordPast, refreshKey = 0 }: {
  onOpen?: (id: string) => void; initialMonth?: string;
  /** "Record who guided…" for the day of the selected past bookings. */
  onRecordPast?: (date: string) => void;
  /** Bump to reload after something outside the table changed the bookings. */
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [tour, setTour] = useState(""); // tour id, or "none" = no tour connected
  const [sources, setSources] = useState<string[]>([]);
  // Filters on columns the server does not filter: applied to the loaded rows.
  const [guest, setGuest] = useState("");
  const [guideF, setGuideF] = useState(""); // "" all · "none" no guide · a guide name
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
    if (tour) p.set("tour", tour);
    if (month) p.set("month", month);
    if (q.trim()) p.set("q", q.trim());
    const r = await fetch(`/api/bookings?${p.toString()}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setRows(d.bookings ?? []); setTours(d.tours ?? []); if (Array.isArray(d.sources)) setSources(d.sources); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, source, tour, month, refreshKey]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? (id ?? "—");
  const shown = rows.filter((r) =>
    (!guest.trim() || (r.customerName ?? "").toLowerCase().includes(guest.trim().toLowerCase())) &&
    (!guideF || (guideF === "none" ? !r.guide : r.guide === guideF)));
  const guideNames = [...new Set(rows.map((r) => r.guide).filter((g): g is string => !!g))].sort();
  const filtering = !!(status || source || tour || month || guest.trim() || guideF);
  const clearFilters = () => { setStatus(""); setSource(""); setTour(""); setMonth(""); setGuest(""); setGuideF(""); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSel((s) => (s.size === shown.length && shown.length > 0 ? new Set() : new Set(shown.map((r) => r.id))));

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
      ? `${past.join(", ")} already happened — no offer sent. Select that day\u2019s bookings on their own and use Record who guided.`
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
    const lines = [head.join(",")].concat(shown.map((b) => [bookingRef(b.externalRef, b.confirmationCode), b.date || "", b.startTime || (b.slotIdx != null ? SLOTS[b.slotIdx]?.start ?? "" : ""), b.tourId ? tourName(b.tourId) : (b.productName || ""), b.customerName || "", b.pax ?? "", b.source, b.status, b.guide || ""].map(cell).join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "folkpaths-bookings.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <div className="op-toolbar" style={{ gap: 8 }}>
        <input className="search" placeholder="Search guest, booking #, product…" value={q} onChange={(e) => setQ(e.target.value)} />
        {filtering && <button className="btn sm ghost" onClick={clearFilters} title="Clear every column filter">✕ Clear filters</button>}
        <button className="btn sm" onClick={exportCsv}>↓ Export CSV</button>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{shown.length} booking{shown.length === 1 ? "" : "s"}</span>
      </div>
      {(sel.size > 0 || msg) && (
        <div className="bulkbar">
          {sel.size > 0 ? <><b>{sel.size} selected</b>
            {(() => {
              // Tours that already ran cannot be offered; record who guided them instead.
              const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
              const chosen = rows.filter((r) => sel.has(r.id));
              const days = [...new Set(chosen.map((r) => r.date ?? ""))];
              const allPast = chosen.length > 0 && chosen.every((r) => r.date && r.date < today);
              if (!onRecordPast || !allPast) return <button className="btn sm primary" onClick={offerSelected}>Offer selected</button>;
              return days.length === 1
                ? <button className="btn sm primary" onClick={() => onRecordPast(days[0])} title="These tours already ran — record which guide ran them">Record who guided…</button>
                : <button className="btn sm primary" disabled title="Select bookings from one day">Record who guided… (one day at a time)</button>;
            })()}
            <button className="btn sm danger" onClick={deleteSelected}>🗑 Delete</button>
            <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button></> : null}
          {msg && <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--green)", fontWeight: 600 }}>{msg}</span>}
        </div>
      )}
      <div className="grid-scroll">
        <table className="acct-table">
          <thead>
            <tr>
              <th style={{ width: 30 }}><input type="checkbox" checked={shown.length > 0 && sel.size === shown.length} onChange={toggleAll} /></th>
              <th>Booking&nbsp;#</th><th>Date</th><th>Tour</th><th>Guest</th><th>Pax</th><th>Source</th><th>Status</th><th>Guide</th></tr>
            {/* A filter under each column (the operator asked to filter right here). */}
            <tr className="bk-filter-row">
              <th />
              <th />
              <th><input className="search bk-filter" style={{ minWidth: 140 }} type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Filter by month" title="Show one month" /></th>
              <th>
                <select className="search bk-filter" value={tour} onChange={(e) => setTour(e.target.value)} aria-label="Filter by tour" title="Filter by tour">
                  <option value="">All tours</option>
                  <option value="none">⚠ No tour connected</option>
                  {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}{t.time ? ` · ${t.time}` : ""}</option>)}
                </select>
              </th>
              <th><input className="search bk-filter" value={guest} onChange={(e) => setGuest(e.target.value)} placeholder="Guest…" aria-label="Filter by guest" /></th>
              <th />
              <th>
                <select className="search bk-filter" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by source">
                  <option value="">All</option>
                  {sources.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </th>
              <th>
                <select className="search bk-filter" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
                  <option value="">All</option>
                  {STATUS_LIST.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </th>
              <th>
                <select className="search bk-filter" value={guideF} onChange={(e) => setGuideF(e.target.value)} aria-label="Filter by guide">
                  <option value="">All</option>
                  <option value="none">No guide</option>
                  {guideNames.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={9} className="op-empty">No bookings match.</td></tr>
            ) : shown.map((b) => (
              <tr key={b.id} onClick={() => onOpen?.(b.id)} style={{ cursor: onOpen ? "pointer" : "default" }} className={sel.has(b.id) ? "sel" : ""}>
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}><input type="checkbox" checked={sel.has(b.id)} onChange={() => toggle(b.id)} /></td>
                <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{bookingRef(b.externalRef, b.confirmationCode) || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{b.date ?? "—"}{(b.startTime || (b.slotIdx != null ? SLOTS[b.slotIdx]?.start : "")) ? <span style={{ color: "var(--ink-soft)" }}> · {b.startTime || SLOTS[b.slotIdx!]?.start}</span> : ""}</td>
                <td>{b.tourId ? tourName(b.tourId) : <span style={{ color: "var(--danger)" }} title="No tour connected — open the booking to choose its tour">⚠ No tour{b.productName ? ` (${b.productName})` : ""}</span>}</td>
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
