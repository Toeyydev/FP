"use client";

// The operator's review panels on the job sheet (owner 2026-11-15; lib/job-expense-review):
//   Tour expenses — the guide's three fixed items: reported, receipt, PEAK account (read-only, from
//   the mapping), verified amount, status, Approve / Reject with a reason, history.
//   Company ADV — Entrance tickets — the advance (number, job, guide, amount, date, transfer,
//   guide's confirmation, PEAK journal, settlement) and each ticket row's receipts: Verify,
//   Reject, Ask for a new one, internal note. Verifying never settles the advance.
// The job's full accounting rows stay below, unchanged.

import { useState } from "react";
import { expenseAmount, thb, type Expense } from "@/lib/jobsheet";
import { FIXED_ITEMS, fixedItemOf, isAdvanceRow, receiptRowStatus, reviewOf, type ReportRow } from "@/lib/guide-fixed-expenses";
import type { AttachmentView } from "@/components/ReceiptFiles";

type Account = { code: string | null; name: string | null } | null;
type History = { at: string; action: string; by: string; detail: Record<string, unknown> };
type AdvRow = { id: string; advanceNo: string; amount: number; advanceDate?: string; method: string; status: string | null; acknowledgedAt?: string | Date | null; peakSync?: { status: string; documentNo: string | null } | null };
type Props = {
  sheetKey: { guideId: string; date: string; slotIdx: number };
  jobRef: string | null; guideLabel: string;
  reported: ReportRow[]; official: Expense[];
  attachments: Record<string, AttachmentView[]>;
  accounts: Record<string, Account> | undefined;
  history: History[] | undefined;
  advances: AdvRow[]; settlement: string;
  locked: boolean;
  onChanged: (msg: string) => void | Promise<void>;
};

