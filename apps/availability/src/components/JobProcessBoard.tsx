"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";
import type { ProcessLane, ProcessStage } from "@/lib/job-process";
import type { ProcessJob } from "@/lib/job-process-server";

// The process as a swimlane board: the TO-BE path left to right, each step drawn in the lane
// of whoever has to do it, with how many jobs are standing on it. A decline or an expired
// offer is drawn under "Offer sent", in the admin's lane — the arrow back in the TO-BE flow.
// Everything shown is derived by lib/job-process from facts other screens own; nothing is
// decided or changed here.

type StageInfo = { stage: ProcessStage; lane: ProcessLane; label: string; th: string; next: string; nextTh: string };
type Data = { from: string; to: string; today: string; jobs: ProcessJob[]; counts: Record<ProcessStage, number>; stages: StageInfo[] };

// One column per step of the path; OFFER_RETURNED shares the offer's column.
const PATH: ProcessStage[] = ["BOOKING_RECEIVED", "OFFER_SENT", "ASSIGNED", "CHECKED_IN", "AWAITING_REPORT", "AWAITING_REVIEW", "AWAITING_TRANSFER", "AWAITING_PEAK", "CLOSED"];
const COLUMN: Record<ProcessStage, number> = { ...Object.fromEntries(PATH.map((s, i) => [s, i])), OFFER_RETURNED: 1 } as Record<ProcessStage, number>;
const LANES: { lane: ProcessLane; label: string; th: string }[] = [
  { lane: "ADMIN", label: "Admin · FolkOPS Web", th: "แอดมิน" },
  { lane: "GUIDE", label: "Guide · FolkOPS App", th: "ไกด์" },
];
const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function JobProcessBoard() {
  const [data, setData] = useState<Data | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pick, setPick] = useState<ProcessStage | "ADMIN" | "GUIDE" | "OPEN">("OPEN");
  const [error, setError] = useState("");

  const load = useCallback(async (f?: string, t?: string) => {
    const p = new URLSearchParams();
    if (f) p.set("from", f);
    if (t) p.set("to", t);
    const r = await fetch(`/api/process?${p.toString()}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError((d.reasons ?? []).join(" ") || `Could not load the process (${r.status})`); return; }
    setError(""); setData(d); setFrom(d.from); setTo(d.to);
  }, []);
  useEffect(() => { load(); }, [load]);
  // Opened from a Dashboard task (?stage=AWAITING_REVIEW …): start on that step.
  useEffect(() => {
    const st = new URLSearchParams(window.location.search).get("stage");
    if (st && /^[A-Z_]+$/.test(st)) setPick(st as ProcessStage);
  }, []);

  const jobs = data?.jobs ?? [];
  const info = (s: ProcessStage) => data?.stages.find((x) => x.stage === s);
  const count = (s: ProcessStage) => data?.counts[s] ?? 0;
  const waitingOn = (lane: ProcessLane) => jobs.filter((j) => j.lane === lane).length;
  const shown = jobs.filter((j) => pick === "OPEN" ? j.stage !== "CLOSED" : pick === "ADMIN" || pick === "GUIDE" ? j.lane === pick : j.stage === pick);
  const title = pick === "OPEN" ? "Every open job" : pick === "ADMIN" ? "Waiting on the admin" : pick === "GUIDE" ? "Waiting on a guide" : info(pick)?.label ?? pick;

  const node = (s: ProcessStage) => {
    const i = info(s);
    const n = count(s);
    return (
      <button key={s} type="button" className={`proc-node${pick === s ? " on" : ""}${n ? "" : " empty"}${s === "OFFER_RETURNED" ? " back" : ""}${s === "CLOSED" ? " done" : ""}`}
        data-stage={s} title={i ? `${i.next} · ${i.nextTh}` : s} onClick={() => setPick(pick === s ? "OPEN" : s)}>
        <b className="num">{n}</b>
        <span>{i?.label ?? s}</span>
        <small>{i?.th}</small>
      </button>
    );
  };

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="process" />
        <div className="op-main">
          <div id="appBar"><div className="subtabs"><span className="subtab active">Job process</span></div>
            <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/payments">Payments</a></div>
          </div>

          <section className="panel" style={{ marginBottom: 14 }}>
            <div className="op-toolbar" style={{ gap: 8 }}>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Tours from</label>
              <input className="search" style={{ flex: "none", width: 150 }} type="date" name="from" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value && to) load(e.target.value, to); }} />
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>to</label>
              <input className="search" style={{ flex: "none", width: 150 }} type="date" name="to" value={to} onChange={(e) => { setTo(e.target.value); if (from && e.target.value) load(from, e.target.value); }} />
              <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" className={`btn sm${pick === "ADMIN" ? " primary" : ""} js-proc-admin`} onClick={() => setPick(pick === "ADMIN" ? "OPEN" : "ADMIN")}>Waiting on admin · {waitingOn("ADMIN")}</button>
                <button type="button" className={`btn sm${pick === "GUIDE" ? " primary" : ""} js-proc-guide`} onClick={() => setPick(pick === "GUIDE" ? "OPEN" : "GUIDE")}>Waiting on guides · {waitingOn("GUIDE")}</button>
              </span>
            </div>
            {error && <div className="pay-drift" role="alert" style={{ margin: "0 14px 10px" }}>{error}</div>}
            {/* Booking → offer → tour → report → review → transfer → PEAK, by who acts. */}
            <div className="grid-scroll">
              <div className="proc-board" role="group" aria-label="The process, by who has to act">
                {LANES.map((l) => (
                  <div key={l.lane} className="proc-lane" data-lane={l.lane}>
                    <div className="proc-lane-name"><b>{l.label}</b><small>{l.th}</small></div>
                    {PATH.map((_, col) => {
                      const here = (Object.keys(COLUMN) as ProcessStage[]).filter((s) => COLUMN[s] === col && (info(s)?.lane === l.lane || (s === "CLOSED" && l.lane === "ADMIN")));
                      return <div key={col} className="proc-cell">{here.map(node)}</div>;
                    })}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{title}</h2><span className="hint">{shown.length} job{shown.length === 1 ? "" : "s"}{pick !== "OPEN" && <> · <button type="button" className="js-proc-all" style={{ border: 0, background: "none", color: "var(--primary)", cursor: "pointer", font: "inherit", textDecoration: "underline", padding: 0 }} onClick={() => setPick("OPEN")}>show every open job</button></>}</span></div>
            <div className="grid-scroll">
              <table className="acct-table js-proc-table">
                <thead><tr><th>Tour date</th><th>Tour</th><th>Guide</th><th className="r">Guests</th><th>Stage</th><th>Next step</th><th>Waiting</th><th /></tr></thead>
                <tbody>
                  {data && shown.length === 0 && <tr><td colSpan={8} className="op-empty">Nothing is standing on this step.</td></tr>}
                  {shown.map((j) => (
                    <tr key={j.key} data-stage={j.stage}>
                      <td style={{ whiteSpace: "nowrap" }}>{dShort(j.date)} · {j.time}</td>
                      <td>{j.tour}{j.jobNo && <small style={{ display: "block", fontFamily: "monospace", fontSize: 11, color: "var(--ink-soft)" }}>{j.jobNo}</small>}</td>
                      <td>{j.guideId ? <><span className="gid">{j.guideId}</span> {j.guide}</> : <i style={{ color: "var(--danger)" }}>No guide</i>}</td>
                      <td className="r num">{j.pax || "—"}</td>
                      <td><span className={`proc-chip lane-${j.lane.toLowerCase()}`}>{j.label}</span><small style={{ display: "block", fontSize: 11, color: "var(--ink-soft)" }}>{j.th}</small></td>
                      <td style={{ fontSize: 12.5 }}>{j.next}<small style={{ display: "block", color: "var(--ink-soft)" }}>{j.nextTh}</small></td>
                      <td className="num" style={{ whiteSpace: "nowrap", color: (j.waitingDays ?? 0) > 3 ? "var(--danger)" : "var(--ink-soft)" }}>{j.waitingDays == null ? "—" : j.waitingDays === 0 ? "today" : `${j.waitingDays} d`}</td>
                      <td style={{ textAlign: "right" }}><a className="btn sm" href={j.href}>Open</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
