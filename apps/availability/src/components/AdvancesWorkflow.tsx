"use client";
import AdvanceAccountJournal from "./AdvanceAccountJournal";
import { useCallback, useEffect, useMemo, useState } from "react";
import { explain, RefundRow, type OpsRefund } from "./AdvanceOperations";
import AdvanceBankSelect from "./AdvanceBankSelect";
import RefundReviewPanel from "./RefundReview";
import AdvancePeakStatus, { type AdvancePeakState } from "./AdvancePeakStatus";
import RecordExistingPeakDialog, { type LinkTarget } from "./RecordExistingPeakDialog";
import { thb } from "@/lib/jobsheet";

// The operator's view of company money a guide is holding.
//
// Three things live here because they are one story: what went out (advances), what came
// back (returns), and the costs that no PEAK document is carrying yet. Recording a
// payment deduction happens in the payment dialog, where the money is.
//
// Nothing on this screen changes a balance by itself: every action posts to the ledger
// (lib/advances), which refuses anything it cannot justify and says why.

type PeakLink = { documentNo: string; documentType: string; linkedAt: string; note: string; warning: string | null; verified: boolean };
type Advance = {
  peakSync?: AdvancePeakState | null; peakLink?: PeakLink | null;
  id: string; advanceNo: string; guideId: string; jobNo: string | null; advanceDate: string;
  amount: number; settled: number; outstanding: number; status: "OPEN" | "IN_USE" | "RETURN_DUE" | "SETTLED" | "VOID" | null; problems?: string[];
  purpose: string | null; txRef: string | null; slipUrl: string | null; reversalReason: string | null;
  voucherUrl?: string | null; acknowledgedAt?: string | null;
};
type Receipt = {
  peakSync?: AdvancePeakState | null; peakLink?: PeakLink | null;
  id: string; receiptNo: string; guideId: string; receivedDate: string; status: "CLAIMED" | "VERIFIED" | "REJECTED" | "VOIDED"; refunded?: number; available?: number; refunds?: OpsRefund[];
  amount: number; allocated: number; unallocated: number; bankRef: string | null; slipUrl: string | null;
  note: string | null; verifiedAt: string | null; rejectedReason: string | null;
};
type Unbooked = {
  totals: { rows: number; total: number; fromAdvance: number; companyDirect: number; advanceWithoutRecord: number; awaitingPayer?: { rows: number; total: number } };
  rows: { guideId: string; jobNo: string | null; date: string; description: string; category: string | null; amount: number; fundedBy: string; advanceNo: string | null; hasAdvanceRecord: boolean; peakDocumentNo: string | null; peakSyncStatus: string | null; state?: "READY_TO_BOOK" | "AWAITING_PAYER" }[];
};

const STATUS_LABEL: Record<string, string> = {
  // Advances (lib/advances/rules advanceSummary). A null status means the ledger does not add up.
  OPEN: "Open", IN_USE: "In use", RETURN_DUE: "Return due", SETTLED: "Settled", VOID: "Reversed", NEEDS_REVIEW: "Needs review",
  CLAIMED: "Waiting to be checked", VERIFIED: "Confirmed", REJECTED: "Rejected", VOIDED: "Voided",
};

const jfetch = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { detail?: string; reasons?: string[]; error?: string }).detail || (body as { reasons?: string[] }).reasons?.join("\n") || (body as { error?: string }).error || `HTTP ${r.status}`);
  return body as Record<string, unknown>;
};

