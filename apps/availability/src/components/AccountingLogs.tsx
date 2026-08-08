"use client";

import { useCallback, useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";

// The finance audit trail, readable: who did what to which money, when.
// Read-only view over AuditLog (finance actions only) with search + load-more.
type Row = { id: string; action: string; entityType: string | null; entityId: string | null; actor: string; actorRole: string | null; detail: unknown; at: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// Action → tone. Failures red, approvals/payments green, the rest neutral.
const tone = (a: string): string =>
  /fail|error|deleted|removed|skipped/.test(a) ? "bad"
  : /paid|approved|created|uploaded|matched|added/.test(a) ? "ok"
  : "mut";
// One-line human summary from the structured detail (best-effort, never raw JSON walls).
function summarize(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  const bits: string[] = [];
  for (const k of ["batchNo", "ref", "period", "guideId", "date", "guides", "items", "total", "amount", "lines", "tours", "flipped"]) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== "object") bits.push(`${k}: ${d[k]}`);
  }
  return bits.slice(0, 5).join(" · ");
}

export default function AccountingLogs() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before?: string | null, query?: string) => {
    setBusy(true);
    const qs = new URLSearchParams();
    if (before) qs.set("before", before);
    if (query?.trim()) qs.set("q", query.trim());
    const r = await fetch(`/api/audit?${qs.toString()}`, { cache: "no-store" });
    setBusy(false);
    if (!r.ok) return;
    const d = await r.json();
    setRows((prev) => (before ? [...(prev ?? []), ...d.rows] : d.rows));
    setNextBefore(d.nextBefore ?? null);
  }, []);
  useEffect(() => { load(null, q); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="op-layout">
      <OperatorNav active="accounting-logs" />
      <div className="op-main">
        <div className="subtabs"><span className="subtab active">Accounting logs</span></div>
        <section className="panel">
          <div className="op-toolbar" style={{ gap: 10 }}>
            <input className="search" style={{ flex: 1, minWidth: 180 }} placeholder="Filter — e.g. batch, payroll.marked, guide id…" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(null, q); }} />
            <button className="btn sm" disabled={busy} onClick={() => load(null, q)}>{busy ? "…" : "Search"}</button>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-soft)" }}>Finance actions only · read-only</span>
          </div>
          {rows == null ? <div style={{ padding: 14 }}>{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skel-row" />)}</div>
            : rows.length === 0 ? <div className="op-empty" style={{ padding: 18 }}>No matching finance events.</div>
            : (
              <div className="grid-scroll" style={{ padding: "0 8px 10px" }}>
                <table className="acct-table">
                  <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: "nowrap", color: "var(--ink-soft)", fontSize: 12.5 }}>{when(r.at)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.actor}</td>
                        <td><span className={`ob ${tone(r.action)}`}>{r.action}</span></td>
                        <td style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{summarize(r.detail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          {nextBefore && <div style={{ padding: "0 14px 14px" }}><button className="btn sm" disabled={busy} onClick={() => load(nextBefore, q)}>{busy ? "…" : "Load older"}</button></div>}
        </section>
      </div>
    </div>
  );
}
