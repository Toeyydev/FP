"use client";

import { Fragment, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { isOnline, lastSeenLabel } from "@/lib/presence";

type Row = { id: string; guideId: string; name: string; languages: string; tours: number; leave: string | null; lastSeenAt: string | null; offerBlocked: boolean; email: string; fullName: string; phone: string; taxId: string; address: string; lineLinked: boolean; hasPush: boolean; hasEmail: boolean };

// Which channels a job offer can reach this guide on. LINE / push are "fast" (a
// phone ping); email is the slow fallback. No fast channel → flag it, because a
// day-of offer can easily be missed.
function Reach({ g }: { g: Row }) {
  const fast = g.lineLinked || g.hasPush;
  const chips: string[] = [];
  if (g.lineLinked) chips.push("LINE");
  if (g.hasPush) chips.push("Push");
  if (g.hasEmail) chips.push("Email");
  if (fast) return <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{chips.join(" · ")}</span>;
  return (
    <span className="leave-badge" style={{ background: "var(--danger-bg)", color: "var(--danger)", borderColor: "var(--danger-line)" }}
      title="No LINE and no app notifications — job offers only reach this guide by email (or not at all). Ask them to connect LINE or install the app.">
      ⚠ {g.hasEmail ? "Email only" : "Unreachable"}
    </span>
  );
}
type EditForm = { email: string; fullName: string; phone: string; taxId: string; address: string };

export default function Guides() {
  const [rows, setRows] = useState<Row[]>([]);
  const load = () => fetch("/api/guides", { cache: "no-store" }).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => {});
  useEffect(() => { load(); }, []);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm>({ email: "", fullName: "", phone: "", taxId: "", address: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  function startEdit(g: Row) {
    setEditId(g.id); setMsg("");
    setForm({ email: g.email || "", fullName: g.fullName || g.name || "", phone: g.phone || "", taxId: g.taxId || "", address: g.address || "" });
  }
  async function saveProfile(id: string) {
    setBusy(true); setMsg("");
    const r = await fetch("/api/guides", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...form }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.hint || (d.error === "email-in-use" ? "That email is already in use." : "Couldn't save.")); return; }
    setEditId(null); await load();
  }

  async function toggleBlock(g: Row) {
    if (!g.offerBlocked && !confirm(`Block ${g.guideId} ${g.name} from receiving job offers?\n\nThey stay active and keep their current tours, but won't be offered new jobs until you unblock them.`)) return;
    await fetch("/api/guides", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: g.id, offerBlocked: !g.offerBlocked }) });
    await load();
  }

  const lbl: React.CSSProperties = { display: "grid", gap: 4, fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" };
  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Guides</span></div>
        <div className="nav"><a className="btn sm" href="/">Board</a><a className="btn sm" href="/tour-log">Tour log</a></div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Guide directory</h2><span className="hint">{rows.length} active · ranked by completed tours</span></div>
        <div className="grid-scroll">
          <table className="acct-table">
            <thead><tr><th>Guide</th><th>Presence</th><th>Reach</th><th>Languages</th><th className="r">Tours</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={8} className="op-empty">No guides.</td></tr> : rows.map((g) => (
                <Fragment key={g.guideId}>
                <tr>
                  <td style={{ whiteSpace: "nowrap" }}><span className="gid">{g.guideId}</span> {g.name}</td>
                  <td style={{ whiteSpace: "nowrap" }}><span className={`presence-dot ${isOnline(g.lastSeenAt) ? "on" : "off"}`} />{isOnline(g.lastSeenAt) ? <b style={{ fontSize: 12, color: "var(--green)" }}>Online</b> : <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{lastSeenLabel(g.lastSeenAt)}</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}><Reach g={g} /></td>
                  <td style={{ color: "var(--ink-soft)" }}>{g.languages || "—"}</td>
                  <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{g.tours}</td>
                  <td>{g.offerBlocked
                    ? <span className="leave-badge" style={{ background: "var(--danger-bg)", color: "var(--danger)", borderColor: "var(--danger-line)" }}>No offers</span>
                    : g.leave ? <span className="leave-badge">On leave {g.leave}</span>
                    : <span style={{ color: "var(--green)", fontSize: 12, fontWeight: 600 }}>Active</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn sm" onClick={() => (editId === g.id ? setEditId(null) : startEdit(g))}>{editId === g.id ? "Close" : "✏️ Edit"}</button>
                      <button className={`btn sm ${g.offerBlocked ? "primary" : "danger"}`} onClick={() => toggleBlock(g)}>{g.offerBlocked ? "Unblock" : "Block offers"}</button>
                    </div>
                  </td>
                </tr>
                {editId === g.id && (
                  <tr><td colSpan={8} style={{ background: "var(--grey-bg,#f7f8f7)", padding: 14 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                      <label style={lbl}>E-mail (login){g.email?.endsWith(".folkpath.local") ? <span style={{ color: "var(--danger)", fontWeight: 600 }}> · placeholder</span> : null}<input className="search" type="email" value={form.email} onChange={(e) => setForm((x) => ({ ...x, email: e.target.value }))} placeholder="name@email.com" /></label>
                      <label style={lbl}>Full name<input className="search" value={form.fullName} onChange={(e) => setForm((x) => ({ ...x, fullName: e.target.value }))} /></label>
                      <label style={lbl}>Phone<input className="search" value={form.phone} onChange={(e) => setForm((x) => ({ ...x, phone: e.target.value }))} /></label>
                      <label style={lbl}>Tax ID<input className="search" value={form.taxId} onChange={(e) => setForm((x) => ({ ...x, taxId: e.target.value }))} /></label>
                      <label style={{ ...lbl, gridColumn: "1 / -1" }}>Address<input className="search" value={form.address} onChange={(e) => setForm((x) => ({ ...x, address: e.target.value }))} /></label>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
                      <button className="btn primary" disabled={busy} onClick={() => saveProfile(g.id)}>{busy ? "Saving…" : "Save profile"}</button>
                      <button className="btn ghost" onClick={() => setEditId(null)}>Cancel</button>
                      {msg && <span style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)" }}>{msg}</span>}
                    </div>
                  </td></tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
