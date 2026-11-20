"use client";

import { useState } from "react";
import { BOOKED_IN_GUIDE_PAYMENT, isBookedInGuidePayment } from "@/lib/advances/rules";

export type AdvancePeakState = { status: string; documentNo: string | null; error: string | null };

// The owner's names for the sync states (2026-11-15). Stored values are unchanged
// (lib/advances/peak-reconcile SYNC_LABEL), kept in step here for the client bundle.
const labels: Record<string, string> = {
  PENDING: "Not synced",
  SENDING: "Syncing",
  POSTED: "Synced",
  BLOCKED: "Failed",
  UNCERTAIN: "Reconciliation required",
  CANCELLED: "Cancelled",
};

type HistoryRow = { at: string; action: string; by: string; detail: Record<string, unknown> | null };

/**
 * A Company ADV movement's PEAK sync: status, the journal number once synced, the error, and —
 * for ADMIN / ACCOUNTANT (`canReconcile`) — Retry on a failed item, Resolve on one that needs
 * reconciliation, and its history. `syncId` is the outbox item (ADVANCE:<id>, RETURN:<id>, EXPENSE:<id>).
 */
export default function AdvancePeakStatus({ state, syncId, canReconcile = false, onChanged }: {
  state?: AdvancePeakState | null; syncId?: string; canReconcile?: boolean; onChanged?: (msg: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState<null | "resolve" | "history">(null);
  const [outcome, setOutcome] = useState<"FOUND" | "NOT_IN_PEAK">("FOUND");
  const [docNo, setDocNo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  if (!state) return null;
  // Recorded as carried by the job's guide-payment document (lib/advances/booked-in-guide-payment):
  // say that in words, not with the stored marker.
  if (isBookedInGuidePayment(state)) {
    return (
      <div className="js-peak-booked" style={{ fontSize: 12, marginTop: 4 }} role="status">
        <span>Booked in guide payment <span className="mono">{state.documentNo}</span> — not posted to PEAK again</span>
        <div className="muted" style={{ whiteSpace: "normal", maxWidth: 280 }}>{(state.error ?? "").replace(`${BOOKED_IN_GUIDE_PAYMENT}: `, "")}</div>
      </div>
    );
  }
  const url = (p: string) => `/api/advances/peak-sync/${encodeURIComponent(syncId ?? "")}/${p}`;
  const call = async (path: string, body?: unknown) => {
    setBusy(true); setErr("");
    let r: Response;
    try { r = await fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
    catch { r = new Response(JSON.stringify({ reasons: ["Offline — try again"] }), { status: 503 }); }
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr((d.reasons ?? [d.error ?? "Couldn't do that"]).join("\n")); return false; }
    return true;
  };
  const loadHistory = async () => {
    if (open === "history") { setOpen(null); return; }
    setOpen("history"); setHistory(null);
    const r = await fetch(url("history")).catch(() => null);
    const d = r?.ok ? await r.json().catch(() => null) : null;
    setHistory(d?.history ?? []);
  };
  const tone = state.status === "POSTED" ? "var(--green)" : state.status === "BLOCKED" || state.status === "UNCERTAIN" ? "var(--danger)" : "var(--ink-soft)";
  const actions = canReconcile && !!syncId;

  return (
    <div className="js-peak-sync" data-status={state.status} style={{ fontSize: 12, marginTop: 4 }} role="status">
      <span className="js-peak-sync-label" style={{ color: tone, fontWeight: 600 }}>{labels[state.status] ?? state.status}</span>
      {state.documentNo && <span className="mono js-peak-sync-doc"> · {state.documentNo}</span>}
      {state.error && <div className="muted" style={{ whiteSpace: "normal", maxWidth: 300 }}>{state.error}</div>}
      {actions && (
        <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
          {state.status === "BLOCKED" && (
            <button type="button" className="btn sm js-peak-retry" disabled={busy}
              onClick={async () => { if (await call("retry")) await onChanged?.("Sent back to the PEAK sender — it tries within a minute"); }}>Retry sync</button>
          )}
          {state.status === "UNCERTAIN" && (
            <button type="button" className="btn sm js-peak-resolve" disabled={busy} aria-expanded={open === "resolve"}
              onClick={() => { setOpen(open === "resolve" ? null : "resolve"); setErr(""); }}>Resolve…</button>
          )}
          <button type="button" className="btn sm ghost js-peak-history" aria-expanded={open === "history"} onClick={loadHistory}>History</button>
        </div>
      )}
      {open === "resolve" && (
        <div className="js-peak-resolve-form" style={{ marginTop: 6, padding: 8, border: "1px solid var(--line)", borderRadius: 8, display: "grid", gap: 6, maxWidth: 340, whiteSpace: "normal", fontFamily: "inherit" }}>
          <div>Look for this movement in PEAK first. FolkOPS will not send it again until you say it is not there.</div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input type="radio" name={`o-${syncId}`} className="js-peak-found" checked={outcome === "FOUND"} onChange={() => setOutcome("FOUND")} /> It is in PEAK as
            <input className="js-peak-docno" style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "4px 6px", width: 140, fontFamily: "ui-monospace, monospace" }} placeholder="JV-…" value={docNo} disabled={outcome !== "FOUND"} onChange={(e) => setDocNo(e.target.value)} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" name={`o-${syncId}`} className="js-peak-notthere" checked={outcome === "NOT_IN_PEAK"} onChange={() => setOutcome("NOT_IN_PEAK")} /> I checked PEAK — it is not there, send it again
          </label>
          <input className="js-peak-reason" style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", fontFamily: "inherit" }} placeholder="What you checked (kept in the history)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn sm primary js-peak-resolve-submit" disabled={busy}
              onClick={async () => {
                const ok = await call("resolve", outcome === "FOUND" ? { outcome, documentNo: docNo, reason } : { outcome, reason });
                if (ok) { setOpen(null); await onChanged?.(outcome === "FOUND" ? `Matched to ${docNo.trim().toUpperCase()} in PEAK ✓` : "Sent back to the PEAK sender"); }
              }}>{busy ? "…" : "Resolve"}</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </div>
      )}
      {open === "history" && (
        <ol className="js-peak-history-list" style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 11.5, maxWidth: 360, whiteSpace: "normal", fontFamily: "inherit" }}>
          {history === null ? <li className="muted">Loading…</li> : history.length === 0 ? <li className="muted">No recorded attempts yet (history starts with this release).</li>
            : history.map((h, i) => (
              <li key={i}>
                {new Date(h.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })} · {h.by} · {describe(h)}
              </li>
            ))}
        </ol>
      )}
      {err && <div role="alert" style={{ color: "var(--danger)", whiteSpace: "pre-line", maxWidth: 320 }}>{err}</div>}
    </div>
  );
}

function describe(h: HistoryRow): string {
  const d = h.detail ?? {};
  const to = labels[String(d.to ?? "")] ?? String(d.to ?? "");
  if (h.action === "advance.peak.retry") return "Retry requested";
  if (h.action === "advance.peak.resolve") return d.outcome === "FOUND" ? `Resolved: found in PEAK as ${String(d.documentNo)} — "${String(d.reason)}"` : `Resolved: not in PEAK, sent again — "${String(d.reason)}"`;
  return `${to}${d.documentNo ? ` · ${String(d.documentNo)}` : ""}${d.error ? ` · ${String(d.error)}` : ""}`;
}
