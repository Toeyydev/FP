"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";
import { thb } from "@/lib/jobsheet";
import { parseReviewEmail } from "@/lib/review-parse";
import { SLOTS } from "@/lib/slots";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";
import { matchState, type Slip } from "@/lib/payments/slips";
import PeakPaymentDialog, { CreatedState, type CreatedDocument } from "@/components/PeakPaymentDialog";
import RecordPaymentDialog from "@/components/RecordPaymentDialog";
import RecordExpDialog from "@/components/RecordExpDialog";
import RecordGuidePaymentDialog, { type PayableJob } from "@/components/RecordGuidePaymentDialog";
import GuidePaymentsWorkflow from "@/components/GuidePaymentsWorkflow";
import AdvancesWorkflow from "@/components/AdvancesWorkflow";
import { separatePaymentWarning } from "@/lib/peak-payment-document";
import { jobPeakDocumentNo } from "@/lib/peak-job-status";
import { type DocumentDrift } from "@/lib/payment-document-drift";

type Job = { date: string; slotIdx: number; tour: string; ref?: string | null; amount: number; paid: boolean; payStatus: string; peakRef?: string | null; paidAt?: string | null; eslipUrl?: string | null; slips?: Slip[] | null; peakPaymentRef?: string | null; fee: number; expenses: number;
  // From /api/payments (lib/combined-payment): whether the job can go into "Pay N jobs
  // together · one ref", and if not, why. The server refuses with the same rule.
  combinable?: boolean; combinedBlock?: { code: string; message: string; documentNo?: string } | null; sheetPeakDocumentNo?: string | null;
  // Payments v2: the recorded payment that pays this job, and why it cannot be in one now.
  payment?: { id: string; paymentNo: string; paymentDate: string; amountTransferred: number; slipUrl: string | null; noSlipReason: string | null } | null;
  payBlock?: string | null;
  // Paid per tour with no PEAK document number yet: "Record EXP…" can take one (api/pay PATCH).
  canRecordExp?: boolean;
  // Paid on its own record, approved, with no PEAK document: "Put paid jobs in PEAK" can take it.
  canPutInPeak?: boolean;
  // From /api/payments (lib/peak-job-status): whether FolkOPS holds a PEAK document for the job.
  peakStatus?: { state: "IN_PEAK" | "NOT_IN_PEAK" | "NOTHING_TO_POST"; documentNo: string | null; source: string | null } };