export default function AdvancesWorkflow({ canEdit = true, isAdmin = false, role = null, userId = null }: { canEdit?: boolean; isAdmin?: boolean; role?: string | null; userId?: string | null }) {
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  // ADVANCE_WRITES_FROZEN, as the server reports it: write controls are disabled while it is on.
  const [frozen, setFrozen] = useState(false);
  const [unbooked, setUnbooked] = useState<Unbooked | null>(null);
  // Bumped on every load, so the account journal below re-reads after any change above it.
  const [loads, setLoads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [returnBank, setReturnBank] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [allocating, setAllocating] = useState<Receipt | null>(null);
  const [detail, setDetail] = useState<Advance | null>(null);
  const [linking, setLinking] = useState<LinkTarget | null>(null);
  const [mode, setMode] = useState<{ reconciliation: boolean; existingLinks: boolean; writesFrozen: boolean; autoSync: boolean } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, r, u, m] = await Promise.all([
        jfetch("/api/advances"), jfetch("/api/advances/returns"), jfetch("/api/advances/unbooked-expenses"),
        jfetch("/api/advances/peak-config").catch(() => null),
      ]);
      if (m) setMode(m as unknown as { reconciliation: boolean; existingLinks: boolean; writesFrozen: boolean; autoSync: boolean });
      setAdvances((a.advances ?? []) as Advance[]);
      setFrozen(a.frozen === true);
      setReceipts((r.receipts ?? []) as Receipt[]);
      setUnbooked(u as unknown as Unbooked);
      setLoads((n) => n + 1);
    } catch (e) { setErr(String((e as Error).message)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); setMsg(done); await load(); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  // Remove a manual PEAK link that named the wrong document — admin only, with a reason
  // (lib/advances/peak-link unlinkPeakDocument). Nothing is sent to PEAK either way.
  const unlink = async (kind: "ADVANCE" | "RETURN" | "EXPENSE", sourceId: string, documentNo: string) => {
    const reason = prompt(`Remove the link to ${documentNo}? Say why it is the wrong document (kept in the audit log):`);
    if (!reason || !reason.trim()) return;
    await act(() => jfetch("/api/advances/peak-link/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, sourceId, reason: reason.trim() }) }), `Link to ${documentNo} removed — link the right document next`);
  };

  // While the cutover freeze is on the server refuses every ordinary advance write.
  // Offering the buttons anyway only produces a 503 the operator cannot act on.
  const canWrite = canEdit && !mode?.writesFrozen && !frozen;
  const canLink = isAdmin && !!mode?.existingLinks;
  const open = useMemo(() => advances.filter((a) => a.status === "OPEN" || a.status === "IN_USE" || a.status === "RETURN_DUE"), [advances]);
  const waiting = useMemo(() => receipts.filter((r) => r.status === "CLAIMED"), [receipts]);

  return (
    <section style={{ display: "grid", gap: 18 }}>
      {mode?.reconciliation && (
        <div className="banner warn" role="status">โหมดเชื่อมเอกสาร PEAK เดิม — การสร้าง Advance และการ Sync อัตโนมัติยังปิดอยู่</div>
      )}
      {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
      {msg && <div className="banner ok" role="status">{msg}</div>}
      {frozen && <div className="banner js-advance-frozen" role="status">Advance writes are currently frozen — everything on this page is read-only until the advance workflow is switched on.</div>}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Company advances</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {open.length} outstanding · {thb(open.reduce((s, a) => s + a.outstanding, 0))} with guides
        </span>
        {canWrite && <button className="btn sm primary" disabled={busy || frozen} onClick={() => setIssuing(true)} style={{ marginLeft: "auto" }}>Record advance…</button>}
      </div>

      {canWrite && waiting.length > 0 && <AdvanceBankSelect value={returnBank} onChange={setReturnBank} disabled={busy} />}
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>Advance</th><th>Guide</th><th>Date</th><th>Job</th><th className="r">Amount</th><th className="r">Settled</th><th className="r">Outstanding</th><th>Status</th><th /></tr></thead>
          <tbody>
            {advances.length === 0 && <tr><td colSpan={9} className="muted">No ticket advance has been recorded.</td></tr>}
            {advances.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.advanceNo}<AdvancePeakStatus state={a.peakSync} />{a.peakLink && <LinkedBadge link={a.peakLink} onUnlink={canLink ? () => void unlink("ADVANCE", a.id, a.peakLink!.documentNo) : undefined} />}<VoucherLine advance={a} /></td>
                <td>{a.guideId}</td>
                <td>{a.advanceDate}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{a.jobNo ?? "—"}</td>
                <td className="r num">{thb(a.amount)}</td>
                <td className="r num">{thb(a.settled)}</td>
                <td className="r num"><b>{thb(a.outstanding)}</b></td>
                <td><span className={`badge${a.status === "SETTLED" ? " ok" : a.status === "VOID" ? " muted" : a.status === null ? " warn" : ""}`} title={a.problems?.join(", ") || undefined}>{STATUS_LABEL[a.status ?? "NEEDS_REVIEW"]}</span></td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn sm ghost" onClick={() => setDetail(a)}>Ledger</button>
                  {canLink && (
                    <button className="btn sm ghost" disabled={busy} title="This transfer, or its ticket costs, are already in PEAK under a document your accountant created"
                      onClick={() => setLinking({ kind: "ADVANCE", advanceId: a.id, guideId: a.guideId, label: a.advanceNo, amount: a.amount, jobNo: a.jobNo, outstanding: a.outstanding })}>PEAK doc…</button>
                  )}
                  {canWrite && a.status === "OPEN" && !a.peakLink && (
                    <button className="btn sm ghost" disabled={busy} title="The transfer never happened, or went to the wrong guide"
                      onClick={() => {
                        const reason = window.prompt(`Reverse ${a.advanceNo}? Say why — this records that the money never left the bank, not that it came back.`);
                        if (reason) void act(() => jfetch(`/api/advances/${a.id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }), `${a.advanceNo} reversed`);
                      }}>Reverse…</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: "6px 0 0" }}>Money returned by guides</h3>
      {waiting.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {waiting.length} waiting to be checked. A return settles nothing until someone confirms it reached the company account.
        </p>
      )}
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>Return</th><th>Guide</th><th>Received</th><th className="r">Amount</th><th className="r">Allocated</th><th>Status</th><th>Evidence</th><th /></tr></thead>
          <tbody>
            {receipts.length === 0 && <tr><td colSpan={8} className="muted">No return has been recorded.</td></tr>}
            {receipts.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.receiptNo}<AdvancePeakStatus state={r.peakSync} />{r.peakLink && <LinkedBadge link={r.peakLink} onUnlink={canLink ? () => void unlink("RETURN", r.id, r.peakLink!.documentNo) : undefined} />}</td>
                <td>{r.guideId}</td>
                <td>{r.receivedDate}</td>
                <td className="r num">{thb(r.amount)}</td>
                <td className="r num">{r.allocated > 0 ? thb(r.allocated) : "—"}</td>
                <td>
                  <span className={`badge${r.status === "VERIFIED" ? " ok" : r.status === "REJECTED" ? " muted" : " warn"}`}>{STATUS_LABEL[r.status]}</span>
                  {r.status === "VERIFIED" && r.unallocated > 0 && <span className="muted" style={{ fontSize: 11.5 }}> · {thb(r.unallocated)} to allocate</span>}
                </td>
                <td>{r.slipUrl ? <a href={r.slipUrl} target="_blank" rel="noreferrer">slip</a> : <span className="muted">no slip</span>}{r.bankRef ? <span className="muted" style={{ fontSize: 11.5 }}> · {r.bankRef}</span> : null}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  {canLink && !r.peakLink && r.status !== "REJECTED" && (
                    <button className="btn sm ghost" disabled={busy} title="This return is already in PEAK — confirm it, put it against its advance and record that document, in one step"
                      onClick={() => setLinking({ kind: "RETURN", receiptId: r.id, guideId: r.guideId, label: r.receiptNo, amount: r.amount, unallocated: r.unallocated, refunded: r.refunded ?? 0, bankRef: r.bankRef, status: r.status, advances: open.filter((a) => a.guideId === r.guideId).map((a) => ({ id: a.id, advanceNo: a.advanceNo, outstanding: a.outstanding })) })}>PEAK doc…</button>
                  )}
                  {canWrite && !r.peakLink && r.status === "CLAIMED" && <>
                    <button className="btn sm primary" disabled={busy || !returnBank} title={returnBank ? "You have seen this money in the company bank account" : "เลือกบัญชีธนาคารบริษัทก่อนยืนยัน"}
                      onClick={() => {
                        const bankRef = window.prompt(`Confirm that ${thb(r.amount)} from ${r.guideId} reached the company account.\n\nFind the transfer on the company bank statement and enter that line's reference. Leave this unconfirmed if you cannot find it.`);
                        if (bankRef && bankRef.trim()) void act(() => jfetch(`/api/advances/returns/${r.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bankRef: bankRef.trim(), bankAccount: returnBank }) }), `${r.receiptNo} confirmed — put against its advance automatically when the guide named one; anything left over is shown as unallocated`);
                      }}>Confirm received</button>
                    <button className="btn sm ghost" disabled={busy}
                      onClick={() => { const reason = window.prompt("Why can this return not be confirmed?"); if (reason) void act(() => jfetch(`/api/advances/returns/${r.id}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }), `${r.receiptNo} rejected`); }}>Reject…</button>
                  </>}
                  {canWrite && !r.peakLink && r.status === "VERIFIED" && r.unallocated > 0 && <button className="btn sm" disabled={busy} onClick={() => setAllocating(r)}>Allocate…</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {role === "ACCOUNTANT" && <RefundReviewPanel userId={userId} />}
      {role !== "ACCOUNTANT" && receipts.some((r) => (r.refunds ?? []).length > 0) && (
        <div className="js-refunds-section" style={{ display: "grid", gap: 6 }}>
          <h3 style={{ margin: "6px 0 0" }}>Refunds to guides <small className="muted" style={{ fontWeight: 500 }}>excess returns paid back — not guide payments</small></h3>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Recorded by an operator, approved by another person (an accountant may approve), then paid with its bank reference and slip.
          </p>
          {receipts.flatMap((r) => (r.refunds ?? []).map((f) => (
            <div key={f.id}>
              <div className="muted" style={{ fontSize: 11.5 }}>{r.receiptNo} · {r.guideId}</div>
              <RefundRow f={f} ops={canWrite} accountant={false} userId={userId} frozen={frozen} busy={busy}
                run={async (label, url, body) => {
                  const res = await fetch(url, body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
                  const d = await res.json().catch(() => ({}));
                  if (!res.ok) { setMsg(explain(res.status, d)); return null; }
                  setMsg(`${label} ✓`); await load(); return d;
                }} />
            </div>
          )))}
        </div>
      )}

      <AdvanceAccountJournal version={loads} />

      <h3 style={{ margin: "6px 0 0" }}>Costs still to be booked</h3>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Company costs that no guide document carries, because the company had already settled them. They are not owed to the
        guide — but they are still company costs, and PEAK does not have them yet.
      </p>
      {unbooked && (
        <>
          <div className="js-unbooked-totals" style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <span><b>{thb(unbooked.totals.total)}</b> over {unbooked.totals.rows} rows</span>
            <span className="muted">from ticket advances {thb(unbooked.totals.fromAdvance)}</span>
            <span className="muted">company paid direct {thb(unbooked.totals.companyDirect)}</span>
            {unbooked.totals.advanceWithoutRecord > 0 && <span style={{ color: "var(--danger, #b3402f)" }}>{thb(unbooked.totals.advanceWithoutRecord)} says “from an advance” with no advance on record</span>}
          </div>
          <div className="tablewrap js-unbooked-ready">
            <table className="grid">
              <thead><tr><th>Date</th><th>Job</th><th>Guide</th><th>Row</th><th className="r">Amount</th><th>Funded by</th><th>Notes</th></tr></thead>
              <tbody>
                {unbooked.rows.filter((r) => r.state !== "AWAITING_PAYER").length === 0 && <tr><td colSpan={7} className="muted">Nothing outstanding.</td></tr>}
                {unbooked.rows.filter((r) => r.state !== "AWAITING_PAYER").map((row, i) => (
                  <tr key={`${row.jobNo}-${i}`}>
                    <td>{row.date}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{row.jobNo ?? "—"}</td>
                    <td>{row.guideId}</td>
                    <td>{row.description}</td>
                    <td className="r num">{thb(row.amount)}</td>
                    <td>{row.fundedBy === "GUIDE_ADVANCE" ? "Ticket advance" : "Company direct"}</td>
                    <td style={{ fontSize: 11.5 }}>
                      {row.fundedBy === "GUIDE_ADVANCE" && !row.hasAdvanceRecord && <span style={{ color: "var(--danger, #b3402f)" }}>no advance on record — check before booking</span>}
                      {row.fundedBy === "GUIDE_ADVANCE" && row.category !== "entrance" && <span style={{ color: "var(--danger, #b3402f)" }}>not a ticket — will not sync to PEAK</span>}
                      {row.hasAdvanceRecord && <span className="muted">{row.advanceNo}</span>}
                      {row.peakSyncStatus === "VOIDED" && <span className="muted"> · sheet document was voided</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(unbooked.totals.awaitingPayer?.rows ?? 0) > 0 && (
            <div className="js-unbooked-awaiting" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13 }}>
                <b>Awaiting payer confirmation</b> <span className="muted">รอยืนยันผู้ชำระ</span> — {thb(unbooked.totals.awaitingPayer!.total)} over {unbooked.totals.awaitingPayer!.rows} rows.{" "}
                <span className="muted">Not ready to book and not in the totals above: the payer is a suggestion nobody confirmed. Confirm it on the job sheet first.</span>
              </div>
              <div className="tablewrap">
                <table className="grid">
                  <thead><tr><th>Date</th><th>Job</th><th>Guide</th><th>Row</th><th className="r">Amount</th><th>Suggested payer</th></tr></thead>
                  <tbody>
                    {unbooked.rows.filter((r) => r.state === "AWAITING_PAYER").map((row, i) => (
                      <tr key={`aw-${row.jobNo}-${i}`}>
                        <td>{row.date}</td>
                        <td className="mono" style={{ fontSize: 11.5 }}>{row.jobNo ?? "—"}</td>
                        <td>{row.guideId}</td>
                        <td>{row.description}</td>
                        <td className="r num">{thb(row.amount)}</td>
                        <td>{row.fundedBy === "GUIDE_ADVANCE" ? "Ticket advance" : "Company direct"} · Suggested / รอยืนยัน</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {issuing && <IssueAdvanceDialog onClose={() => setIssuing(false)} onDone={async (m) => { setIssuing(false); setMsg(m); await load(); }} />}
      {detail && <LedgerDialog advance={detail} canEdit={canEdit} isAdmin={isAdmin} onClose={() => setDetail(null)} onChanged={async (m) => { setMsg(m); await load(); }} />}
      {linking && <RecordExistingPeakDialog target={linking} bankAccount={returnBank || undefined} onClose={() => setLinking(null)} onDone={async (m) => { setLinking(null); setMsg(m); await load(); }} />}
      {allocating && <AllocateDialog receipt={allocating} advances={open.filter((a) => a.guideId === allocating.guideId)} onClose={() => setAllocating(null)} onDone={async (m) => { setAllocating(null); setMsg(m); await load(); }} />}
    </section>
  );
}

/** The guide's own copy: where it is filed, and whether they have confirmed it. */
function VoucherLine({ advance }: { advance: Advance }) {
  if (!advance.voucherUrl && !advance.acknowledgedAt) return null;
  return (
    <div style={{ fontSize: 11.5, marginTop: 2 }}>
      {advance.voucherUrl && <a href={advance.voucherUrl} target="_blank" rel="noreferrer">ใบสำคัญจ่าย</a>}
      {advance.acknowledgedAt
        ? <span className="badge ok" style={{ marginLeft: 6 }}>ไกด์ยืนยันรับแล้ว</span>
        : <span className="muted" style={{ marginLeft: 6 }}>รอไกด์ยืนยันรับ</span>}
    </div>
  );
}

/** Already in PEAK, under someone else's document — so FolkOPS will not send it. */
function LinkedBadge({ link, onUnlink }: { link: PeakLink; onUnlink?: () => void }) {
  return (
    <div className="js-peak-linked" style={{ fontSize: 12, marginTop: 2 }} title={`${link.note}${link.warning ? ` · ${link.warning}` : ""}`}>
      <span className="badge ok">บันทึกใน PEAK อยู่แล้ว</span>{" "}
      <span className="mono">{link.documentNo}</span>
      {!link.verified && <span className="muted"> · figures not machine-checked</span>}
      {onUnlink && <> · <button type="button" className="btn sm ghost js-peak-unlink" onClick={onUnlink}>wrong document?</button></>}
    </div>
  );
}

function IssueAdvanceDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [guideId, setGuideId] = useState("");
  const [advanceDate, setAdvanceDate] = useState(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [jobNo, setJobNo] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [bankRef, setBankRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // What it may pay for (tickets by default); "other" needs a reason, kept in its history.
  const [cats, setCats] = useState<string[]>(["entrance"]);
  const [otherReason, setOtherReason] = useState("");
  const [purpose, setPurpose] = useState("");

  const submit = async () => {
    if (!cats.length) { setErr("Choose at least one category this advance may pay for"); return; }
    if (cats.includes("other") && otherReason.trim().length < 8) { setErr("Say why this advance may pay for other costs (at least 8 characters)"); return; }
    if (!jobNo.trim()) { setErr("เลือก Job No. ของรายการเงินทดรอง"); return; }
    if (!bankAccount) { setErr("เลือกบัญชีธนาคารบริษัทที่โอนเงินออก"); return; }
    if (!bankRef.trim()) { setErr("ใส่เลขอ้างอิงรายการโอนจากธนาคาร"); return; }
    if (!file) { setErr("แนบสลิปโอนเงินก่อนบันทึก"); return; }
    setBusy(true); setErr(null);
    try {
      const body = new FormData();
      for (const [key,value] of Object.entries({guideId:guideId.trim(),advanceDate,amount,jobNo:jobNo.trim(),bankRef,bankAccount})) body.set(key,value);
      if (file) body.set("file",file);
      body.set("allowedCategories", cats.join(","));
      if (cats.includes("other")) body.set("otherReason", otherReason.trim());
      if (purpose.trim()) body.set("purpose", purpose.trim());
      const r = await jfetch("/api/advances", { method: "POST", body });
      onDone(`${(r.advance as { advanceNo: string }).advanceNo} recorded`);
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="adv-h" style={{ width: "min(520px, 100%)" }}>
        <h3 id="adv-h">Record advance</h3>
        <div className="mbody">
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Money the company transferred to a guide to buy customer tickets for this Job No. It is cleared by the approved ticket
          rows or by unused money the guide returns.
        </p>
        {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
        <div style={{ display: "grid", gap: 8 }}>
          <label>Guide ID<input value={guideId} onChange={(e) => setGuideId(e.target.value)} placeholder="G-000" disabled={busy} /></label>
          <label>Date the money left the bank<input type="date" value={advanceDate} onChange={(e) => setAdvanceDate(e.target.value)} disabled={busy} /></label>
          <label>Amount (฿)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
          <label>Job No.<input value={jobNo} onChange={(e) => setJobNo(e.target.value)} placeholder="FOLK-BKK-…" disabled={busy} /></label>
          <AdvanceBankSelect value={bankAccount} onChange={setBankAccount} disabled={busy} />
          <label>สลิปโอนเงิน<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy} onChange={e=>setFile(e.target.files?.[0]??null)} /></label>
          <label>Bank reference<input value={bankRef} onChange={(e) => setBankRef(e.target.value)} disabled={busy} /></label>
          <div className="js-issue-categories" style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
            <span className="muted">May pay for:</span>
            {[["entrance", "Entrance tickets"], ["meal", "Meals"], ["transport", "Transport"], ["other", "Other"]].map(([k, label]) => (
              <label key={k} style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={cats.includes(k)} disabled={busy} onChange={(e) => setCats((c) => (e.target.checked ? [...c, k] : c.filter((x) => x !== k)))} />{label}</label>
            ))}
          </div>
          {cats.includes("other") && <label>Why may it pay for other costs?<input value={otherReason} onChange={(e) => setOtherReason(e.target.value)} disabled={busy} /></label>}
          <label>Purpose (optional)<input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} disabled={busy} /></label>
        </div>
        </div>
        <div className="mfoot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !guideId.trim() || !amount.trim() || !jobNo.trim() || !bankAccount || !bankRef.trim() || !file}>Record</button>
        </div>
      </div>
    </div>
  );
}

function AllocateDialog({ receipt, advances, onClose, onDone }: { receipt: Receipt; advances: Advance[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [lines, setLines] = useState<{ advanceId: string; amount: string }[]>(advances.length ? [{ advanceId: advances[0].id, amount: "" }] : []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One request, one key: a retry is the same action, never a second allocation.
  const [requestKey] = useState(() => `alloc-${receipt.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const left = Math.round((receipt.unallocated - total) * 100) / 100;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await jfetch(`/api/advances/returns/${receipt.id}/allocate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestKey, allocations: lines.filter((l) => Number(l.amount) > 0).map((l) => ({ advanceId: l.advanceId, amount: Number(l.amount) })) }),
      });
      onDone(`${receipt.receiptNo} allocated`);
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="alloc-h" style={{ width: "min(560px, 100%)" }}>
        <h3 id="alloc-h">Allocate {receipt.receiptNo}</h3>
        <div className="mbody">
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          {thb(receipt.amount)} received on {receipt.receivedDate}{receipt.bankRef ? ` · ${receipt.bankRef}` : ""} · {thb(receipt.unallocated)} still to be put against an advance.
        </p>
        {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
        {advances.length === 0 && <div className="banner warn">{receipt.guideId} has no advance with a balance left. Record the advance first, or reject this return.</div>}
        <div style={{ display: "grid", gap: 8 }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <select value={l.advanceId} disabled={busy} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, advanceId: e.target.value } : x)))} style={{ flex: 1 }}>
                {advances.map((a) => <option key={a.id} value={a.id}>{a.advanceNo} · {a.advanceDate} · {thb(a.outstanding)} outstanding</option>)}
              </select>
              <input inputMode="decimal" placeholder="฿" value={l.amount} disabled={busy} style={{ width: 110 }}
                onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              {lines.length > 1 && <button className="btn sm ghost" disabled={busy} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          {advances.length > lines.length && <button className="btn sm" disabled={busy} onClick={() => setLines((ls) => [...ls, { advanceId: advances.find((a) => !ls.some((l) => l.advanceId === a.id))!.id, amount: "" }])}>+ another advance</button>}
        </div>
        <p style={{ fontSize: 13, marginBottom: 0 }}>
          Allocating {thb(total)} · {left === 0 ? <b>nothing left over ✓</b> : left > 0 ? <>{thb(left)} would still be unallocated</> : <span style={{ color: "var(--danger, #b3402f)" }}>{thb(-left)} more than came in</span>}
        </p>
        </div>
        <div className="mfoot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || total <= 0 || left < 0}>Allocate</button>
        </div>
      </div>
    </div>
  );
}

type Entry = {
  peakSync?: AdvancePeakState | null;
  id: string; type: string; label: string; amount: number; effectiveDate: string; jobNo: string | null; reason: string | null;
  paymentNo: string | null; paymentStatus: string | null; receiptNo: string | null;
  reversesEntryId: string | null; reversedByEntryId: string | null; canReverse: boolean;
};

function LedgerDialog({ advance, canEdit, isAdmin, onClose, onChanged }: { advance: Advance; canEdit: boolean; isAdmin: boolean; onClose: () => void; onChanged: (msg: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [head, setHead] = useState<{ amount: number; settled: number; outstanding: number; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [booked, setBooked] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await jfetch(`/api/advances/${advance.id}`);
      setEntries(d.entries as Entry[]);
      setHead(d.advance as { amount: number; settled: number; outstanding: number; status: string });
    } catch (e) { setErr(String((e as Error).message)); }
  }, [advance.id]);
  useEffect(() => { void load(); }, [load]);

  const reverse = async (e: Entry) => {
    const reason = window.prompt(`Reverse “${e.label}” of ${thb(e.amount)}? Say why. The entry stays on the ledger and a contra entry is added.`);
    if (!reason) return;
    setBusy(true); setErr(null);
    try {
      await jfetch(`/api/advances/entries/${e.id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
      await load(); onChanged(`Entry reversed on ${advance.advanceNo}`);
    } catch (x) { setErr(String((x as Error).message)); }
    finally { setBusy(false); }
  };

  const source = (e: Entry) => e.paymentNo ? `${e.paymentNo}${e.paymentStatus === "REVERSED" ? " (payment reversed)" : ""}` : e.receiptNo ?? e.jobNo ?? "—";

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ledger-h" style={{ width: "min(760px, 100%)" }}>
        <h3 id="ledger-h">{advance.advanceNo} · {advance.guideId}</h3>
        <div className="mbody">
        {head && <p style={{ marginTop: 0, fontSize: 13 }}>Advanced <b>{thb(head.amount)}</b> · settled <b>{thb(head.settled)}</b> · outstanding <b>{thb(head.outstanding)}</b> · {STATUS_LABEL[head.status] ?? head.status}</p>}
        {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
        <div className="tablewrap">
          <table className="grid">
            <thead><tr><th>Date</th><th>Entry</th><th>Source</th><th className="r">Amount</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {entries === null && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
              {entries?.length === 0 && <tr><td colSpan={6} className="muted">Nothing has been settled against this advance.</td></tr>}
              {entries?.map((e) => (
                <tr key={e.id} style={e.reversedByEntryId ? { opacity: 0.6 } : undefined}>
                  <td>{e.effectiveDate}</td>
                  <td>{e.label}{e.reversedByEntryId ? " · reversed" : ""}<AdvancePeakStatus state={e.peakSync} /></td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{source(e)}</td>
                  <td className="r num">{thb(e.amount)}</td>
                  <td style={{ fontSize: 12 }}>{e.reason ?? ""}</td>
                  <td>
                    {canEdit && e.canReverse && <button className="btn sm ghost" disabled={busy} onClick={() => reverse(e)}>Reverse…</button>}
                    {isAdmin && e.type === "EXPENSE_SETTLEMENT" && ["PENDING", "BLOCKED"].includes(e.peakSync?.status ?? "") && (
                      <button className="btn sm ghost" disabled={busy} title="Close this pending item only when the same job's guide-payment document already carries the expense"
                        onClick={() => setBooked(e)}>Already in guide payment…</button>
                    )}
                    {e.type === "PAYMENT_DEDUCTION" && !e.reversedByEntryId && <span className="muted" style={{ fontSize: 11.5 }}>undo by reversing {e.paymentNo}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
        <div className="mfoot">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
      {booked && <BookedInGuidePaymentDialog entry={booked} onClose={() => setBooked(null)} onDone={async () => {
        setBooked(null);
        await load();
        onChanged(`${booked.label} recorded as already booked in the guide payment — nothing was posted to PEAK`);
      }} />}
    </div>
  );
}

/**
 * Evidence-first exception for historical settlements already carried by the guide's
 * own EXP document. The copy is intentionally explicit: this closes a FolkOPS queue
 * item and never creates or changes a PEAK document.
 */
function BookedInGuidePaymentDialog({ entry, onClose, onDone }: { entry: Entry; onClose: () => void; onDone: () => void }) {
  const [expenseDocumentNo, setExpenseDocumentNo] = useState("");
  const [paymentEvidenceNo, setPaymentEvidenceNo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = /^EXP-/i.test(expenseDocumentNo.trim()) && /^PV-/i.test(paymentEvidenceNo.trim()) && reason.trim().length >= 8;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await jfetch(`/api/advances/entries/${entry.id}/booked-in-guide-payment`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expenseDocumentNo: expenseDocumentNo.trim(), paymentEvidenceNo: paymentEvidenceNo.trim(), reason: reason.trim() }),
      });
      onDone();
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="booked-guide-payment-h" style={{ width: "min(560px, 100%)" }}>
        <h3 id="booked-guide-payment-h">Already booked in guide payment</h3>
        <div className="mbody">
          <p style={{ marginTop: 0 }}><b>{entry.label}</b> · {entry.jobNo ?? "job sheet"} · {thb(entry.amount)}</p>
          {/* The app has no .banner style, so the two messages that must not be missed are styled here. */}
          <div className="banner warn js-booked-note" role="note" style={{ padding: "10px 12px", border: "1px solid #ecd9bf", borderLeft: "4px solid #b45309", borderRadius: 8, background: "#fff8ec", fontSize: 13.5, lineHeight: 1.45 }}>
            <b>Nothing is posted to PEAK.</b> This only closes this settlement’s pending outbox item, after FolkOPS confirms the expense document belongs to the same job’s guide payment.
          </div>
          {err && <div className="banner danger js-booked-error" role="alert" style={{ whiteSpace: "pre-line", padding: "10px 12px", border: "1px solid var(--danger-line)", borderLeft: "4px solid var(--danger)", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", fontSize: 13.5, fontWeight: 600 }}>{err}</div>}
          <div style={{ display: "grid", gap: 10 }}>
            <label>Guide-payment expense document
              <input autoFocus value={expenseDocumentNo} onChange={(e) => setExpenseDocumentNo(e.target.value)} placeholder="EXP-…" disabled={busy} autoComplete="off" />
            </label>
            <label>Payment evidence
              <input value={paymentEvidenceNo} onChange={(e) => setPaymentEvidenceNo(e.target.value)} placeholder="PV-…" disabled={busy} autoComplete="off" />
            </label>
            <label>Accounting reason
              {/* .modal styles input and select, not textarea — give it the same look, full width, on its own line. */}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} disabled={busy}
                placeholder="Why this settlement must not create another PEAK document"
                style={{ display: "block", width: "100%", border: "1px solid var(--line-strong)", borderRadius: 10, padding: "9px 12px", fontFamily: "inherit", fontSize: 14, background: "var(--paper)", resize: "vertical" }} />
            </label>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Result: the outbox item is marked cancelled with both references in its audit record. The guide-payment document keeps its existing owner; no PEAK link is created.
          </p>
        </div>
        <div className="mfoot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !ready}>{busy ? "Checking…" : "Check and close without posting"}</button>
        </div>
      </div>
    </div>
  );
}
