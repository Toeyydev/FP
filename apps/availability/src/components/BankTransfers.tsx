"use client";

import { useCallback, useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";
import { thb } from "@/lib/jobsheet";

// Payments › Bank transfers (PR4-0b): every real bank movement the registry holds, those needing
// review first, with each record that names it. Finance reads; an Admin corrects — with evidence on
// file, a reason, and against the version they saw (the server checks all three again).

type Rec = { useId: string; table: string; id: string; docNo: string | null; guideId: string | null; role: string; amountSatang: number | null; live: boolean; verified: boolean };
type Row = {
  id: string; version: string; direction: string; refRaw: string | null; refStatus: string; amountSatang: number | null; amountSource: string | null;
  accountKey: string | null; accountDisplay: string | null; transferDate: string | null; reviewStatus: string; reviewNote: string | null; records: Rec[];
};
type Detail = Row & { releases: { kind: string; fromUseId: string; targetTable: string; targetId: string; reason: string; createdAt: string }[]; history: { action: string; actorId: string | null; actorRole: string | null; createdAt: string; detail: unknown }[] };

const money = (s: number | null) => (s == null ? "—" : thb(s / 100));
const SOURCE: Record<string, string> = { FIRST_USE: "from the first record", GROUP_TOTAL: "the transfer's recorded total", CLAIM: "from a claim, not yet verified", TRANSFER_ROW: "from its transfer row's slip", HISTORICAL_GROUP_SUM: "summed from history", CORRECTED: "corrected by an Admin" };
const TABLE: Record<string, string> = { GuidePayment: "Guide payment", GuidePaymentTransfer: "Payment transfer", GuidePaymentDocument: "PEAK payment document", GuideAdvance: "Company advance", GuideAdvanceReceipt: "ADV return", GuideAdvanceRefund: "ADV refund", GuideAdvanceReturn: "ADV return (old)", UpsellPayment: "Upsell payment", CashSettlementTransfer: "Extras hand-in transfer" };

function state(r: Rec) {
  if (r.role === "DOC") return "Describes it";
  if (r.live) return r.verified ? "Pays" : "Claimed — not verified";
  return r.verified ? "Reversed — money moved, still counted" : "Ended — never verified";
}
const why = (r: Row) =>
  r.reviewStatus !== "NEEDS_REVIEW" ? "" : r.refStatus === "PENDING_VERIFICATION" ? "Reference has no digits" : r.reviewNote ?? "Needs review";

export default function BankTransfers({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [onlyReview, setOnlyReview] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Detail | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (onlyReview) qs.set("review", "1");
    if (q.trim()) qs.set("q", q.trim());
    const r = await fetch(`/api/bank-transactions?${qs}`, { cache: "no-store" });
    setRows(r.ok ? (await r.json()).rows : []);
  }, [onlyReview, q]);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [onlyReview]);

  const openDetail = async (id: string) => {
    const r = await fetch(`/api/bank-transactions/${id}`, { cache: "no-store" });
    if (r.ok) setOpen(await r.json());
  };

  return (
    <div className="op-layout">
      <OperatorNav active="bank-transfers" />
      <div className="op-main">
        <div className="subtabs"><span className="subtab active">Bank transfers</span></div>
        {msg && <div className="ob ok" role="status" style={{ display: "block", margin: "0 0 10px", whiteSpace: "normal" }}>{msg}</div>}
        <section className="panel">
          <div className="op-toolbar" style={{ gap: 10, flexWrap: "wrap" }}>
            <select aria-label="Show" value={onlyReview ? "review" : "all"} onChange={(e) => setOnlyReview(e.target.value === "review")} className="search" style={{ maxWidth: 220 }}>
              <option value="review">Needs review</option><option value="all">All transfers</option>
            </select>
            <input className="search" style={{ flex: 1, minWidth: 180 }} placeholder="Reference" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
            <button className="btn sm" onClick={load}>Search</button>
            <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{isAdmin ? "Admin: corrections need evidence and a reason" : "Read only"} · a transfer is never deleted</span>
          </div>
          {rows == null ? <div style={{ padding: 14 }}>{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" />)}</div>
            : rows.length === 0 ? <div className="op-empty" style={{ padding: 18 }}>{onlyReview ? "Nothing needs review." : "No transfers match."}</div>
            : (
              <div className="grid-scroll" style={{ padding: "0 8px 10px" }}>
                <table className="acct-table js-bank-transfers">
                  <thead><tr><th>Reference</th><th>In/out</th><th style={{ textAlign: "right" }}>Amount</th><th>Account</th><th>Records</th><th>Why</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} onClick={() => openDetail(r.id)} style={{ cursor: "pointer" }}>
                        <td style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, wordBreak: "break-all", minWidth: 110 }}>{r.refRaw}</td>
                        <td>{r.direction === "IN" ? "In" : "Out"}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(r.amountSatang)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.accountDisplay ?? "not recorded"}</td>
                        <td style={{ minWidth: 180 }}>{r.records.map((x) => <div key={x.table + x.id} style={{ wordBreak: "break-word" }}>{x.docNo ?? TABLE[x.table] ?? x.table}{x.guideId ? ` · ${x.guideId}` : ""}{!x.live && x.role === "USE" ? <span className="ob warn" style={{ marginLeft: 6 }}>{x.verified ? "reversed" : "ended"}</span> : null}</div>)}</td>
                        <td style={{ minWidth: 140 }}>{why(r) ? <span className="ob warn" style={{ whiteSpace: "normal" }}>{why(r)}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      </div>
      {open && <TransferDialog t={open} isAdmin={isAdmin} onClose={() => setOpen(null)} onChanged={async (m) => { setMsg(m); await load(); await openDetail(open.id); }} />}
    </div>
  );
}

