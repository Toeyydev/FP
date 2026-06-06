"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Row = { guideId: string; name: string; languages: string; tours: number; rating: number | null; ratingCount: number; leave: string | null };

export default function Guides() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { fetch("/api/guides", { cache: "no-store" }).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => {}); }, []);

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Guides</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/tour-log">Tour log</a></div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Guide directory</h2><span className="hint">{rows.length} active · rated by completed tours</span></div>
        <div className="grid-scroll">
          <table className="acct-table">
            <thead><tr><th>Guide</th><th>Languages</th><th className="r">Tours</th><th className="r">Rating</th><th>Status</th></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={5} className="op-empty">No guides.</td></tr> : rows.map((g) => (
                <tr key={g.guideId}>
                  <td style={{ whiteSpace: "nowrap" }}><span className="gid">{g.guideId}</span> {g.name}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{g.languages || "—"}</td>
                  <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{g.tours}</td>
                  <td className="r">{g.rating != null ? <span style={{ fontWeight: 700 }}>★ {g.rating} <small style={{ color: "var(--ink-soft)", fontWeight: 400 }}>({g.ratingCount})</small></span> : <span style={{ color: "var(--ink-soft)" }}>—</span>}</td>
                  <td>{g.leave ? <span className="leave-badge">On leave {g.leave}</span> : <span style={{ color: "var(--green)", fontSize: 12, fontWeight: 600 }}>Active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
