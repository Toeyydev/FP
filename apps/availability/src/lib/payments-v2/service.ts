// Payments v2 — the ONE place a job becomes PAID.
//
//   recordPayment   validate (lib/payments-v2/rules) → one transaction: GuidePayment
//                   (FOLK-PMT-…) + its jobs with the figures paid + adjustments, and each
//                   job's TourPayment set PAID, dated the actual transfer, linked to it →
//                   audit. A second ACTIVE payment for a job is refused twice over: by the
//                   rules, and by a partial unique index in the database.
//   reversePayment  a mistaken payment is never deleted: it becomes REVERSED with a reason,
//                   its jobs go back to unpaid, and the record stays.
//   previewPayment  the same checks with nothing written, for the Record payment dialog.
//
// Every caller — Record payment, bank-slip match, slip review, a combined PEAK document's
// payment — goes through here. Nothing else may write TourPayment.status = "PAID".
import { advanceJobKey } from "@/lib/advances/coverage";
import { liveAdvancesByJob } from "@/lib/advances/coverage-server";
import { Prisma, type PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { coveredByPayrollRun } from "@/lib/payment-coverage";
import { peakJobStatus } from "@/lib/peak-job-status";
import { documentHoldsJobs } from "@/lib/peak-payment-document";
import { applyDeductionsInTx, LedgerConflict, reverseDeductionsForPaymentInTx } from "@/lib/advances/service";
import {
  bangkokToday, checkMissingTransfers, checkPayment, paidAtFor, paymentNoFor, toSatang, ADJUSTMENT_TYPES,
  type AdjustmentInput, type JobFacts, type PaymentCheck, type PaymentRequest, type PaymentSource, type Reconciliation, type SupplementFacts,
} from "@/lib/payments-v2/rules";
import { SUPPLEMENTAL_LABEL, type SupplementalType } from "@/lib/supplemental-payments/rules";

type Db = PrismaClient | Prisma.TransactionClient;
export type Actor = { actorId: string | null; actorRole: string | null };
type AuditEntry = Parameters<typeof audit>[0];

export type SlipRef = { url: string; evidenceId?: string | null; uploadedAt?: Date | null; uploadedById?: string | null };

export type RecordPaymentInput = Omit<PaymentRequest, "hasSlip" | "transfers"> & {
  slip?: SlipRef | null;
  /** Several bank transfers, each with its own slip (same order). See PaymentRequest.transfers. */
  transfers?: { amount: number; date: string; bankRef?: string | null; slip?: SlipRef | null }[];
  note?: string | null;
  actor: Actor;
  /** Injected in tests; the Bangkok calendar date otherwise. */
  today?: string;
  /** Set by recordPayment when one transfer is recorded as two linked payments. */
  transferGroup?: string | null;
};

export type RecordedPayment = { id: string; paymentNo: string; paymentDate: string; amountTransferred: number; accountingPeriod: string; jobs: { jobNo: string; date: string; slotIdx: number; payable: number }[]; supplements: { id: string; type: string; netAmount: number }[] };
export type RecordPaymentResult =
  | { ok: true; payment: RecordedPayment; reconciliation: Reconciliation; audits: AuditEntry[];
      /** The company-borne review incentive recorded from the same transfer, as its own payment. */
      linked?: RecordedPayment | null }
  | { ok: false; code: "invalid" | "conflict"; reasons: string[]; reconciliation?: Reconciliation };

/** A write raced another one (a job paid or changed in between): the transaction is rolled back. */
export class PaymentConflict extends Error {
  constructor(message: string) { super(message); this.name = "PaymentConflict"; }
}

const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;

/** What the rules need to know about each job, read in one pass. */
export async function loadJobFacts(db: Db, guideId: string, jobs: { date: string; slotIdx: number }[]): Promise<{ facts: JobFacts[]; sheets: Map<string, { tourId: string; peakDocumentNo: string | null; peakDocumentId: string | null; peakSyncStatus: string | null }>; tourPays: Map<string, { peakRef: string | null; peakDocumentId: string | null }>; docs: Map<string, { paymentRef: string; peakDocumentNo: string | null; peakDocumentId: string | null; status: string }> }> {
  const or = jobs.map((j) => ({ guideId, date: j.date, slotIdx: j.slotIdx }));
  if (!or.length) return { facts: [], sheets: new Map(), tourPays: new Map(), docs: new Map() };
  const periods = [...new Set(jobs.map((j) => j.date.slice(0, 7)))];
  const [sheets, pays, active, assigns, payrolls] = await Promise.all([
    db.jobSheet.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, ref: true, tourId: true, approvalStatus: true, accountingDate: true, expenses: true, guideFee: true, createdAt: true, peakDocumentNo: true, peakDocumentId: true, peakSyncStatus: true } }),
    db.tourPayment.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, status: true, guidePaymentId: true, peakPaymentRef: true, peakRef: true, peakDocumentId: true } }),
    db.guidePaymentJob.findMany({ where: { OR: or, active: true }, select: { date: true, slotIdx: true, paymentId: true } }),
    db.assignment.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, createdAt: true } }),
    db.payrollStatus.findMany({ where: { guideId, period: { in: periods } }, select: { period: true, status: true, paidAt: true } }),
  ]);
  const activeIds = [...new Set(active.map((a) => a.paymentId))];
  const activePayments = activeIds.length ? await db.guidePayment.findMany({ where: { id: { in: activeIds } }, select: { id: true, paymentNo: true } }) : [];
  const refs = [...new Set(pays.map((p) => p.peakPaymentRef).filter((r): r is string => !!r))];
  const docRows = refs.length ? await db.guidePaymentDocument.findMany({ where: { paymentRef: { in: refs } }, select: { paymentRef: true, peakDocumentNo: true, peakDocumentId: true, status: true } }) : [];
  const docs = new Map(docRows.map((d) => [d.paymentRef, d]));
  const advanced = await liveAdvancesByJob(db, { jobs: jobs.map((j) => ({ guideId, date: j.date, slotIdx: j.slotIdx })) });
  const facts: JobFacts[] = jobs.map((j) => {
    const s = sheets.find((x) => key(x) === key(j));
    const p = pays.find((x) => key(x) === key(j));
    const a = assigns.find((x) => key(x) === key(j));
    const payroll = payrolls.find((x) => x.period === j.date.slice(0, 7));
    const created = a?.createdAt ?? s?.createdAt;
    const doc = p?.peakPaymentRef ? docs.get(p.peakPaymentRef) ?? null : null;
    return {
      date: j.date, slotIdx: j.slotIdx,
      sheet: s ? { ref: s.ref, approvalStatus: s.approvalStatus, accountingDate: s.accountingDate, expenses: s.expenses, guideFee: s.guideFee } : null,
      payment: p ? { status: p.status, guidePaymentId: p.guidePaymentId, peakPaymentRef: p.peakPaymentRef } : null,
      activePaymentNo: activePayments.find((p) => p.id === active.find((x) => key(x) === key(j))?.paymentId)?.paymentNo ?? null,
      paidByPayroll: !!created && coveredByPayrollRun(payroll, j.date, created),
      document: doc && documentHoldsJobs(doc.status) ? { paymentRef: doc.paymentRef, peakDocumentNo: doc.peakDocumentNo, status: doc.status } : null,
      advances: advanced.get(advanceJobKey({ guideId, date: j.date, slotIdx: j.slotIdx })) ?? [],
    };
  });
  return {
    facts,
    sheets: new Map(sheets.map((s) => [key(s), { tourId: s.tourId, peakDocumentNo: s.peakDocumentNo, peakDocumentId: s.peakDocumentId, peakSyncStatus: s.peakSyncStatus }])),
    tourPays: new Map(pays.map((p) => [key(p), { peakRef: p.peakRef, peakDocumentId: p.peakDocumentId }])),
    docs,
  };
}