type Action = null | "amount" | "review" | "rerecord";

function TransferDialog({ t, isAdmin, onClose, onChanged }: { t: Detail; isAdmin: boolean; onClose: () => void; onChanged: (m: string) => Promise<void> }) {
  const [action, setAction] = useState<Action>(null);
  const handedOn = new Set(t.releases.map((x) => x.fromUseId));
  const reversed = t.records.filter((r) => r.role === "USE" && !r.live && r.verified && !handedOn.has(r.useId ?? ""));
  const applied = t.records.filter((r) => r.role === "USE" && (r.live || r.verified)).reduce((n, r) => n + (r.amountSatang ?? 0), 0);
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal js-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="bt-h" style={{ width: "min(720px, 100%)" }}>
        <h3 id="bt-h">{t.direction === "IN" ? "In" : "Out"} · <span style={{ wordBreak: "break-all" }}>{t.refRaw}</span></h3>
        <div className="mbody">
          <dl style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.6fr)", gap: "6px 12px", margin: 0, fontSize: 13.5 }}>
            <dt className="muted">Amount</dt><dd style={{ margin: 0 }}><b>{money(t.amountSatang)}</b> · {SOURCE[t.amountSource ?? ""] ?? "not set yet"}</dd>
            <dt className="muted">Transfer date</dt><dd style={{ margin: 0 }}>{t.transferDate ?? "—"}</dd>
            <dt className="muted">Company account</dt><dd style={{ margin: 0, wordBreak: "break-all" }}>{t.accountDisplay ?? "not recorded"}</dd>
            <dt className="muted">Counted against it</dt><dd style={{ margin: 0 }}>{money(applied)}</dd>
            {t.reviewStatus === "NEEDS_REVIEW" && <><dt className="muted">Needs review</dt><dd style={{ margin: 0 }}>{why(t)}</dd></>}
          </dl>
          <div className="grid-scroll">
            <table className="acct-table" style={{ minWidth: 520 }}>
              <thead><tr><th>Record</th><th>Payee</th><th style={{ textAlign: "right" }}>Amount</th><th>State</th></tr></thead>
              <tbody>{t.records.map((r) => (
                <tr key={r.table + r.id}>
                  <td style={{ wordBreak: "break-word" }}>{r.docNo ?? r.id}<div className="muted" style={{ fontSize: 12 }}>{TABLE[r.table] ?? r.table}</div></td>
                  <td>{r.guideId ?? "—"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(r.amountSatang)}</td>
                  <td style={{ whiteSpace: "normal" }}>{state(r)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {t.releases.length > 0 && <div style={{ fontSize: 13 }}><b>Handed on</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{t.releases.map((x, i) => <li key={i}>{x.kind === "REALLOCATION" ? "Re-recorded" : "Moved to its transfer rows"} — {x.reason}</li>)}</ul></div>}
          <details><summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 32 }}>History ({t.history.length})</summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12.5 }}>{t.history.map((h, i) => <li key={i}>{new Date(h.createdAt).toLocaleString("en-GB")} · {h.action} · {h.actorRole ?? ""}</li>)}</ul>
          </details>
          {action === "amount" && <AmountForm t={t} onDone={onChanged} onCancel={() => setAction(null)} />}
          {action === "review" && <ReviewForm t={t} onDone={onChanged} onCancel={() => setAction(null)} />}
          {action === "rerecord" && <RerecordForm t={t} reversed={reversed} onCancel={() => setAction(null)} />}
        </div>
        <div className="mfoot" style={{ flexWrap: "wrap" }}>
          {isAdmin && !action && reversed.length > 0 && <button className="btn sm primary js-rerecord" onClick={() => setAction("rerecord")}>Re-record with this transfer…</button>}
          {isAdmin && !action && <button className="btn sm js-correct-amount" onClick={() => setAction("amount")}>Correct the amount…</button>}
          {isAdmin && !action && t.reviewStatus === "NEEDS_REVIEW" && <button className="btn sm js-mark-reviewed" onClick={() => setAction("review")}>Mark reviewed…</button>}
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Upload the slip or statement first: corrections cite evidence on file, by id. */
async function uploadEvidence(file: File | null): Promise<string> {
  if (!file) throw new Error("Attach the slip or statement");
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/bank-transactions/evidence", { method: "POST", body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.reasons ?? [d.error ?? `HTTP ${r.status}`]).join(" "));
  return d.evidenceId as string;
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.reasons ?? [d.error ?? `HTTP ${r.status}`]).join(" "));
}

