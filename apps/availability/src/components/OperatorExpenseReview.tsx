"use client";

// The operator's review panel on the job sheet (owner 2026-11-15; lib/job-expense-review):
//   Company ADV — Entrance tickets — the advance (number, job, guide, amount, date, transfer,
//   guide's confirmation, PEAK journal, settlement) and each ticket row's receipts: Verify,
//   Reject, Ask for a new one, internal note. Verifying never settles the advance.
// The job's full accounting rows stay below, unchanged. The "Tour expenses · guide report" panel
// (Water / Bus / Ferry approve-reject) was removed from the job sheet (owner, 22 Nov 2026): the
// guide's three fixed items are compared with the job's rows in the guide-report comparison below.

import { useState } from "react";
import { expenseAmount, thb, type Expense } from "@/lib/jobsheet";
import { isAdvanceRow, receiptRowStatus } from "@/lib/guide-fixed-expenses";
import type { AttachmentView } from "@/components/ReceiptFiles";

type History = { at: string; action: string; by: string; detail: Record<string, unknown> };
type AdvRow = { id: string; advanceNo: string; amount: number; advanceDate?: string; method: string; status: string | null; acknowledgedAt?: string | Date | null; peakSync?: { status: string; documentNo: string | null } | null };
type Props = {
  sheetKey: { guideId: string; date: string; slotIdx: number };
  jobRef: string | null; guideLabel: string;
  official: Expense[];
  attachments: Record<string, AttachmentView[]>;
  history: History[] | undefined;
  advances: AdvRow[]; settlement: string;
  locked: boolean;
  onChanged: (msg: string) => void | Promise<void>;
};

const chip = (bg: string, line: string, fg: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, color: fg, background: bg, border: `1px solid ${line}`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap", display: "inline-block" });
const OK = chip("var(--green-bg)", "var(--green-line)", "var(--green)"),
  BAD = chip("var(--danger-bg)", "var(--danger-line)", "var(--danger)"), GREY = chip("var(--grey-bg)", "var(--line)", "var(--ink-soft)");
const SYNC: Record<string, string> = { PENDING: "Not synced", SENDING: "Syncing", POSTED: "Synced", BLOCKED: "Failed", UNCERTAIN: "Reconciliation required", CANCELLED: "Cancelled" };
const SETTLE: Record<string, string> = { OPEN: "Open", IN_USE: "In use", RETURN_DUE: "Return due", SETTLED: "Settled", NEEDS_REVIEW: "Needs review", NO_ADVANCE: "—" };
const dt = (v?: string | Date | null) => (v ? new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "");
const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-soft)", textAlign: "left" };
const td: React.CSSProperties = { padding: "10px 8px", borderTop: "1px solid var(--line)", verticalAlign: "top" };
const box: React.CSSProperties = { background: "var(--card,#fff)", border: "1px solid var(--line)", borderRadius: 12, padding: 14, display: "grid", gap: 10, marginBottom: 14 };

