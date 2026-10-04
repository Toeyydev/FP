"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { thb } from "@/lib/jobsheet";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";
import { REVIEW_RATE, reviewIncentiveFigures, SUPPLEMENTAL_LABEL, SUPPLEMENTAL_TYPES, STATE_LABEL, type SupplementalType } from "@/lib/supplemental-payments/rules";
import CopyMemo from "@/components/CopyMemo";
import { reviewMemo } from "@/lib/bank-memo";

// Supplemental payments: an amount left out of a payout that already went — a review
// incentive, a bonus, an adjustment. Each is its own obligation and is paid by its own
// transfer (FOLK-PMT-…). The payout it follows is linked, never edited.

type Row = {
  id: string; guideId: string; guide: string; type: SupplementalType; typeLabel: string;
  grossAmount: number; whtPct: number; whtSource: string; wht: number; netAmount: number; accountingCategory: string;
  whtBearer?: string; reviewCount?: number | null; workMonth?: string | null; eWithholding?: boolean;
  peakStatus?: string | null; peakError?: string | null; peakDocumentLink?: string | null;
  legacyBonus: { id: string; period: string } | null;
  reason: string; note: string | null; jobs: { jobNo: string; date: string; slotIdx: number }[];
  originalPaymentNo: string | null; duplicateOverrideReason: string | null;
  payment: "UNPAID" | "PAID" | "VOID"; accounting: "NOT_PAID" | "ACCOUNTING_PENDING" | "RECONCILED" | "VOID";
  paymentNo: string | null; paidDate: string | null; peakRef: string | null; voidReason: string | null; createdAt: string;
};
type Policy = { pct: number | null; invalid: boolean };
type Options = {
  guides: { guideId: string; displayName: string }[]; whtPolicy: Record<SupplementalType, Policy>; categories: string[];
  jobs?: { jobNo: string; date: string; slotIdx: number }[];
  payments?: { id: string; paymentNo: string; paymentDate: string; amountTransferred: number; kind: string }[];
};
type Preview = { reasons: string[]; duplicates: string[]; figures: { gross: number; wht: number; net: number; whtPct: number; whtSource: string; whtBearer?: string } | null; accountingCategory: string | null; review?: { reviewCount: number; workMonth: string; eWithholding: boolean } | null };
/** Pre-fill for the Add dialog: from "Reward a review", or converting an earlier bonus (amount fixed). */
export type SupplementalPrefill = { guideId: string; type: SupplementalType; date?: string; slotIdx?: number; reason?: string; legacyBonus?: { id: string; amount: number; period: string } };

const FILTERS = [["ALL", "All"], ["UNPAID", "Unpaid"], ["PAID", "Paid"], ["ACCOUNTING_PENDING", "Accounting pending"], ["RECONCILED", "Reconciled"], ["VOID", "Void"]] as const;
type Filter = (typeof FILTERS)[number][0];
const bangkokToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const DUPLICATE_REASON = "This looks like a payment that already exists";
// A form field: its label above it, full width.
const FIELD = { display: "grid", gap: 4, fontSize: 13, fontWeight: 600 } as const;