function AmountForm({ t, onDone, onCancel }: { t: Detail; onDone: (m: string) => Promise<void>; onCancel: () => void }) {
  const [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [file, setFile] = useState<File | null>(null), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const evidenceId = await uploadEvidence(file);
      await post(`/api/bank-transactions/${t.id}/amount`, { amount: Number(amount), reason, evidenceId, expectedVersion: t.version });
      await onDone(`Amount corrected to ${thb(Number(amount))} ✓`);
      onCancel();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <fieldset className="js-amount-form" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
      <legend style={{ fontWeight: 700 }}>Correct the amount (from the slip or statement)</legend>
      <label className="fl" htmlFor="bt-amount">Amount on the slip (฿)</label>
      <input id="bt-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label className="fl" htmlFor="bt-ev">Evidence (required)</label>
      <input id="bt-ev" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label className="fl" htmlFor="bt-why">Why</label>
      <input id="bt-why" value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Refused below what is already counted against it. The old and new amounts, the evidence and you are kept in the audit.</p>
      {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}><button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button><button className="btn sm primary" onClick={save} disabled={busy || !amount || !file || reason.trim().length < 5}>{busy ? "…" : "Save"}</button></div>
    </fieldset>
  );
}

function ReviewForm({ t, onDone, onCancel }: { t: Detail; onDone: (m: string) => Promise<void>; onCancel: () => void }) {
  const noDigits = t.refStatus === "PENDING_VERIFICATION";
  const [shows, setShows] = useState<"none" | "real">("none");
  const [note, setNote] = useState(""), [file, setFile] = useState<File | null>(null), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const record = t.records.find((r) => r.role === "USE") ?? t.records[0];
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const evidenceId = await uploadEvidence(file);
      await post(`/api/bank-transactions/${t.id}/review`, { outcome: noDigits ? "NO_REFERENCE_ON_SLIP" : "CONFIRMED_ON_SLIP", note, evidenceId, expectedVersion: t.version });
      await onDone("Marked reviewed ✓");
      onCancel();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <fieldset className="js-review-form" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
      <legend style={{ fontWeight: 700 }}>Mark reviewed</legend>
      {noDigits && (
        <div role="radiogroup" aria-label="What the slip shows" style={{ display: "grid", gap: 4 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}><input type="radio" style={{ width: "auto" }} checked={shows === "real"} onChange={() => setShows("real")} /> A real reference — correct it on its record</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}><input type="radio" style={{ width: "auto" }} checked={shows === "none"} onChange={() => setShows("none")} /> No reference printed — keep as typed; it stays unmatched</label>
        </div>
      )}
      {noDigits && shows === "real" ? (
        <p style={{ margin: 0, fontSize: 13.5 }}>Review never changes a reference. Open <a href={`/payments?view=${record?.table?.startsWith("GuideAdvance") ? "advances" : "guide-payments"}`}>{record?.docNo ?? "the record"}</a> and correct its bank reference there (its own correction, with a reason); this transfer then becomes the real one.</p>
      ) : (
        <>
          <label className="fl" htmlFor="bt-rev-ev">Evidence (the slip)</label>
          <input id="bt-rev-ev" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <label className="fl" htmlFor="bt-rev-note">Note</label>
          <input id="bt-rev-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={noDigits ? "Slip checked: no reference printed" : "Checked against the slip"} />
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Never a made-up number. Clearing the flag is audited with the evidence.</p>
          {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}><button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button><button className="btn sm primary" onClick={save} disabled={busy || !file || note.trim().length < 5}>{busy ? "…" : "Mark reviewed"}</button></div>
        </>
      )}
    </fieldset>
  );
}

