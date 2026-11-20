"use client";

import { useCallback, useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";

// Finance › Extras cash (Tour Upsell PR4; mockup v9a approved with Codex's copy fixes). The guides'
// hand-ins to confirm or return, sale reversals to decide, the receiving account and the VAT
// registration answer. Finance reads; an Admin decides — the server checks the role, the version
// of what is confirmed (submission no.), and the ledger, on every write.

type Transfer = { id: string; seq: number; amountSatang: number; transferredAt: string; bankRef: string; slipUrl: string | null; toAccount: string; status: string; withdrawnReason: string | null };
type HandIn = { id: string; settlementNo: string; guideId: string; jobRef: string | null; jobDate: string; status: string; submissionNo: number; returnedReason: string | null; owedSatang: number;
  submission: { submissionNo: number; totalSatang: number; transferIds: string[]; status: string; saleRefs: string[] } | null; transfers: Transfer[] };
type Reversal = { id: string; kind: string; status: string; reason: string; saleNo: string; grossSatang: number; guideId: string; jobRef: string | null; guideAffirmationText: string | null; guideAffirmedAt: string | null; refundAmountSatang: number | null; refundPaidBy: string | null; refundEvidenceUrl: string | null; createdAt: string };
type Account = { id: string; version: number; label: string; display: string; peakPaymentMethodName: string | null; confirmedAt: string; retiredAt: string | null };
type Method = { id: string; name?: string | null; bankName?: string | null; accountNumber?: string | null };

const masked = (n?: string | null) => { const d = (n ?? "").replace(/\D+/g, ""); return d ? `···${d.slice(-4)}` : null; };
const isKbank = (m: { bankName?: string | null; name?: string | null }) => /kasikorn|kbank|กสิกร/i.test(`${m.bankName ?? ""} ${m.name ?? ""}`);
const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const STATUS: Record<string, string> = { SUBMITTED: "Sent — waiting for Admin", RETURNED: "Returned for checking", CONFIRMED: "Confirmed", REVERSED: "Reversed" };

async function call(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.reasons ?? [d.error ?? `HTTP ${r.status}`]).join(" "));
  return d;
}
const postJson = (url: string, body: unknown) => call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export default function UpsellCash({ isAdmin }: { isAdmin: boolean }) {
  const [handIns, setHandIns] = useState<HandIn[] | null>(null);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [accounts, setAccounts] = useState<{ current: Account | null; versions: Account[] } | null>(null);
  const [vat, setVat] = useState<{ vatRegistration: string; vatRegistrationSource: string | null; status: string } | null>(null);
  const [confirming, setConfirming] = useState<HandIn | null>(null);
  const [returning, setReturning] = useState<HandIn | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [h, r, a, v] = await Promise.all([
      call("/api/upsell/settlements?status=SUBMITTED,RETURNED,CONFIRMED", { cache: "no-store" }).catch(() => ({ rows: [] })),
      call("/api/upsell/reversals?status=AWAITING_ADMIN", { cache: "no-store" }).catch(() => ({ rows: [] })),
      call("/api/upsell/receiving-account", { cache: "no-store" }).catch(() => null),
      call("/api/upsell/tax-profile/vat-registration", { cache: "no-store" }).catch(() => null),
    ]);
    setHandIns(h.rows); setReversals(r.rows); setAccounts(a); setVat(v?.profile ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const done = async (m: string) => { setMsg(m); setConfirming(null); setReturning(null); await load(); };

  return (
    <div className="op-layout">
      <OperatorNav active="upsell-cash" />
      <div className="op-main">
        <div className="subtabs"><span className="subtab active">Extras cash</span></div>
        {msg && <div className="ob ok" role="status" style={{ display: "block", whiteSpace: "normal", marginBottom: 10 }}>{msg}</div>}

        <section className="panel js-handins" style={{ marginBottom: 14 }}>
          <div className="op-toolbar"><b>Hand-ins</b><span className="muted" style={{ fontSize: 12 }}>{isAdmin ? "Confirm against the bank, or return for checking" : "Read only"}</span></div>
          {handIns == null ? <div style={{ padding: 14 }}><div className="skel-row" /></div>
            : handIns.length === 0 ? <div className="op-empty" style={{ padding: 18 }}>No hand-ins yet.</div>
            : (
              <div className="grid-scroll" style={{ padding: "0 8px 10px" }}>
                <table className="acct-table">
                  <thead><tr><th>Hand-in</th><th>Guide · job</th><th>Transfers</th><th style={{ textAlign: "right" }}>Owed now</th><th>Status</th><th /></tr></thead>
                  <tbody>{handIns.map((h) => (
                    <tr key={h.id}>
                      <td style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, wordBreak: "break-all" }}>{h.settlementNo}<div className="muted" style={{ fontFamily: "inherit" }}>submission {h.submissionNo}</div></td>
                      <td>{h.guideId}<div className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>{h.jobRef ?? h.jobDate}</div>{h.submission?.saleRefs.length ? <div className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>{h.submission.saleRefs.join(", ")}</div> : null}</td>
                      <td style={{ minWidth: 220 }}>{h.transfers.map((t) => <div key={t.id} style={{ fontSize: 12.5, wordBreak: "break-word", opacity: t.status === "WITHDRAWN" ? 0.6 : 1 }}>{t.seq}. {baht(t.amountSatang)} · sent {when(t.transferredAt)} · {t.bankRef} · to {t.toAccount}{t.status === "WITHDRAWN" ? " · taken out" : ""}</div>)}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{baht(h.owedSatang)}</td>
                      <td style={{ whiteSpace: "normal" }}>{STATUS[h.status] ?? h.status}{h.status === "RETURNED" && h.returnedReason ? <div className="muted" style={{ fontSize: 12 }}>“{h.returnedReason}”</div> : null}{h.status === "CONFIRMED" ? <div className="muted" style={{ fontSize: 12 }}>Locked — corrections after confirmation come later</div> : null}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{isAdmin && h.status === "SUBMITTED" && <>
                        <button className="btn sm primary js-confirm" onClick={() => setConfirming(h)}>Confirm…</button>{" "}
                        <button className="btn sm danger js-return" onClick={() => setReturning(h)}>Return…</button>
                      </>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
        </section>

        <ReversalsPanel rows={reversals} isAdmin={isAdmin} onDone={done} />
        <AccountPanel accounts={accounts} isAdmin={isAdmin} onDone={done} />
        <VatPanel vat={vat} isAdmin={isAdmin} onDone={done} />
      </div>
      {confirming && <ConfirmDialog h={confirming} onClose={() => setConfirming(null)} onDone={done} />}
      {returning && <ReturnDialog h={returning} onClose={() => setReturning(null)} onDone={done} />}
    </div>
  );
}

function ConfirmDialog({ h, onClose, onDone }: { h: HandIn; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const sub = h.submission!;
  const sent = h.transfers.filter((t) => sub.transferIds.includes(t.id));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const all = ticked.size === sent.length;
  const accounts = new Set(sent.map((t) => t.toAccount));
  const go = async () => {
    setBusy(true); setErr("");
    try { await postJson(`/api/upsell/settlements/${h.id}/confirm`, { submissionNo: sub.submissionNo, transferIds: [...ticked] }); await onDone(`${h.settlementNo} confirmed — ${baht(sub.totalSatang)} received ✓`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal js-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cf-h" style={{ width: "min(560px, 100%)" }}>
        <h3 id="cf-h">Confirm {baht(sub.totalSatang)} · submission {sub.submissionNo}</h3>
        <div className="mctx">{h.guideId} · {h.settlementNo} · {h.jobRef ?? h.jobDate} · owed now {baht(h.owedSatang)}</div>
        <div className="mbody">
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 4 }}>
            <legend style={{ fontWeight: 700, paddingBottom: 4 }}>Each transfer is on the statement</legend>
            {sent.map((t) => (
              <label key={t.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", minHeight: 44, fontSize: 13.5 }}>
                <input type="checkbox" style={{ width: 20, height: 20, flex: "none", marginTop: 2 }} checked={ticked.has(t.id)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })} />
                <span style={{ wordBreak: "break-word" }}>{baht(t.amountSatang)} · sent <b>{when(t.transferredAt)}</b> · {t.bankRef} · to {t.toAccount}{t.slipUrl ? <> · <a href={t.slipUrl} target="_blank" rel="noreferrer">slip</a></> : null}</span>
              </label>
            ))}
          </fieldset>
          {accounts.size > 1 && <div className="ob warn" style={{ display: "block", whiteSpace: "normal" }}>Transfers went to different receiving account versions — each is shown as it was reported, never relabelled; each account is cleared on its own.</div>}
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>One step: every ticked transfer confirmed, one remittance, the bank clearing queued — or nothing. Refused if the hand-in changed since you opened it (a newer submission, a reversed sale): reload. It closes this hand-in only; the job sheet's approval is separate.</p>
          {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
        </div>
        <div className="mfoot"><button className="btn sm" onClick={onClose} disabled={busy}>Cancel</button><button className="btn sm primary" onClick={() => void go()} disabled={busy || !all}>{busy ? "…" : `Confirm ${baht(sub.totalSatang)}`}</button></div>
      </div>
    </div>
  );
}

function ReturnDialog({ h, onClose, onDone }: { h: HandIn; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [reason, setReason] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr("");
    try { await postJson(`/api/upsell/settlements/${h.id}/return`, { submissionNo: h.submissionNo, reason }); await onDone(`${h.settlementNo} returned for checking`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal js-return-dialog" role="dialog" aria-modal="true" aria-labelledby="rt-h" style={{ width: "min(520px, 100%)" }}>
        <h3 id="rt-h">Return for checking</h3>
        <div className="mctx">{h.settlementNo} · {h.guideId} · submission {h.submissionNo}</div>
        <div className="mbody">
          <label className="fl" htmlFor="rt-why">What needs checking — the guide sees this</label>
          <input id="rt-why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Transfer 2 is not on the statement yet" />
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Returning changes review status only. Reported transfers and money already in the bank remain recorded; no new transfer is needed unless the earlier report was wrong.</p>
          {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
        </div>
        <div className="mfoot"><button className="btn sm" onClick={onClose} disabled={busy}>Cancel</button><button className="btn sm danger" onClick={() => void go()} disabled={busy || reason.trim().length < 5}>Return for checking</button></div>
      </div>
    </div>
  );
}

function ReversalsPanel({ rows, isAdmin, onDone }: { rows: Reversal[]; isAdmin: boolean; onDone: (m: string) => Promise<void> }) {
  const [err, setErr] = useState("");
  const [refund, setRefund] = useState({ saleNo: "", reason: "", paidBy: "GUIDE_CASH", file: null as File | null });
  const decide = async (r: Reversal, approve: boolean) => {
    setErr("");
    try { await postJson(`/api/upsell/reversals/${r.id}/decide`, { approve }); await onDone(`${r.saleNo} ${approve ? "reversed" : "kept — reversal rejected"}`); }
    catch (e) { setErr((e as Error).message); }
  };
  const recordRefund = async () => {
    setErr("");
    try {
      if (!refund.file) throw new Error("Attach the proof of the refund");
      const fd = new FormData(); fd.append("file", refund.file);
      const ev = await call("/api/bank-transactions/evidence", { method: "POST", body: fd });
      await postJson(`/api/upsell/sales/${encodeURIComponent(refund.saleNo.trim())}/refund`, { reason: refund.reason, paidBy: refund.paidBy, evidence: { url: ev.url, evidenceId: ev.evidenceId } });
      setRefund({ saleNo: "", reason: "", paidBy: "GUIDE_CASH", file: null });
      await onDone("Refund recorded — approve it below");
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="panel js-reversals" style={{ marginBottom: 14, padding: 14, display: "grid", gap: 10 }}>
      <b>Sale reversals waiting for Admin</b>
      {rows.length === 0 ? <div className="muted">None.</div> : rows.map((r) => (
        <div key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10, display: "grid", gap: 6, fontSize: 13.5 }}>
          <div><b>{r.saleNo}</b> · {baht(r.grossSatang)} · {r.guideId} · {r.jobRef ?? ""} · {r.kind === "RECORDED_IN_ERROR" ? "Recorded in error" : "Refunded to the guest"}</div>
          {r.kind === "RECORDED_IN_ERROR"
            ? <div className="ob ok" style={{ display: "block", whiteSpace: "normal" }}>Guide's confirmation ({r.guideAffirmedAt ? when(r.guideAffirmedAt) : ""}): “{r.guideAffirmationText}”<br />Reason: “{r.reason}”</div>
            : <div>Full refund {baht(r.refundAmountSatang ?? 0)} · paid back by {r.refundPaidBy === "COMPANY" ? "the company — the guide's cash is unchanged" : "the guide, from the cash held"} · {r.refundEvidenceUrl ? <a href={r.refundEvidenceUrl} target="_blank" rel="noreferrer">proof</a> : "proof on file"}<br />Reason: “{r.reason}”</div>}
          {isAdmin && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="btn sm" onClick={() => void decide(r, false)}>Reject</button><button className="btn sm danger js-approve-reversal" onClick={() => void decide(r, true)}>Approve — reverse {baht(r.grossSatang)}</button></div>}
        </div>
      ))}
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Not while the job's hand-in is sent (return it first) or confirmed (locked; later). Approval of the job and the guide's fee are not affected.</p>
      {isAdmin && (
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 700, minHeight: 32 }}>Record a refund to a guest…</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 6, maxWidth: 520 }}>
            <input className="search" aria-label="Sale Ref" placeholder="Sale Ref (FOLK-UPS-…)" value={refund.saleNo} onChange={(e) => setRefund({ ...refund, saleNo: e.target.value })} />
            <select className="search" aria-label="Paid back by" value={refund.paidBy} onChange={(e) => setRefund({ ...refund, paidBy: e.target.value })}>
              <option value="GUIDE_CASH">The guide, from the cash held (cash held goes down)</option>
              <option value="COMPANY">The company (the guide's cash is unchanged)</option>
            </select>
            <input className="search" aria-label="Reason" placeholder="Why the guest was refunded" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} />
            <input type="file" aria-label="Proof of the refund" accept="image/*,application/pdf" onChange={(e) => setRefund({ ...refund, file: e.target.files?.[0] ?? null })} />
            <div className="muted" style={{ fontSize: 12.5 }}>The full sale only (partial refunds later).</div>
            <button className="btn sm" onClick={() => void recordRefund()} disabled={!refund.saleNo.trim() || refund.reason.trim().length < 5 || !refund.file}>Record refund</button>
          </div>
        </details>
      )}
      {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
    </section>
  );
}

function AccountPanel({ accounts, isAdmin, onDone }: { accounts: { current: Account | null; versions: Account[] } | null; isAdmin: boolean; onDone: (m: string) => Promise<void> }) {
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [pick, setPick] = useState(""), [label, setLabel] = useState(""), [sure, setSure] = useState(false), [err, setErr] = useState("");
  const loadMethods = async () => {
    setErr("");
    try { setMethods((await call("/api/peak/payment-methods", { cache: "no-store" })).methods ?? []); } catch (e) { setErr((e as Error).message); setMethods([]); }
  };
  const save = async () => {
    setErr("");
    try { const r = await postJson("/api/upsell/receiving-account", { peakPaymentMethodId: pick, label, confirmSuitable: sure }); await onDone(`Receiving account version ${r.version} saved (${r.display})`); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="panel js-receiving-account" style={{ marginBottom: 14, padding: 14, display: "grid", gap: 8 }}>
      <b>Receiving account for Extras cash</b>
      <div>{accounts?.current ? <>Version {accounts.current.version}: <b>{accounts.current.label}</b> · {accounts.current.display}{accounts.current.peakPaymentMethodName ? ` · PEAK: ${accounts.current.peakPaymentMethodName}` : ""}</> : <span className="ob warn">Not set — guides cannot hand in until it is</span>}</div>
      {isAdmin && (methods == null
        ? <div><button className="btn sm js-choose-account" onClick={() => void loadMethods()}>{accounts?.current ? "Change…" : "Choose from PEAK…"}</button></div>
        : (
          <div style={{ display: "grid", gap: 6, maxWidth: 520 }}>
            <select className="search" aria-label="PEAK bank channel" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a PEAK bank channel…</option>
              {[...methods].sort((a, b) => Number(isKbank(b)) - Number(isKbank(a))).map((m) => <option key={m.id} value={m.id}>{[m.bankName, masked(m.accountNumber), m.name].filter(Boolean).join(" · ")}</option>)}
            </select>
            <input className="search" aria-label="Name" placeholder="Name shown to guides, e.g. Folkpaths Extras" value={label} onChange={(e) => setLabel(e.target.value)} />
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5, minHeight: 40 }}><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} style={{ width: 20, height: 20, flex: "none" }} /> I confirm this account receives the guides' Extras cash, and its PEAK mapping is right</label>
            <button className="btn sm primary" onClick={() => void save()} disabled={!pick || label.trim().length < 2 || !sure}>Save as a new version</button>
            <div className="muted" style={{ fontSize: 12.5 }}>Owner: the Extras account is at <b>Kasikorn (KBank)</b>, account holder <b>บจก.โฟล์คพาธส์</b> — Kasikorn channels are listed first. If there are several, compare the last digits with the bank book. Not the ADV account unless that is truly it. Read from PEAK — nothing is guessed or preselected; transfers already reported keep the account they were sent to.</div>
          </div>
        ))}
      {(accounts?.versions.length ?? 0) > 1 && <details><summary style={{ cursor: "pointer" }}>Earlier versions</summary><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{accounts!.versions.filter((v) => v.retiredAt).map((v) => <li key={v.id}>v{v.version} · {v.label} · {v.display} · until {when(v.retiredAt!)}</li>)}</ul></details>}
      {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
    </section>
  );
}

function VatPanel({ vat, isAdmin, onDone }: { vat: { vatRegistration: string; vatRegistrationSource: string | null; status: string } | null; isAdmin: boolean; onDone: (m: string) => Promise<void> }) {
  const [source, setSource] = useState("Owner, 20 Nov 2026: the company is not VAT-registered (ยังไม่ได้จด VAT)");
  const [err, setErr] = useState("");
  if (!vat) return null;
  const save = async () => {
    setErr("");
    try { await postJson("/api/upsell/tax-profile/vat-registration", { code: "UPSELL-STD", vatRegistration: "NOT_REGISTERED", source }); await onDone("Recorded: not VAT-registered"); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="panel js-vat" style={{ padding: 14, display: "grid", gap: 8 }}>
      <b>VAT registration (upsell tax profile)</b>
      <div>{vat.vatRegistration === "NOT_REGISTERED" ? <>Not VAT-registered — no VAT charged, no tax invoice. <span className="muted">Source: {vat.vatRegistrationSource}</span></> : vat.vatRegistration === "REGISTERED" ? "VAT-registered" : <span className="ob warn">Not recorded</span>} · profile {vat.status === "CONFIRMED" ? "confirmed by the accountant" : "draft — the accountant confirms it"}</div>
      <div className="muted" style={{ fontSize: 12.5 }}>Not being registered is not a claim that the service is VAT-exempt. The PEAK document type is chosen after the UAT.</div>
      {isAdmin && vat.vatRegistration === "UNKNOWN" && (
        <div style={{ display: "grid", gap: 6, maxWidth: 520 }}>
          <input className="search" aria-label="Source of the answer" value={source} onChange={(e) => setSource(e.target.value)} />
          <button className="btn sm js-record-vat" onClick={() => void save()} disabled={source.trim().length < 5}>Record: not VAT-registered</button>
        </div>
      )}
      {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
    </section>
  );
}