/** What the rules need to know about each supplemental payment being paid. */
export async function loadSupplementFacts(db: Db, ids: string[] | null | undefined): Promise<SupplementFacts[]> {
  const wanted = [...new Set((ids ?? []).filter(Boolean))];
  if (!wanted.length) return [];
  const rows = await db.supplementalPayment.findMany({ where: { id: { in: wanted } } });
  const active = await db.guidePaymentSupplementLine.findMany({ where: { supplementalId: { in: wanted }, active: true }, select: { supplementalId: true, paymentId: true } });
  const payIds = [...new Set(active.map((a) => a.paymentId))];
  // Only a RECORDED payment holds it (see deactivateStaleSupplementLines).
  const pays = payIds.length ? await db.guidePayment.findMany({ where: { id: { in: payIds }, status: "RECORDED" }, select: { id: true, paymentNo: true } }) : [];
  return rows.map((r) => {
    const line = active.find((a) => a.supplementalId === r.id && pays.some((p) => p.id === a.paymentId));
    return {
      id: r.id, guideId: r.guideId, type: r.type,
      label: SUPPLEMENTAL_LABEL[r.type as SupplementalType]?.en ?? r.type,
      accountingCategory: r.accountingCategory,
      grossAmount: Number(r.grossAmount), wht: Number(r.wht), netAmount: Number(r.netAmount), whtSource: r.whtSource, whtBearer: r.whtBearer, workMonth: r.workMonth,
      voided: !!r.voidedAt,
      activePaymentNo: line ? pays.find((p) => p.id === line.paymentId)!.paymentNo : null,
    };
  });
}

