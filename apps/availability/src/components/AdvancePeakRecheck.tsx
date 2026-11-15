"use client";

import { useState } from "react";

// Read-only re-check of every Company ADV journal FolkOPS holds as in PEAK, against PEAK as it is
// now (POST /api/advances/peak-sync/recheck). ADMIN / ACCOUNTANT. Flags mismatches; changes nothing.
type Row = { id: string; kind: string; documentNo: string; via: "SENT" | "LINKED"; result: "MATCH" | "MISMATCH" | "NOT_FOUND" | "UNCHECKED"; reasons: string[] };
type Res = { checkedAt: string; summary: { total: number; match: number; mismatch: number; notFound: number; unchecked: number }; rows: Row[] };

const LABEL: Record<Row["result"], string> = { MATCH: "Matches", MISMATCH: "Mismatch", NOT_FOUND: "Not in PEAK", UNCHECKED: "Not checked" };
const TONE: Record<Row["result"], string> = { MATCH: "var(--green)", MISMATCH: "var(--danger)", NOT_FOUND: "var(--danger)", UNCHECKED: "var(--ink-soft)" };

export default function AdvancePeakRecheck() {
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [all, setAll] = useState(false);
  const run = async () => {
    setBusy(true); setErr("");
    const r = await fetch("/api/advances/peak-sync/recheck", { method: "POST" }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    setBusy(false);
    if (!r?.ok || !d) { setErr(d?.reasons?.join("\n") ?? "Couldn't reach the server — try again"); return; }
    setRes(d);
  };
  const shown = res ? res.rows.filter((x) => all || x.result !== "MATCH") : [];
  return (
    <section className="js-peak-recheck" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Check journals against PEAK</h3>
        <button type="button" className="btn sm js-peak-recheck-run" disabled={busy} onClick={run}>{busy ? "Checking…" : "Re-check now"}</button>
        <span className="muted" style={{ fontSize: 12 }}>Reads PEAK only — nothing is changed in PEAK or FolkOPS.</span>
      </div>
      {err && <div role="alert" style={{ color: "var(--danger)", whiteSpace: "pre-line", marginTop: 6 }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 8 }}>
          <div className="js-peak-recheck-summary" style={{ fontSize: 13 }}>
            {res.summary.total} journal{res.summary.total === 1 ? "" : "s"} · <b style={{ color: "var(--green)" }}>{res.summary.match} match</b>
            {res.summary.mismatch > 0 && <> · <b style={{ color: "var(--danger)" }}>{res.summary.mismatch} mismatch</b></>}
            {res.summary.notFound > 0 && <> · <b style={{ color: "var(--danger)" }}>{res.summary.notFound} not in PEAK</b></>}
            {res.summary.unchecked > 0 && <> · {res.summary.unchecked} not checked</>}
            {" "}<label style={{ marginLeft: 8, fontSize: 12 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> show matches too</label>
          </div>
          {shown.length > 0 ? (
            <div className="tablewrap" style={{ overflowX: "auto", marginTop: 6 }}>
              <table className="adv-table" style={{ fontSize: 12.5 }}>
                <thead><tr><th>Journal</th><th>Movement</th><th>How</th><th>Result</th></tr></thead>
                <tbody>{shown.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{x.documentNo}</td>
                    <td>{x.kind === "ADVANCE" ? "Advance" : x.kind === "RETURN" ? "Return" : "Settlement"}</td>
                    <td>{x.via === "SENT" ? "Sent by FolkOPS" : "Linked"}</td>
                    <td><b style={{ color: TONE[x.result] }}>{LABEL[x.result]}</b>{x.reasons.length > 0 && <div className="muted" style={{ whiteSpace: "normal", maxWidth: 360 }}>{x.reasons.join(" · ")}</div>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Everything FolkOPS holds as in PEAK matches PEAK.</div>}
        </div>
      )}
    </section>
  );
}
