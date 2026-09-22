"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import AdvanceBankSelect from "./AdvanceBankSelect";
import AdvancePeakStatus, { type AdvancePeakState } from "./AdvancePeakStatus";
import { thb } from "@/lib/jobsheet";

// The operator's view of company money a guide is holding.
//
// Three things live here because they are one story: what went out (advances), what came
// back (returns), and the costs that no PEAK document is carrying yet. Recording a
// payment deduction happens in the payment dialog, where the money is.
//
// Nothing on this screen changes a balance by itself: every action posts to the ledger
// (lib/advances), which refuses anything it cannot justify and says why.

type Advance = {
  peakSync?: AdvancePeakState | null;
  id: string; advanceNo: string; guideId: string; jobNo: string | null; advanceDate: string;
  amount: number; settled: number; outstanding: number; status: "OPEN" | "PARTIALLY_SETTLED" | "SETTLED" | "REVERSED";
  purpose: string | null; txRef: string | null; slipUrl: string | null; reversalReason: string | null;
};
type Receipt = {
  peakSync?: AdvancePeakState | null;
  id: string; receiptNo: string; guideId: string; receivedDate: string; status: "CLAIMED" | "VERIFIED" | "REJECTED";
  amount: number; allocated: number; unallocated: number; bankRef: string | null; slipUrl: string | null;
  note: string | null; verifiedAt: string | null; rejectedReason: string | null;
};
type Unbooked = {
  totals: { rows: number; total: number; fromAdvance: number; companyDirect: number; advanceWithoutRecord: number };
  rows: { guideId: string; jobNo: string | null; date: string; description: string; amount: number; fundedBy: string; advanceNo: string | null; hasAdvanceRecord: boolean; peakDocumentNo: string | null; peakSyncStatus: string | null }[];
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", PARTIALLY_SETTLED: "Part settled", SETTLED: "Settled", REVERSED: "Reversed",
  CLAIMED: "Waiting to be checked", VERIFIED: "Confirmed", REJECTED: "Rejected",
};

const jfetch = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { detail?: string; reasons?: string[]; error?: string }).detail || (body as { reasons?: string[] }).reasons?.join("\n") || (body as { error?: string }).error || `HTTP ${r.status}`);
  return body as Record<string, unknown>;
};