function RerecordForm({ t, reversed, onCancel }: { t: Detail; reversed: Rec[]; onCancel: () => void }) {
  const [pick, setPick] = useState(reversed[0]?.id ?? ""), [reason, setReason] = useState("");
  const r = reversed.find((x) => x.id === pick);
  const href = r?.table === "GuidePayment" ? `/payments?view=guide-payments&reuse=${encodeURIComponent(r.id)}&why=${encodeURIComponent(reason.trim())}` : null;
  return (
    <fieldset className="js-rerecord-form" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
      <legend style={{ fontWeight: 700 }}>Re-record with this transfer</legend>
      <div className="ob warn" style={{ display: "block", whiteSpace: "normal" }}>The reversed record keeps its share of this transfer until it is handed on. It goes to <b>the one record you write next</b>, on the same reference and company account ({t.accountDisplay ?? "account not recorded"}). No new bank transfer is made.</div>
      <label className="fl" htmlFor="bt-rr-from">Reversed record</label>
      <select id="bt-rr-from" value={pick} onChange={(e) => setPick(e.target.value)}>
        {reversed.map((x) => <option key={x.id} value={x.id}>{x.docNo ?? x.id} · {x.guideId ?? "—"} · {money(x.amountSatang)}</option>)}
      </select>
      <label className="fl" htmlFor="bt-rr-why">Why (kept in the audit)</label>
      <input id="bt-rr-why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. paid for the right job; the first record named the wrong one" />
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Old: {r?.docNo ?? "—"} for {r?.guideId ?? "—"}. New: the guide, jobs and payee you choose on the next step. Saved together, or not at all; the reversed record cannot come back after.</p>
      {r && !href && <div className="ob warn" style={{ whiteSpace: "normal" }}>Re-record a {TABLE[r.table] ?? r.table} from its own form (Payments › Advances) with “re-record a reversed transfer”.</div>}
      <div style={{ display: "flex", gap: 8 }}><button className="btn sm" onClick={onCancel}>Cancel</button>
        {href ? <a className="btn sm primary" href={reason.trim().length >= 5 ? href : undefined} aria-disabled={reason.trim().length < 5} style={reason.trim().length < 5 ? { opacity: 0.4, pointerEvents: "none" } : undefined}>Continue to Record payment</a> : null}
      </div>
    </fieldset>
  );
}