async function post(url: string, body: unknown): Promise<string | null> {
  let r: Response;
  try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { return "Offline — try again"; }
  if (r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return (d.reasons ?? [d.error ?? "Couldn't save"]).join("\n");
}

export default function OperatorExpenseReview(p: Props) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<Record<string, string>>({});
  const [showHist, setShowHist] = useState<string | null>(null);

  const advRows = p.official.map((row, index) => ({ row, index })).filter(({ row }) => isAdvanceRow(row));
  const liveAdv = p.advances.filter((a) => a.status !== "VOID");
  const hist = (pred: (h: History) => boolean) => (p.history ?? []).filter(pred);

  async function receipt(rowId: string, action: "VERIFY" | "REJECT" | "REQUEST_NEW" | "NOTE") {
    setBusy(rowId + action); setErr((x) => ({ ...x, [rowId]: "" }));
    const msg = await post("/api/jobsheet/receipt-review", { ...p.sheetKey, rowId, action, note: (notes[rowId] ?? "").trim() || undefined });
    setBusy("");
    if (msg) { setErr((x) => ({ ...x, [rowId]: msg })); return; }
    setNotes((x) => ({ ...x, [rowId]: "" }));
    await p.onChanged(action === "VERIFY" ? "Receipt verified ✓" : action === "NOTE" ? "Note added" : "Sent to the guide");
  }

  return (
    <div className="no-print js-operator-review">
      {(liveAdv.length > 0 || advRows.length > 0) && (
        <section className="js-review-adv" style={box}>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Company ADV — Entrance tickets <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>เงินทดรอง · ค่าบัตร</small></h3>
            <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Not tour expenses · settlement by Admin / Accountant</span>
          </div>
          {liveAdv.length ? liveAdv.map((a) => (
            <div key={a.id} className="js-adv-summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
              {[
                ["Advance", <span key="n" className="mono" style={{ fontWeight: 700 }}>{a.advanceNo}</span>, `${p.jobRef ?? ""} · ${p.guideLabel}`],
                ["Transferred", <b key="a" style={{ fontSize: 16 }}>{thb(a.amount)}</b>, `${a.advanceDate ?? ""} · ${a.method === "bank" ? "✓ Transferred" : a.method}`],
                ["Guide confirmed", <span key="g" style={{ fontWeight: 700, color: a.acknowledgedAt ? "var(--green)" : "var(--ink-soft)" }}>{a.acknowledgedAt ? `✓ ${dt(a.acknowledgedAt)}` : "Not yet"}</span>, ""],
                ["PEAK journal", <span key="p" style={{ fontWeight: 700 }}>{a.peakSync?.documentNo ? <span className="mono">{a.peakSync.documentNo}</span> : null}{a.peakSync ? `${a.peakSync.documentNo ? " · " : ""}${SYNC[a.peakSync.status] ?? a.peakSync.status}` : "—"}</span>, ""],
                ["Settlement", <span key="s" style={{ fontWeight: 700 }}>{SETTLE[p.settlement] ?? p.settlement}</span>, ""],
              ].map(([label, value, sub], k) => (
                <div key={k} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", minWidth: 0 }}>
                  <div style={{ fontSize: 10.5, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: ".05em" }}>{label as string}</div>
                  <div style={{ overflowWrap: "anywhere" }}>{value}</div>
                  {sub ? <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{sub as string}</div> : null}
                </div>
              ))}
            </div>
          )) : <div style={{ fontSize: 12.5, color: "var(--danger)" }}>Rows are marked “From company advance” but no advance is recorded for this job.</div>}

          {advRows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead><tr><th style={th}>Ticket</th><th style={{ ...th, textAlign: "right" }}>On the sheet</th><th style={th}>Receipts</th><th style={th}>Status</th><th style={th} /></tr></thead>
                <tbody>
                  {advRows.map(({ row }) => {
                    const id = row.rowId ?? "";
                    const files = (id && p.attachments[id]) || [];
                    const st = receiptRowStatus(files);
                    const note = files.map((f) => f.reviewNote).filter(Boolean).at(-1);
                    const rh = hist((h) => h.action === "receipt.review" && h.detail.rowId === id);
                    return (
                      <tr key={id || row.description} className="js-adv-receipt-row" data-status={st}>
                        <td style={{ ...td, fontWeight: 600 }}>{row.description}</td>
                        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{thb(expenseAmount(row))}<div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{row.price ?? 0} × {row.pax ?? 0}</div></td>
                        <td style={td}>{files.length ? files.map((x, k) => <a key={x.id} href={x.link ?? undefined} target="_blank" rel="noopener noreferrer" style={{ display: "block", fontSize: 12.5 }}>{x.name || `File ${k + 1}`}</a>) : <span style={{ color: "var(--ink-soft)" }}>Not uploaded</span>}</td>
                        <td style={td}>
                          <span className="js-adv-receipt-status" style={st === "VERIFIED" ? OK : st === "REJECTED" || st === "REPLACEMENT_REQUESTED" ? BAD : GREY}>
                            {st === "VERIFIED" ? "✓ Verified" : st === "REJECTED" ? "Rejected" : st === "REPLACEMENT_REQUESTED" ? "New receipt requested" : st === "TO_REVIEW" ? "To review" : "Waiting for guide"}
                          </span>
                          {note && st !== "VERIFIED" && <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>“{note}”</div>}
                        </td>
                        <td style={td}>
                          {id ? (
                            <div style={{ display: "grid", gap: 6, minWidth: 240 }}>
                              <input aria-label={`${row.description} note`} className="js-adv-note" placeholder="Note — the guide sees it on Reject / Ask" maxLength={500} value={notes[id] ?? ""}
                                onChange={(ev) => setNotes((x) => ({ ...x, [id]: ev.target.value }))} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", fontSize: 13, fontFamily: "inherit" }} />
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button type="button" className="btn sm primary js-adv-verify" disabled={!!busy || !files.length} onClick={() => receipt(id, "VERIFY")}>Verify</button>
                                <button type="button" className="btn sm js-adv-reject" disabled={!!busy || !files.length} onClick={() => receipt(id, "REJECT")} style={{ color: "var(--danger)" }}>Reject</button>
                                <button type="button" className="btn sm js-adv-request" disabled={!!busy} onClick={() => receipt(id, "REQUEST_NEW")}>Ask for a new one</button>
                                <button type="button" className="btn sm ghost js-adv-internal" disabled={!!busy} onClick={() => receipt(id, "NOTE")}>Internal note</button>
                                {rh.length > 0 && <button type="button" className="btn sm ghost js-adv-history" onClick={() => setShowHist(showHist === id ? null : id)}>History</button>}
                              </div>
                              {showHist === id && (
                                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                                  {rh.map((h, k) => <li key={k}>{dt(h.at)} · {h.by} · {String(h.detail.action).toLowerCase().replace("_", " ")}{h.detail.note ? ` — “${String(h.detail.note)}”${h.detail.internal ? " (internal)" : ""}` : ""}</li>)}
                                </ol>
                              )}
                              {err[id] && <div role="alert" style={{ color: "var(--danger)", fontSize: 12, whiteSpace: "pre-line" }}>{err[id]}</div>}
                            </div>
                          ) : <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Save the sheet to review this row</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Verifying a receipt never settles the advance. Settlement, adjustments, PEAK journals and reversals stay with Admin / Accountant.</div>
        </section>
      )}
    </div>
  );
}
