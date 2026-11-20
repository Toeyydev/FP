"use client";

import { useCallback, useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";

// Finance › Extras cash (Tour Upsell PR4; mockup v9a approved with Codex's copy fixes). The guides'
// hand-ins to confirm or return, sale reversals to decide, the receiving account and the VAT
// registration answer. Finance reads; an Admin decides — the server checks the role, the version
// of what is confirmed (submission no.), and the ledger, on every write.

type Transfer = { id: string; seq: number; amountSatang: number; transferredAt: string; bankRef: string; slipUrl: string | null; toAccount: string; status: string; withdrawnReason: string | null };
type Slip = { id: string; seq: number; status: string; url: string | null; uploadedAt: string; removedReason: string | null; shownAccount: { id: string; version: number; display: string }; reviewVersion: number;
  reviewed: { amountSatang: number; transferredAt: string; bankRef: string; accountId: string; accountVersion: number; toAccount: string; reviewedAt: string } | null; transferId: string | null };
type HandIn = { id: string; settlementNo: string; guideId: string; jobRef: string | null; jobDate: string; status: string; submissionNo: number; returnedReason: string | null; owedSatang: number;
  submission: { submissionNo: number; kind: string; expectedSatang: number; slipIds: string[]; totalSatang: number; transferIds: string[]; status: string; saleRefs: string[] } | null; transfers: Transfer[]; slips: Slip[] };
type CashSale = { saleNo: string; guideId: string; jobRef: string | null; jobDate: string; productName: string; kind: string; guests: number; grossSatang: number; status: string; recordedAt: string; bookings: { bookingRef: string; guests: number; status: string }[]; handIn: string };
type KnownAccount = { id: string; version: number; label: string; display: string; retired: boolean };
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
  const [known, setKnown] = useState<KnownAccount[]>([]);
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
    setHandIns(h.rows); setKnown(h.accounts ?? []); setReversals(r.rows); setAccounts(a); setVat(v?.profile ?? null);
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
                      <td style={{ minWidth: 220 }}>{h.slips.filter((x) => x.status === "ACTIVE" && !x.transferId).length > 0 && <div className="js-slip-count" style={{ fontSize: 12.5 }}>{h.slips.filter((x) => x.status === "ACTIVE" && !x.transferId).length} slip(s) · {h.slips.filter((x) => x.status === "ACTIVE" && x.reviewed && !x.transferId).length} checked</div>}{h.transfers.map((t) => <div key={t.id} style={{ fontSize: 12.5, wordBreak: "break-word", opacity: t.status === "WITHDRAWN" ? 0.6 : 1 }}>{t.seq}. {baht(t.amountSatang)} · sent {when(t.transferredAt)} · {t.bankRef} · to {t.toAccount}{t.status === "WITHDRAWN" ? " · taken out" : ""}</div>)}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{baht(h.owedSatang)}</td>
                      <td style={{ whiteSpace: "normal" }}>{STATUS[h.status] ?? h.status}{h.status === "RETURNED" && h.returnedReason ? <div className="muted" style={{ fontSize: 12 }}>“{h.returnedReason}”</div> : null}{h.status === "CONFIRMED" ? <div className="muted" style={{ fontSize: 12 }}>Locked — corrections after confirmation come later</div> : null}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{isAdmin && h.status === "SUBMITTED" && <>
                        <button className="btn sm primary js-confirm" onClick={() => setConfirming(h)}>{h.submission?.kind === "SLIPS" ? "Check slips…" : "Confirm…"}</button>{" "}
                        <button className="btn sm danger js-return" onClick={() => setReturning(h)}>Return…</button>
                      </>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
        </section>

        <CashSalesPanel />
        <PeakPanel isAdmin={isAdmin} onDone={done} />
        <ReversalsPanel rows={reversals} isAdmin={isAdmin} onDone={done} />
        <AccountPanel accounts={accounts} isAdmin={isAdmin} onDone={done} />
        <VatPanel vat={vat} isAdmin={isAdmin} onDone={done} />
      </div>
      {confirming && (confirming.submission?.kind === "SLIPS"
        ? <SlipsDialog key={confirming.id} h={handIns?.find((x) => x.id === confirming.id) ?? confirming} known={known} onClose={() => setConfirming(null)} onDone={done} onReload={load} onReturn={() => { setReturning(confirming); setConfirming(null); }} />
        : <ConfirmDialog h={confirming} onClose={() => setConfirming(null)} onDone={done} />)}
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

// Slip-only hand-in: the Admin reads each slip (and the statement) and records what it actually
// shows — amount, time, the bank's reference, and which company account it was paid into (the one
// the guide was shown is the default; checked explicitly). The tick confirms exactly the review
// version on screen: if another Admin changed a slip since, Confirm is refused — reload.
const bkk = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString();
function SlipsDialog({ h, known, onClose, onDone, onReload, onReturn }: { h: HandIn; known: KnownAccount[]; onClose: () => void; onDone: (m: string) => Promise<void>; onReload: () => Promise<void>; onReturn: () => void }) {
  const sub = h.submission!;
  const slips = h.slips.filter((x) => sub.slipIds.includes(x.id));
  const [ticked, setTicked] = useState<Map<string, number>>(new Map());
  const [edit, setEdit] = useState<string | null>(slips.find((x) => !x.reviewed)?.id ?? null);
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const total = slips.reduce((n, x) => n + (x.reviewed?.amountSatang ?? 0), 0);
  const allTicked = slips.every((x) => x.reviewed && ticked.get(x.id) === x.reviewVersion);
  const exact = total === sub.expectedSatang;
  const go = async () => {
    setBusy(true); setErr("");
    try { await postJson(`/api/upsell/settlements/${h.id}/confirm`, { submissionNo: sub.submissionNo, slips: slips.map((x) => ({ id: x.id, reviewVersion: ticked.get(x.id) })) }); await onDone(`${h.settlementNo} confirmed — ${baht(sub.expectedSatang)} received ✓`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal js-slips-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-h" style={{ width: "min(620px, 100%)" }}>
        <h3 id="sl-h">Check the slips · {baht(sub.expectedSatang)} owed</h3>
        <div className="mctx">{h.guideId} · ref.โอนเงิน {h.jobRef ?? "—"} · hand-in {h.settlementNo} · {h.jobDate} · submission {sub.submissionNo} · owed now {baht(h.owedSatang)}</div>
        <div className="mbody">
          {slips.map((x) => (
            <div key={x.id} className="js-slip" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10, display: "grid", gap: 6, fontSize: 13.5 }}>
              <div style={{ wordBreak: "break-word" }}><b>Slip {x.seq}</b> · uploaded {when(x.uploadedAt)} · {x.url ? <a href={x.url} target="_blank" rel="noreferrer">open the slip</a> : "file on record"} · guide was shown {x.shownAccount.display} (v{x.shownAccount.version})</div>
              {x.reviewed && edit !== x.id && (
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", minHeight: 44 }}>
                  <input type="checkbox" className="js-slip-tick" style={{ width: 20, height: 20, flex: "none", marginTop: 2 }} checked={ticked.get(x.id) === x.reviewVersion}
                    onChange={(e) => setTicked((m) => { const n = new Map(m); if (e.target.checked) n.set(x.id, x.reviewVersion); else n.delete(x.id); return n; })} />
                  <span style={{ wordBreak: "break-word" }}>On the statement: {baht(x.reviewed.amountSatang)} · <b>{when(x.reviewed.transferredAt)}</b> · ref {x.reviewed.bankRef} · into {x.reviewed.toAccount}{x.reviewed.accountId !== x.shownAccount.id ? " (not the account shown to the guide)" : ""}</span>
                </label>
              )}
              {x.reviewed && edit !== x.id && <div><button className="btn sm" onClick={() => setEdit(x.id)}>Correct what was recorded…</button></div>}
              {edit === x.id && <SlipReview h={h} slip={x} known={known} onSaved={async () => { setEdit(null); setTicked((m) => { const n = new Map(m); n.delete(x.id); return n; }); await onReload(); }} onCancel={() => setEdit(null)} />}
            </div>
          ))}
          <div className="js-slip-total" style={{ fontWeight: 700 }}>Recorded from the slips: {baht(total)} of {baht(sub.expectedSatang)}</div>
          {slips.every((x) => x.reviewed) && !exact && <div className="ob warn" role="status" style={{ display: "block", whiteSpace: "normal" }}>{total < sub.expectedSatang ? "Short" : "Over"} by {baht(Math.abs(total - sub.expectedSatang))} — this cannot be confirmed. Return it to the guide with the reason.</div>}
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Wrong account, a missing or unreadable slip, short or over: return it. One step on Confirm: the slips become recorded transfers, one remittance, the bank clearing queued — or nothing.</p>
          {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
        </div>
        <div className="mfoot"><button className="btn sm" onClick={onClose} disabled={busy}>Close</button><button className="btn sm danger" onClick={onReturn} disabled={busy}>Return…</button><button className="btn sm primary js-slips-confirm" onClick={() => void go()} disabled={busy || !allTicked || !exact}>{busy ? "…" : `Confirm ${baht(sub.expectedSatang)}`}</button></div>
      </div>
    </div>
  );
}

function SlipReview({ h, slip, known, onSaved, onCancel }: { h: HandIn; slip: Slip; known: KnownAccount[]; onSaved: () => Promise<void>; onCancel: () => void }) {
  const r = slip.reviewed;
  const [f, setF] = useState({ amount: r ? String(r.amountSatang / 100) : "", date: r ? bkk(r.transferredAt).slice(0, 10) : "", time: r ? bkk(r.transferredAt).slice(11, 16) : "", ref: r?.bankRef ?? "",
    accountId: r?.accountId ?? slip.shownAccount.id, verified: false });
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr("");
    try {
      await postJson(`/api/upsell/settlements/slips/${slip.id}/review`, { submissionNo: h.submission!.submissionNo, reviewVersion: slip.reviewVersion, amountSatang: Math.round(Number(f.amount) * 100),
        transferredAt: new Date(`${f.date}T${f.time}:00+07:00`).toISOString(), bankRef: f.ref.trim(), receivingAccountId: f.accountId, recipientVerified: f.verified });
      await onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const acct = known.find((a) => a.id === f.accountId);
  return (
    <div className="js-slip-review" style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 6 }}>
        <label className="fl">Amount on the slip (฿)<input aria-label="Amount on the slip" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="fl">Bank reference<input aria-label="Bank reference" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></label>
        <label className="fl">Date on the slip<input aria-label="Date on the slip" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label className="fl">Time on the slip<input aria-label="Time on the slip" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
      </div>
      <label className="fl">Paid into (the recipient on the slip)
        <select aria-label="Paid into" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value, verified: false })}>
          {known.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.display} · v{a.version}{a.retired ? " (retired)" : ""}{a.id === slip.shownAccount.id ? " — shown to the guide" : ""}</option>)}
        </select>
      </label>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", minHeight: 44 }}>
        <input type="checkbox" className="js-recipient-ok" style={{ width: 20, height: 20, flex: "none", marginTop: 2 }} checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked })} />
        <span>The slip’s recipient is {acct ? `${acct.label} · ${acct.display}` : "this account"}. Not a company account? Don’t record it — return the hand-in.</span>
      </label>
      {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {r && <button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="btn sm primary js-slip-save" onClick={() => void save()} disabled={busy || !f.amount || !f.date || !f.time || !f.ref.trim() || !f.verified}>{busy ? "…" : "Save what the slip shows"}</button>
      </div>
    </div>
  );
}