export default function SupplementalPayments({ canEdit, prefill, onPrefillUsed, onChanged }: { canEdit: boolean; prefill?: SupplementalPrefill | null; onPrefillUsed?: () => void; onChanged?: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [adding, setAdding] = useState<SupplementalPrefill | { guideId: ""; type: SupplementalType } | null>(null);
  const [paying, setPaying] = useState<Row | null>(null);
  const [msg, setMsg] = useState("");
  const [msgOk, setMsgOk] = useState(false); // a confirmation, not a refusal
  const [peakDraft, setPeakDraft] = useState<Record<string, string>>({});
  // PEAK's bank accounts, for a review incentive's own document (lib/supplemental-payments/peak).
  const [methods, setMethods] = useState<{ id: string; label: string }[] | null>(null);
  const [method, setMethod] = useState<Record<string, string>>({});
  const loadMethods = useCallback(async () => {
    if (methods) return;
    const r = await fetch("/api/peak/payment-methods", { cache: "no-store" }).catch(() => null);
    const d = r && r.ok ? await r.json().catch(() => ({})) : {};
    setMethods(((d.methods ?? []) as { id: string; name?: string; bankName?: string; accountNumber?: string }[]).map((m) => ({ id: m.id, label: [m.bankName, m.accountNumber].filter(Boolean).join(" ") || m.name || m.id })));
  }, [methods]);
  async function peakCall(id: string, init: { method: "POST" | "PATCH"; body: Record<string, unknown> }) {
    const r = await fetch(`/api/supplemental-payments/${id}/peak`, { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsgOk(false); setMsg((d.reasons ?? ["Not done"]).join(" ")); await load(); return; }
    setMsgOk(true); setMsg(d.documentNo ? `In PEAK as ${d.documentNo}${d.peakStatus === "PAID" ? " — payment recorded" : ""}` : "Recorded"); await load();
  }

  const load = useCallback(async () => {
    const r = await fetch("/api/supplemental-payments", { cache: "no-store" });
    if (r.ok) setRows((await r.json()).rows ?? []);
    onChanged?.(); // the month summary and the earlier-bonus list follow this list
  }, [onChanged]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (prefill) { setAdding(prefill); onPrefillUsed?.(); } }, [prefill, onPrefillUsed]);

  const shown = rows.filter((r) => filter === "ALL" || r.payment === filter || r.accounting === filter);
  const pending = rows.filter((r) => r.accounting === "ACCOUNTING_PENDING");
  const unpaid = rows.filter((r) => r.payment === "UNPAID");

  async function act(id: string, body: Record<string, unknown>) {
    const r = await fetch(`/api/supplemental-payments/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsgOk(false); setMsg((d.reasons ?? ["Not saved"]).join(" ")); return false; }
    setMsg(""); await load(); return true;
  }
  async function correctPeak(r: Row) {
    const next = window.prompt(`${r.peakRef} is recorded for this payment. The correct PEAK document number:`, "");
    if (!next) return;
    const reason = window.prompt(`Why is ${r.peakRef} being corrected to ${next.trim().toUpperCase()}? (kept in the audit)`, "");
    if (reason === null) return;
    await act(r.id, { action: "peakRef", peakRef: next, reason });
  }
  async function addReviews(r: Row) {
    const more = window.prompt(`How many more reviews named ${r.guide} for ${r.workMonth}? (now ${r.reviewCount})`, "1");
    if (more === null) return;
    const n = Number(more);
    const reason = window.prompt("Where did they come from? (kept in the audit)", "");
    if (reason === null) return;
    await act(r.id, { action: "reviews", addReviews: n, reason });
  }
  async function voidRow(r: Row) {
    const reason = window.prompt(`Void this ${r.typeLabel.toLowerCase()} of ${thb(r.grossAmount)} for ${r.guide}? It has not been paid.\n\nReason:`, "");
    if (reason === null) return;
    await act(r.id, { action: "void", reason });
  }

  return (
    <section className="panel" style={{ marginTop: 14 }} aria-label="Supplemental payments">
      <div className="panel-head">
        <h2>Supplemental payments <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>ยอดจ่ายเพิ่มเติม</small></h2>
        {canEdit && <button className="btn primary sm js-add-supplemental" onClick={() => setAdding({ guideId: "", type: "REVIEW_INCENTIVE" })}>+ Add Supplemental Payment · เพิ่มยอดจ่ายเพิ่มเติม</button>}
      </div>
      <div style={{ padding: 14, display: "grid", gap: 10 }}>
        <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>An amount left out of a payout that already went. Each is paid by its own transfer — earlier payments are never changed.</div>
        {pending.length > 0 && (
          <div className="pay-drift js-accounting-pending" role="alert">
            <b>⚠ {pending.length} paid supplemental payment{pending.length === 1 ? " is" : "s are"} not in PEAK yet — {thb(pending.reduce((s, r) => s + r.netAmount, 0))}</b>
            <span>The money has gone, but no PEAK document (EXP-…) is recorded. Enter the EXP number on {pending.length === 1 ? "it" : "each"} below · บันทึกเลขเอกสาร PEAK ให้ครบ</span>
          </div>
        )}
        {unpaid.length > 0 && <div style={{ fontSize: 12.5 }}><b>{unpaid.length}</b> unpaid · {thb(unpaid.reduce((s, r) => s + r.netAmount, 0))} still to transfer</div>}
        <div className="subtabs" role="tablist" aria-label="Filter">
          {FILTERS.map(([k, l]) => <button key={k} type="button" className={`subtab${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>{l} ({rows.filter((r) => k === "ALL" || r.payment === k || r.accounting === k).length})</button>)}
        </div>
        {msg && (msgOk
          ? <div role="status" style={{ padding: "8px 12px", borderRadius: 8, background: "var(--ok-bg,#eef7f0)", border: "1px solid var(--ok-line,#cfe6d6)", color: "var(--green,#2f7d4f)", fontSize: 13 }}>{msg}</div>
          : <div className="pay-drift" role="alert">{msg}</div>)}
        <div className="grid-scroll">
          <table className="acct-table js-supplemental-table">
            <thead><tr><th>Guide</th><th>Type</th><th>Related</th><th>Reason</th><th className="r">Gross</th><th className="r">WHT</th><th className="r">Net</th><th>Status</th><th>Paid</th><th>Accounting</th><th>PEAK ref</th><th /></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={12} className="op-empty">No supplemental payments{filter === "ALL" ? "" : " here"}.</td></tr>}
              {shown.map((r) => (
                <tr key={r.id} data-id={r.id} style={r.accounting === "ACCOUNTING_PENDING" ? { background: "#fdf3e7" } : undefined}>
                  <td style={{ whiteSpace: "nowrap" }}><span className="gid">{r.guideId}</span> {r.guide}</td>
                  <td>{r.typeLabel}<small style={{ display: "block", color: "var(--ink-soft)" }}>{r.accountingCategory}</small></td>
                  <td className="num" style={{ fontSize: 12 }}>
                    {r.reviewCount ? <div className="js-review-month" style={{ whiteSpace: "nowrap" }}>{r.reviewCount} review{r.reviewCount === 1 ? "" : "s"} · {r.workMonth}{r.eWithholding ? " · e-WHT" : ""}</div>
                      : r.jobs.length ? r.jobs.map((j) => <div key={j.jobNo} style={{ whiteSpace: "nowrap" }}>{j.jobNo}</div>) : <span style={{ color: "var(--ink-soft)" }}>guide-level</span>}
                    {r.originalPaymentNo && <div style={{ color: "var(--ink-soft)", whiteSpace: "nowrap" }}>omitted from {r.originalPaymentNo}</div>}
                    {r.legacyBonus && <div style={{ color: "var(--ink-soft)", whiteSpace: "nowrap" }}>converted from earlier bonus ({r.legacyBonus.period})</div>}
                  </td>
                  <td style={{ maxWidth: 220 }}>{r.reason}{r.duplicateOverrideReason && <small style={{ display: "block", color: "#b45309" }}>Created despite a match: {r.duplicateOverrideReason}</small>}</td>
                  <td className="r num">{thb(r.grossAmount)}</td>
                  <td className="r num">{thb(r.wht)}<small style={{ display: "block", color: "var(--ink-soft)" }}>{r.whtPct}% · {r.whtBearer === "COMPANY_ONCE" ? "borne by the company" : r.whtSource === "CONFIGURED" ? "configured" : r.whtSource === "BELOW_THRESHOLD" ? "under ฿1,000" : "entered"}</small></td>
                  <td className="r num"><b>{thb(r.netAmount)}</b></td>
                  <td><span className={`chip-pay ${r.payment === "PAID" ? "recorded" : r.payment === "VOID" ? "reversed" : ""}`}>{STATE_LABEL[r.payment]}</span>{r.voidReason && <small style={{ display: "block", color: "var(--ink-soft)" }}>{r.voidReason}</small>}</td>
                  <td className="num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{r.paymentNo ? <>{r.paymentNo}<div style={{ color: "var(--ink-soft)" }}>{r.paidDate}</div></> : "—"}</td>
                  <td style={{ fontSize: 12 }}>{STATE_LABEL[r.accounting]}</td>
                  <td className="num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {r.whtBearer === "COMPANY_ONCE" && r.payment === "PAID" && r.peakStatus !== "PAID" && canEdit ? (
                      <div className="js-review-peak" style={{ display: "grid", gap: 4 }}>
                        {r.peakRef && <span>{r.peakRef} · payment not recorded yet</span>}
                        {r.peakError && <small style={{ color: "#b45309", whiteSpace: "normal", maxWidth: 240 }}>{r.peakError}</small>}
                        {r.peakStatus === "CREATE_UNCERTAIN" ? (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <input className="search" aria-label="EXP found in PEAK" style={{ width: 120, fontSize: 12 }} placeholder="EXP-… found" value={peakDraft[r.id] ?? ""} onChange={(e) => setPeakDraft((d) => ({ ...d, [r.id]: e.target.value }))} />
                            <button className="btn sm" disabled={!(peakDraft[r.id] ?? "").trim()} onClick={() => peakCall(r.id, { method: "PATCH", body: { resolution: { kind: "created", documentNo: peakDraft[r.id] } } })}>It is in PEAK</button>
                            <button className="btn sm ghost" onClick={() => peakCall(r.id, { method: "PATCH", body: { resolution: { kind: "not-created" } } })}>Not in PEAK</button>
                          </span>
                        ) : r.peakStatus === "PAYMENT_UNCERTAIN" ? (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <button className="btn sm" onClick={() => peakCall(r.id, { method: "PATCH", body: { resolution: { kind: "payment-found" } } })}>Payment is in PEAK</button>
                            <button className="btn sm ghost" onClick={() => peakCall(r.id, { method: "PATCH", body: { resolution: { kind: "payment-not-found" } } })}>No payment in PEAK</button>
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <select className="search" aria-label="Bank account the money left from" style={{ fontSize: 12, maxWidth: 160 }} value={method[r.id] ?? ""} onFocus={loadMethods} onChange={(e) => setMethod((m) => ({ ...m, [r.id]: e.target.value }))}>
                              <option value="">Bank account…</option>
                              {(methods ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                            <button className="btn sm primary js-put-review-in-peak" disabled={!method[r.id]} onClick={() => peakCall(r.id, { method: "POST", body: { paymentMethodId: method[r.id] } })}>Put in PEAK</button>
                          </span>
                        )}
                      </div>
                    ) : r.whtBearer === "COMPANY_ONCE" && r.peakStatus === "PAID" ? (
                      r.peakDocumentLink ? <a href={r.peakDocumentLink} target="_blank" rel="noopener noreferrer">{r.peakRef}</a> : <>{r.peakRef}</>
                    ) : r.peakRef ? <>{r.peakRef}{canEdit && r.payment !== "VOID" && <> <button className="btn sm ghost" onClick={() => correctPeak(r)}>Correct</button></>}</> : (canEdit && r.payment !== "VOID" ? (
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        <input className="search" aria-label="PEAK document number" style={{ width: 130, fontSize: 12 }} placeholder="EXP-…" value={peakDraft[r.id] ?? ""} onChange={(e) => setPeakDraft((d) => ({ ...d, [r.id]: e.target.value }))} />
                        <button className="btn sm" disabled={!(peakDraft[r.id] ?? "").trim()} onClick={async () => { if (await act(r.id, { action: "peakRef", peakRef: peakDraft[r.id] })) setPeakDraft((d) => ({ ...d, [r.id]: "" })); }}>Save</button>
                      </span>
                    ) : "—")}
                  </td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    {canEdit && r.payment === "UNPAID" && <>
                      <button className="btn sm primary" onClick={() => setPaying(r)}>Record payment</button>{" "}
                      {r.reviewCount ? <><button className="btn sm js-add-reviews" onClick={() => addReviews(r)}>+ Reviews</button>{" "}</> : null}
                      {r.reviewCount && r.workMonth ? <div style={{ marginTop: 4 }}><CopyMemo memo={reviewMemo(r.guideId, r.workMonth)} label="Review transfer" /></div> : null}
                      <button className="btn sm ghost danger" onClick={() => voidRow(r)}>Void</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {adding && <AddDialog start={adding} onClose={() => setAdding(null)} onDone={(m) => { setAdding(null); setMsgOk(true); setMsg(m); load(); }} />}
      {paying && <PayDialog row={paying} onClose={() => setPaying(null)} onDone={(m) => { setPaying(null); setMsgOk(true); setMsg(m); load(); }} />}
    </section>
  );
}

function AddDialog({ start, onClose, onDone }: { start: SupplementalPrefill | { guideId: ""; type: SupplementalType }; onClose: () => void; onDone: (msg: string) => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [guideId, setGuideId] = useState(start.guideId);
  const [type, setType] = useState<SupplementalType>(start.type);
  const [jobs, setJobs] = useState<string[]>([]);
  const [jobSearch, setJobSearch] = useState("");
  const legacy = "legacyBonus" in start ? start.legacyBonus ?? null : null;
  const [amount, setAmount] = useState(legacy ? String(legacy.amount) : "");
  const [whtPct, setWhtPct] = useState<string>("");
  const [category, setCategory] = useState("");
  const [original, setOriginal] = useState("");
  const [reason, setReason] = useState("reason" in start && start.reason ? start.reason : "");
  const [note, setNote] = useState("");
  const [override, setOverride] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[]>([]);
  const [requestKey] = useState(newKey);
  const isReview = type === "REVIEW_INCENTIVE";
  const [reviews, setReviews] = useState("");
  // The month the guide worked — from "Reward a review" its tour date, else this month.
  const [workMonth, setWorkMonth] = useState("date" in start && start.date ? start.date.slice(0, 7) : new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7));
  const [eWht, setEWht] = useState(false);
  const reviewCount = Number(reviews);
  const reviewEst = isReview && Number.isInteger(reviewCount) && reviewCount > 0 ? reviewIncentiveFigures(reviewCount, eWht) : null;

  useEffect(() => {
    fetch(`/api/supplemental-payments/options${guideId ? `?guideId=${encodeURIComponent(guideId)}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).then((d: Options | null) => {
        if (!d) return;
        setOpts(d);
        // From "Reward a review": the job the review was for, chosen for the operator.
        if ("date" in start && start.date && guideId === start.guideId && (start.type as string) !== "REVIEW_INCENTIVE") {
          const hit = d.jobs?.find((j) => j.date === start.date && j.slotIdx === start.slotIdx);
          if (hit) setJobs([hit.jobNo]);
        }
      });
  }, [guideId]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (opts?.jobs ?? []).filter((j) => jobs.includes(j.jobNo)), [opts, jobs]);
  // Withholding comes from configured accounting policy; with none, the operator enters it.
  const policy: Policy = opts?.whtPolicy?.[type] ?? { pct: null, invalid: false };
  useEffect(() => { setPreview(null); setErr([]); }, [guideId, type, jobs, amount, whtPct, category, original, reason, note, reviews, workMonth, eWht]);

  const body = () => isReview ? {
    guideId, type, grossAmount: 0, reason, note: note || null, jobs: [], requestKey,
    reviewCount, workMonth, eWithholding: eWht,
  } : ({
    guideId, type, grossAmount: Number(amount), reason, note: note || null,
    whtPct: policy.pct !== null || whtPct.trim() === "" ? null : Number(whtPct),
    accountingCategory: category || null,
    jobs: chosen.map((j) => ({ jobNo: j.jobNo, date: j.date, slotIdx: j.slotIdx })),
    originalPaymentId: original || null, duplicateOverrideReason: override || null, requestKey,
    legacyBonusId: legacy?.id ?? null,
  });
  async function review() {
    setBusy(true);
    const r = await fetch("/api/supplemental-payments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.reasons ?? ["Could not check this payment"]); return; }
    setPreview(d);
  }
  async function create() {
    setBusy(true);
    const r = await fetch("/api/supplemental-payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.reasons ?? ["Not created"]); return; }
    onDone(`Created — ${SUPPLEMENTAL_LABEL[type].en.toLowerCase()} for ${guideId}, unpaid. Record the transfer when it is made.`);
  }
  const blocking = (preview?.reasons ?? []).filter((x) => !(x.startsWith(DUPLICATE_REASON) && override.trim().length >= 10));
  const jobList = (opts?.jobs ?? []).filter((j) => !jobSearch.trim() || j.jobNo.toLowerCase().includes(jobSearch.trim().toLowerCase()));

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal js-add-supplemental-dialog" role="dialog" aria-modal="true" aria-labelledby="sup-h" style={{ width: "min(680px, 100%)" }}>
        <h3 id="sup-h">Add Supplemental Payment · เพิ่มยอดจ่ายเพิ่มเติม</h3>
        <div className="mctx">This payment is separate from previous completed guide payments.</div>
        <div className="mbody" style={{ display: "grid", gap: 10 }}>
          <label className="js-field" style={FIELD}>Guide
            <select className="search" name="guide" value={guideId} onChange={(e) => { setGuideId(e.target.value); setJobs([]); setOriginal(""); }}>
              <option value="">Choose guide…</option>
              {(opts?.guides ?? []).map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.displayName}</option>)}
            </select>
          </label>
          {legacy && <div className="pay-review-facts" role="status"><div><span className="paydoc-label">Converting an earlier bonus</span><b>{legacy.period} · {thb(legacy.amount)} — paid once, through this supplemental payment. The earlier record stays as history.</b></div></div>}
          <label className="js-field" style={FIELD}>Type
            <select className="search" name="type" value={type} disabled={!!legacy} onChange={(e) => setType(e.target.value as SupplementalType)}>
              {SUPPLEMENTAL_TYPES.map((t) => <option key={t} value={t}>{SUPPLEMENTAL_LABEL[t].en} / {SUPPLEMENTAL_LABEL[t].th}</option>)}
            </select>
          </label>
          {isReview && (
            <div className="js-review-fields" style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <label className="js-field" style={FIELD}>Reviews naming the guide · จำนวนรีวิว
                  <input className="search" name="reviews" type="number" min={1} step={1} value={reviews} onChange={(e) => setReviews(e.target.value)} style={{ width: 120 }} />
                </label>
                <label className="js-field" style={FIELD}>Month the guide worked · เดือนที่ทำงาน
                  <input className="search" name="workMonth" type="month" value={workMonth} onChange={(e) => setWorkMonth(e.target.value)} />
                </label>
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" name="ewht" style={{ width: "auto", margin: 0 }} checked={eWht} onChange={(e) => setEWht(e.target.checked)} />
                Paid through e-Withholding Tax (1% instead of 3%)
              </label>
              <div className="js-wht-rule" style={{ fontSize: 12.5 }}>
                ฿{REVIEW_RATE} a review, paid to the guide in full. The company bears the {eWht ? "1" : "3"}% withholding once (ผู้จ่ายออกภาษีให้ครั้งเดียว) — it is not deducted.
                {reviewEst && <> {reviewCount} × ฿{REVIEW_RATE} = <b>{thb(reviewEst.net)}</b> to the guide · tax <b>{thb(reviewEst.wht)}</b> · income on the 50 ทวิ <b>{thb(reviewEst.gross)}</b>.</>}
              </div>
            </div>
          )}
          {guideId && !isReview && (
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Related job(s) <small style={{ fontWeight: 400, color: "var(--ink-soft)" }}>— optional; none for a guide-level amount</small></div>
              <input className="search" placeholder="Search Job No." value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} style={{ width: "100%", boxSizing: "border-box", margin: "4px 0" }} />
              <div style={{ maxHeight: 140, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 6 }}>
                {jobList.length === 0 && <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>No jobs.</div>}
                {jobList.map((j) => (
                  <label key={j.jobNo} style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 8, fontSize: 12.5, padding: "2px 0" }}>
                    <input type="checkbox" style={{ width: "auto", margin: 0, flex: "none" }} checked={jobs.includes(j.jobNo)} onChange={(e) => setJobs((x) => (e.target.checked ? [...x, j.jobNo] : x.filter((y) => y !== j.jobNo)))} />
                    <span className="num">{j.jobNo}</span>
                  </label>
                ))}
              </div>
              {jobs.length > 0 && <div style={{ fontSize: 12, marginTop: 4 }}>Chosen: {jobs.join(", ")}</div>}
            </div>
          )}
          {!isReview && <label className="js-field" style={FIELD}>Amount (฿, before withholding)
            <input className="search" name="amount" type="number" min={0} step="0.01" value={amount} readOnly={!!legacy} onChange={(e) => setAmount(e.target.value)} />
          </label>}
          {isReview ? null : policy.pct !== null ? (
            <div style={{ fontSize: 12.5 }} className="js-wht-rule">Withholding tax <b>{policy.pct}%</b> — configured accounting policy for a {SUPPLEMENTAL_LABEL[type].en.toLowerCase()}.</div>
          ) : (
            <label className="js-field js-wht-rule" style={FIELD}>Withholding tax % <small style={{ fontWeight: 400, color: "#b45309" }}>No rate is configured for a {SUPPLEMENTAL_LABEL[type].en.toLowerCase()}{policy.invalid ? " (the configured value is not a valid rate)" : ""} — enter the rate your accountant confirmed, 0 if none is withheld.</small>
              <input className="search" name="whtPct" type="number" min={0} max={100} step="0.01" value={whtPct} placeholder="e.g. 0 or 3" onChange={(e) => setWhtPct(e.target.value)} style={{ width: 120 }} />
            </label>
          )}
          {type === "REVIEW_INCENTIVE" ? (
            <div style={{ fontSize: 12.5 }}>Account <b>REVIEW_REWARD</b> — cost of services, kept apart from the guide fee. Not a reimbursement, not an advance, not a marketing expense.</div>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label className="js-field" style={FIELD}>Account
                <select className="search" name="category" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">Choose…</option>
                  {(opts?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
          )}
          {guideId && !isReview && (
            <label className="js-field" style={FIELD}>Omitted from a previous payout? <small style={{ color: "var(--ink-soft)" }}>optional</small>
              <select className="search" name="original" value={original} onChange={(e) => setOriginal(e.target.value)}>
                <option value="">No — not linked to a payout</option>
                {(opts?.payments ?? []).map((p) => <option key={p.id} value={p.id}>{p.paymentNo} · {p.paymentDate} · {thb(p.amountTransferred)}</option>)}
              </select>
              {original && <small style={{ color: "var(--ink-soft)" }}>Additional payment — omitted from previous payout. That payout stays exactly as it was.</small>}
            </label>
          )}
          <label className="js-field" style={FIELD}>Reason <small style={{ color: "var(--ink-soft)" }}>Why is this extra payment being made?</small>
            <textarea className="search" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%", boxSizing: "border-box", minHeight: 48 }} />
          </label>
          <label className="js-field" style={FIELD}>Note <small style={{ color: "var(--ink-soft)" }}>optional</small>
            <input className="search" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>

          {preview && (
            <div className="pay-review-facts js-supplemental-review" role="status">
              <div><span className="paydoc-label">Supplemental payment</span><b>{SUPPLEMENTAL_LABEL[type].en}</b></div>
              <div><span className="paydoc-label">Guide</span><b>{guideId}</b></div>
              {preview.review ? <div><span className="paydoc-label">Reviews · month worked</span><b>{preview.review.reviewCount} · {preview.review.workMonth}</b></div>
                : <div><span className="paydoc-label">Related jobs</span><b>{jobs.join(", ") || "guide-level"}</b></div>}
              {preview.figures && preview.figures.whtBearer === "COMPANY_ONCE" && <>
                <div><span className="paydoc-label">To the guide (in full)</span><b>{thb(preview.figures.net)}</b></div>
                <div><span className="paydoc-label">Tax {preview.figures.whtPct}% — borne by the company, once</span><b>{thb(preview.figures.wht)}</b></div>
                <div><span className="paydoc-label">Income on the 50 ทวิ · 510110 expense</span><b>{thb(preview.figures.gross)}</b></div>
              </>}
              {preview.figures && preview.figures.whtBearer !== "COMPANY_ONCE" && <>
                <div><span className="paydoc-label">Amount</span><b>{thb(preview.figures.gross)}</b></div>
                <div><span className="paydoc-label">WHT {preview.figures.whtPct}% · {preview.figures.whtSource === "CONFIGURED" ? "configured policy" : "entered"}</span><b>−{thb(preview.figures.wht)}</b></div>
                <div><span className="paydoc-label">To transfer</span><b>{thb(preview.figures.net)}</b></div>
              </>}
              {preview.accountingCategory && <div><span className="paydoc-label">Account</span><b>{preview.accountingCategory}</b></div>}
            </div>
          )}
          {preview && preview.duplicates.length > 0 && (
            <div className="pay-drift js-supplemental-duplicates" role="alert">
              <b>Possible duplicate</b>
              {preview.duplicates.map((d, i) => <span key={i}>{d}</span>)}
              <label>Create it anyway only if it is a separate payment — say why (recorded and audited):
                <textarea className="search" name="override" value={override} onChange={(e) => setOverride(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
              </label>
            </div>
          )}
          {[...err, ...blocking.filter((x) => !x.startsWith(DUPLICATE_REASON))].map((x, i) => <div key={i} className="pay-drift" role="alert">{x}</div>)}
        </div>
        <div className="mfoot">
          <button className="btn" onClick={onClose}>Cancel</button>
          {!preview
            ? <button className="btn primary" disabled={busy || !guideId || (isReview ? !reviewEst || !workMonth : !(Number(amount) > 0) || (policy.pct === null && whtPct.trim() === ""))} onClick={review}>Review</button>
            : <button className="btn primary js-create-supplemental" disabled={busy || blocking.length > 0} onClick={create}>Create as unpaid</button>}
        </div>
      </div>
    </div>
  );
}

function PayDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: (msg: string) => void }) {
  const [paymentDate, setPaymentDate] = useState(bangkokToday());
  const [amount, setAmount] = useState(String(row.netAmount));
  const [bankRef, setBankRef] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [noSlipReason, setNoSlipReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[]>([]);
  async function submit() {
    setBusy(true); setErr([]);
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ guideId: row.guideId, jobs: [], supplements: [row.id], paymentDate, amountTransferred: Number(amount), bankRef: bankRef || null, noSlipReason: file ? null : noSlipReason || null }));
    if (file) { const blob = await shrinkImage(file); fd.append("file", blob, shrunkName(file.name, blob)); }
    const r = await fetch("/api/guide-payments", { method: "POST", body: fd });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.reasons ?? [`Not recorded (${r.status})`]); return; }
    onDone(`Recorded ${d.payment?.paymentNo ?? "the payment"} — ${thb(d.payment?.amountTransferred ?? Number(amount))} to ${row.guide}.`);
  }
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal js-pay-supplemental-dialog" role="dialog" aria-modal="true" aria-labelledby="supp-pay-h" style={{ width: "min(520px, 100%)" }}>
        <h3 id="supp-pay-h">Record payment · {row.typeLabel}</h3>
        <div className="mctx">{row.guideId} · {row.guide} · {thb(row.grossAmount)} − WHT {thb(row.wht)} = <b>{thb(row.netAmount)}</b>. A transfer of its own — no earlier payment changes.</div>
        <div className="mbody" style={{ display: "grid", gap: 10 }}>
          <label className="js-field" style={FIELD}>Transfer date<input className="search" name="paymentDate" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} /></label>
          <label className="js-field" style={FIELD}>Amount transferred (฿)<input className="search" name="amountTransferred" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label className="js-field" style={FIELD}>Bank reference <small style={{ color: "var(--ink-soft)" }}>optional</small><input className="search" name="bankRef" value={bankRef} onChange={(e) => setBankRef(e.target.value)} /></label>
          <label className="js-field" style={FIELD}>Bank slip<input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          {!file && <label className="js-field" style={FIELD}>No slip? Say why<input className="search" name="noSlipReason" value={noSlipReason} onChange={(e) => setNoSlipReason(e.target.value)} /></label>}
          {err.map((x, i) => <div key={i} className="pay-drift" role="alert">{x}</div>)}
        </div>
        <div className="mfoot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary js-record-supplemental" disabled={busy || !(Number(amount) > 0)} onClick={submit}>{busy ? "Recording…" : "Record payment"}</button>
        </div>
      </div>
    </div>
  );
}