/** The RECORDED payment, if any, that already holds this bank reference or slip — on the payment itself, or on one of its transfers. */
async function evidenceHolder(db: Db, ev: { bankRef?: string | null; slip?: SlipRef | null }, transferGroup?: string | null): Promise<{ byRef: string | null; bySlip: string | null }> {
  const bankRef = (ev.bankRef ?? "").trim();
  // The other half of the same transfer shares the slip and the bank reference by design.
  const others = transferGroup ? { OR: [{ transferGroup: null }, { transferGroup: { not: transferGroup } }] } : {};
  const slipWhere = ev.slip?.evidenceId ? { evidenceId: ev.slip.evidenceId } : ev.slip?.url ? { slipUrl: ev.slip.url } : null;
  const [refPay, refPart, slipPay, slipPart] = await Promise.all([
    bankRef ? db.guidePayment.findFirst({ where: { bankRef, status: "RECORDED", ...others }, select: { paymentNo: true } }) : null,
    bankRef ? db.guidePaymentTransfer.findFirst({ where: { bankRef, payment: { status: "RECORDED" } }, select: { payment: { select: { paymentNo: true } } } }) : null,
    slipWhere ? db.guidePayment.findFirst({ where: { ...slipWhere, status: "RECORDED", ...others }, select: { paymentNo: true } }) : null,
    slipWhere ? db.guidePaymentTransfer.findFirst({ where: { ...slipWhere, payment: { status: "RECORDED" } }, select: { payment: { select: { paymentNo: true } } } }) : null,
  ]);
  return { byRef: refPay?.paymentNo ?? refPart?.payment.paymentNo ?? null, bySlip: slipPay?.paymentNo ?? slipPart?.payment.paymentNo ?? null };
}

async function evidenceContext(db: Db, input: Pick<RecordPaymentInput, "bankRef" | "slip" | "transferGroup" | "transfers">) {
  const top = await evidenceHolder(db, input, input.transferGroup);
  const partsUsedBy = await Promise.all((input.transfers ?? []).map(async (p) => {
    const h = await evidenceHolder(db, p);
    return h.byRef ?? h.bySlip;
  }));
  return { bankRefUsedBy: top.byRef, slipUsedBy: top.bySlip, partsUsedBy };
}

const request = (input: RecordPaymentInput): PaymentRequest => ({
  ...input,
  hasSlip: !!(input.slip?.url || input.slip?.evidenceId),
  transfers: input.transfers?.map((p) => ({ amount: p.amount, date: p.date, bankRef: p.bankRef ?? null, hasSlip: !!(p.slip?.url || p.slip?.evidenceId) })),
});

/**
 * One bank transfer that pays a guide's jobs AND their company-borne review incentives
 * (owner policy 2026-10-06) is recorded as two payments: the jobs, and the incentives —
 * each with its own number, voucher, PEAK document and 50 ทวิ, sharing the slip, the bank
 * reference and the date. The review payment is exactly the incentives' net; whatever the
 * transfer differs by stays with the jobs, where a reason for it is asked for.
 * Null when the transfer is not of that shape (the rules then judge it whole).
 */
