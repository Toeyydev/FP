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
import { Prisma, type PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { coveredByPayrollRun } from "@/lib/payment-coverage";
import { peakJobStatus } from "@/lib/peak-job-status";
import { documentHoldsJobs } from "@/lib/peak-payment-document";
import {
  bangkokToday, checkPayment, paidAtFor, paymentNoFor, ADJUSTMENT_TYPES,
  type AdjustmentInput, type JobFacts, type PaymentCheck, type PaymentRequest, type PaymentSource, type Reconciliation,
} from "@/lib/payments-v2/rules";

type Db = PrismaClient | Prisma.TransactionClient;
export type Actor = { actorId: string | null; actorRole: string | null };
type AuditEntry = Parameters<typeof audit>[0];

export type SlipRef = { url: string; evidenceId?: string | null; uploadedAt?: Date | null; uploadedById?: string | null };

export type RecordPaymentInput = Omit<PaymentRequest, "hasSlip"> & {
  slip?: SlipRef | null;
  note?: string | null;
  actor: Actor;
  /** Injected in tests; the Bangkok calendar date otherwise. */
  today?: string;
};

export type RecordedPayment = { id: string; paymentNo: string; paymentDate: string; amountTransferred: number; accountingPeriod: string; jobs: { jobNo: string; date: string; slotIdx: number; payable: number }[] };
export type RecordPaymentResult =
  | { ok: true; payment: RecordedPayment; reconciliation: Reconciliation; audits: AuditEntry[] }
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
    };
  });
  return {
    facts,
    sheets: new Map(sheets.map((s) => [key(s), { tourId: s.tourId, peakDocumentNo: s.peakDocumentNo, peakDocumentId: s.peakDocumentId, peakSyncStatus: s.peakSyncStatus }])),
    tourPays: new Map(pays.map((p) => [key(p), { peakRef: p.peakRef, peakDocumentId: p.peakDocumentId }])),
    docs,
  };
}

async function evidenceContext(db: Db, input: Pick<RecordPaymentInput, "bankRef" | "slip">) {
  const bankRef = (input.bankRef ?? "").trim();
  const [byRef, bySlip] = await Promise.all([
    bankRef ? db.guidePayment.findFirst({ where: { bankRef, status: "RECORDED" }, select: { paymentNo: true } }) : null,
    input.slip?.evidenceId
      ? db.guidePayment.findFirst({ where: { evidenceId: input.slip.evidenceId, status: "RECORDED" }, select: { paymentNo: true } })
      : input.slip?.url ? db.guidePayment.findFirst({ where: { slipUrl: input.slip.url, status: "RECORDED" }, select: { paymentNo: true } }) : null,
  ]);
  return { bankRefUsedBy: byRef?.paymentNo ?? null, slipUsedBy: bySlip?.paymentNo ?? null };
}

const request = (input: RecordPaymentInput): PaymentRequest => ({ ...input, hasSlip: !!(input.slip?.url || input.slip?.evidenceId) });

