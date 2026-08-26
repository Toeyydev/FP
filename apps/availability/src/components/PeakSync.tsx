"use client";

import { useCallback, useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import OperatorNav from "@/components/OperatorNav";

// Operational PEAK monitoring — no credentials, no developer config. Shows the
// integration's real state honestly: today PEAK refs are recorded manually on
// Payments; auto-posting stays dormant until credentials + account chart are set
// and the accountant signs off. Page load makes NO external calls; "Test
// connection" explicitly hits the PEAK sandbox via the existing test endpoint.
type Row = { guideId: string; guide: string; date: string; slotIdx: number; time: string; ref: string | null; amount: number; peakRef: string | null; paidAt: string | null; batchNo: string | null };
type Data = {
  period: string;
  config: { configured: boolean; enabled: boolean; chartReady: boolean; sandbox: boolean };
  refs: { total: number; synced: number; missing: Row[]; recorded: Row[] };
};

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const Dot = ({ on }: { on: boolean }) => <span className="att-dot" style={{ background: on ? "var(--green)" : "var(--grey)" }} />;

export default function PeakSync({ canEdit }: { canEdit: boolean }) {
  const thisMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const [period, setPeriod] = useState(thisMonth);
  const [d, setD] = useState<Data | null>(null);
  const [test, setTest] = useState<{ busy: boolean; msg: string; ok?: boolean }>({ busy: false, msg: "" });
  const [showRecorded, setShowRecorded] = useState(false);

  const load = useCallback(async (p: string) => {
    setD(null);
    const r = await fetch(`/api/peak/status?period=${p}`, { cache: "no-store" });
    if (r.ok) setD(await r.json());
  }, []);
  useEffect(() => { load(period); }, [period, load]);

  // Live connection check — the only thing on this page that talks to PEAK.
  // /api/peak/test-connection performs the Client Token handshake ONLY: no contact
  // lookup, no expense, no database access. It reports a rejection as a 502 (and a
  // misconfigured deploy as a 503) whose body still carries PEAK's own reason, so the
  // body is read BEFORE the status is judged — bailing on !r.ok would throw away the
  // one thing this button exists to show.
  async function testConnection() {
    setTest({ busy: true, msg: "Contacting PEAK…" });
    try {
      const r = await fetch("/api/peak/test-connection", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) { setTest({ busy: false, ok: false, msg: "Test failed — operator access required." }); return; }
      // Which endpoint we reached comes from the status feed's own base-URL check;
      // the connection test deliberately returns nothing but the verdict.
      if (j.connected) { setTest({ busy: false, ok: true, msg: `Connected ✓ (${d?.config && !d.config.sandbox ? "production" : "sandbox"})` }); return; }
      // PEAK's own resDesc (already sanitised server-side) plus its result code —
      // that pair is what distinguishes a bad key from a bad timestamp or wrong host.
      const why = [j.error, j.peakCode ? `code ${j.peakCode}` : ""].filter(Boolean).join(" · ");
      setTest({ busy: false, ok: false, msg: `Not connected — ${why || `PEAK rejected the request (HTTP ${r.status})`}` });
    } catch { setTest({ busy: false, ok: false, msg: "Network error contacting the server." }); }
  }

  const cfg = d?.config;
  const autoReady = !!(cfg?.enabled && cfg?.chartReady);

  return (
    <div className="op-layout">
      <OperatorNav active="peak-sync" />
      <div className="op-main">
        <div className="subtabs"><span className="subtab active">PEAK sync</span></div>

        {/* Integration state — booleans only, never credentials. */}
        <section className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head"><h2>PEAK accounting</h2>
            <span className="hint">{autoReady ? "auto-posting configured" : "reference tracking — auto-posting dormant"}</span>
            {canEdit && <button className="btn sm" style={{ marginLeft: "auto" }} disabled={test.busy} onClick={testConnection} title="Contacts the PEAK API once to verify the credentials work">{test.busy ? "Testing…" : "Test connection"}</button>}
          </div>
          <div style={{ padding: "10px 16px 14px", display: "grid", gap: 7, fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Dot on={!!cfg?.configured} /> Developer credentials {cfg?.configured ? "set" : "not set"}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Dot on={!!cfg?.enabled} /> Owner user token {cfg?.enabled ? "set" : "not set"}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Dot on={!!cfg?.chartReady} /> Account chart mapping {cfg?.chartReady ? "configured" : "not configured"}</div>
            {cfg && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="att-dot" style={{ background: cfg.sandbox ? "var(--assign)" : "var(--green)" }} /> Endpoint: {cfg.sandbox ? "UAT sandbox" : "production"}</div>}
            {test.msg && <div style={{ fontWeight: 600, color: test.ok ? "var(--green)" : "var(--danger)" }}>{test.msg}</div>}
            {!autoReady && <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5 }}>
              Until credentials and the account chart are set (and the accountant confirms the mapping), EXP- expense refs are recorded manually on <a href="/payments">Payments</a>. Nothing here blocks paying guides.
            </div>}
          </div>
        </section>

        {/* Reference coverage — the operational to-do: paid tours missing a ref. */}
        <section className="panel">
          <div className="op-toolbar" style={{ gap: 10 }}>
            <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Month</label>
            <input className="search" style={{ flex: "none", width: 160 }} type="month" value={period} max={thisMonth} onChange={(e) => setPeriod(e.target.value)} />
            {d && <span style={{ marginLeft: "auto", fontSize: 13 }}>
              {d.refs.total === 0 ? "No paid tours this month." : d.refs.synced === d.refs.total
                ? <span className="ob ok">✓ PEAK {d.refs.synced}/{d.refs.total} recorded</span>
                : <span className="ob warn">⚠ {d.refs.total - d.refs.synced} of {d.refs.total} missing a ref</span>}
            </span>}
          </div>
          {!d ? <div style={{ padding: 14 }}>{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel-row" />)}</div> : (
            <>
              {d.refs.missing.length > 0 && (
                <div className="grid-scroll" style={{ padding: "0 8px 10px" }}>
                  <table className="acct-table">
                    <thead><tr><th>Paid tour</th><th>Job No.</th><th>Guide</th><th className="r">Amount</th><th>Batch</th><th /></tr></thead>
                    <tbody>
                      {d.refs.missing.map((r, i) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: "nowrap" }}>{dShort(r.date)} · {r.time}</td>
                          <td style={{ fontFamily: "monospace", fontSize: 12 }}>{r.ref || "—"}</td>
                          <td>{r.guide}</td>
                          <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{thb(r.amount)}</td>
                          <td style={{ fontFamily: "monospace", fontSize: 11.5 }}>{r.batchNo || "—"}</td>
                          <td style={{ textAlign: "right" }}><a className="btn sm" href="/payments" title="Record the EXP- ref on the Payments row">Record ref</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {d.refs.recorded.length > 0 && (
                <div style={{ padding: "0 14px 12px" }}>
                  <button className="btn sm ghost" onClick={() => setShowRecorded((s) => !s)}>{showRecorded ? "Hide" : "Show"} recorded ({d.refs.recorded.length})</button>
                  {showRecorded && (
                    <table className="acct-table" style={{ marginTop: 8 }}>
                      <thead><tr><th>Paid tour</th><th>Job No.</th><th>Guide</th><th className="r">Amount</th><th>PEAK ref</th></tr></thead>
                      <tbody>
                        {d.refs.recorded.map((r, i) => (
                          <tr key={i}>
                            <td style={{ whiteSpace: "nowrap" }}>{dShort(r.date)} · {r.time}</td>
                            <td style={{ fontFamily: "monospace", fontSize: 12 }}>{r.ref || "—"}</td>
                            <td>{r.guide}</td>
                            <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{thb(r.amount)}</td>
                            <td style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: "var(--primary)" }}>{r.peakRef}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
              {d.refs.total === 0 && <div className="op-empty" style={{ padding: 18 }}>No paid tours in {period} yet.</div>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
