"use client";

import { useCallback, useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";
import type { SyncDisplay, SyncRowView } from "@/lib/calendar-sync-status";

// Ops → Calendar sync: each company calendar event and whether Google has it. Retry sends the
// existing event through the calendar sync again — it never makes a new one and never emails.

const LABEL: Record<SyncDisplay, string> = { ok: "OK", waiting: "Retrying", failed: "Failed" };
const COLOR: Record<SyncDisplay, string> = { ok: "var(--green)", waiting: "var(--assign)", failed: "var(--danger)" };
const dShort = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—";

export default function CalendarSync() {
  const [view, setView] = useState<"attention" | "all">("attention");
  const [status, setStatus] = useState<"" | SyncDisplay>("");
  const [range, setRange] = useState<"upcoming" | "all">("upcoming");
  const [data, setData] = useState<{ counts: Record<SyncDisplay, number>; rows: SyncRowView[]; truncated: boolean; canBulkRetry: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the row being retried, or "bulk"
  const [result, setResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [bulkMsg, setBulkMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ view, when: range, ...(status ? { status } : {}) });
    const r = await fetch(`/api/calendar-sync?${qs}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr("Could not load the calendar status."); return; }
    setErr(null); setData(d);
  }, [view, status, range]);
  useEffect(() => { void load(); }, [load]);

  const retry = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const r = await fetch("/api/calendar-sync/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const d = await r.json().catch(() => ({}));
      setResult((x) => ({ ...x, [id]: { ok: !!d.ok, message: d.message ?? (r.ok ? "Done." : "The retry did not go through.") } }));
      await load();
    } finally { setBusy(null); }
  };
  const retryAll = async () => {
    if (busy) return;
    setBusy("bulk"); setBulkMsg(null);
    try {
      const r = await fetch("/api/calendar-sync/retry-not-in-step", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setBulkMsg(r.ok
        ? { ok: d.failed === 0, text: `Retried ${d.tried}: ${d.succeeded} now in Google Calendar${d.failed ? `, ${d.failed} still not` : ""}.${d.more ? " More remain — run it again." : ""}` }
        : { ok: false, text: d.message ?? "The retry did not go through." });
      await load();
    } finally { setBusy(null); }
  };

  const c = data?.counts ?? { ok: 0, waiting: 0, failed: 0 };
  const notInStep = c.waiting + c.failed;
  return (
    <div className="op-layout">
      <OperatorNav active="calendar-sync" />
      <div className="op-main">
        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-head" style={{ padding: 0, marginBottom: 10 }}>
            <h2>Calendar sync · ปฏิทิน</h2>
            <span className="hint">Each guide&rsquo;s tour invitation on the company Google Calendar. Retrying ones are tried again automatically; Failed ones have stopped retrying and need Retry now.</span>
          </div>

          <div className="cs-counts" style={{ display: "flex", gap: 18, flexWrap: "wrap", margin: "4px 0 12px" }}>
            {(["ok", "waiting", "failed"] as SyncDisplay[]).map((k) => (
              <div key={k} className="stat" data-count={k}><b style={{ color: COLOR[k] }}>{c[k]}</b><span>{LABEL[k]}</span></div>
            ))}
            <span style={{ fontSize: 12, color: "var(--ink-soft)", alignSelf: "center" }}>{range === "upcoming" ? "from today" : "all dates"}</span>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button className={`chip-pick${view === "attention" ? " on" : ""}`} onClick={() => setView("attention")}>Needs attention</button>
            <button className={`chip-pick${view === "all" ? " on" : ""}`} onClick={() => setView("all")}>All</button>
            <select className="search" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as "" | SyncDisplay)} style={{ width: "auto" }}>
              <option value="">Any status</option><option value="ok">OK</option><option value="waiting">Retrying</option><option value="failed">Failed</option>
            </select>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={range === "all"} onChange={(e) => setRange(e.target.checked ? "all" : "upcoming")} /> Include past tours
            </label>
            {data?.canBulkRetry && notInStep > 0 && (
              <button className="btn" style={{ marginLeft: "auto" }} disabled={!!busy} onClick={retryAll}>{busy === "bulk" ? "Retrying…" : "Retry all not in step (up to 20)"}</button>
            )}
          </div>

          {err && <div role="alert" style={{ color: "var(--danger)", marginBottom: 10 }}>{err}</div>}
          {bulkMsg && <div role="status" style={{ color: bulkMsg.ok ? "var(--green)" : "var(--danger)", marginBottom: 10 }}>{bulkMsg.text}</div>}

          {data && data.rows.length === 0 && (
            <p style={{ color: "var(--ink-soft)" }}>{view === "attention" ? "Nothing needs attention — every invitation is in Google Calendar." : "No calendar events here."}</p>
          )}
          <div className="cs-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data?.rows.map((r) => (
              <div key={r.id} className="cs-row" data-status={r.status} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", background: "var(--card, #fff)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                  <b style={{ fontSize: 14 }}>{dShort(r.date)} · {r.time} — {r.tour}</b>
                  <span style={{ fontWeight: 700, fontSize: 12.5, color: COLOR[r.status] }}>{LABEL[r.status]}{r.state === "CANCELLED" ? " · cancellation" : ""}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 2 }}>
                  {r.guideId} {r.guide !== r.guideId ? r.guide : ""} · attempts {r.attempts} · updated {when(r.updatedAt)}{r.nextAttemptAt ? ` · next retry ${when(r.nextAttemptAt)}` : ""}
                </div>
                {r.error && !result[r.id] && <div className="cs-error" style={{ fontSize: 13, color: "var(--danger)", marginTop: 4 }}>{r.error}</div>}
                {result[r.id] && <div role="status" style={{ fontSize: 13, marginTop: 4, color: result[r.id].ok ? "var(--green)" : "var(--danger)" }}>{result[r.id].message}</div>}
                {r.canRetry && (
                  <button className="btn sm" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => retry(r.id)}>{busy === r.id ? "Retrying…" : "Retry now"}</button>
                )}
              </div>
            ))}
          </div>
          {data?.truncated && <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>Showing the first 300 — narrow the filter to see the rest.</p>}
        </section>
      </div>
    </div>
  );
}