/** The guides' cash sales as recorded ("Send to Admin" on the job sheet) — read only. */
const HANDIN: Record<string, string> = { NOT_SENT: "Cash with the guide", DRAFT: "Cash with the guide", SUBMITTED: "Slip sent — check it above", RETURNED: "Returned to the guide", CONFIRMED: "Handed in", REVERSED: "Reversed" };
function CashSalesPanel() {
  const [rows, setRows] = useState<CashSale[] | null>(null);
  useEffect(() => { void call("/api/upsell/sales", { cache: "no-store" }).then((d) => setRows(d.rows)).catch(() => setRows([])); }, []);
  return (
    <section className="panel js-cash-sales" style={{ marginBottom: 14 }}>
      <div className="op-toolbar"><b>Cash sales from guides</b><span className="muted" style={{ fontSize: 12 }}>Sent by the guide when the cash was received · read only</span></div>
      {rows == null ? <div style={{ padding: 14 }}><div className="skel-row" /></div>
        : rows.length === 0 ? <div className="op-empty" style={{ padding: 18 }}>No cash sales yet.</div>
        : (
          <div style={{ padding: "0 10px 10px", display: "grid", gap: 8 }}>
            {rows.map((r) => (
              <div key={r.saleNo} className="js-cash-sale" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "4px 12px", fontSize: 13.5 }}>
                <span style={{ minWidth: 0, flex: "1 1 220px", wordBreak: "break-word" }}>
                  <b>{r.productName}</b> · {r.guests} {r.guests === 1 ? "guest" : "guests"}{r.status === "REVERSED" ? " · reversed" : ""}
                  <br /><span className="muted" style={{ fontSize: 12 }}>{r.guideId} · {r.jobRef ?? r.jobDate} · {r.saleNo} · {when(r.recordedAt)}</span>
                  {r.bookings.length > 0 && <><br /><span className="muted" style={{ fontSize: 12 }}>{r.bookings.map((b) => `${b.bookingRef} × ${b.guests}${b.status === "RELEASED" ? " (reversed)" : ""}`).join(" · ")}</span></>}
                </span>
                <span style={{ textAlign: "right", whiteSpace: "nowrap" }}><b>{baht(r.grossSatang)}</b><br /><span className="muted" style={{ fontSize: 12 }}>{HANDIN[r.handIn] ?? r.handIn}</span></span>
              </div>
            ))}
          </div>
        )}
    </section>
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

