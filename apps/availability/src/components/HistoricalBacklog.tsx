"use client";

import { useCallback, useEffect, useState } from "react";
import { loadBacklog } from "@/lib/historical-backlog-load";
import { useSession } from "next-auth/react";
import {
  applyGeneration, dryRunGeneration, isConfirmationValid,
  REQUIRED_CONFIRMATION, type DryRun,
} from "@/lib/historical-generate";

type Row = {
  id: string; instanceKey: string; date: string; slotIdx: number;
  tourName: string | null; reviewStatus: string;
  confirmedGuideId: string | null; guideName: string | null;
  jobSheetId: string | null; jobSheet: { ref: string | null; status: string; origin: string } | null;
  exclusionReason: string | null; reviewNotes: string | null;
  bookingRefs: string[]; bookingsDeleted: number;
  missingInfo: string[];
  auditSnapshot: { livePax?: number; channels?: string[]; bookingStatuses?: string[]; archivedCount?: number } | null;
};
type Data = {
  month: string;
  totals: { backlog: number; existingJobSheets: number; tourInstances: number };
  guides: { guideId: string; displayName: string }[];
  rows: Row[];
};

const SLOT_TIME: Record<number, string> = { 0: "08:30", 1: "10:00", 2: "13:30", 3: "14:00", 4: "15:00", 5: "17:30" };

// Colour carries state so a queue of 53 can be scanned rather than read.
const TONE: Record<string, string> = {
  NEEDS_REVIEW: "pending", CONFIRMED_OPERATED: "active", CUSTOMER_NO_SHOW: "active",
  CONFIRMED_CANCELLED: "muted", EXCLUDED: "muted", GUIDE_UNKNOWN: "invited",
  NEEDS_EVIDENCE: "invited", READY_TO_RECONSTRUCT: "active",
  RECONSTRUCTED_DRAFT: "invited", COMPLETED: "active",
};

