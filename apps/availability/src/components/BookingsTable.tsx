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
export default function BookingsTable() {
  const [rows, setRows] = useState<Row[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");

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
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{rows.length} bookings</span>
      </div>
      <div className="grid-scroll">
        <table className="acct-table">
          <thead>
            <tr><th>Booking&nbsp;#</th><th>Date</th><th>Tour</th><th>Guest</th><th>Pax</th><th>Source</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="op-empty">No bookings match.</td></tr>
            ) : rows.map((b) => (
              <tr key={b.id}>
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