type Row = { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number; status: string; paidAt: string | null; eslipUrl?: string | null; peakRef?: string | null; jobs: Job[] };
type Totals = { tours: number; netFee: number; expenses: number; payout: number };
type Bonus = { id: string; guideId: string; guide: string; amount: number; reason: string; ref: string; eslipUrl: string | null };
type Candidate = { date: string; slotIdx: number; time: string; tourId: string; tour: string; guideId: string; guide: string; customerName: string | null; ref: string | null };
// A combined PEAK payment document ("Pay N jobs together"), in two stages: created in
// PEAK and AWAITING_PAYMENT, then PAID once the payment is recorded against it.
// CREATE_UNCERTAIN / PAYMENT_UNCERTAIN are waiting on someone to check PEAK. While a
// document holds its jobs they cannot be paid or posted any other way.
type PaymentDoc = {
  paymentRef: string; guideId: string; status: string; error: string | null; total: number; gross: number; wht: number; lineCount: number;
  jobs: unknown; peakDocumentNo: string | null; peakDocumentLink: string | null; paymentDate: string | null;
  attachmentStatus: string | null; attachmentError: string | null; updatedAt?: string;
  // Jobs paid before the document existed: its payment is the transfer already made
  // (paidDate, and whether a slip was saved then). Shown under Paid, not Unpaid.
  alreadyPaid?: boolean; paidDate?: string | null; hasSavedSlip?: boolean;
  // Awaiting payment: the document against the current approved job sheets (lib/payment-document-drift).
  drift?: DocumentDrift | null;
};
const docJobCount = (d: PaymentDoc) => (Array.isArray(d.jobs) ? d.jobs.length : 0);
const asCreated = (d: PaymentDoc): CreatedDocument => ({
  paymentRef: d.paymentRef, documentNo: d.peakDocumentNo ?? d.paymentRef, documentLink: d.peakDocumentLink,
  gross: d.gross, wht: d.wht, total: d.total, lineCount: d.lineCount,
  jobs: (Array.isArray(d.jobs) ? d.jobs : []) as CreatedDocument["jobs"],
  ...(d.alreadyPaid ? { alreadyPaid: true, paidDate: d.paidDate ?? null, hasSavedSlip: !!d.hasSavedSlip } : {}),
});
/** The Bangkok calendar date of a stored instant — the day a transfer was made. */
const bkkDateOf = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function Payments({ canEdit = true }: { canEdit?: boolean }) {
  const [payTogether, setPayTogether] = useState<{ guideId: string; guide: string; jobs: Job[] } | null>(null);
  // Stage 2: record the payment against a document already created in PEAK.
  const [recordPayment, setRecordPayment] = useState<{ guideId: string; guide: string; doc: CreatedDocument } | null>(null);
  // "Record EXP…": the number of a PEAK document made by hand, on already-paid jobs.
  const [recordExp, setRecordExp] = useState<{ guideId: string; guide: string; jobs: Job[]; preselect: string[] } | null>(null);
  // "Put paid jobs in PEAK": one document for jobs one transfer already paid.
  const [putInPeak, setPutInPeak] = useState<{ guideId: string; guide: string; jobs: Job[]; paidDate: string } | null>(null);
  const [paymentDocs, setPaymentDocs] = useState<PaymentDoc[]>([]);
  const [recordPay, setRecordPay] = useState<{ guideId: string; guide: string; jobs: PayableJob[]; preselect: string[] } | null>(null);
  // Two views of the same money: the month board (legacy history included) and the
  // canonical Guide Payments workflow (one bank transfer at a time).
  const [view, setView] = useState<"board" | "guide-payments" | "advances">("board");
  const [period, setPeriod] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ tours: 0, netFee: 0, expenses: 0, payout: 0 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [hideSec, setHideSec] = useState<Set<string>>(new Set());
  const toggleSec = (s: string) => setHideSec((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "paid" | "notpeak">("all");
  const [q, setQ] = useState(""); // filter by guide id / name
  const [bonuses, setBonuses] = useState<{ rows: Bonus[]; total: number }>({ rows: [], total: 0 });
  // date/slotIdx are set only when the bonus is tied to a rewarded tour (via "Reward a
  // review"), so the server can make the bonus ref follow that tour's job-sheet number.
  const [bForm, setBForm] = useState<{ guideId: string; amount: string; reason: string; date?: string; slotIdx?: number }>({ guideId: "", amount: "", reason: "" });
  // "Reward a review" helper: the OTA email gives only the product + rating; the
  // operator adds the tour date or reviewer name to find who guided it.
  const [rv, setRv] = useState({ paste: "", date: "", name: "", product: "", stars: 0, comment: "", ota: "GYG" });
  const [rvMatches, setRvMatches] = useState<Candidate[] | null>(null);
  const [rvBusy, setRvBusy] = useState(false);
  const [extraGuides, setExtraGuides] = useState<{ guideId: string; guide: string }[]>([]); // guides found via review lookup but not in this month's rows
  // Draft PEAK ref typed against a still-pending guide (keyed by guideId) — shown on
  // the row so the operator can record it before paying the guide's jobs together.
  const [payRef, setPayRef] = useState<Record<string, string>>({});
  const toggle = (gid: string) => setOpen((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  // Batch flow: tick guides → review the total → create ONE payment batch from all
  // their unpaid jobs (server snapshots the amounts; already-batched jobs are
  // skipped and reported by the API — a payable can't sit in two active batches).
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const toggleSel = (gid: string) => setSel((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  async function createBatchFromSelection(guides: Row[]) {
    const items = guides.filter((r) => sel.has(r.guideId)).flatMap((r) => r.jobs.filter((j) => !j.paid).map((j) => ({ guideId: r.guideId, date: j.date, slotIdx: j.slotIdx })));
    if (!items.length) return;
    setBatchBusy(true);
    const r = await fetch("/api/payment-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
    const d = await r.json().catch(() => ({}));
    setBatchBusy(false);
    if (!r.ok) { alert(d.error === "no-eligible-items" ? "None of those jobs are eligible — already paid or already in a batch." : "Couldn't create the batch."); return; }
    setSel(new Set());
    if (confirm(`Batch ${d.batchNo} created — ${d.added} job${d.added === 1 ? "" : "s"} · ${thb(d.total)}${d.skipped?.length ? ` (${d.skipped.length} already in another batch, skipped)` : ""}.\n\nOpen Payment batches to review and pay it?`)) {
      window.location.href = "/payment-batches";
    } else load(period);
  }
  // Put a job marked paid BEFORE Payments v2 back to pending. A job paid by a recorded
  // payment is not undone here — that payment is reversed, with a reason.
  async function setJobPaid(j: Job, guideId: string) {
    const r = await fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date: j.date, slotIdx: j.slotIdx, status: "PENDING" }) });
    if (r.ok) { load(period); return; }
    const d = await r.json().catch(() => ({}));
    alert(d.detail || `Couldn't update this payment (${r.status}).`);
  }

  // Record payment: the jobs of this guide that a transfer could pay, with the reason
  // beside any that cannot go in (the server applies the same rules).
  function openRecordPayment(guideId: string, guide: string, jobs: Job[], preselect: string[] = []) {
    const candidates: PayableJob[] = jobs
      .filter((j) => !j.paid || j.payBlock === null)
      .filter((j) => !j.payment)
      .map((j) => ({ date: j.date, slotIdx: j.slotIdx, ref: j.ref, tour: j.tour, amount: j.amount, payBlock: j.payBlock ?? null }));
    if (!candidates.some((c) => !c.payBlock)) { alert(`No job of ${guide}'s is waiting for a transfer this month.`); return; }
    setRecordPay({ guideId, guide, jobs: candidates, preselect });
  }

  // Reverse a payment recorded by mistake: the record stays, marked reversed with a reason.
  async function reversePayment(payment: NonNullable<Job["payment"]>) {
    const reason = prompt(`Reverse ${payment.paymentNo} (${thb(payment.amountTransferred)})?\n\nIts jobs go back to unpaid and the payment stays on record, marked reversed.\n\nWhy is it being reversed?`, "");
    if (reason === null) return;
    const r = await fetch(`/api/guide-payments/${payment.id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) { load(period); return; }
    alert(d.detail || `Couldn't reverse ${payment.paymentNo} (${r.status}).`);
  }

  // Pay several tours in ONE transfer → ONE PEAK document: the guide as the contact,
  // one reference, one payment date, one Paid By account, one slip, and a line per job
  // and category. The dialog shows that document before anything is posted.
  // A single pending job keeps the direct path.
  async function payBatch(guideId: string, jobs: Job[]) {
    const payable = jobs.filter((j) => !j.paid && !j.peakPaymentRef && j.combinable);
    if (!payable.length) return;
    setPayTogether({ guideId, guide: rows.find((x) => x.guideId === guideId)?.guide ?? guideId, jobs: payable });
  }

  // Paying one job on its own while the guide has others unpaid costs a PEAK document
  // per transfer. Ask first, and point at the one-document path — unless this job
  // cannot go into that document anyway, when on its own is the only way to pay it.
  const confirmSeparate = (guide: string, payableCount: number, job: Job) => {
    if (!job.combinable) return true;
    const w = separatePaymentWarning(guide, payableCount);
    return !w || confirm(w);
  };
  // Unpaid jobs per guide that can go into one payment document — the server's count.
  const combinableOf = (jobs: Job[]) => jobs.filter((j) => !j.paid && j.combinable);
  const payableCountOf = (guideId: string) => combinableOf(rows.find((x) => x.guideId === guideId)?.jobs ?? []).length;
  // Why unpaid, unlocked jobs were left out of "Pay N jobs together", in words.
  const leftOutNote = (jobs: Job[]) => {
    const out = jobs.filter((j) => !j.paid && !j.peakPaymentRef && !j.combinable);
    if (!out.length) return null;
    const inPeak = out.filter((j) => j.combinedBlock?.code === "in-peak-from-sheet").length;
    const unapproved = out.filter((j) => j.combinedBlock?.code === "not-approved").length;
    const other = out.length - inPeak - unapproved;
    return [
      inPeak ? `${inPeak} already in PEAK from ${inPeak === 1 ? "its job sheet" : "their job sheets"}` : "",
      unapproved ? `${unapproved} not approved` : "",
      other ? `${other} not payable together yet — see the job${other === 1 ? "" : "s"} below` : "",
    ].filter(Boolean).join(" · ");
  };
  // Why this unpaid job is not in "Pay N jobs together": its own PEAK document, or the
  // sheet still waiting on approval.
  const inPeakTag = (j: Job) => !j.paid && j.combinedBlock?.code === "in-peak-from-sheet"
    ? <span className="pay-doc-tag" title={`Posted to PEAK from the job sheet as its own document, so it cannot also go into a combined payment document. It can still be paid on its own. If that document was voided in PEAK, record it with "Voided in PEAK…" on the job sheet.`}>In PEAK from job sheet · {j.sheetPeakDocumentNo ?? j.combinedBlock.documentNo ?? "document"}</span>
    : !j.paid && j.combinedBlock?.code === "not-approved"
      ? <span className="pay-doc-tag" title="A combined PEAK payment takes approved job sheets only. Approve this job sheet first — it can still be paid on its own.">Not approved</span>
      : null;
  // No PEAK document for this job in FolkOPS (lib/peak-job-status). Once paid, that is a
  // gap in the books; before payment it is the normal state — so the paid one stands out.
  const notInPeak = (j: Job) => j.peakStatus?.state === "NOT_IN_PEAK";
  const expCandidate = (j: Job) => !!j.canRecordExp && notInPeak(j);
  const peakBadge = (j: Job) => notInPeak(j)
    ? <span className={`pay-peak-missing${j.paid ? " paid" : ""}`} title={j.paid ? "Paid, but FolkOPS has no PEAK document for this job — record its EXP ref, or post it to PEAK" : "No PEAK document for this job yet"}>Not in PEAK</span>
    : j.peakStatus?.state === "NOTHING_TO_POST"
      ? <span className="pay-peak-none" title="This job pays nothing, so there is nothing to book in PEAK">No PEAK doc · ฿0</span>
      : null;
  // A locked job's combined document, in words: its EXP once PEAK created it.
  const docFor = (j: Job) => paymentDocs.find((d) => d.paymentRef === j.peakPaymentRef);
  // Out of sync: the document is not the payout the approved job sheets say. Blocked: a job IN
  // it changed since it was made — the server refuses the payment, so it is not offered.
  const outOfSync = (d: PaymentDoc) => !!d.drift && !d.drift.inSync;
  // What paid this job: the payment record, or — for jobs paid before Payments v2 — a plain
  // "paid" with whatever evidence was kept then.
  const paymentChip = (j: Job) => j.payment
    ? <span className="pay-pmt" title={`Recorded payment · ${thb(j.payment.amountTransferred)} on ${j.payment.paymentDate}${j.payment.slipUrl ? " · slip attached" : j.payment.noSlipReason ? ` · no slip: ${j.payment.noSlipReason}` : ""}`}>{j.payment.paymentNo}{j.payment.slipUrl ? " · slip" : ""}</span>
    : j.paid ? <span className="pay-pmt legacy" title="Marked paid before payments were recorded — there is no payment record behind it">paid · no payment record</span> : null;
  const paymentBlocked = (d: PaymentDoc) => !!d.drift && d.drift.changed.length > 0;
  const docTag = (j: Job) => { const d = docFor(j); return d?.peakDocumentNo ? `Combined PEAK document ${d.peakDocumentNo}` : j.peakPaymentRef ?? ""; };
  const docBadge = (j: Job) => {
    const st = docFor(j)?.status;
    return st === "AWAITING_PAYMENT" ? "Awaiting payment" : st === "PAYING" || st === "PAYMENT_UNCERTAIN" ? "Payment unconfirmed" : st === "PAID" ? "Paid" : "Waiting on PEAK";
  };
  // Settle a payment document by what only PEAK can say.
  async function resolveDoc(doc: PaymentDoc, resolution: "found" | "not-found" | "payment-found" | "payment-not-found" | "voided") {
    const n = docJobCount(doc);
    const docNo = doc.peakDocumentNo ?? doc.paymentRef;
    let documentNo: string | undefined;
    if (resolution === "found") {
      const v = prompt(`Enter the PEAK document number for ${doc.paymentRef}.\n\nIn PEAK, find the expense whose reference is ${doc.paymentRef}. It will be recorded as awaiting payment — nothing is marked paid.`, "EXP-");
      if (v === null || !v.trim() || v.trim() === "EXP-") return;
      documentNo = v.trim();
    } else if (resolution === "not-found") {
      if (!confirm(`Confirm ${doc.paymentRef} is NOT in PEAK?\n\nIts ${n} job${n === 1 ? "" : "s"} will be released so they can go into a new document. If PEAK does have it, a new document would be a second one.`)) return;
    } else if (resolution === "payment-found") {
      if (!confirm(doc.alreadyPaid
        ? `Confirm PEAK shows the payment recorded on ${docNo}?\n\nAll ${n} job${n === 1 ? "" : "s"} take ${docNo}. They stay paid as recorded, and the guide is not told again.`
        : `Confirm PEAK shows the payment recorded on ${docNo}?\n\nAll ${n} job${n === 1 ? "" : "s"} will be marked paid and the guide told.`)) return;
    } else if (resolution === "payment-not-found") {
      if (!confirm(`Confirm PEAK shows NO payment on ${docNo}?\n\nThe document goes back to awaiting payment, so the payment can be recorded again. If PEAK does hold it, recording again pays twice.`)) return;
    } else if (!confirm(`Mark ${docNo} as voided in PEAK?\n\nOnly do this after voiding it in PEAK. All ${n} job${n === 1 ? "" : "s"} in it are released${doc.alreadyPaid ? " and lose the EXP — they stay paid" : doc.status === "PAID" ? " and become unpaid again" : ""}.`)) return;
    const r = await fetch("/api/pay/peak-document", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentRef: doc.paymentRef, resolution, ...(documentNo ? { documentNo } : {}) }) });
    if (r.ok) { load(period); return; }
    const d = await r.json().catch(() => ({}));
    alert(d.error || `Couldn't update ${doc.paymentRef} (${r.status}).`);
  }
  // Remove a single uploaded job sheet + its tour records (operators only).
  async function removeJob(j: Job, guideId: string, guide: string) {
    if (!confirm(`Remove this job sheet?\n${guide} · ${dShort(j.date)} ${SLOTS[j.slotIdx]?.start} · ${j.tour}${j.ref ? ` · ${j.ref}` : ""}\n\nDeletes the job sheet, assignment, payment, any check-in/report AND the imported booking for this tour, so it won't re-sync back onto Payments.\n\nThis does NOT cancel it on the OTA (GetYourGuide) — do that there first. Cannot be undone.`)) return;
    const r = await fetch("/api/jobsheet", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date: j.date, slotIdx: j.slotIdx }) });
    if (r.ok) load(period);
  }
  // Save the PEAK accounting ref (EXP-…) for a guide's combined monthly payout.
  async function savePeakRef(guideId: string, peakRef: string) {
    await fetch("/api/payments", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId, peakRef }) });
    load(period);
  }

  const load = useCallback(async (p?: string) => {
    const r = await fetch(`/api/payments${p ? `?period=${p}` : ""}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setPeriod(d.period); setRows(d.rows ?? []); setTotals(d.totals); setPaymentDocs(d.paymentDocs ?? []); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadBonuses = useCallback(async (p: string) => {
    if (!p) return;
    const r = await fetch(`/api/payments/bonus?period=${p}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setBonuses({ rows: d.rows ?? [], total: d.total ?? 0 }); }
  }, []);
  useEffect(() => { loadBonuses(period); }, [period, loadBonuses]);

  async function addBonus() {
    const amt = parseFloat(bForm.amount);
    if (!bForm.guideId || !(amt > 0)) return;
    const r = await fetch("/api/payments/bonus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId: bForm.guideId, amount: amt, reason: bForm.reason, ...(bForm.date && bForm.slotIdx != null ? { date: bForm.date, slotIdx: bForm.slotIdx } : {}) }) });
    if (r.ok) { setBForm({ guideId: "", amount: "", reason: "" }); setExtraGuides([]); loadBonuses(period); }
  }
  // Pull product / rating / comment out of a pasted OTA review email.
  function onPasteReview(text: string) {
    const p = parseReviewEmail(text);
    setRv((s) => ({ ...s, paste: text, product: p.product ?? s.product, stars: p.stars ?? s.stars, comment: p.comment ?? s.comment, ota: p.ota ?? s.ota }));
  }
  // Look up who guided the reviewed tour (by date and/or reviewer name).
  async function findReviewGuide() {
    if (!rv.date && rv.name.trim().length < 2) return;
    setRvBusy(true); setRvMatches(null);
    const qs = new URLSearchParams();
    if (rv.date) qs.set("date", rv.date);
    if (rv.name.trim()) qs.set("name", rv.name.trim());
    if (rv.product.trim()) qs.set("product", rv.product.trim());
    const r = await fetch(`/api/payments/review-match?${qs.toString()}`, { cache: "no-store" });
    setRvBusy(false);
    if (r.ok) { const d = await r.json(); setRvMatches(d.candidates ?? []); } else setRvMatches([]);
  }
  // Pre-fill the bonus form for the chosen guide (adding them to the picker if this
  // month's payout doesn't already list them — a late review can span months).
  function rewardCandidate(c: Candidate) {
    const reason = `${rv.stars ? rv.stars + "★ " : ""}${rv.ota || "OTA"} · ${c.tour} · ${dShort(c.date)}${rv.comment ? ` · "${rv.comment}"` : ""}`.slice(0, 200);
    setExtraGuides((g) => g.some((x) => x.guideId === c.guideId) ? g : [...g, { guideId: c.guideId, guide: c.guide }]);
    setBForm({ guideId: c.guideId, amount: "", reason, date: c.date, slotIdx: c.slotIdx });
    setRvMatches(null);
  }
  async function delBonus(id: string) {
    const r = await fetch("/api/payments/bonus", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    if (r.ok) loadBonuses(period);
  }
  async function uploadBonusEslip(bonusId: string, file: File) {
    // The bonus REF NO. follows the payment slip: capture the slip's ref no. on upload
    // (blank keeps the current ref).
    const slipRef = prompt("Payment slip ref no. — sets the bonus REF NO. (leave blank to keep the current ref):", "");
    const blob = await shrinkImage(file);
    const fd = new FormData(); fd.append("bonusId", bonusId); fd.append("file", blob, shrunkName(file.name, blob));
    if (slipRef && slipRef.trim()) fd.append("ref", slipRef.trim());
    const r = await fetch("/api/payments/bonus/eslip", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok) loadBonuses(period); else alert(d.hint || d.detail || `E-slip upload failed (${r.status}).`);
  }
  async function editBonusRef(id: string, ref: string) {
    await fetch("/api/payments/bonus", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ref }) });
    loadBonuses(period);
  }

  async function mark(guideId: string, status: "pending" | "paid") {
    const r = await fetch("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId, status }) });
    if (r.ok) load(period);
  }
  // Split payment: add ONE slip (with its amount) to a single tour. Several slips
  // can be added and must sum to the tour's payout ("the right number") before it
  // shows Paid. A mismatch is reported so the operator can correct the amount.
  // The transfer amount is the one number that must not be retyped from memory —
  // or read off another screen. The operator reported taking it from PEAK and
  // picking the wrong column there (gross instead of net of withholding tax, a
  // 3% miss). FolkOPS already knows the exact figure; make it one tap to copy so
  // there is no reason to look anywhere else.
  const [copied, setCopied] = useState<string>("");
  const copyAmount = (key: string, amount: number) => {
    // Plain digits, no ฿ and no thousands separator — this is pasted into a
    // banking app, which rejects both.
    const plain = amount.toFixed(2);
    navigator.clipboard?.writeText(plain)
      .then(() => { setCopied(key); setTimeout(() => setCopied(""), 1500); })
      .catch(() => {});
  };


  async function removeRow(guideId: string, guide: string) {
    if (!confirm(`Delete ${guide}'s entire pay for ${period}?\nThis permanently removes ALL their tours that month — assignments, job sheets, check-ins, reports, payments AND the imported bookings for those tours, so they won't re-sync back onto Payments.\n\nThis does NOT cancel anything on the OTA (GetYourGuide) — do that there first. Cannot be undone.`)) return;
    const r = await fetch("/api/payments", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId }) });
    if (r.ok) load(period);
  }

  function exportCsv() {
    const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    // Per-JOB rows so each tour reconciles to the PEAK ref of the transfer that paid it —
    // the job's own document only, never the guide's monthly ref on a job it did not pay.
    const head = ["Guide ID", "Guide", "Date", "Job sheet no.", "Tour", "Amount", "Paid", "PEAK ref"];
    const lines = [head.join(",")].concat(
      rows.flatMap((r) => r.jobs.map((j) => [r.guideId, r.guide, j.date, j.ref ?? "", j.tour, j.amount, j.paid ? "PAID" : "PENDING", jobPeakDocumentNo(j.peakStatus) ?? ""].map(cell).join(",")))
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `folkpaths-payroll-${period}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Print-ready PDF of everything still owed (unpaid jobs), grouped by guide.
  // Same no-dependency approach as the job sheet: open an HTML doc and let the
  // browser "Save as PDF". Thai tour names render natively.
  function exportPendingPdf() {
    const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    const guides = rows
      .map((r) => ({ ...r, ujobs: r.jobs.filter((j) => !j.paid) }))
      .filter((r) => r.ujobs.length > 0)
      .sort((a, b) => a.guideId.localeCompare(b.guideId));
    if (guides.length === 0) { alert("No pending jobs to export — everyone is paid for this period."); return; }
    const grand = guides.reduce((s, r) => s + r.ujobs.reduce((a, j) => a + j.amount, 0), 0);
    const jobCount = guides.reduce((s, r) => s + r.ujobs.length, 0);
    const genDate = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const sections = guides.map((r) => {
      const sub = r.ujobs.reduce((a, j) => a + j.amount, 0);
      const ref = (payRef[r.guideId] ?? "").trim();
      const body = r.ujobs.map((j) => `<tr><td>${esc(dShort(j.date))} · ${esc(SLOTS[j.slotIdx]?.start ?? "")}</td><td>${esc(j.tour)}${j.ref ? `<br><span style="color:#888;font-size:10.5px">${esc(j.ref)}</span>` : ""}</td><td class="r">${esc(thb(j.fee))}</td><td class="r">${esc(thb(j.expenses))}</td><td class="r b">${esc(thb(j.amount))}</td></tr>`).join("");
      return `<section><h2><span class="gid">${esc(r.guideId)}</span> ${esc(r.guide)}${ref ? `<span class="ref">PEAK ref: ${esc(ref)}</span>` : ""}</h2>
        <table><thead><tr><th>Date</th><th>Tour</th><th class="r">Guide fee</th><th class="r">Expenses</th><th class="r">Amount</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="4" class="r b">Subtotal · ${r.ujobs.length} job${r.ujobs.length === 1 ? "" : "s"}</td><td class="r b">${esc(thb(sub))}</td></tr></tfoot></table></section>`;
    }).join("");
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Folkpaths pending payments ${esc(period)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Helvetica Neue",Arial,"Noto Sans Thai",sans-serif;color:#2a2520;padding:28px 30px;font-size:13px}
  .toolbar{position:sticky;top:0;background:#7e3a2c;color:#fff;display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-radius:9px;margin-bottom:22px}
  .toolbar button{background:#fff;color:#7e3a2c;border:none;border-radius:7px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer}
  h1{font-size:21px;font-weight:800}
  .meta{color:#6f665b;font-size:12.5px;margin:3px 0 18px}
  .summary{background:#fbf4e8;border:1px solid #ecd9bf;border-radius:10px;padding:12px 16px;margin-bottom:22px;display:flex;justify-content:space-between;font-weight:700}
  .summary .tot{color:#7e3a2c;font-size:17px}
  section{margin-bottom:20px;break-inside:avoid}
  h2{font-size:15px;font-weight:800;margin-bottom:7px;padding-bottom:5px;border-bottom:2px solid #ecd9bf;display:flex;align-items:baseline;gap:8px}
  h2 .gid{color:#7e3a2c;font-family:monospace}
  h2 .ref{margin-left:auto;font-size:11.5px;color:#6f665b;font-weight:600}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;font-size:12.5px}
  th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#6f665b}
  .r{text-align:right}.b{font-weight:700}
  tfoot td{border-top:2px solid #ddd;border-bottom:none;padding-top:8px}
  @media print{.toolbar{display:none}body{padding:0}}
</style></head>
<body>
  <div class="toolbar"><span>Pending payments · ${esc(period)}</span><button onclick="window.print()">Save as PDF / Print</button></div>
  <h1>Folkpaths — Pending payments</h1>
  <div class="meta">${esc(period)} · generated ${esc(genDate)}</div>
  <div class="summary"><span>${jobCount} pending job${jobCount === 1 ? "" : "s"} · ${guides.length} guide${guides.length === 1 ? "" : "s"}</span><span class="tot">Total owed: ${esc(thb(grand))}</span></div>
  ${sections}
  <script>window.onload=function(){setTimeout(function(){window.print();},350);};</script>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) { alert("Please allow pop-ups to export the PDF."); return; }
    w.document.write(html); w.document.close();
  }

  const ql = q.trim().toLowerCase();
  // Guides with unpaid jobs float to the top so the operator sees who's still owed.
  const visible = rows
    .filter((r) => (statusFilter === "all" || (statusFilter === "notpeak" ? r.jobs.some(notInPeak) : r.status === statusFilter)) && (!ql || `${r.guideId} ${r.guide}`.toLowerCase().includes(ql)))
    .sort((a, b) => a.guide.localeCompare(b.guide));
  // Split BY TOUR: a guide appears under Unpaid for their unpaid tours and under Paid
  // for their paid tours — so a single tour moves to Paid the moment it's paid.
  // "Not in PEAK" narrows each guide to the jobs FolkOPS has no PEAK document for.
  const jobsShown = (r: Row) => (statusFilter === "notpeak" ? r.jobs.filter(notInPeak) : r.jobs);
  const unpaidGuides = visible.filter((r) => jobsShown(r).some((j) => !j.paid));
  const paidGuides = visible.filter((r) => jobsShown(r).some((j) => j.paid));
  // Flat, date-sorted list of every unpaid job across all guides — the "Pending only"
  // view, so pending payments read in tour-date order (earliest first) rather than by guide.
  const pendingFlat: (Job & { guideId: string; guide: string })[] = rows
    .filter((r) => !ql || `${r.guideId} ${r.guide}`.toLowerCase().includes(ql))
    .flatMap((r) => r.jobs.filter((j) => !j.paid).map((j) => ({ ...j, guideId: r.guideId, guide: r.guide })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx);
  const sumBy = (jobs: Job[], k: "amount" | "fee" | "expenses") => jobs.reduce((s, j) => s + (j[k] ?? 0), 0);

  function renderGuideRow(r: Row, jobs: Job[], mode: "unpaid" | "paid") {
    const okey = `${mode}|${r.guideId}`;
    const isOpen = open.has(okey);
    // PEAK stays in the background on the main row: a compact recorded-vs-total
    // count; the actual EXP- refs live in the expanded job rows.
    const refd = jobs.filter((j) => !notInPeak(j)).length;
    const missing = jobs.length - refd;
    // Jobs a payment document holds are paid through that document only. `payable` is
    // what "Pay N jobs together" may take — the server's own rule; `unlocked` is every
    // unpaid job no payment document holds, which a per-tour or covering slip can pay.
    const payable = combinableOf(jobs);
    const unlocked = jobs.filter((j) => !j.paid && !j.peakPaymentRef);
    const leftOut = mode === "unpaid" ? leftOutNote(jobs) : null;
    const mine = paymentDocs.filter((d) => d.guideId === r.guideId && jobs.some((j) => j.peakPaymentRef === d.paymentRef));
    // Created in PEAK, not yet paid: the document and its EXP stay in view until the payment is recorded.
    // A document for jobs paid before it existed lives with those jobs, under Paid.
    const inMode = mine.filter((d) => (mode === "paid") === !!d.alreadyPaid);
    const awaitingDocs = inMode.filter((d) => d.status === "AWAITING_PAYMENT");
    const createUnconfirmed = inMode.filter((d) => d.status === "CREATING" || d.status === "CREATE_UNCERTAIN");
    const paymentUnconfirmed = inMode.filter((d) => d.status === "PAYING" || d.status === "PAYMENT_UNCERTAIN");
    const openDocs = [...createUnconfirmed, ...paymentUnconfirmed];
    const unattached = mode === "paid" ? mine.filter((d) => d.status === "PAID" && d.attachmentStatus === "FAILED") : [];
    return (
      <Fragment key={okey}>
        <tr style={{ cursor: "pointer" }} onClick={() => toggle(okey)}>
          <td onClick={(e) => e.stopPropagation()} style={{ width: 30, textAlign: "center" }}>
            {mode === "unpaid" && canEdit
              ? <input type="checkbox" checked={sel.has(r.guideId)} onChange={() => toggleSel(r.guideId)} title="Select for a payment batch" />
              : null}
          </td>
          <td><span style={{ color: "var(--ink-soft)", marginRight: 4 }}>{isOpen ? "▾" : "▸"}</span><span className="gid">{r.guideId}</span> {r.guide}</td>
          <td className="r">{jobs.length}</td>
          <td className="r">{thb(sumBy(jobs, "fee"))}</td>
          <td className="r">{thb(sumBy(jobs, "expenses"))}</td>
          <td className="r"><b>{thb(sumBy(jobs, "amount"))}</b></td>
          <td>
            {mode === "paid" && (openDocs.length || awaitingDocs.length)
              ? (openDocs.length
                  ? <span className="ob warn" title="PEAK has not confirmed a document or payment for these paid jobs — open the row to settle it">⚠ PEAK unconfirmed</span>
                  : outOfSync(awaitingDocs[0])
                    ? <span className="ob warn pay-drift-badge" title="The PEAK document no longer matches the current job sheets — align it in PEAK before recording the payment">{awaitingDocs[0].peakDocumentNo} · out of sync</span>
                    : <span className="ob warn" title="A PEAK document was created for these paid jobs — record their payment against it">{awaitingDocs[0].peakDocumentNo} · record payment</span>)
              : mode === "paid"
              ? (!missing
                  ? <span className="ob ok" title="FolkOPS has a PEAK document for every job in this payout">✓ PEAK {refd}/{jobs.length}</span>
                  : <span className="ob warn" title="Paid jobs with no PEAK document in FolkOPS — open the row to see which">⚠ {missing} not in PEAK</span>)
              : openDocs.length
                ? <span className="ob warn" title="PEAK has not confirmed a document or payment for this guide — open the row to settle it">⚠ PEAK unconfirmed</span>
                : awaitingDocs.length
                  ? (outOfSync(awaitingDocs[0])
                      ? <span className="ob warn pay-drift-badge" title="The PEAK document no longer matches the current job sheets — align it in PEAK before recording the payment">{awaitingDocs[0].peakDocumentNo} · out of sync</span>
                      : <span className="ob warn" title="A combined PEAK document exists and is waiting for its payment to be recorded">{awaitingDocs[0].peakDocumentNo} · awaiting payment</span>)
                  : missing ? <span className="ob mut" title="No PEAK document for these jobs yet">{missing} not in PEAK</span> : <span className="ob mut">—</span>}
          </td>
          <td><span className={`badge ${mode === "paid" ? "active" : "invited"}`}>{mode === "paid" ? "Paid" : "Pending"}</span></td>
          <td style={{ display: "flex", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
            {mode === "paid" && r.eslipUrl && <a className="btn sm" href={r.eslipUrl} target="_blank" rel="noopener noreferrer" title="View payment slip in Drive">View slip</a>}
            {mode === "paid" && r.paidAt && <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>{new Date(r.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
            {mode === "unpaid" && canEdit && payable.length > 0 && <button className="btn sm primary" title={payable.length > 1 ? `Pay ${payable.length} jobs in one transfer — ONE PEAK document with a line per job` : "Pay this job"} onClick={() => payBatch(r.guideId, payable)}>Pay {payable.length}</button>}
            {mode === "unpaid" && canEdit && <button className="btn sm" title="Record a bank transfer to this guide: the jobs it paid, the date, the amount and the slip" onClick={() => openRecordPayment(r.guideId, r.guide, jobs)}>Record payment…</button>}
          </td>
        </tr>
        {isOpen && (
          <tr className="pay-jobs-row"><td colSpan={9} style={{ background: "var(--grey-bg)", padding: "6px 12px" }}>
            {awaitingDocs.map((d) => (
              <div key={d.paymentRef} className="pay-doc-bar pay-doc-awaiting" role="status" style={{ display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>{d.alreadyPaid ? `PEAK document created for jobs paid ${d.paidDate ? dShort(d.paidDate) : "earlier"} · record that payment` : "PEAK document created · awaiting payment"}</span>
                {outOfSync(d) && <DriftPanel doc={d} />}
                {/* A job in the document changed: the payment is not offered — PEAK must match the job sheets first (the server refuses it too). */}
                <CreatedState compact doc={asCreated(d)} onRecordPayment={canEdit && !paymentBlocked(d) ? () => setRecordPayment({ guideId: r.guideId, guide: r.guide, doc: asCreated(d) }) : undefined} />
                {canEdit && paymentBlocked(d) && <button type="button" className="btn sm" disabled aria-disabled="true" title={`Align ${d.peakDocumentNo ?? d.paymentRef} in PEAK with the current job sheets first`} style={{ justifySelf: "start" }}>Record payment — blocked until PEAK matches</button>}
                {d.error && <span style={{ fontSize: 12, color: "var(--danger)" }}>Last attempt: {d.error}</span>}
                {canEdit && <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>Voided this document in PEAK instead? <button className="btn sm ghost" onClick={() => resolveDoc(d, "voided")}>Voided in PEAK…</button></span>}
              </div>
            ))}
            {createUnconfirmed.map((d) => (
              <div key={d.paymentRef} className="pay-doc-bar" role="status">
                <span>⚠ PEAK has not confirmed document <b>{d.paymentRef}</b> · {docJobCount(d)} job{docJobCount(d) === 1 ? "" : "s"} · {thb(d.total)}{d.error ? ` — ${d.error}` : ""}. Find the expense with this reference in PEAK, then record what you found. Nothing is paid.</span>
                {canEdit && <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                  <button className="btn sm" onClick={() => resolveDoc(d, "found")}>Found it in PEAK…</button>
                  <button className="btn sm ghost" onClick={() => resolveDoc(d, "not-found")}>Not in PEAK</button>
                </span>}
              </div>
            ))}
            {paymentUnconfirmed.map((d) => (
              <div key={d.paymentRef} className="pay-doc-bar" role="status">
                <span>⚠ PEAK has not confirmed the payment of <b>{d.peakDocumentNo}</b> ({d.paymentRef}) · {thb(d.total)}{d.error ? ` — ${d.error}` : ""}. The jobs stay unpaid. Look at {d.peakDocumentNo} in PEAK, then record what you found — do not pay again.</span>
                {canEdit && <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                  {d.peakDocumentLink && <a className="btn sm" href={d.peakDocumentLink} target="_blank" rel="noopener noreferrer">View PEAK document</a>}
                  <button className="btn sm" onClick={() => resolveDoc(d, "payment-found")}>Payment is in PEAK</button>
                  <button className="btn sm ghost" onClick={() => resolveDoc(d, "payment-not-found")}>No payment in PEAK</button>
                </span>}
              </div>
            ))}
            {unattached.map((d) => (
              <div key={d.paymentRef} className="pay-doc-bar" role="status">
                <span>The slip did not attach to PEAK document <b>{d.peakDocumentNo}</b> ({d.paymentRef}){d.attachmentError ? ` — ${d.attachmentError}` : ""}. It is saved in Drive; attach it in PEAK by hand.</span>
              </div>
            ))}
            {mode === "paid" && canEdit && (() => {
              const cands = jobs.filter(expCandidate);
              // One transfer, one document: offer the jobs paid on each day together.
              const byDay = new Map<string, Job[]>();
              for (const j of jobs) if (j.canPutInPeak && notInPeak(j) && j.paidAt) byDay.set(bkkDateOf(j.paidAt), [...(byDay.get(bkkDateOf(j.paidAt)) ?? []), j]);
              const missingCount = jobs.filter((j) => notInPeak(j) && (expCandidate(j) || j.canPutInPeak)).length;
              return missingCount > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "2px 0 8px" }}>
                  {[...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, js]) => (
                    <button key={day} className="btn sm primary" title={`Create ONE PEAK document for the ${js.length} job${js.length === 1 ? "" : "s"} paid on ${dShort(day)}, then record that payment against it. Check PEAK first: if a document for this transfer was made by hand, use Record EXP… instead.`} onClick={() => setPutInPeak({ guideId: r.guideId, guide: r.guide, jobs: js, paidDate: day })}>
                      Put {js.length} job{js.length === 1 ? "" : "s"} paid {dShort(day)} in PEAK · 1 document
                    </button>
                  ))}
                  {cands.length > 0 && <button className="btn sm" title="These jobs were paid, but FolkOPS has no PEAK document for them. If one was made by hand in PEAK, record its number here." onClick={() => setRecordExp({ guideId: r.guideId, guide: r.guide, jobs: cands, preselect: cands.length === 1 ? [`${cands[0].date}|${cands[0].slotIdx}`] : [] })}>Record EXP…</button>}
                  <span className="pay-doc-note">{missingCount} paid job{missingCount === 1 ? "" : "s"} not in PEAK — {cands.length > 0 ? "already made by hand in PEAK? Record EXP…; otherwise put them in PEAK here" : "put them in PEAK here"}</span>
                </div>
              );
            })()}
            {mode === "unpaid" && canEdit && unlocked.length > 0 && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "2px 0 8px" }}>
              {payable.length > 0 && <>
                <button className="btn sm primary" title={payable.length > 1 ? "Step 1: create ONE unpaid PEAK document for these jobs. Step 2, after reviewing it in PEAK and transferring: record the payment against it." : "Pay this job"} onClick={() => payBatch(r.guideId, payable)}>Pay {payable.length} job{payable.length === 1 ? "" : "s"} together · one ref</button>
                <span className="pay-doc-note" title="PEAK bills each document created, not each job">= 1 PEAK document</span>
              </>}
              {leftOut && <span className="pay-doc-note" title="These jobs stay listed below and can still be paid on their own">Not in it: {leftOut}</span>}
              {canEdit && <button className="btn sm" title="Record the transfer that paid these jobs — date, amount, slip" onClick={() => openRecordPayment(r.guideId, r.guide, jobs)}>Record payment · {unlocked.length} unpaid</button>}
              <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>A job is paid by a recorded payment — one per bank transfer.</span>
            </div>}
            {jobs.map((j, i) => {
              const ms = matchState(j.slips ?? [], j.amount);
              const hasSlips = (j.slips?.length ?? 0) > 0;
              return (
              <div key={i}>
                <div className={`pay-job-row${i ? "" : " first"}`}>
                  <span>{dShort(j.date)} · {SLOTS[j.slotIdx]?.start}</span>
                  <span style={{ display: "block" }}>{j.tour}{j.ref ? <span style={{ display: "block", fontSize: 11, color: "var(--ink-soft)", fontFamily: "monospace" }}>{j.ref}</span> : null}</span>
                  <span className="pay-job-amt" style={{ fontVariantNumeric: "tabular-nums" }}>
                    <button type="button" className="pay-copy"
                      title={`Copy ${thb(j.amount)} to paste into your banking app · คัดลอกยอดไปวางในแอปธนาคาร`}
                      onClick={() => copyAmount(`${r.guideId}|${j.date}|${j.slotIdx}`, j.amount)}>
                      {thb(j.amount)}
                      <span className="pay-copy-tag">{copied === `${r.guideId}|${j.date}|${j.slotIdx}` ? "copied" : "copy"}</span>
                    </button>
                    {(j.expenses ?? 0) > 0 && <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "var(--ink-soft)", whiteSpace: "nowrap" }} title="Guide fee (after WHT) + expense reimbursement">fee {thb(j.fee)} + reimb. {thb(j.expenses)}</span>}
                  </span>
                  <span className="pay-job-status">
                  {j.peakRef && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--primary)", fontVariantNumeric: "tabular-nums" }} title="PEAK ref for this payment">{j.peakRef}</span>}
                  {j.peakPaymentRef && <span className="pay-doc-tag" title="The combined PEAK document this job belongs to — every job in it shares this reference and document">{docTag(j)}</span>}
                  {paymentChip(j)}
                  {inPeakTag(j)}
                  {peakBadge(j)}
                  {canEdit && expCandidate(j) && <button type="button" className="btn sm ghost" style={{ padding: "1px 8px" }} title="Record the number of the PEAK document made by hand for this payment" onClick={() => setRecordExp({ guideId: r.guideId, guide: r.guide, jobs: jobs.filter(expCandidate), preselect: [`${j.date}|${j.slotIdx}`] })}>+ EXP</button>}
                  <span className={`badge ${j.paid ? "active" : "invited"}`} style={{ minWidth: 64, textAlign: "center" }}>{j.paid ? "Paid" : j.peakPaymentRef ? docBadge(j) : hasSlips ? "Partial" : "Pending"}</span>{j.paid && j.paidAt ? <span style={{ fontSize: 11, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{new Date(j.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span> : null}
                  </span>
                  <span className="pay-job-actions">
                  <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(r.guideId)}&date=${j.date}&slotIdx=${j.slotIdx}`} title="Open this tour's job sheet">Job sheet</a>
                  {j.paid && j.eslipUrl && !hasSlips && <a className="btn sm" href={j.eslipUrl} target="_blank" rel="noopener noreferrer" title="View this tour's payment slip in Drive">E-slip</a>}
                  {canEdit && (j.paid
                    ? (j.peakPaymentRef
                        // Paid inside a PEAK document with other jobs: undoing one job here
                        // would leave PEAK still paying it. Void the document there first.
                        ? <button className="btn sm ghost" title="Paid in one PEAK document with other jobs — void it in PEAK first, then record that here" onClick={() => { const d = paymentDocs.find((x) => x.paymentRef === j.peakPaymentRef); if (d) resolveDoc(d, "voided"); else alert(`Reload Payments to manage ${j.peakPaymentRef}.`); }}>Voided in PEAK…</button>
                        : j.payment
                          ? <button className="btn sm ghost" title={`Paid by ${j.payment.paymentNo} — reverse that payment, with a reason; the record stays`} onClick={() => reversePayment(j.payment!)}>Reverse payment…</button>
                          : <button className="btn sm ghost" title="Marked paid before payments were recorded — put it back to pending" onClick={() => setJobPaid(j, r.guideId)}>Undo</button>)
                    : !j.peakPaymentRef && !j.payBlock && <button className="btn sm primary" title="Record the transfer that pays this job" onClick={() => openRecordPayment(r.guideId, r.guide, jobs, [`${j.date}|${j.slotIdx}`])}>Record payment…</button>)}
                  {canEdit && !j.peakPaymentRef && <button className="btn sm danger" title="Remove this job sheet, its tour records and the imported booking (won't re-sync)" onClick={() => removeJob(j, r.guideId, r.guide)}>Delete</button>}
                  </span>
                </div>
                {hasSlips && (
                  <div style={{ margin: "5px 0 2px 160px", fontSize: 12, background: "var(--card,#fff)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 10px" }}>
                    {(j.slips ?? []).map((s, si) => (
                      <div key={si} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                        <span style={{ color: "var(--ink-soft)", minWidth: 48 }}>Slip {si + 1}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 84, fontWeight: 600 }}>{thb(s.amount)}</span>
                        {s.url && <a className="btn sm" href={s.url} target="_blank" rel="noopener noreferrer">View</a>}
                        <span style={{ flex: 1, textAlign: "right", fontSize: 11, color: "var(--ink-soft)" }}>{new Date(s.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                      </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 4, fontWeight: 700, color: ms.paid ? "var(--green,#1a7f37)" : ms.warn === "over" ? "var(--danger)" : "var(--ink)" }}>
                      <span>{ms.paid ? "✓ Slips add up to the payout" : ms.warn === "over" ? `⚠ Over by ${thb(Math.abs(ms.delta))} — remove or fix a slip` : `${thb(ms.remaining)} still to pay`}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{thb(ms.slipsTotal)} / {thb(ms.payout)}</span>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </td></tr>
        )}
      </Fragment>
    );
  }
  // Under "Not in PEAK" the footer adds up only the jobs shown, not the guides' whole month.
  const vTotals = statusFilter === "notpeak"
    ? visible.flatMap(jobsShown).reduce((a, j) => ({ tours: a.tours + 1, netFee: a.netFee + (j.fee ?? 0), expenses: a.expenses + (j.expenses ?? 0), payout: a.payout + (j.amount ?? 0) }), { tours: 0, netFee: 0, expenses: 0, payout: 0 })
    : visible.reduce((a, r) => ({ tours: a.tours + r.tours, netFee: a.netFee + r.netFee, expenses: a.expenses + r.expenses, payout: a.payout + r.payout }), { tours: 0, netFee: 0, expenses: 0, payout: 0 });
  // Month-overview figures for the dashboard band (whole month, not the filtered view).
  const allJobs = rows.flatMap((r) => r.jobs);
  const paidAmt = allJobs.filter((j) => j.paid).reduce((sum, j) => sum + (j.amount || 0), 0);
  const unpaidJobs = allJobs.filter((j) => !j.paid);
  const outstanding = unpaidJobs.reduce((sum, j) => sum + (j.amount || 0), 0);

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="payments" />
        <div className="op-main">
      <div id="appBar">
        <div className="subtabs">
          <button type="button" className={`subtab${view === "board" ? " active" : ""}`} onClick={() => setView("board")}>Payments</button>
          <button type="button" className={`subtab${view === "guide-payments" ? " active" : ""}`} onClick={() => setView("guide-payments")}>Guide Payments</button>
          <button type="button" className={`subtab${view === "advances" ? " active" : ""}`} onClick={() => setView("advances")}>Advances</button>
        </div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>
      {view === "advances" ? <AdvancesWorkflow canEdit={canEdit} /> : view === "guide-payments" ? <GuidePaymentsWorkflow canEdit={canEdit} /> : (<>

      {/* Payment execution at a glance: who needs paying, how much, done or not.
          Pending payment carries the emphasis; paid-to-date is a footnote. */}
      <div className="kpi-row" style={{ marginBottom: 4 }}>
        <div className={`kpi${outstanding > 0 ? " warn" : " ok"}`} style={{ gridColumn: "span 2" }}>
          <b style={{ fontSize: 26, fontVariantNumeric: "tabular-nums" }}>{thb(outstanding)}</b>
          <span>Pending payment</span>
          {outstanding > 0 && <small className="kpi-sub">this month · not yet transferred</small>}
        </div>
        <div className="kpi"><b>{unpaidGuides.length}</b><span>Guides to pay</span></div>
        <div className="kpi"><b>{unpaidJobs.length}</b><span>Jobs</span></div>
        <div className="kpi"><b style={{ fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{thb(unpaidJobs.reduce((s, j) => s + (j.expenses || 0), 0))}</b><span>Reimbursements</span></div>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", padding: "0 2px", marginBottom: 12 }}>
        Paid so far this month: <b style={{ color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{thb(paidAmt)}</b>
        {bonuses.total > 0 && <> · bonuses <b style={{ color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{thb(bonuses.total)}</b></>}
        {" "}· month total {thb(totals.payout)} across {totals.tours} job{totals.tours === 1 ? "" : "s"}
      </div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Month</label>
          <input className="search" style={{ flex: "none", width: 160 }} type="month" value={period} onChange={(e) => { setPeriod(e.target.value); load(e.target.value); }} />
          <select className="search" style={{ flex: "none", width: 150 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "pending" | "paid" | "notpeak")} title="Filter by payment or PEAK status">
            <option value="all">All statuses</option>
            <option value="pending">Pending only</option>
            <option value="paid">Paid only</option>
            <option value="notpeak">Not in PEAK</option>
          </select>
          <input className="search" style={{ flex: "none", width: 180 }} placeholder="Search guide…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" onClick={exportCsv}>Export payroll CSV</button>
          <button className="btn sm" onClick={exportPendingPdf} title="Print-ready list of every unpaid job, grouped by guide — Save as PDF">Export pending PDF</button>
          <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600 }}>Month total: {thb(totals.payout)}</span>
        </div>
        {canEdit && sel.size > 0 && (() => {
          const chosen = unpaidGuides.filter((r) => sel.has(r.guideId));
          const jobsN = chosen.reduce((s, r) => s + r.jobs.filter((j) => !j.paid).length, 0);
          const total = chosen.reduce((s, r) => s + r.jobs.filter((j) => !j.paid).reduce((a, j) => a + j.amount, 0), 0);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 14px", background: "var(--green-bg)", borderTop: "1px solid var(--green-line)", borderBottom: "1px solid var(--green-line)", fontSize: 13 }}>
              <b>{chosen.length} guide{chosen.length === 1 ? "" : "s"} selected</b>
              <span style={{ color: "var(--ink-soft)" }}>{jobsN} job{jobsN === 1 ? "" : "s"} · <b style={{ color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{thb(total)}</b></span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
                <button className="btn sm primary" disabled={batchBusy} title="Group these guides' unpaid jobs into ONE payment batch — amounts snapshotted server-side; a job can't sit in two batches" onClick={() => createBatchFromSelection(unpaidGuides)}>{batchBusy ? "Creating…" : `Create payment batch (${thb(total)})`}</button>
              </span>
            </div>
          );
        })()}
        <div className="grid-scroll">
          {statusFilter === "pending" ? (
          <table className="acct-table pay-table">
            <thead>
              <tr><th>Date</th><th>Guide</th><th>Tour</th><th className="r">Amount</th><th></th></tr>
            </thead>
            <tbody>
              {pendingFlat.length === 0 ? (
                <tr><td colSpan={5} className="op-empty">{unpaidJobs.length === 0 ? "Everyone's paid — no pending payments this month." : "No pending payments match this search."}</td></tr>
              ) : pendingFlat.map((j) => (
                <tr key={`${j.guideId}|${j.date}|${j.slotIdx}`}>
                  <td style={{ whiteSpace: "nowrap" }}>{dShort(j.date)} · {SLOTS[j.slotIdx]?.start}</td>
                  <td><span className="gid">{j.guideId}</span> {j.guide}</td>
                  <td>{j.tour}{j.ref ? <span style={{ display: "block", fontSize: 11, color: "var(--ink-soft)", fontFamily: "monospace" }}>{j.ref}</span> : null}</td>
                  <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>
                    <b>{thb(j.amount)}</b>
                    {(j.expenses ?? 0) > 0 && <span style={{ display: "block", fontSize: 11, color: "var(--ink-soft)", whiteSpace: "nowrap" }} title="Guide fee (after WHT) + expense reimbursement">fee {thb(j.fee)} + reimb. {thb(j.expenses)}</span>}
                  </td>
                  <td style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(j.guideId)}&date=${j.date}&slotIdx=${j.slotIdx}`} title="Open this tour's job sheet">Job sheet</a>
                    {j.peakPaymentRef && <span className="pay-doc-tag" title="The combined PEAK document this job belongs to">{docTag(j)} · {docBadge(j)}</span>}
                    {inPeakTag(j)}
                    {peakBadge(j)}
                    {canEdit && !j.peakPaymentRef && !j.payBlock && <button className="btn sm primary" title="Record the transfer that pays this job" onClick={() => openRecordPayment(j.guideId, j.guide, rows.find((x) => x.guideId === j.guideId)?.jobs ?? [j], [`${j.date}|${j.slotIdx}`])}>Record payment…</button>}
                  </td>
                </tr>
              ))}
            </tbody>
            {pendingFlat.length > 0 && (
              <tfoot>
                <tr className="pay-foot"><td colSpan={3}><b>{pendingFlat.length} pending job{pendingFlat.length === 1 ? "" : "s"}</b></td><td className="r"><b>{thb(pendingFlat.reduce((s, j) => s + j.amount, 0))}</b></td><td></td></tr>
              </tfoot>
            )}
          </table>
          ) : (
          <table className="acct-table pay-table">
            <thead>
              <tr><th style={{ width: 30 }} /><th>Guide</th><th className="r">Jobs</th><th className="r">Guide fee</th><th className="r">Reimbursement</th><th className="r">Payable</th><th>PEAK</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={9} className="op-empty">{rows.length === 0 ? "No tours assigned this month yet." : "No guides match this filter."}</td></tr>
              ) : (<>
                {unpaidGuides.length > 0 && <tr><td colSpan={9} onClick={() => toggleSec("unpaid")} style={{ cursor: "pointer", padding: "8px 12px 5px", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--assign)" }}>{hideSec.has("unpaid") ? "▸" : "▾"} Unpaid — needs payment ({unpaidGuides.length}) · {thb(unpaidGuides.reduce((s, r) => s + jobsShown(r).filter((j) => !j.paid).reduce((a, j) => a + j.amount, 0), 0))}</td></tr>}
                {!hideSec.has("unpaid") && unpaidGuides.map((r) => renderGuideRow(r, jobsShown(r).filter((j) => !j.paid), "unpaid"))}
                {paidGuides.length > 0 && <tr><td colSpan={9} onClick={() => toggleSec("paid")} style={{ cursor: "pointer", padding: "12px 12px 5px", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--green)" }}>{hideSec.has("paid") ? "▸" : "▾"} Paid ({paidGuides.length}) · {thb(paidGuides.reduce((s, r) => s + jobsShown(r).filter((j) => j.paid).reduce((a, j) => a + j.amount, 0), 0))}</td></tr>}
                {!hideSec.has("paid") && paidGuides.map((r) => renderGuideRow(r, jobsShown(r).filter((j) => j.paid), "paid"))}
              </>)}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="pay-foot">
                  <td />
                  <td><b>{statusFilter !== "all" || ql ? `Shown (${visible.length} of ${rows.length})` : `Total (${rows.length} guides)`}</b></td>
                  <td className="r">{vTotals.tours}</td>
                  <td className="r">{thb(vTotals.netFee)}</td>
                  <td className="r">{thb(vTotals.expenses)}</td>
                  <td className="r"><b>{thb(vTotals.payout)}</b></td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            )}
          </table>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head"><h2>Bonuses &amp; adjustments</h2><span className="hint">e.g. 5★ review rewards · {bonuses.rows.length} this month</span></div>
        <div style={{ padding: 14 }}>
          {bonuses.rows.length === 0 ? <div className="op-empty">No bonuses this month.</div> : (
            <table className="acct-table" style={{ marginBottom: 12 }}>
              <thead><tr><th>Guide</th><th>Ref no.</th><th>Reason</th><th className="r">Amount</th><th>E-slip</th><th /></tr></thead>
              <tbody>
                {bonuses.rows.map((b) => (
                  <tr key={b.id}>
                    <td style={{ whiteSpace: "nowrap" }}><span className="gid">{b.guideId}</span> {b.guide}</td>
                    <td><input className="search" style={{ width: 150, fontSize: 12, fontVariantNumeric: "tabular-nums" }} defaultValue={b.ref} disabled={!canEdit} title="Bonus reference no. (e.g. PEAK job no.)" onBlur={(e) => { if (e.target.value.trim() !== b.ref) editBonusRef(b.id, e.target.value.trim()); }} /></td>
                    <td style={{ color: "var(--ink-soft)" }}>{b.reason || "—"}</td>
                    <td className="r" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>+{thb(b.amount)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {b.eslipUrl
                        ? <span style={{ display: "inline-flex", gap: 6 }}>
                            <a className="btn sm" href={b.eslipUrl} target="_blank" rel="noopener noreferrer" title="View bonus slip in Drive">E-slip</a>
                            {canEdit && <label className="btn sm ghost" style={{ cursor: "pointer" }} title="Replace">Replace<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBonusEslip(b.id, f); e.target.value = ""; }} /></label>}
                          </span>
                        : (canEdit && <label className="btn sm" style={{ cursor: "pointer" }} title="Upload bonus payment slip">Slip<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBonusEslip(b.id, f); e.target.value = ""; }} /></label>)}
                    </td>
                    <td style={{ textAlign: "right" }}>{canEdit && <button className="btn sm danger" title="Remove bonus" onClick={() => delBonus(b.id)}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="pay-foot"><td colSpan={3}><b>Total bonuses</b></td><td className="r"><b>+{thb(bonuses.total)}</b></td><td colSpan={2} /></tr></tfoot>
            </table>
          )}
          {canEdit && (
          <div style={{ border: "1px dashed var(--line-strong)", borderRadius: 12, padding: 12, margin: "0 0 12px", background: "var(--paper)" }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Reward a review</div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)", margin: "2px 0 8px" }}>Paste the OTA review email (optional), then add the tour date or the reviewer&apos;s name to find who guided it.</div>
            <textarea className="search" style={{ width: "100%", minHeight: 52, resize: "vertical", marginBottom: 8, boxSizing: "border-box" }} placeholder="Paste the GetYourGuide / Viator review email here…" value={rv.paste} onChange={(e) => onPasteReview(e.target.value)} />
            {(rv.product || rv.stars > 0) && <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 8 }}>{rv.stars > 0 ? "★".repeat(rv.stars) + " " : ""}{rv.product ? <b style={{ color: "var(--ink)" }}>{rv.product}</b> : null}{rv.comment ? ` · "${rv.comment}"` : ""}</div>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input className="search" style={{ flex: "none", width: 150 }} type="date" title="Tour date (from the OTA portal)" value={rv.date} onChange={(e) => setRv((s) => ({ ...s, date: e.target.value }))} />
              <input className="search" style={{ flex: 1, minWidth: 160 }} placeholder="or reviewer / customer name" value={rv.name} onChange={(e) => setRv((s) => ({ ...s, name: e.target.value }))} />
              <button className="btn" disabled={rvBusy || (!rv.date && rv.name.trim().length < 2)} onClick={findReviewGuide}>{rvBusy ? "Finding…" : "Find guide"}</button>
            </div>
            {rvMatches && (rvMatches.length ? (
              <table className="acct-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Date</th><th>Tour</th><th>Guide</th><th>Customer</th><th /></tr></thead>
                <tbody>
                  {rvMatches.map((c, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: "nowrap" }}>{dShort(c.date)}<br /><small style={{ color: "var(--ink-soft)" }}>{c.time}</small></td>
                      <td>{c.tour}</td>
                      <td style={{ whiteSpace: "nowrap" }}><span className="gid">{c.guideId}</span> {c.guide}</td>
                      <td style={{ color: "var(--ink-soft)" }}>{c.customerName || "—"}</td>
                      <td style={{ textAlign: "right" }}><button className="btn sm primary" onClick={() => rewardCandidate(c)}>Reward →</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="op-empty" style={{ marginTop: 10 }}>No match — check the date, or try the reviewer&apos;s name.</div>)}
          </div>
          )}
          {canEdit && (
          <div className="op-toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
            <select className="search" style={{ flex: "none", width: 200 }} value={bForm.guideId} onChange={(e) => setBForm((x) => ({ ...x, guideId: e.target.value, date: undefined, slotIdx: undefined }))}>
              <option value="">Choose guide…</option>
              {[...rows.map((g) => ({ guideId: g.guideId, guide: g.guide })), ...extraGuides.filter((e) => !rows.some((r) => r.guideId === e.guideId))].map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.guide}</option>)}
            </select>
            <input className="search" style={{ flex: 1, minWidth: 180 }} placeholder="Reason (e.g. 5★ review – Omari)" value={bForm.reason} onChange={(e) => setBForm((x) => ({ ...x, reason: e.target.value }))} />
            <input className="search" style={{ flex: "none", width: 120 }} type="number" min={0} placeholder="฿ amount" value={bForm.amount} onChange={(e) => setBForm((x) => ({ ...x, amount: e.target.value }))} />
            <button className="btn primary" disabled={!bForm.guideId || !(parseFloat(bForm.amount) > 0)} onClick={addBonus}>+ Add bonus</button>
          </div>
          )}
        </div>
      </section>
      </>)}
        </div>
      </div>

      {payTogether && (
        <PeakPaymentDialog
          guideId={payTogether.guideId}
          guide={payTogether.guide}
          jobs={payTogether.jobs}
          onClose={() => setPayTogether(null)}
          onDone={() => { const gid = payTogether.guideId; setPayTogether(null); setPayRef((p) => { const n = { ...p }; delete n[gid]; return n; }); load(period); }}
          onRecordPayment={(doc) => { const { guideId, guide } = payTogether; setPayTogether(null); load(period); setRecordPayment({ guideId, guide, doc }); }}
        />
      )}
      {putInPeak && (
        <PeakPaymentDialog
          guideId={putInPeak.guideId}
          guide={putInPeak.guide}
          jobs={putInPeak.jobs}
          alreadyPaid={{ paidDate: putInPeak.paidDate }}
          onClose={() => setPutInPeak(null)}
          onDone={() => { setPutInPeak(null); load(period); }}
          onRecordPayment={(doc) => { const { guideId, guide } = putInPeak; setPutInPeak(null); load(period); setRecordPayment({ guideId, guide, doc }); }}
        />
      )}
      {recordExp && (
        <RecordExpDialog guideId={recordExp.guideId} guide={recordExp.guide} jobs={recordExp.jobs} preselect={recordExp.preselect}
          onClose={() => setRecordExp(null)}
          onDone={(msg) => { setRecordExp(null); load(period); alert(msg); }} />
      )}
      {recordPay && (
        <RecordGuidePaymentDialog
          guideId={recordPay.guideId}
          guide={recordPay.guide}
          jobs={recordPay.jobs}
          preselect={recordPay.preselect}
          today={new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)}
          onClose={() => setRecordPay(null)}
          onDone={(msg) => { setRecordPay(null); load(period); alert(msg); }}
        />
      )}
      {recordPayment && (
        <RecordPaymentDialog
          guideId={recordPayment.guideId}
          guide={recordPayment.guide}
          doc={recordPayment.doc}
          onClose={() => setRecordPayment(null)}
          onDone={() => { setRecordPayment(null); load(period); }}
        />
      )}
    </div>
  );
}

// A combined PEAK document that no longer matches the approved job sheets: what the guide
// is owed now, what PEAK holds, and every job that differs. Nothing here changes PEAK or
// the stored document — PEAK is aligned by hand (or the document voided there) first.
const signedThb = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${thb(Math.abs(v))}`;
function DriftPanel({ doc }: { doc: PaymentDoc }) {
  const x = doc.drift!;
  const no = doc.peakDocumentNo ?? doc.paymentRef;
  const label = (j: { ref: string | null; date: string; slotIdx: number }) => j.ref || `${j.date} slot ${j.slotIdx}`;
  return (
    <div className="pay-drift" role="alert">
      <b>⚠ {no} is out of sync with the current job sheets. {x.changed.length ? "Align it in PEAK before recording the payment." : `Recording its payment pays only the ${x.stored.jobs} job${x.stored.jobs === 1 ? "" : "s"} in it.`}</b>
      <div className="grid-scroll">
        <table className="acct-table pay-drift-table" aria-label={`Current payout compared with ${no}`}>
          <thead><tr><th /><th className="r">Jobs</th><th className="r">Gross</th><th className="r">WHT</th><th className="r">Net payable</th></tr></thead>
          <tbody>
            <tr><td>Current payout · approved job sheets</td><td className="r num">{x.current.jobs}</td><td className="r num">{thb(x.current.gross)}</td><td className="r num">{thb(x.current.wht)}</td><td className="r num"><b>{thb(x.current.net)}</b></td></tr>
            <tr><td>PEAK document {no} · as created</td><td className="r num">{x.stored.jobs}</td><td className="r num">{thb(x.stored.gross)}</td><td className="r num">{thb(x.stored.wht)}</td><td className="r num">{thb(x.stored.net)}</td></tr>
            <tr className="pay-drift-delta"><td>Difference</td><td className="r num">{x.current.jobs - x.stored.jobs > 0 ? `+${x.current.jobs - x.stored.jobs}` : x.current.jobs - x.stored.jobs}</td><td className="r num">{signedThb(x.delta.gross)}</td><td className="r num">{signedThb(x.delta.wht)}</td><td className="r num"><b>{signedThb(x.delta.net)}</b></td></tr>
          </tbody>
        </table>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {x.changed.map((c) => (
          <li key={`c|${c.date}|${c.slotIdx}`}>
            <span className="num">{label(c)}</span>{c.current
              ? <> now gross {thb(c.current.gross)} · WHT {thb(c.current.wht)} · pays {thb(c.current.net)} — {no} has gross {thb(c.stored.gross)} · WHT {thb(c.stored.wht)} · {thb(c.stored.net)}</>
              : <> has no job sheet any more — {no} has {thb(c.stored.net)}</>}
          </li>
        ))}
        {x.leftOut.map((j) => (
          <li key={`l|${j.date}|${j.slotIdx}`}><span className="num">{label(j)}</span> is approved and unpaid (gross {thb(j.gross)} · WHT {thb(j.wht)} · pays {thb(j.net)}) but is not in {no}</li>
        ))}
      </ul>
      <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
        {x.changed.length
          ? <>Record payment is blocked: PEAK would be paid for figures no job sheet holds. </>
          : <>The job{x.leftOut.length === 1 ? "" : "s"} left out would need a separate transfer and PEAK document after this one. </>}
        FolkOPS keeps {no} exactly as it was created and does not change PEAK. Edit {no} in PEAK to match, or void it there and record that with “Voided in PEAK…”.
      </span>
    </div>
  );
}