/** The checks Record payment runs, with nothing written. */
export async function previewPayment(db: Db, input: RecordPaymentInput): Promise<PaymentCheck> {
  const { facts } = await loadJobFacts(db, input.guideId, input.jobs);
  return checkPayment(request(input), facts, { today: input.today ?? bangkokToday(), ...(await evidenceContext(db, input)) });
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
  const check = checkPayment(request(input), facts, { today: input.today ?? bangkokToday(), ...(await evidenceContext(tx, input)) });
  if (check.reasons.length) return { ok: false, code: "invalid", reasons: check.reasons, reconciliation: check.reconciliation };

  const paymentNo = await nextPaymentNo(tx, input.paymentDate);
  const paidAt = paidAtFor(input.paymentDate);
  const adjustments = (input.adjustments ?? []).filter((a): a is AdjustmentInput & { type: (typeof ADJUSTMENT_TYPES)[number] } => ADJUSTMENT_TYPES.includes(a.type as never));
  const t = (s: string | null | undefined) => (s ?? "").trim() || null;

  const payment = await tx.guidePayment.create({
    data: {
      paymentNo, guideId: input.guideId, accountingPeriod: check.accountingPeriod!, paymentDate: input.paymentDate,
      jobTotal: check.reconciliation.jobTotal, adjustmentTotal: check.reconciliation.adjustmentTotal, amountTransferred: check.reconciliation.amountTransferred,
      status: "RECORDED", source: input.source as PaymentSource,
      bankRef: t(input.bankRef), evidenceId: input.slip?.evidenceId ?? null, slipUrl: input.slip?.url ?? null,
      slipUploadedAt: input.slip ? input.slip.uploadedAt ?? new Date() : null, slipUploadedById: input.slip?.uploadedById ?? null,
      noSlipReason: input.slip ? null : t(input.noSlipReason),
      mismatchReason: check.reconciliation.balanced ? null : t(input.mismatchReason),
      periodOverrideReason: check.periods.length > 1 ? t(input.periodOverrideReason) : null,
      peakPaymentRef: input.source === "PEAK_DOCUMENT" ? t(input.peakPaymentRef) : null,
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
        create: adjustments.map((a) => ({ type: a.type, amount: a.amount, description: a.description.trim(), jobNo: t(a.jobNo), createdById: input.actor.actorId })),
      },
    },
    select: { id: true, paymentNo: true },
  });

  for (const j of check.jobs) {
    const where = { guideId: input.guideId, date: j.date, slotIdx: j.slotIdx };
    const data = { status: "PAID", paidAt, approvedBy: input.actor.actorId, guidePaymentId: payment.id, ...(input.slip?.url ? { eslipUrl: input.slip.url } : {}) };
    const moved = await tx.tourPayment.updateMany({ where: { ...where, guidePaymentId: null, status: { not: "PAID" } }, data });
    if (moved.count === 1) continue;
    const existing = await tx.tourPayment.findUnique({ where: { guideId_date_slotIdx: where }, select: { id: true } });
    if (existing) throw new PaymentConflict(`${j.jobNo} was paid or changed while this payment was being recorded`);
    await tx.tourPayment.create({ data: { ...where, tourId: sheets.get(key(j))?.tourId ?? "", ...data } });
  }

  const summary = {
    paymentNo, guideId: input.guideId, source: input.source, paymentDate: input.paymentDate, accountingPeriod: check.accountingPeriod,
    jobs: check.jobs.map((j) => ({ jobNo: j.jobNo, payable: j.figures.payable })),
    jobTotal: check.reconciliation.jobTotal, adjustmentTotal: check.reconciliation.adjustmentTotal, amountTransferred: check.reconciliation.amountTransferred,
    balanced: check.reconciliation.balanced, mismatchReason: check.reconciliation.balanced ? null : t(input.mismatchReason),
    periodOverrideReason: check.periods.length > 1 ? t(input.periodOverrideReason) : null,
    bankRef: t(input.bankRef), slip: !!input.slip?.url, noSlipReason: input.slip ? null : t(input.noSlipReason), peakPaymentRef: t(input.peakPaymentRef),
  };
  const audits: AuditEntry[] = [
    { ...input.actor, action: "payment.recorded", entityType: "GuidePayment", entityId: payment.id, detail: summary },
    ...adjustments.map((a) => ({ ...input.actor, action: "payment.adjustment_added", entityType: "GuidePayment", entityId: payment.id, detail: { paymentNo, type: a.type, amount: a.amount, description: a.description.trim(), jobNo: t(a.jobNo) } })),
    ...(input.slip?.url ? [{ ...input.actor, action: "payment.slip_attached", entityType: "GuidePayment", entityId: payment.id, detail: { paymentNo, evidenceId: input.slip.evidenceId ?? null } }] : []),
  ];
  return {
    ok: true,
    payment: { id: payment.id, paymentNo, paymentDate: input.paymentDate, amountTransferred: check.reconciliation.amountTransferred, accountingPeriod: check.accountingPeriod!, jobs: check.jobs.map((j) => ({ jobNo: j.jobNo, date: j.date, slotIdx: j.slotIdx, payable: j.figures.payable })) },
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
      const result = await prisma.$transaction((tx) => recordPaymentInTx(tx, input), { timeout: 20_000 });
      if (result.ok) for (const a of result.audits) await audit(a);
      return result;
    } catch (e) {
      if (e instanceof PaymentConflict) return { ok: false, code: "conflict", reasons: [e.message] };
      const target = uniqueTarget(e);
      if (target.includes("paymentNo")) continue; // two payments took the same number at once: try the next one
      if (target) return { ok: false, code: "conflict", reasons: ["One of these jobs was paid by another payment a moment ago — reload and check"] };
      throw e;
    }
  }
  return { ok: false, code: "conflict", reasons: ["Could not allocate a payment number — try again"] };
}

export type ReversePaymentResult = { ok: true; paymentNo: string; jobs: string[] } | { ok: false; status: number; reasons: string[] };

/**
 * Reverse a payment recorded by mistake. Nothing is deleted: the payment becomes REVERSED
 * with who, when and why; its jobs are unpaid again and free to be paid by a new payment.
 * A payment PEAK itself holds (a combined document still PAID in FolkOPS) is not reversed
 * here — void the document in PEAK and record that first.
 */
export async function reversePayment(prisma: PrismaClient, input: { paymentId: string; reason: string; actor: Actor }): Promise<ReversePaymentResult> {
  const reason = (input.reason ?? "").trim();
  const p = await prisma.guidePayment.findUnique({ where: { id: input.paymentId }, include: { jobs: true, adjustments: true } });
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
  await prisma.$transaction(async (tx) => {
    const moved = await tx.guidePayment.updateMany({ where: { id: p.id, status: "RECORDED" }, data: { status: "REVERSED", reversedAt: now, reversedById: input.actor.actorId, reversalReason: reason } });
    if (moved.count !== 1) throw new PaymentConflict(`${p.paymentNo} changed while it was being reversed`);
    await tx.guidePaymentJob.updateMany({ where: { paymentId: p.id }, data: { active: false } });
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
      before: { status: "RECORDED", paymentDate: p.paymentDate, amountTransferred: Number(p.amountTransferred), jobs: p.jobs.map((j) => j.jobNo) },
      after: { status: "REVERSED", jobsUnpaid: p.jobs.map((j) => j.jobNo).filter((n) => !stillHeld.includes(n)), jobsStillPaidByAnotherPayment: stillHeld },
    },
  });
  return { ok: true, paymentNo: p.paymentNo, jobs: p.jobs.map((j) => j.jobNo) };
}