export default function AdvancesWorkflow({ canEdit = true }: { canEdit?: boolean }) {
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [unbooked, setUnbooked] = useState<Unbooked | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [returnBank, setReturnBank] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [allocating, setAllocating] = useState<Receipt | null>(null);
  const [detail, setDetail] = useState<Advance | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, r, u] = await Promise.all([
        jfetch("/api/advances"), jfetch("/api/advances/returns"), jfetch("/api/advances/unbooked-expenses"),
      ]);
      setAdvances((a.advances ?? []) as Advance[]);
      setReceipts((r.receipts ?? []) as Receipt[]);
      setUnbooked(u as unknown as Unbooked);
    } catch (e) { setErr(String((e as Error).message)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); setMsg(done); await load(); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const open = useMemo(() => advances.filter((a) => a.status === "OPEN" || a.status === "PARTIALLY_SETTLED"), [advances]);
  const waiting = useMemo(() => receipts.filter((r) => r.status === "CLAIMED"), [receipts]);

  return (
    <section style={{ display: "grid", gap: 18 }}>
      {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
      {msg && <div className="banner ok" role="status">{msg}</div>}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Advances</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {open.length} outstanding · {thb(open.reduce((s, a) => s + a.outstanding, 0))} with guides
        </span>
        {canEdit && <button className="btn sm primary" disabled={busy} onClick={() => setIssuing(true)} style={{ marginLeft: "auto" }}>Record an advance…</button>}
      </div>

      {canEdit && waiting.length > 0 && <AdvanceBankSelect value={returnBank} onChange={setReturnBank} disabled={busy} />}
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>Advance</th><th>Guide</th><th>Date</th><th>Job</th><th className="r">Amount</th><th className="r">Settled</th><th className="r">Outstanding</th><th>Status</th><th /></tr></thead>
          <tbody>
            {advances.length === 0 && <tr><td colSpan={9} className="muted">No advance has been recorded.</td></tr>}
            {advances.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.advanceNo}<AdvancePeakStatus state={a.peakSync} /></td>
                <td>{a.guideId}</td>
                <td>{a.advanceDate}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{a.jobNo ?? "—"}</td>
                <td className="r num">{thb(a.amount)}</td>
                <td className="r num">{thb(a.settled)}</td>
                <td className="r num"><b>{thb(a.outstanding)}</b></td>
                <td><span className={`badge${a.status === "SETTLED" ? " ok" : a.status === "REVERSED" ? " muted" : ""}`}>{STATUS_LABEL[a.status]}</span></td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="btn sm ghost" onClick={() => setDetail(a)}>Ledger</button>
                  {canEdit && a.status === "OPEN" && (
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
                <td className="mono">{r.receiptNo}<AdvancePeakStatus state={r.peakSync} /></td>
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
                  {canEdit && r.status === "CLAIMED" && <>
                    <button className="btn sm primary" disabled={busy || !returnBank} title={returnBank ? "You have seen this money in the company bank account" : "เลือกบัญชีธนาคารบริษัทก่อนยืนยัน"}
                      onClick={() => {
                        const bankRef = window.prompt(`Confirm that ${thb(r.amount)} from ${r.guideId} reached the company account.\n\nFind the transfer on the company bank statement and enter that line's reference. Leave this unconfirmed if you cannot find it.`);
                        if (bankRef && bankRef.trim()) void act(() => jfetch(`/api/advances/returns/${r.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bankRef: bankRef.trim(), bankAccount: returnBank }) }), `${r.receiptNo} confirmed`);
                      }}>Confirm received</button>
                    <button className="btn sm ghost" disabled={busy}
                      onClick={() => { const reason = window.prompt("Why can this return not be confirmed?"); if (reason) void act(() => jfetch(`/api/advances/returns/${r.id}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }), `${r.receiptNo} rejected`); }}>Reject…</button>
                  </>}
                  {canEdit && r.status === "VERIFIED" && r.unallocated > 0 && <button className="btn sm" disabled={busy} onClick={() => setAllocating(r)}>Allocate…</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: "6px 0 0" }}>Costs still to be booked</h3>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Company costs that no guide document carries, because the company had already settled them. They are not owed to the
        guide — but they are still company costs, and PEAK does not have them yet.
      </p>
      {unbooked && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <span><b>{thb(unbooked.totals.total)}</b> over {unbooked.totals.rows} rows</span>
            <span className="muted">from an advance {thb(unbooked.totals.fromAdvance)}</span>
            <span className="muted">company paid direct {thb(unbooked.totals.companyDirect)}</span>
            {unbooked.totals.advanceWithoutRecord > 0 && <span style={{ color: "var(--danger, #b3402f)" }}>{thb(unbooked.totals.advanceWithoutRecord)} says “from an advance” with no advance on record</span>}
          </div>
          <div className="tablewrap">
            <table className="grid">
              <thead><tr><th>Date</th><th>Job</th><th>Guide</th><th>Row</th><th className="r">Amount</th><th>Funded by</th><th>Notes</th></tr></thead>
              <tbody>
                {unbooked.rows.length === 0 && <tr><td colSpan={7} className="muted">Nothing outstanding.</td></tr>}
                {unbooked.rows.map((row, i) => (
                  <tr key={`${row.jobNo}-${i}`}>
                    <td>{row.date}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{row.jobNo ?? "—"}</td>
                    <td>{row.guideId}</td>
                    <td>{row.description}</td>
                    <td className="r num">{thb(row.amount)}</td>
                    <td>{row.fundedBy === "GUIDE_ADVANCE" ? "Guide advance" : "Company direct"}</td>
                    <td style={{ fontSize: 11.5 }}>
                      {row.fundedBy === "GUIDE_ADVANCE" && !row.hasAdvanceRecord && <span style={{ color: "var(--danger, #b3402f)" }}>no advance on record — check before booking</span>}
                      {row.hasAdvanceRecord && <span className="muted">{row.advanceNo}</span>}
                      {row.peakSyncStatus === "VOIDED" && <span className="muted"> · sheet document was voided</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {issuing && <IssueAdvanceDialog onClose={() => setIssuing(false)} onDone={async (m) => { setIssuing(false); setMsg(m); await load(); }} />}
      {detail && <LedgerDialog advance={detail} canEdit={canEdit} onClose={() => setDetail(null)} onChanged={async (m) => { setMsg(m); await load(); }} />}
      {allocating && <AllocateDialog receipt={allocating} advances={open.filter((a) => a.guideId === allocating.guideId)} onClose={() => setAllocating(null)} onDone={async (m) => { setAllocating(null); setMsg(m); await load(); }} />}
    </section>
  );
}

function IssueAdvanceDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [guideId, setGuideId] = useState("");
  const [advanceDate, setAdvanceDate] = useState(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [jobNo, setJobNo] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [purpose, setPurpose] = useState("");
  const [bankRef, setBankRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!jobNo.trim()) { setErr("เลือก Job No. ของรายการเงินทดรอง"); return; }
    if (!bankAccount) { setErr("เลือกบัญชีธนาคารบริษัทที่โอนเงินออก"); return; }
    if (!bankRef.trim()) { setErr("ใส่เลขอ้างอิงรายการโอนจากธนาคาร"); return; }
    if (!file) { setErr("แนบสลิปโอนเงินก่อนบันทึก"); return; }
    setBusy(true); setErr(null);
    try {
      const body = new FormData();
      for (const [key,value] of Object.entries({guideId:guideId.trim(),advanceDate,amount,jobNo:jobNo.trim(),purpose,bankRef,bankAccount})) body.set(key,value);
      if (file) body.set("file",file);
      const r = await jfetch("/api/advances", { method: "POST", body });
      onDone(`${(r.advance as { advanceNo: string }).advanceNo} recorded`);
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="adv-h" style={{ width: "min(520px, 100%)" }}>
        <h3 id="adv-h">Record an advance</h3>
        <div className="mbody">
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Money the company has already transferred to a guide. It is not a fee and not an expense — it is a balance the guide
          owes back, settled by their expenses, by money they send back, or from a later payment.
        </p>
        {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}
        <div style={{ display: "grid", gap: 8 }}>
          <label>Guide ID<input value={guideId} onChange={(e) => setGuideId(e.target.value)} placeholder="G-000" disabled={busy} /></label>
          <label>Date the money left the bank<input type="date" value={advanceDate} onChange={(e) => setAdvanceDate(e.target.value)} disabled={busy} /></label>
          <label>Amount (฿)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
          <label>Job No.<input value={jobNo} onChange={(e) => setJobNo(e.target.value)} placeholder="FOLK-BKK-…" disabled={busy} /></label>
          <AdvanceBankSelect value={bankAccount} onChange={setBankAccount} disabled={busy} />
          <label>สลิปโอนเงิน<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy} onChange={e=>setFile(e.target.files?.[0]??null)} /></label>
          <label>What it is for (optional)<input value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={busy} /></label>
          <label>Bank reference<input value={bankRef} onChange={(e) => setBankRef(e.target.value)} disabled={busy} /></label>
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

function LedgerDialog({ advance, canEdit, onClose, onChanged }: { advance: Advance; canEdit: boolean; onClose: () => void; onChanged: (msg: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [head, setHead] = useState<{ amount: number; settled: number; outstanding: number; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    </div>
  );
}