const chip = (bg: string, line: string, fg: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, color: fg, background: bg, border: `1px solid ${line}`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap", display: "inline-block" });
const OK = chip("var(--green-bg)", "var(--green-line)", "var(--green)"), WARN = chip("var(--assign-bg)", "var(--assign-line)", "var(--assign)"),
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
  const [edit, setEdit] = useState<Record<string, { verified: string; reason: string; open: boolean }>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<Record<string, string>>({});
  const [showHist, setShowHist] = useState<string | null>(null);

  const advRows = p.official.map((row, index) => ({ row, index })).filter(({ row }) => isAdvanceRow(row));
  const liveAdv = p.advances.filter((a) => a.status !== "VOID");
  const hist = (pred: (h: History) => boolean) => (p.history ?? []).filter(pred);

  async function review(key: string, action: "APPROVE" | "REJECT", reported: number) {
    const e = edit[key] ?? { verified: String(reported), reason: "", open: true };
    setBusy(key); setErr((x) => ({ ...x, [key]: "" }));
    const v = e.verified.trim() === "" ? reported : Number(e.verified);
    const msg = await post("/api/jobsheet/expense-review", { ...p.sheetKey, item: key, action, ...(action === "APPROVE" ? { verifiedAmount: v } : {}), reason: e.reason.trim() || undefined });
    setBusy("");
    if (msg) { setErr((x) => ({ ...x, [key]: msg })); return; }
    setEdit((x) => ({ ...x, [key]: { ...e, open: false } }));
    await p.onChanged(action === "REJECT" ? "Rejected — the guide sees your reason" : "Reviewed ✓ — the accounting row now carries the verified amount");
  }
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
      <section className="js-review-expenses" style={box}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Tour expenses <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>ค่าใช้จ่ายระหว่างทัวร์ · guide report</small></h3>
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>🔒 Fixed items · PEAK accounts from the account mapping</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead><tr><th style={th}>Item</th><th style={th}>PEAK account</th><th style={{ ...th, textAlign: "right" }}>Reported</th><th style={th}>Receipt</th><th style={{ ...th, textAlign: "right" }}>Verified</th><th style={th}>Status</th><th style={th} /></tr></thead>
            <tbody>
              {FIXED_ITEMS.map((f) => {
                const mine = p.reported.find((r) => fixedItemOf(r)?.key === f.key && expenseAmount(r) > 0);
                const off = p.official.find((r) => fixedItemOf(r)?.key === f.key);
                const files = (off?.rowId && p.attachments[off.rowId]) || [];
                const st = reviewOf(mine);
                const reported = mine ? expenseAmount(mine) : 0;
                const acct = p.accounts?.[f.key];
                const e = edit[f.key];
                const open = !!mine && !p.locked && (st === "PENDING" || e?.open);
                const vText = e?.verified ?? String(mine?.verifiedAmount ?? reported);
                const differs = open && Number(vText || reported) !== reported;
                return (
                  <tr key={f.key} className="js-review-row" data-item={f.key} data-status={st ?? "NONE"}>
                    <td style={{ ...td, fontWeight: 600 }}>{f.label} <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>(Inc. Guide)</span></td>
                    <td style={{ ...td, fontSize: 12.5, color: acct ? "var(--ink-soft)" : "var(--danger)" }}>{acct ? `${acct.code} ${acct.name ?? ""}` : "Not mapped — Admin/Accountant to set"}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{mine ? <>{thb(reported)}<div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{mine.price ?? 0} × {mine.pax ?? 0}</div></> : <span style={{ color: "var(--ink-soft)" }}>Not reported</span>}</td>
                    <td style={td}>{files.length ? files.map((x, k) => <a key={x.id} href={x.link ?? undefined} target="_blank" rel="noopener noreferrer" style={{ display: "block", fontSize: 12.5 }}>File {k + 1}</a>) : <span style={{ color: "var(--ink-soft)" }}>None</span>}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {open ? <input aria-label={`${f.label} verified amount`} className="js-review-verified" type="number" min={0} inputMode="decimal" value={vText}
                        onChange={(ev) => setEdit((x) => ({ ...x, [f.key]: { verified: ev.target.value, reason: x[f.key]?.reason ?? "", open: true } }))}
                        style={{ width: 92, border: "1px solid var(--line-strong, var(--line))", borderRadius: 8, padding: "6px 8px", textAlign: "right", fontSize: 13.5, fontFamily: "inherit" }} />
                        : mine && st !== "PENDING" ? <b>{thb(mine.verifiedAmount ?? 0)}</b> : ""}
                    </td>
                    <td style={td}>
                      {st ? <span className="js-review-status" style={st === "APPROVED" ? OK : st === "ADJUSTED" ? WARN : st === "REJECTED" ? BAD : GREY}>{st === "APPROVED" ? "✓ Approved" : st === "ADJUSTED" ? "Adjusted" : st === "REJECTED" ? "Rejected" : "To review"}</span> : <span style={GREY}>—</span>}
                      {mine?.reviewReason && st !== "PENDING" && <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>“{mine.reviewReason}”</div>}
                    </td>
                    <td style={td}>
                      {open ? (
                        <div style={{ display: "grid", gap: 6, minWidth: 210 }}>
                          <input aria-label={`${f.label} reason`} className="js-review-reason" placeholder={differs ? "Why the amount differs (required)" : "Reason (required to reject)"} maxLength={500}
                            value={e?.reason ?? ""} onChange={(ev) => setEdit((x) => ({ ...x, [f.key]: { verified: x[f.key]?.verified ?? vText, reason: ev.target.value, open: true } }))}
                            style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", fontSize: 13, fontFamily: "inherit" }} />
                          <div style={{ display: "flex", gap: 6 }}>
                            <button type="button" className="btn sm primary js-review-approve" disabled={busy === f.key} onClick={() => review(f.key, "APPROVE", reported)}>Approve</button>
                            <button type="button" className="btn sm js-review-reject" disabled={busy === f.key} onClick={() => review(f.key, "REJECT", reported)} style={{ color: "var(--danger)" }}>Reject</button>
                          </div>
                        </div>
                      ) : mine && !p.locked && st !== "PENDING" ? <button type="button" className="btn sm ghost js-review-change" onClick={() => setEdit((x) => ({ ...x, [f.key]: { verified: String(mine.verifiedAmount ?? reported), reason: "", open: true } }))}>Change</button> : null}
                      {hist((h) => h.action === "expense.review" && h.detail.item === f.key).length > 0 && (
                        <button type="button" className="btn sm ghost js-review-history" onClick={() => setShowHist(showHist === f.key ? null : f.key)}>History</button>
                      )}
                      {showHist === f.key && (
                        <ol style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                          {hist((h) => h.action === "expense.review" && h.detail.item === f.key).map((h, k) => (
                            <li key={k}>{dt(h.at)} · {h.by} · {String(h.detail.status).toLowerCase()} {thb(Number(h.detail.verified) || 0)} of {thb(Number(h.detail.reported) || 0)}{h.detail.reason ? ` — “${String(h.detail.reason)}”` : ""}</li>
                          ))}
                        </ol>
                      )}
                      {err[f.key] && <div role="alert" style={{ color: "var(--danger)", fontSize: 12, whiteSpace: "pre-line", marginTop: 4 }}>{err[f.key]}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{p.locked ? "The job sheet is approved — the review is closed." : "An amount that differs from the guide's needs a reason. An approved amount goes into the job's accounting row; nothing reaches PEAK before the job sheet is approved."}</div>
      </section>

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
