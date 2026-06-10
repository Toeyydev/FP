"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { isOnline, lastSeenLabel } from "@/lib/presence";

type Row = { id: string; guideId: string; name: string; languages: string; tours: number; rating: number | null; ratingCount: number; leave: string | null; lastSeenAt: string | null; offerBlocked: boolean };

export default function Guides() {
  const [rows, setRows] = useState<Row[]>([]);
  const load = () => fetch("/api/guides", { cache: "no-store" }).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => {});
  useEffect(() => { load(); }, []);
  async function toggleBlock(g: Row) {
    if (!g.offerBlocked && !confirm(`Block ${g.guideId} ${g.name} from receiving job offers?\n\nThey stay active and keep their current tours, but won't be offered new jobs until you unblock them.`)) return;
    await fetch("/api/guides", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: g.id, offerBlocked: !g.offerBlocked }) });
    await load();
  }

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
            <thead><tr><th>Guide</th><th>Presence</th><th>Languages</th><th className="r">Tours</th><th className="r">Rating</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={7} className="op-empty">No guides.</td></tr> : rows.map((g) => (
                <tr key={g.guideId}>
                  <td style={{ whiteSpace: "nowrap" }}><span className="gid">{g.guideId}</span> {g.name}</td>
                  <td style={{ whiteSpace: "nowrap" }}><span className={`presence-dot ${isOnline(g.lastSeenAt) ? "on" : "off"}`} />{isOnline(g.lastSeenAt) ? <b style={{ fontSize: 12, color: "var(--green)" }}>Online</b> : <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{lastSeenLabel(g.lastSeenAt)}</span>}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{g.languages || "—"}</td>
                  <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{g.tours}</td>
                  <td className="r">{g.rating != null ? <span style={{ fontWeight: 700 }}>★ {g.rating} <small style={{ color: "var(--ink-soft)", fontWeight: 400 }}>({g.ratingCount})</small></span> : <span style={{ color: "var(--ink-soft)" }}>—</span>}</td>
                  <td>{g.offerBlocked
                    ? <span className="leave-badge" style={{ background: "var(--danger-bg)", color: "var(--danger)", borderColor: "var(--danger-line)" }}>No offers</span>
                    : g.leave ? <span className="leave-badge">On leave {g.leave}</span>
                    : <span style={{ color: "var(--green)", fontSize: 12, fontWeight: 600 }}>Active</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className={`btn sm ${g.offerBlocked ? "primary" : "danger"}`} onClick={() => toggleBlock(g)}>{g.offerBlocked ? "Unblock" : "Block offers"}</button>
                      <a className="btn sm" href={`/profile?userId=${g.id}`}>Profile</a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