type PeakEvent = { id: string; kind: string; status: string; eventDate: string; reference: string | null; blockedReasons: string[]; lastError: string | null; peakCode: string | null; attempts: number; updatedAt: string };
// One word per state, the same on every row.
const SYNC: Record<string, string> = { BLOCKED: "Blocked", PENDING: "Queued", SENDING: "Queued", POSTED: "Synced", FAILED: "Failed", UNCERTAIN: "Uncertain", CANCELLED: "Cancelled" };
const KIND: Record<string, string> = { RECEIPT: "Receipt", BANK_CLEARING: "Bank clearing", REVENUE_RECOGNITION: "Revenue", SALE_CANCELLED: "Cancel", SALE_REFUNDED: "Refund" };

function PeakPanel({ isAdmin, onDone }: { isAdmin: boolean; onDone: (m: string) => Promise<void> }) {
  const [data, setData] = useState<{ autoSync: boolean; counts: Record<string, number>; rows: PeakEvent[] } | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const load = useCallback(async () => { setData(await call("/api/upsell/peak-events", { cache: "no-store" }).catch(() => null)); }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (url: string, body: unknown, m: string) => {
    setErr("");
    try { const r = await postJson(url, body); await load(); await onDone(r.status === "POSTED" ? `${m} — synced` : `${m} — ${SYNC[r.status] ?? r.status}${r.lastError ? `: ${r.lastError}` : ""}`); }
    catch (e) { setErr((e as Error).message); }
  };
  if (!data) return null;
  const n = (k: string[]) => k.reduce((t, s) => t + (data.counts[s] ?? 0), 0);
  return (
    <section className="panel js-peak-sync" style={{ marginBottom: 14, padding: 14, display: "grid", gap: 8 }}>
      <b>PEAK</b>
      <div className="muted" style={{ fontSize: 12.5 }}>{data.autoSync ? "Sent automatically." : "Automatic sending is off — nothing goes to PEAK."} Queued {n(["PENDING", "SENDING"])} · Synced {n(["POSTED"])} · Failed {n(["FAILED"])} · Uncertain {n(["UNCERTAIN"])} · Blocked {n(["BLOCKED"])}</div>
      {data.rows.length === 0 ? <div className="muted">Nothing yet.</div> : (
        <div className="grid-scroll"><table className="acct-table">
          <thead><tr><th>What</th><th>Ref</th><th>Date</th><th>PEAK</th><th /></tr></thead>
          <tbody>{data.rows.map((e) => (
            <tr key={e.id} className={`js-peak-${e.status.toLowerCase()}`}>
              <td>{KIND[e.kind] ?? e.kind}</td>
              <td style={{ wordBreak: "break-all", fontSize: 12.5 }}>{e.reference}</td>
              <td style={{ whiteSpace: "nowrap" }}>{e.eventDate}</td>
              <td style={{ whiteSpace: "normal", minWidth: 200 }}><b>{SYNC[e.status] ?? e.status}</b>{e.peakCode ? ` · ${e.peakCode}` : ""}
                {e.status === "BLOCKED" && <div className="muted" style={{ fontSize: 12 }}>{e.blockedReasons.join(" · ")}</div>}
                {(e.status === "FAILED" || e.status === "UNCERTAIN") && e.lastError && <div className="muted" style={{ fontSize: 12 }}>{e.lastError}</div>}
                {e.status === "UNCERTAIN" && <div className="muted" style={{ fontSize: 12 }}>It may be in PEAK. Never send it again — find it in PEAK first.</div>}</td>
              <td style={{ whiteSpace: "nowrap" }}>{isAdmin && e.status === "FAILED" && <button className="btn sm" onClick={() => void act(`/api/upsell/peak-events/${e.id}/retry`, {}, `${e.reference} queued again`)}>Send again</button>}
                {isAdmin && e.status === "UNCERTAIN" && <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  {e.kind !== "RECEIPT" && <input className="search" style={{ width: 150 }} aria-label="PEAK document number" placeholder="Code in PEAK" value={codes[e.id] ?? ""} onChange={(x) => setCodes({ ...codes, [e.id]: x.target.value })} />}
                  <button className="btn sm" onClick={() => void act(`/api/upsell/peak-events/${e.id}/resolve`, { peakCode: codes[e.id] || undefined }, `${e.reference} checked in PEAK`)}>Check in PEAK</button>
                </span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {err && <div className="ob bad" role="alert" style={{ whiteSpace: "normal" }}>{err}</div>}
    </section>
  );
}