async function splitTransfer(db: Db, input: RecordPaymentInput): Promise<{ jobs: RecordPaymentInput; reviews: RecordPaymentInput; reviewNet: number } | null> {
  if (!input.jobs.length || !(input.supplements ?? []).length || (input.transfers ?? []).length) return null;
  const sups = await loadSupplementFacts(db, input.supplements);
  if (sups.length !== (input.supplements ?? []).length || !sups.every((x) => x.whtBearer === "COMPANY_ONCE")) return null;
  const reviewNetSatang = sups.reduce((t, x) => t + toSatang(x.netAmount), 0);
  const group = input.transferGroup ?? `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    reviewNet: reviewNetSatang / 100,
    jobs: { ...input, supplements: [], amountTransferred: (toSatang(input.amountTransferred) - reviewNetSatang) / 100, transferGroup: group },
    reviews: { ...input, jobs: [], adjustments: [], mismatchReason: null, amountTransferred: reviewNetSatang / 100, transferGroup: group },
  };
}

const merged = (a: Reconciliation, b: Reconciliation, total: number): Reconciliation => {
  const expected = toSatang(a.expectedTransfer) + toSatang(b.expectedTransfer);
  return {
    jobTotal: a.jobTotal, supplementTotal: b.supplementTotal ?? 0, adjustmentTotal: a.adjustmentTotal,
    expectedTransfer: expected / 100, amountTransferred: total, difference: (toSatang(total) - expected) / 100,
    balanced: toSatang(total) === expected,
  };
};

/** The checks Record payment runs, with nothing written. */
export async function previewPayment(db: Db, input: RecordPaymentInput): Promise<PaymentCheck> {
  const split = await splitTransfer(db, input);
  if (split) {
    const [j, r] = [await previewPayment(db, split.jobs), await previewPayment(db, split.reviews)];
    return { ...j, reasons: [...j.reasons, ...r.reasons], supplements: r.supplements, reconciliation: merged(j.reconciliation, r.reconciliation, input.amountTransferred) };
  }
  const { facts } = await loadJobFacts(db, input.guideId, input.jobs);
  const supplements = await loadSupplementFacts(db, input.supplements);
  return checkPayment(request(input), facts, { today: input.today ?? bangkokToday(), supplements, ...(await evidenceContext(db, input)) });
}

async function nextPaymentNo(db: Db, paymentDate: string): Promise<string> {
  const prefix = paymentNoFor(paymentDate, 0).slice(0, -3); // "FOLK-PMT-202609-"
  const last = await db.guidePayment.findFirst({ where: { paymentNo: { startsWith: prefix } }, orderBy: { paymentNo: "desc" }, select: { paymentNo: true } });
  const seq = last ? Number(last.paymentNo.slice(prefix.length)) || 0 : 0;
  return paymentNoFor(paymentDate, seq + 1);
}

/**
 * Record a payment inside the caller's transaction (a bank-slip match already has one).
 * Validation failures return without writing; a race throws PaymentConflict so the whole
 * transaction rolls back. Audit entries are returned, to be written after commit.
 */
export async function recordPaymentInTx(tx: Prisma.TransactionClient, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  const { facts, sheets, tourPays, docs } = await loadJobFacts(tx, input.guideId, input.jobs);
  const supplementFacts = await loadSupplementFacts(tx, input.supplements);
  const check = checkPayment(request(input), facts, { today: input.today ?? bangkokToday(), supplements: supplementFacts, ...(await evidenceContext(tx, input)) });
  if (check.reasons.length) return { ok: false, code: "invalid", reasons: check.reasons, reconciliation: check.reconciliation };

  // A line still active on a REVERSED payment can only come from a build without this
  // feature reversing it; it holds nothing, so it is closed before this payment's line.
  if (check.supplements.length) {
    const reversed = await tx.guidePayment.findMany({ where: { status: "REVERSED", supplements: { some: { supplementalId: { in: check.supplements.map((x) => x.id) }, active: true } } }, select: { id: true } });
    if (reversed.length) await tx.guidePaymentSupplementLine.updateMany({ where: { paymentId: { in: reversed.map((p) => p.id) } }, data: { active: false } });
  }
  const paymentNo = await nextPaymentNo(tx, input.paymentDate);
  const paidAt = paidAtFor(input.paymentDate);
  const adjustments = (input.adjustments ?? []).filter((a): a is AdjustmentInput & { type: (typeof ADJUSTMENT_TYPES)[number] } => ADJUSTMENT_TYPES.includes(a.type as never));
  const t = (s: string | null | undefined) => (s ?? "").trim() || null;

  // Several transfers: each is kept; the payment's own evidence is the last one that has a slip.
  const parts = (input.transfers ?? []).map((p, i) => ({ ...p, seq: i + 1 }));
  const lastSlip = [...parts].reverse().find((p) => p.slip?.url || p.slip?.evidenceId)?.slip ?? null;
  const evidence = parts.length ? lastSlip : input.slip ?? null;
  const payment = await tx.guidePayment.create({
    data: {
      paymentNo, guideId: input.guideId, accountingPeriod: check.accountingPeriod!, paymentDate: input.paymentDate,
      jobTotal: check.reconciliation.jobTotal, adjustmentTotal: check.reconciliation.adjustmentTotal, amountTransferred: check.reconciliation.amountTransferred,
      kind: check.supplements.length ? "SUPPLEMENTAL" : "REGULAR", supplementTotal: check.reconciliation.supplementTotal ?? 0,
      status: "RECORDED", source: input.source as PaymentSource,
      bankRef: parts.length ? null : t(input.bankRef), evidenceId: evidence?.evidenceId ?? null, slipUrl: evidence?.url ?? null,
      slipUploadedAt: evidence ? evidence.uploadedAt ?? new Date() : null, slipUploadedById: evidence?.uploadedById ?? null,
      noSlipReason: parts.length ? (parts.every((p) => p.slip?.url || p.slip?.evidenceId) ? null : t(input.noSlipReason)) : input.slip ? null : t(input.noSlipReason),
      mismatchReason: check.reconciliation.balanced ? null : t(input.mismatchReason),
      periodOverrideReason: check.periods.length > 1 ? t(input.periodOverrideReason) : null,
      peakPaymentRef: input.source === "PEAK_DOCUMENT" ? t(input.peakPaymentRef) : null,
      transferGroup: input.transferGroup ?? null,
      note: t(input.note), createdById: input.actor.actorId,
      jobs: {
        create: check.jobs.map((j) => {
          const sheet = sheets.get(key(j));
          const tp = tourPays.get(key(j));
          const holding = facts.find((f) => key(f) === key(j))?.document ?? null;
          const doc = holding ? docs.get(holding.paymentRef) ?? null : null;
          // The PEAK document the job explicitly belongs to right now — never borrowed.
          const peak = peakJobStatus({ sheet: sheet ?? null, paymentRef: tp?.peakRef ?? null, document: doc, amount: j.figures.payable });
          return {
            guideId: input.guideId, date: j.date, slotIdx: j.slotIdx, jobNo: j.jobNo, accountingDate: j.accountingDate,
            feeGross: j.figures.feeGross, wht: j.figures.wht, reimbursement: j.figures.reimbursement, reviewReward: j.figures.reviewReward, payable: j.figures.payable,
            peakDocumentNo: peak.state === "IN_PEAK" ? peak.documentNo : null,
            peakDocumentId: peak.state !== "IN_PEAK" ? null : peak.source === "sheet" ? sheet?.peakDocumentId ?? null : peak.source === "combined" ? doc?.peakDocumentId ?? null : tp?.peakDocumentId ?? null,
            peakSource: peak.state === "IN_PEAK" ? peak.source : null,
          };
        }),
      },
      adjustments: {
        create: adjustments.map((a) => ({ type: a.type, amount: a.amount, description: a.description.trim(), jobNo: t(a.jobNo), advanceId: t(a.advanceId), createdById: input.actor.actorId })),
      },
      // The figures each supplemental payment was paid on. A partial unique index allows
      // one ACTIVE line per supplemental payment — the database refuses paying it twice.
      supplements: {
        create: check.supplements.map((x) => ({ supplementalId: x.id, guideId: input.guideId, type: x.type, accountingCategory: x.accountingCategory, grossAmount: x.grossAmount, wht: x.wht, netAmount: x.netAmount })),
      },
      transfers: {
        create: parts.map((p) => ({ seq: p.seq, amount: p.amount, transferDate: p.date, bankRef: t(p.bankRef), slipUrl: p.slip?.url ?? null, evidenceId: p.slip?.evidenceId ?? null })),
      },
    },
    select: { id: true, paymentNo: true },
  });

  // Phase 3: an ADVANCE_SETTLEMENT adjustment clears a real advance. The ledger entry
  // is written inside THIS transaction — if the payment rolls back, so does the
  // settlement. Advances are taken in id order (see lib/advances/service for the lock
  // order shared by every path).
  const advanceLines = adjustments
    .filter((a) => a.type === "ADVANCE_SETTLEMENT" && (a.advanceId ?? "").trim())
    .map((a) => ({ advanceId: (a.advanceId as string).trim(), amountSatang: Math.abs(toSatang(a.amount)) }));
  const deducted = await applyDeductionsInTx(tx, {
    guideId: input.guideId, paymentId: payment.id, paymentNo: payment.paymentNo,
    paymentDate: input.paymentDate, deductions: advanceLines, actor: input.actor,
  });
  // The money math and the ledger must agree to the satang, or neither is written.
  const ledgerSatang = deducted.reduce((sum, d) => sum + d.amountSatang, 0);
  const adjustmentSatang = adjustments.filter((a) => a.type === "ADVANCE_SETTLEMENT").reduce((sum, a) => sum + Math.abs(toSatang(a.amount)), 0);
  if (ledgerSatang !== adjustmentSatang) {
    throw new LedgerConflict(`The advance settlements on this payment come to ${(adjustmentSatang / 100).toFixed(2)} but ${(ledgerSatang / 100).toFixed(2)} was cleared on the ledger`);
  }

  for (const j of check.jobs) {
    const where = { guideId: input.guideId, date: j.date, slotIdx: j.slotIdx };
    const data = { status: "PAID", paidAt, approvedBy: input.actor.actorId, guidePaymentId: payment.id, ...(evidence?.url ? { eslipUrl: evidence.url } : {}) };
    const moved = await tx.tourPayment.updateMany({ where: { ...where, guidePaymentId: null, status: { not: "PAID" } }, data });
    if (moved.count === 1) continue;
    const existing = await tx.tourPayment.findUnique({ where: { guideId_date_slotIdx: where }, select: { id: true } });
    if (existing) throw new PaymentConflict(`${j.jobNo} was paid or changed while this payment was being recorded`);
    await tx.tourPayment.create({ data: { ...where, tourId: sheets.get(key(j))?.tourId ?? "", ...data } });
  }

  const summary = {
    paymentNo, guideId: input.guideId, source: input.source, paymentDate: input.paymentDate, accountingPeriod: check.accountingPeriod,
    advancesSettled: deducted.map((d) => ({ advanceNo: d.advanceNo, amount: d.amountSatang / 100 })),
    jobs: check.jobs.map((j) => ({ jobNo: j.jobNo, payable: j.figures.payable })),
    ...(check.supplements.length ? { kind: "SUPPLEMENTAL", supplements: check.supplements.map((x) => ({ id: x.id, type: x.type, gross: x.grossAmount, wht: x.wht, net: x.netAmount, accountingCategory: x.accountingCategory })), supplementTotal: check.reconciliation.supplementTotal } : {}),
    jobTotal: check.reconciliation.jobTotal, adjustmentTotal: check.reconciliation.adjustmentTotal, amountTransferred: check.reconciliation.amountTransferred,
    balanced: check.reconciliation.balanced, mismatchReason: check.reconciliation.balanced ? null : t(input.mismatchReason),
    periodOverrideReason: check.periods.length > 1 ? t(input.periodOverrideReason) : null,
    bankRef: t(input.bankRef), slip: !!input.slip?.url, noSlipReason: input.slip ? null : t(input.noSlipReason), peakPaymentRef: t(input.peakPaymentRef),
    ...(parts.length ? { transfers: parts.map((p) => ({ seq: p.seq, amount: p.amount, date: p.date, bankRef: t(p.bankRef), slip: !!(p.slip?.url || p.slip?.evidenceId) })) } : {}),
  };
  const audits: AuditEntry[] = [
    { ...input.actor, action: "payment.recorded", entityType: "GuidePayment", entityId: payment.id, detail: summary },
    ...adjustments.map((a) => ({ ...input.actor, action: "payment.adjustment_added", entityType: "GuidePayment", entityId: payment.id, detail: { paymentNo, type: a.type, amount: a.amount, description: a.description.trim(), jobNo: t(a.jobNo) } })),
    ...(input.slip?.url ? [{ ...input.actor, action: "payment.slip_attached", entityType: "GuidePayment", entityId: payment.id, detail: { paymentNo, evidenceId: input.slip.evidenceId ?? null } }] : []),
    ...check.supplements.map((x) => ({ ...input.actor, action: "supplemental.paid", entityType: "SupplementalPayment", entityId: x.id, detail: { paymentNo, type: x.type, gross: x.grossAmount, wht: x.wht, net: x.netAmount, paymentDate: input.paymentDate, bankRef: t(input.bankRef), slip: !!input.slip?.url } })),
  ];
  return {
    ok: true,
    payment: { id: payment.id, paymentNo, paymentDate: input.paymentDate, amountTransferred: check.reconciliation.amountTransferred, accountingPeriod: check.accountingPeriod!, jobs: check.jobs.map((j) => ({ jobNo: j.jobNo, date: j.date, slotIdx: j.slotIdx, payable: j.figures.payable })), supplements: check.supplements.map((x) => ({ id: x.id, type: x.type, netAmount: x.netAmount })) },
    reconciliation: check.reconciliation,
    audits,
  };
}

const uniqueTarget = (e: unknown): string => {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return "";
  const t = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(t) ? t.join(",") : String(t ?? "");
};

/** Record a payment in its own transaction, then audit it. */
export async function recordPayment(prisma: PrismaClient, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const split = await splitTransfer(tx, input);
        if (!split) return recordPaymentInTx(tx, input);
        const jobs = await recordPaymentInTx(tx, split.jobs);
        if (!jobs.ok) return jobs;
        const reviews = await recordPaymentInTx(tx, split.reviews);
        if (!reviews.ok) throw new PaymentConflict(reviews.reasons.join(" "));
        return { ...jobs, linked: reviews.payment, audits: [...jobs.audits, ...reviews.audits], reconciliation: merged(jobs.reconciliation, reviews.reconciliation, input.amountTransferred) };
      }, { timeout: 20_000 });
      if (result.ok) for (const a of result.audits) await audit(a);
      return result;
    } catch (e) {
      if (e instanceof PaymentConflict) return { ok: false, code: "conflict", reasons: [e.message] };
      if (e instanceof LedgerConflict) return { ok: false, code: "conflict", reasons: [e.message] };
      const target = uniqueTarget(e);
      if (target.includes("paymentNo")) continue; // two payments took the same number at once: try the next one
      if (target.includes("Supplement")) return { ok: false, code: "conflict", reasons: ["This supplemental payment was paid by another payment a moment ago — reload and check"] };
      if (target) return { ok: false, code: "conflict", reasons: ["One of these jobs was paid by another payment a moment ago — reload and check"] };
      throw e;
    }
  }
  return { ok: false, code: "conflict", reasons: ["Could not allocate a payment number — try again"] };
}

export type ReversePaymentResult =
  | { ok: true; paymentNo: string; jobs: string[]; advancesReopened: { advanceNo: string; amount: number }[] }
  | { ok: false; status: number; reasons: string[] };

/**
 * Reverse a payment recorded by mistake. Nothing is deleted: the payment becomes REVERSED
 * with who, when and why; its jobs are unpaid again and free to be paid by a new payment.
 * A payment PEAK itself holds (a combined document still PAID in FolkOPS) is not reversed
 * here — void the document in PEAK and record that first.
 */
export async function reversePayment(prisma: PrismaClient, input: { paymentId: string; reason: string; actor: Actor }): Promise<ReversePaymentResult> {
  const reason = (input.reason ?? "").trim();
  const p = await prisma.guidePayment.findUnique({ where: { id: input.paymentId }, include: { jobs: true, adjustments: true, supplements: true } });
  if (!p) return { ok: false, status: 404, reasons: ["No such payment"] };
  if (p.status !== "RECORDED") return { ok: false, status: 409, reasons: [`${p.paymentNo} is already ${p.status.toLowerCase()}`] };
  if (reason.length < 5) return { ok: false, status: 400, reasons: ["Give the reason this payment is being reversed"] };
  if (p.source === "PEAK_DOCUMENT" && p.peakPaymentRef) {
    const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: p.peakPaymentRef }, select: { status: true, peakDocumentNo: true } });
    if (doc && doc.status === "PAID") return { ok: false, status: 409, reasons: [`PEAK holds this payment on ${doc.peakDocumentNo ?? p.peakPaymentRef}. Void that document in PEAK and record it with "Voided in PEAK…" before reversing the payment here`] };
  }
  const now = new Date();
  // The jobs to unpay come from this payment's OWN GuidePaymentJob rows — the authoritative
  // membership. TourPayment.guidePaymentId is a cache and is never asked; a missing or wrong
  // pointer must not leave a job paid after its payment is reversed.
  const held = p.jobs.map((j) => ({ guideId: j.guideId, date: j.date, slotIdx: j.slotIdx, jobNo: j.jobNo }));
  let stillHeld: string[] = [];
  let restoredAdvances: { advanceId: string; advanceNo: string; amountSatang: number }[] = [];
  await prisma.$transaction(async (tx) => {
    const moved = await tx.guidePayment.updateMany({ where: { id: p.id, status: "RECORDED" }, data: { status: "REVERSED", reversedAt: now, reversedById: input.actor.actorId, reversalReason: reason } });
    if (moved.count !== 1) throw new PaymentConflict(`${p.paymentNo} changed while it was being reversed`);
    await tx.guidePaymentJob.updateMany({ where: { paymentId: p.id }, data: { active: false } });
    // Its supplemental payments are unpaid again — the obligation stays, ready to be paid
    // by a new transfer, and this payment's line stays on record, inactive.
    await tx.guidePaymentSupplementLine.updateMany({ where: { paymentId: p.id }, data: { active: false } });
    // The deductions this payment made never settled anything, because the money is
    // being undone. Contra entries are always negative, so this can never be refused
    // by the ledger's bounds (lib/advances/rules).
    restoredAdvances = await reverseDeductionsForPaymentInTx(tx, { paymentId: p.id, paymentNo: p.paymentNo, reason, actor: input.actor });
    if (!held.length) return;
    // A job another payment still holds stays paid by that one: only jobs left with no
    // active payment go back to unpaid.
    const others = await tx.guidePaymentJob.findMany({
      where: { OR: held.map((h) => ({ guideId: h.guideId, date: h.date, slotIdx: h.slotIdx })), active: true },
      select: { guideId: true, date: true, slotIdx: true, jobNo: true },
    });
    const takenBy = new Set(others.map((o) => `${o.guideId}|${o.date}|${o.slotIdx}`));
    stillHeld = held.filter((h) => takenBy.has(`${h.guideId}|${h.date}|${h.slotIdx}`)).map((h) => h.jobNo);
    const free = held.filter((h) => !takenBy.has(`${h.guideId}|${h.date}|${h.slotIdx}`));
    if (!free.length) return;
    const keys = free.map((h) => ({ guideId: h.guideId, date: h.date, slotIdx: h.slotIdx }));
    // This payment's slip stops being the job's evidence; a slip from elsewhere stays.
    if (p.slipUrl) await tx.tourPayment.updateMany({ where: { OR: keys, eslipUrl: p.slipUrl }, data: { eslipUrl: null } });
    await tx.tourPayment.updateMany({ where: { OR: keys }, data: { status: "PENDING", paidAt: null, approvedBy: null, guidePaymentId: null } });
  });
  await audit({
    ...input.actor, action: "payment.reversed", entityType: "GuidePayment", entityId: p.id,
    detail: {
      paymentNo: p.paymentNo, guideId: p.guideId, reason,
      before: { status: "RECORDED", paymentDate: p.paymentDate, amountTransferred: Number(p.amountTransferred), jobs: p.jobs.map((j) => j.jobNo), ...(p.supplements.length ? { supplements: p.supplements.map((x) => ({ id: x.supplementalId, type: x.type, net: Number(x.netAmount) })) } : {}) },
      after: { status: "REVERSED", ...(p.supplements.length ? { supplementsUnpaid: p.supplements.map((x) => x.supplementalId) } : {}), jobsUnpaid: p.jobs.map((j) => j.jobNo).filter((n) => !stillHeld.includes(n)), jobsStillPaidByAnotherPayment: stillHeld, advancesReopened: restoredAdvances.map((a) => ({ advanceNo: a.advanceNo, amount: a.amountSatang / 100 })) },
    },
  });
  for (const x of p.supplements) {
    await audit({ ...input.actor, action: "supplemental.payment_reversed", entityType: "SupplementalPayment", entityId: x.supplementalId,
      detail: { paymentNo: p.paymentNo, reason, type: x.type, net: Number(x.netAmount), note: "unpaid again; the reversed payment stays on record" } });
  }
  return { ok: true, paymentNo: p.paymentNo, jobs: p.jobs.map((j) => j.jobNo), advancesReopened: restoredAdvances.map((a) => ({ advanceNo: a.advanceNo, amount: a.amountSatang / 100 })) };
}

export type MissingTransferInput = {
  paymentId: string;
  recordedAmount: number;
  added: { amount: number; date: string; bankRef?: string | null; slip?: SlipRef | null }[];
  reason: string;
  actor: Actor;
};
export type MissingTransferResult =
  | { ok: true; paymentNo: string; transfers: { seq: number; amount: number; date: string; bankRef: string | null; slipUrl: string | null }[] }
  | { ok: false; status: number; reasons: string[] };

async function missingTransferCheck(db: Db, input: MissingTransferInput) {
  const p = await db.guidePayment.findUnique({ where: { id: input.paymentId }, include: { _count: { select: { transfers: true } } } });
  if (!p) return { p: null, reasons: ["No such payment"] };
  const addedUsedBy = await Promise.all(input.added.map(async (t) => {
    const h = await evidenceHolder(db, t);
    return h.byRef ?? h.bySlip;
  }));
  const reasons = checkMissingTransfers({
    payment: { status: p.status, amountTransferred: Number(p.amountTransferred), paymentDate: p.paymentDate, bankRef: p.bankRef, transfers: p._count.transfers },
    recordedAmount: input.recordedAmount,
    added: input.added.map((t) => ({ amount: t.amount, date: t.date, bankRef: t.bankRef ?? null, hasSlip: !!(t.slip?.url || t.slip?.evidenceId) })),
    reason: input.reason, today: bangkokToday(), addedUsedBy,
  });
  return { p, reasons };
}

/** The checks of addMissingTransfers with nothing written — run before any slip is filed. */
export async function previewMissingTransfers(db: Db, input: MissingTransferInput): Promise<string[]> {
  return (await missingTransferCheck(db, input)).reasons;
}

/**
 * Record the transfers missing from a payment recorded as one (see checkMissingTransfers).
 * The recorded transfer becomes transfer 1 at the amount its slip really shows, keeping its
 * slip and reference; the missing ones follow. Jobs, figures, WHT, the payment date and the
 * PEAK document are untouched — the total is the same, only the evidence is completed.
 */
export async function addMissingTransfers(prisma: PrismaClient, input: MissingTransferInput): Promise<MissingTransferResult> {
  const reason = (input.reason ?? "").trim();
  const { p, reasons } = await missingTransferCheck(prisma, input);
  if (!p) return { ok: false, status: 404, reasons };
  if (reasons.length) return { ok: false, status: 409, reasons };
  const t = (s: string | null | undefined) => (s ?? "").trim() || null;
  const parts = [
    { seq: 1, amount: input.recordedAmount, transferDate: p.paymentDate, bankRef: t(p.bankRef), slipUrl: p.slipUrl, evidenceId: p.evidenceId },
    ...input.added.map((a, i) => ({ seq: i + 2, amount: a.amount, transferDate: a.date, bankRef: t(a.bankRef), slipUrl: a.slip?.url ?? null, evidenceId: a.slip?.evidenceId ?? null })),
  ];
  const last = parts[parts.length - 1];
  try {
    await prisma.$transaction(async (tx) => {
      // Only while it is still recorded as one transfer — a second press, or a reversal in
      // between, changes nothing.
      const moved = await tx.guidePayment.updateMany({
        where: { id: p.id, status: "RECORDED", transfers: { none: {} } },
        // As recordPayment keeps a payment made in several transfers: the references live on
        // the transfers, and the payment's own evidence is the last slip.
        data: { bankRef: null, slipUrl: last.slipUrl, evidenceId: last.evidenceId, slipUploadedAt: new Date(), slipUploadedById: input.actor.actorId },
      });
      if (moved.count !== 1) throw new PaymentConflict(`${p.paymentNo} changed while its transfers were being added`);
      await tx.guidePaymentTransfer.createMany({ data: parts.map((x) => ({ ...x, paymentId: p.id })) });
    });
  } catch (e) {
    if (e instanceof PaymentConflict) return { ok: false, status: 409, reasons: [e.message] };
    throw e;
  }
  await audit({
    ...input.actor, action: "payment.transfers_added", entityType: "GuidePayment", entityId: p.id,
    detail: {
      paymentNo: p.paymentNo, guideId: p.guideId, reason,
      note: "evidence corrected; jobs, figures, WHT, payment date and PEAK document unchanged",
      before: { amountTransferred: Number(p.amountTransferred), transfers: 1, bankRef: p.bankRef, slip: !!p.slipUrl },
      after: { amountTransferred: Number(p.amountTransferred), transfers: parts.map((x) => ({ seq: x.seq, amount: x.amount, date: x.transferDate, bankRef: x.bankRef, slip: !!x.slipUrl })) },
    },
  });
  return { ok: true, paymentNo: p.paymentNo, transfers: parts.map((x) => ({ seq: x.seq, amount: x.amount, date: x.transferDate, bankRef: x.bankRef, slipUrl: x.slipUrl })) };
}