export default function HistoricalBacklog() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The route is the authority on who may generate; this only decides whether to
  // show the control, so an operator is not offered a button that would 403.
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";
  const [dry, setDry] = useState<DryRun | null>(null);
  const [typed, setTyped] = useState("");
  const [genBusy, setGenBusy] = useState<"dry" | "apply" | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [genDone, setGenDone] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    const res = await loadBacklog<Data>();
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function runDryRun() {
    setGenBusy("dry"); setGenError(null); setGenDone(null);
    const r = await dryRunGeneration();
    setGenBusy(null);
    if (r.ok) setDry(r.data); else setGenError(r.error);
  }

  async function runApply() {
    // Guarded here as well as by the disabled button: a keyboard submit must not
    // slip past, and the route would reject it anyway.
    if (!isConfirmationValid(typed) || genBusy) return;
    setGenBusy("apply"); setGenError(null);
    const r = await applyGeneration(fetch, typed);
    setGenBusy(null);
    if (!r.ok) { setGenError(r.error); return; }   // 409 included — never retried here
    setGenDone(`Created ${r.data.created} review${r.data.created === 1 ? "" : "s"}.`);
    setDry(null); setTyped("");
    await load();   // bring the new rows on screen
  }

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(id); setMsg("");
    const r = await fetch("/api/historical", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action, ...extra }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setMsg(errorText(d.error)); return; }
    await load();
  }

  async function reconstruct(id: string) {
    setBusy(id); setMsg("");
    const r = await fetch("/api/historical/reconstruct", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setMsg(errorText(d.error)); return; }
    setMsg("Historical draft created — open it to fill in what you can verify.");
    await load();
  }

  // Before the loading fallback, or a failure is indistinguishable from a slow
  // load — which is exactly how a 403 spent an afternoon looking like a hang.
  if (error) {
    return (
      <div className="op-empty" style={{ padding: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "var(--danger)" }}>{error}</span>
        <button className="btn sm" onClick={() => { void load(); }}>Retry</button>
      </div>
    );
  }
  if (!data) return <div className="op-empty" style={{ padding: 16 }}>Loading the historical backlog…</div>;

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="hb-totals">
        <div><b>{data.totals.tourInstances}</b><span>May tour instances</span></div>
        <div><b>{data.totals.existingJobSheets}</b><span>already have a Job Sheet</span></div>
        <div><b>{data.totals.backlog}</b><span>in this backlog</span></div>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        These tours have no Job Sheet. The imported records cannot say whether a tour ran —
        an archived booking only means someone hid it from the inbox — so nothing here is
        confirmed until you confirm it. No guide is ever guessed.
      </p>
      {msg && <div className="hint" style={{ color: "var(--danger)" }}>{msg}</div>}

      {data.rows.length === 0 ? (
        <div className="op-empty" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <span>Nothing in the backlog for {data.month}.{!isAdmin && " An admin prepares it."}</span>

          {isAdmin && !dry && (
            <button className="btn sm primary" disabled={genBusy === "dry"} onClick={runDryRun}>
              {genBusy === "dry" ? "Checking…" : `Prepare ${data.month} backlog`}
            </button>
          )}

          {isAdmin && dry && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", width: "100%", maxWidth: 520 }}>
              {/* Counts first: nothing is written until the operator has seen them. */}
              <div style={{ fontSize: 13 }}>
                This will create <b>{dry.wouldCreate}</b> review{dry.wouldCreate === 1 ? "" : "s"}.{" "}
                <span style={{ color: "var(--ink-soft)" }}>
                  {dry.skippedExistingSheet} instance{dry.skippedExistingSheet === 1 ? "" : "s"} already
                  {dry.skippedExistingSheet === 1 ? " has" : " have"} a job sheet and {dry.skippedExistingSheet === 1 ? "is" : "are"} skipped,
                  out of {dry.tourInstances} tour instances.
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                Nothing has been written yet. Type <code>{REQUIRED_CONFIRMATION}</code> to confirm.
              </div>
              <input
                className="search" style={{ width: "100%", maxWidth: 260, fontFamily: "monospace" }}
                value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder={REQUIRED_CONFIRMATION} autoComplete="off" spellCheck={false}
                aria-label="Type the confirmation phrase"
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn sm primary"
                  disabled={!isConfirmationValid(typed) || genBusy === "apply"}
                  onClick={runApply}
                >
                  {genBusy === "apply" ? "Generating…" : `Generate ${dry.wouldCreate} review${dry.wouldCreate === 1 ? "" : "s"}`}
                </button>
                <button className="btn sm ghost" disabled={genBusy === "apply"} onClick={() => { setDry(null); setTyped(""); setGenError(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {genError && <span style={{ color: "var(--danger)", fontSize: 12.5 }}>{genError}</span>}
          {genDone && <span style={{ color: "var(--green,#2f7d4f)", fontSize: 12.5 }}>{genDone}</span>}
        </div>
      ) : (
        <div className="js-table-scroll">
          <table className="acct-table">
            <thead><tr>
              <th>Date</th><th>Time</th><th>Tour</th><th className="r">Guests</th>
              <th>Booking refs</th><th>Guide</th><th>Job Sheet</th><th>Status</th><th />
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.date}</td>
                  <td className="mono">{SLOT_TIME[r.slotIdx] ?? `slot ${r.slotIdx}`}</td>
                  <td>{r.tourName ?? <span style={{ color: "var(--ink-soft)" }}>unmapped product</span>}</td>
                  <td className="r">{r.auditSnapshot?.livePax ?? "—"}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                    {r.bookingRefs.slice(0, 2).join(" ") || "—"}
                    {r.bookingRefs.length > 2 ? ` +${r.bookingRefs.length - 2}` : ""}
                    {r.bookingsDeleted > 0 && <div style={{ color: "var(--danger)" }}>{r.bookingsDeleted} source booking(s) deleted</div>}
                  </td>
                  <td>{r.confirmedGuideId ? `${r.confirmedGuideId} ${r.guideName ?? ""}` : <span style={{ color: "var(--ink-soft)" }}>not identified</span>}</td>
                  <td>{r.jobSheet ? <a href={`/job-sheet?guideId=${r.confirmedGuideId}&date=${r.date}&slotIdx=${r.slotIdx}`}>{r.jobSheet.ref ?? "draft"}</a> : "—"}</td>
                  <td><span className={`tag ${TONE[r.reviewStatus] ?? "muted"}`}>{r.reviewStatus.replace(/_/g, " ").toLowerCase()}</span></td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button className="btn sm ghost" onClick={() => setOpen((m) => ({ ...m, [r.id]: !m[r.id] }))}>
                      {open[r.id] ? "Close" : "Review"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.rows.filter((r) => open[r.id]).map((r) => (
        <ReviewPanel key={r.id} row={r} guides={data.guides} busy={busy === r.id}
          onAct={(a, extra) => act(r.id, a, extra)} onReconstruct={() => reconstruct(r.id)} />
      ))}
    </div>
  );
}

function errorText(code?: string): string {
  switch (code) {
    case "reason-required": return "Give a reason — it is recorded with the decision.";
    case "guide-required": return "Identify the guide first.";
    case "sheet-already-exists": return "A Job Sheet already exists for that guide, date and slot.";
    case "already-reconstructed": return "A draft was already created for this tour.";
    case "admin-only": return "Only an administrator can do that.";
    case "unresolved-duplicate": return "Resolve the possible duplicate first.";
    case "not-ready": return "Mark the record ready to reconstruct first.";
    case "historical-job-requires-reversal": return "That Job Sheet was reconstructed from historical records. An administrator must reverse it first.";
    default: return "That action was refused.";
  }
}

function ReviewPanel({ row, guides, busy, onAct, onReconstruct }: {
  row: Row; guides: { guideId: string; displayName: string }[]; busy: boolean;
  onAct: (action: string, extra?: Record<string, unknown>) => void; onReconstruct: () => void;
}) {
  const [note, setNote] = useState("");
  const [guide, setGuide] = useState(row.confirmedGuideId ?? "");
  const canReconstruct = row.reviewStatus === "READY_TO_RECONSTRUCT" && !!row.confirmedGuideId && !row.jobSheetId;

  return (
    <div className="hb-panel">
      <div className="hb-panel-head">
        <b className="mono">{row.date} · {SLOT_TIME[row.slotIdx] ?? `slot ${row.slotIdx}`}</b>
        <span style={{ color: "var(--ink-soft)" }}>{row.tourName ?? "unmapped product"}</span>
      </div>

      {row.missingInfo.length > 0 && (
        <div className="hint">Still unknown: {row.missingInfo.join(" · ")}. Leave it unknown rather than guessing.</div>
      )}

      <div className="hb-row">
        <label className="fl">Did this tour operate?</label>
        <button className="btn sm" disabled={busy} onClick={() => onAct("confirmOperated")}>It operated</button>{" "}
        <button className="btn sm" disabled={busy} onClick={() => onAct("confirmNoShow")}>Customer no-show</button>{" "}
        <button className="btn sm ghost" disabled={busy || !note.trim()} onClick={() => onAct("confirmCancelled", { reason: note })}>Cancelled — with reason</button>
      </div>

      <div className="hb-row">
        <label className="fl">Who worked it?</label>
        <select className="search" value={guide} onChange={(e) => setGuide(e.target.value)}>
          <option value="">— not identified —</option>
          {guides.map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.displayName}</option>)}
        </select>{" "}
        <button className="btn sm" disabled={busy || !guide} onClick={() => onAct("setGuide", { guideId: guide })}>Set guide</button>{" "}
        <button className="btn sm ghost" disabled={busy} onClick={() => onAct("guideUnknown")}>Nobody remembers</button>
      </div>

      <div className="hb-row">
        <label className="fl">Notes</label>
        <input className="search" style={{ minWidth: 320 }} value={note} placeholder="What you checked, and where you checked it"
          onChange={(e) => setNote(e.target.value)} />{" "}
        <button className="btn sm ghost" disabled={busy || !note.trim()} onClick={() => onAct("addNote", { reason: note })}>Save note</button>{" "}
        <button className="btn sm ghost" disabled={busy || !note.trim()} onClick={() => onAct("needEvidence", { reason: note })}>Needs evidence</button>
      </div>

      <div className="hb-row">
        <button className="btn sm" disabled={busy} onClick={() => onAct("markReady")}>Ready to reconstruct</button>{" "}
        <button className="btn sm danger" disabled={busy || !note.trim()} onClick={() => onAct("exclude", { reason: note })}>Exclude — with reason</button>{" "}
        {canReconstruct && (
          <button className="btn sm primary" disabled={busy} onClick={onReconstruct}>Create historical draft</button>
        )}
      </div>

      {row.jobSheet?.origin === "HISTORICAL_BACKFILL" && (
        <div className="hb-warn">Reconstructed from historical records — not submitted by the guide.</div>
      )}
      {row.exclusionReason && <div className="hint">Excluded: {row.exclusionReason}</div>}
    </div>
  );
}
