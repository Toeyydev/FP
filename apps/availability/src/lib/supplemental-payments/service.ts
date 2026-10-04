// Supplemental guide payments — load, create, void, record the PEAK reference, list.
//
// Paying one is NOT here: a supplemental payment is paid by a GuidePayment, through
// lib/payments-v2 (recordPayment with `supplements`), like every other transfer. This file
// never writes a GuidePayment, and never touches the payment a supplemental payment was
// omitted from — that one is linked, not edited.
import { Prisma, type PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { reviewRewardTotal, type Expense } from "@/lib/jobsheet";
import { isMapped } from "@/lib/peak-accounts";
import { configuredWhtPct } from "@/lib/supplemental-payments/policy";
import {
  MAX_REVIEWS, reviewIncentiveFigures, validReviewCount, checkCreate, normalizePeakRef, supplementalState, MIN_REASON, PEAK_EXPENSE_REF, SUPPLEMENTAL_LABEL, SUPPLEMENTAL_TYPES,
  type AccountingState, type CreateCheck, type CreateFacts, type CreateInput, type PaymentState, type SupplementalJob, type SupplementalType,
} from "@/lib/supplemental-payments/rules";

type Db = PrismaClient | Prisma.TransactionClient;
export type Actor = { actorId: string | null; actorRole: string | null };
const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const jobsOf = (v: unknown): SupplementalJob[] => (Array.isArray(v) ? (v as SupplementalJob[]) : []);

/**
 * The payment holding each supplemental payment right now, if any: an ACTIVE line on a
 * RECORDED payment. A line left active on a reversed payment (only possible if a build
 * without this feature reversed it) does not count as paid.
 */
export async function activePaymentNos(db: Db, ids: string[]): Promise<Map<string, { paymentNo: string; paymentDate: string; paymentId: string }>> {
  if (!ids.length) return new Map();
  const lines = await db.guidePaymentSupplementLine.findMany({ where: { supplementalId: { in: ids }, active: true }, select: { supplementalId: true, paymentId: true } });
  const pays = lines.length ? await db.guidePayment.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.paymentId))] }, status: "RECORDED" }, select: { id: true, paymentNo: true, paymentDate: true } }) : [];
  const out = new Map<string, { paymentNo: string; paymentDate: string; paymentId: string }>();
  for (const l of lines) {
    const p = pays.find((x) => x.id === l.paymentId);
    if (p) out.set(l.supplementalId, { paymentNo: p.paymentNo, paymentDate: p.paymentDate, paymentId: p.id });
  }
  return out;
}

/** The categories with a PEAK account mapped. */
export async function mappedCategories(db: Db): Promise<string[]> {
  const rows = await db.peakAccountMapping.findMany({ select: { folkopsCategory: true, peakAccountCode: true, peakAccountName: true, isActive: true } });
  return rows.filter((r) => isMapped(r)).map((r) => r.folkopsCategory).sort();
}

/** Everything checkCreate needs, read in one pass. */
export async function loadCreateFacts(db: Db, input: CreateInput): Promise<CreateFacts> {
  const jobs = input.jobs ?? [];
  const or = jobs.map((j) => ({ guideId: input.guideId, date: j.date, slotIdx: j.slotIdx }));
  const [guide, sheets, paidJobs, categories, original, existing, legacy, openBonuses] = await Promise.all([
    input.guideId ? db.user.findFirst({ where: { guideId: input.guideId }, select: { id: true } }) : null,
    or.length ? db.jobSheet.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, ref: true, expenses: true } }) : [],
    or.length ? db.guidePaymentJob.findMany({ where: { OR: or, active: true }, select: { date: true, slotIdx: true, reviewReward: true, paymentId: true } }) : [],
    mappedCategories(db),
    input.originalPaymentId ? db.guidePayment.findUnique({ where: { id: input.originalPaymentId }, select: { guideId: true, paymentNo: true, status: true } }) : null,
    input.guideId && input.type ? db.supplementalPayment.findMany({ where: { guideId: input.guideId, type: input.type, voidedAt: null }, select: { id: true, jobs: true, grossAmount: true, originalPaymentId: true, createdAt: true, whtBearer: true, workMonth: true } }) : [],
    input.legacyBonusId ? db.bonus.findUnique({ where: { id: input.legacyBonusId }, select: { id: true, guideId: true, amount: true, period: true, eslipUrl: true, supplementals: { where: { voidedAt: null }, select: { id: true } } } }) : null,
    input.guideId ? db.bonus.findMany({ where: { guideId: input.guideId, eslipUrl: null, supplementals: { none: { voidedAt: null } } }, select: { id: true, amount: true, period: true } }) : [],
  ]);
  const jobPays = paidJobs.length ? await db.guidePayment.findMany({ where: { id: { in: [...new Set(paidJobs.map((j) => j.paymentId))] } }, select: { id: true, paymentNo: true } }) : [];
  const convertedId = legacy?.supplementals[0]?.id ?? null;
  const held = await activePaymentNos(db, [...existing.map((e) => e.id), ...(convertedId ? [convertedId] : [])]);
  const type = SUPPLEMENTAL_TYPES.includes(input.type as SupplementalType) ? (input.type as SupplementalType) : null;
  return {
    guideExists: !!guide,
    configuredWhtPct: type ? configuredWhtPct(type).pct : null,
    legacyBonus: legacy ? { id: legacy.id, guideId: legacy.guideId, amount: legacy.amount, period: legacy.period, paid: !!legacy.eslipUrl, convertedTo: convertedId ? { id: convertedId, paidBy: held.get(convertedId)?.paymentNo ?? null } : null } : null,
    openLegacyBonuses: openBonuses.map((b) => ({ id: b.id, amount: b.amount, period: b.period })),
    sheets: sheets.map((s) => {
      const paid = paidJobs.find((j) => key(j) === key(s));
      return {
        date: s.date, slotIdx: s.slotIdx, ref: s.ref,
        reviewReward: reviewRewardTotal((s.expenses as unknown as Expense[]) ?? []),
        reviewPaidBy: paid && Number(paid.reviewReward) > 0 ? jobPays.find((p) => p.id === paid.paymentId)?.paymentNo ?? null : null,
      };
    }),
    categories,
    original,
    existing: existing.map((e) => ({ id: e.id, jobs: jobsOf(e.jobs), grossAmount: Number(e.grossAmount), originalPaymentId: e.originalPaymentId, paidBy: held.get(e.id)?.paymentNo ?? null, createdAt: e.createdAt, whtBearer: e.whtBearer, workMonth: e.workMonth })),
  };
}

/** The checks Create runs, with nothing written. */
export async function previewSupplemental(db: Db, input: CreateInput): Promise<CreateCheck> {
  return checkCreate(input, await loadCreateFacts(db, input));
}

export type CreateResult =
  | { ok: true; id: string; replayed: boolean; check: CreateCheck }
  | { ok: false; status: number; reasons: string[]; duplicates: string[] };

/**
 * Create a supplemental payment, UNPAID. A request carrying a key it has already used gets
 * the same payment back rather than a second one — a double-click or a retried request
 * never creates two.
 */
export async function createSupplemental(prisma: PrismaClient, input: CreateInput & { requestKey?: string | null; actor: Actor }): Promise<CreateResult> {
  const requestKey = (input.requestKey ?? "").trim() || null;
  if (requestKey) {
    const prior = await prisma.supplementalPayment.findUnique({ where: { requestKey }, select: { id: true, guideId: true, type: true, grossAmount: true, reviewCount: true, workMonth: true } });
    if (prior) {
      const same = prior.guideId === input.guideId && prior.type === input.type && (prior.reviewCount
        ? prior.reviewCount === input.reviewCount && prior.workMonth === (input.workMonth ?? "").trim()
        : Math.round(Number(prior.grossAmount) * 100) === Math.round(input.grossAmount * 100));
      if (!same) return { ok: false, status: 409, reasons: ["This request was already used for a different payment — reload and try again"], duplicates: [] };
      return { ok: true, id: prior.id, replayed: true, check: { reasons: [], duplicates: [], figures: null, accountingCategory: null, review: null } };
    }
  }
  const check = await previewSupplemental(prisma, input);
  if (check.reasons.length) return { ok: false, status: 409, reasons: check.reasons, duplicates: check.duplicates };
  const t = (s: string | null | undefined) => (s ?? "").trim() || null;
  const jobs = (input.jobs ?? []).map((j) => ({ jobNo: j.jobNo.trim(), date: j.date, slotIdx: j.slotIdx }));
  const override = check.duplicates.length ? t(input.duplicateOverrideReason) : null;
  let row: { id: string };
  try {
    row = await prisma.supplementalPayment.create({
      data: {
        guideId: input.guideId, type: input.type, accountingCategory: check.accountingCategory!,
        grossAmount: check.figures!.gross, whtPct: check.figures!.whtPct, whtSource: check.figures!.whtSource, wht: check.figures!.wht, netAmount: check.figures!.net,
        reason: input.reason.trim(), note: t(input.note), jobs, originalPaymentId: t(input.originalPaymentId), legacyBonusId: t(input.legacyBonusId),
        duplicateOverrideReason: override, requestKey, createdById: input.actor.actorId,
        whtBearer: check.figures!.whtBearer,
        ...(check.review ? { reviewCount: check.review.reviewCount, workMonth: check.review.workMonth, eWithholding: check.review.eWithholding } : {}),
      },
      select: { id: true },
    });
  } catch (e) {
    // Two identical requests at once: the second finds the first by its key.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      if (requestKey) {
        const prior = await prisma.supplementalPayment.findUnique({ where: { requestKey }, select: { id: true } });
        if (prior) return { ok: true, id: prior.id, replayed: true, check };
      }
      // The database's own refusal: that earlier bonus was converted a moment ago.
      return { ok: false, status: 409, reasons: ["That earlier bonus was just converted by someone else — reload"], duplicates: [] };
    }
    throw e;
  }
  const original = input.originalPaymentId ? await prisma.guidePayment.findUnique({ where: { id: input.originalPaymentId }, select: { paymentNo: true } }) : null;
  await audit({
    ...input.actor, action: "supplemental.created", entityType: "SupplementalPayment", entityId: row.id,
    detail: {
      guideId: input.guideId, type: input.type, accountingCategory: check.accountingCategory,
      gross: check.figures!.gross, whtPct: check.figures!.whtPct, whtSource: check.figures!.whtSource, wht: check.figures!.wht, net: check.figures!.net,
      whtBearer: check.figures!.whtBearer, ...(check.review ?? {}),
      legacyBonusId: t(input.legacyBonusId),
      jobs: jobs.map((j) => j.jobNo), reason: input.reason.trim(), originalPaymentNo: original?.paymentNo ?? null,
      note: "a separate obligation; the original payment is not changed",
    },
  });
  if (input.legacyBonusId) {
    await audit({ ...input.actor, action: "bonus.converted", entityType: "Bonus", entityId: input.legacyBonusId,
      detail: { supplementalId: row.id, amount: check.figures!.gross, note: "the bonus row is kept unchanged as history; it is paid through the supplemental payment" } });
  }
  if (override) {
    await audit({ ...input.actor, action: "supplemental.duplicate_override", entityType: "SupplementalPayment", entityId: row.id, detail: { matches: check.duplicates, reason: override } });
  }
  return { ok: true, id: row.id, replayed: false, check };
}

type ChangeResult = { ok: true } | { ok: false; status: number; reasons: string[] };

/**
 * Change an UNPAID company-borne review incentive: more reviews for the same month, or paid
 * through e-Withholding (1%) or not (3%). The figures are worked out again from the count;
 * nothing is typed. A paid one is never changed — later reviews start a new incentive.
 */
export async function changeReviewIncentive(prisma: PrismaClient, input: { id: string; addReviews?: number | null; eWithholding?: boolean | null; reason: string; actor: Actor }): Promise<ChangeResult> {
  const row = await prisma.supplementalPayment.findUnique({ where: { id: input.id } });
  if (!row) return { ok: false, status: 404, reasons: ["No such supplemental payment"] };
  if (row.whtBearer !== "COMPANY_ONCE" || !row.reviewCount) return { ok: false, status: 409, reasons: ["Only a review incentive counted in reviews can be changed this way"] };
  if (row.voidedAt) return { ok: false, status: 409, reasons: ["It is void"] };
  const held = (await activePaymentNos(prisma, [row.id])).get(row.id);
  if (held) return { ok: false, status: 409, reasons: [`It is paid by ${held.paymentNo} — later reviews go into a new review incentive`] };
  const add = input.addReviews ?? 0;
  if (add !== 0 && !validReviewCount(add)) return { ok: false, status: 400, reasons: ["Enter how many more reviews — a whole number, at least 1"] };
  const count = row.reviewCount + add;
  if (count > MAX_REVIEWS) return { ok: false, status: 400, reasons: [`That makes ${count} reviews — more than ${MAX_REVIEWS} in one month`] };
  const eWithholding = input.eWithholding ?? row.eWithholding;
  if (!add && eWithholding === row.eWithholding) return { ok: false, status: 400, reasons: ["Nothing to change"] };
  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON) return { ok: false, status: 400, reasons: ["Say why it changes (e.g. two more reviews this week)"] };
  const f = reviewIncentiveFigures(count, eWithholding);
  const moved = await prisma.supplementalPayment.updateMany({
    where: { id: row.id, voidedAt: null, reviewCount: row.reviewCount, eWithholding: row.eWithholding },
    data: { reviewCount: count, eWithholding, grossAmount: f.gross, whtPct: f.whtPct, wht: f.wht, netAmount: f.net },
  });
  if (moved.count !== 1) return { ok: false, status: 409, reasons: ["It changed while this was being saved — reload"] };
  await audit({ ...input.actor, action: "supplemental.review_incentive_changed", entityType: "SupplementalPayment", entityId: row.id,
    detail: { workMonth: row.workMonth, before: { reviews: row.reviewCount, eWithholding: row.eWithholding, net: Number(row.netAmount), wht: Number(row.wht), gross: Number(row.grossAmount) },
      after: { reviews: count, eWithholding, net: f.net, wht: f.wht, gross: f.gross }, reason } });
  return { ok: true };
}

/** Withdraw an UNPAID supplemental payment. A paid one is undone by reversing its payment, never here. */
export async function voidSupplemental(prisma: PrismaClient, input: { id: string; reason: string; actor: Actor }): Promise<ChangeResult> {
  const reason = (input.reason ?? "").trim();
  const row = await prisma.supplementalPayment.findUnique({ where: { id: input.id } });
  if (!row) return { ok: false, status: 404, reasons: ["No such supplemental payment"] };
  if (row.voidedAt) return { ok: false, status: 409, reasons: ["It is already void"] };
  const held = (await activePaymentNos(prisma, [row.id])).get(row.id);
  if (held) return { ok: false, status: 409, reasons: [`It is paid by ${held.paymentNo} — reverse that payment first; a paid amount is never voided`] };
  if (reason.length < MIN_REASON) return { ok: false, status: 400, reasons: ["Give the reason it is being voided"] };
  const moved = await prisma.supplementalPayment.updateMany({ where: { id: row.id, voidedAt: null }, data: { voidedAt: new Date(), voidedById: input.actor.actorId, voidReason: reason } });
  if (moved.count !== 1) return { ok: false, status: 409, reasons: ["It changed while it was being voided — reload"] };
  await audit({ ...input.actor, action: "supplemental.voided", entityType: "SupplementalPayment", entityId: row.id, detail: { reason, type: row.type, gross: Number(row.grossAmount), net: Number(row.netAmount) } });
  return { ok: true };
}

/**
 * Record — or correct — the PEAK document (EXP-…) the payment is booked in. Paid with a
 * reference = reconciled. A reference already used for anything else (another payment's
 * document, a job sheet, a combined document) is refused: one transfer, one document.
 * Correcting a recorded reference needs a reason; every value it ever had stays in the audit.
 */
export async function setPeakRef(prisma: PrismaClient, input: { id: string; peakRef: string; reason?: string | null; actor: Actor }): Promise<ChangeResult> {
  const ref = normalizePeakRef(input.peakRef);
  if (!PEAK_EXPENSE_REF.test(ref)) return { ok: false, status: 400, reasons: ["Enter the PEAK document number as it appears in PEAK — EXP-YYYYMM…"] };
  const row = await prisma.supplementalPayment.findUnique({ where: { id: input.id }, select: { id: true, voidedAt: true, peakRef: true } });
  if (!row) return { ok: false, status: 404, reasons: ["No such supplemental payment"] };
  if (row.voidedAt) return { ok: false, status: 409, reasons: ["It is void — nothing to book"] };
  if (row.peakRef === ref) return { ok: true };
  const reason = (input.reason ?? "").trim();
  if (row.peakRef && reason.length < MIN_REASON) return { ok: false, status: 400, reasons: [`It is already recorded as ${row.peakRef} — give the reason for correcting it`] };
  const clash = await peakRefInUse(prisma, ref, row.id);
  if (clash) return { ok: false, status: 409, reasons: [`${ref} is already recorded for ${clash} — one PEAK document per transfer. Check the number in PEAK.`] };
  await prisma.supplementalPayment.update({ where: { id: row.id }, data: { peakRef: ref, peakRefAt: new Date(), peakRefById: input.actor.actorId } });
  await audit({ ...input.actor, action: row.peakRef ? "supplemental.peak_ref_corrected" : "supplemental.peak_ref_recorded", entityType: "SupplementalPayment", entityId: row.id,
    detail: { before: row.peakRef, after: ref, ...(row.peakRef ? { reason } : {}) } });
  return { ok: true };
}

/** What else, if anything, already carries this PEAK document number. Supplemental payments paid by the same transfer may share one. */
async function peakRefInUse(db: Db, ref: string, selfId: string): Promise<string | null> {
  const spellings = [...new Set([ref, ref.replace(/^EXP-(\d{6})/, "EXP-$1-")])];
  const [sheet, tour, doc, job, others] = await Promise.all([
    db.jobSheet.findFirst({ where: { peakDocumentNo: { in: spellings } }, select: { ref: true } }),
    db.tourPayment.findFirst({ where: { peakRef: { in: spellings } }, select: { guideId: true, date: true } }),
    db.guidePaymentDocument.findFirst({ where: { peakDocumentNo: { in: spellings } }, select: { paymentRef: true } }),
    db.guidePaymentJob.findFirst({ where: { peakDocumentNo: { in: spellings } }, select: { jobNo: true } }),
    db.supplementalPayment.findMany({ where: { peakRef: { in: spellings }, id: { not: selfId }, voidedAt: null }, select: { id: true } }),
  ]);
  if (sheet) return `job ${sheet.ref ?? "(no Job No.)"}`;
  if (job) return `job ${job.jobNo}`;
  if (doc) return `payment document ${doc.paymentRef}`;
  if (tour) return `${tour.guideId}'s tour on ${tour.date}`;
  if (others.length) {
    const held = await activePaymentNos(db, [selfId, ...others.map((o) => o.id)]);
    const mine = held.get(selfId)?.paymentId ?? null;
    const foreign = others.find((o) => !mine || held.get(o.id)?.paymentId !== mine);
    if (foreign) return "another supplemental payment, paid by a different transfer";
  }
  return null;
}

export type SupplementalView = {
  id: string; guideId: string; guide: string; type: SupplementalType; typeLabel: string;
  grossAmount: number; whtPct: number; wht: number; netAmount: number; accountingCategory: string;
  whtSource: string;
  whtBearer: string; reviewCount: number | null; workMonth: string | null; eWithholding: boolean;
  peakStatus: string | null; peakError: string | null; peakDocumentLink: string | null;
  reason: string; note: string | null; jobs: SupplementalJob[];
  originalPaymentNo: string | null; duplicateOverrideReason: string | null;
  legacyBonus: { id: string; period: string } | null;
  payment: PaymentState; accounting: AccountingState;
  paymentNo: string | null; paymentId: string | null; paidDate: string | null;
  peakRef: string | null; voidReason: string | null; createdAt: Date;
};

/** Supplemental payments with where each one stands. */
export async function listSupplementals(db: Db, where: { guideId?: string | null } = {}): Promise<SupplementalView[]> {
  // No limit: an unpaid or accounting-pending one must never drop off the list.
  const rows = await db.supplementalPayment.findMany({ where: where.guideId ? { guideId: where.guideId } : {}, orderBy: { createdAt: "desc" }, include: { legacyBonus: { select: { id: true, period: true } } } });
  const held = await activePaymentNos(db, rows.map((r) => r.id));
  const originals = rows.some((r) => r.originalPaymentId)
    ? await db.guidePayment.findMany({ where: { id: { in: rows.map((r) => r.originalPaymentId).filter((x): x is string => !!x) } }, select: { id: true, paymentNo: true } })
    : [];
  const guides = await db.user.findMany({ where: { guideId: { in: [...new Set(rows.map((r) => r.guideId))] } }, select: { guideId: true, displayName: true } });
  return rows.map((r) => {
    const h = held.get(r.id) ?? null;
    const state = supplementalState(r, h?.paymentNo ?? null);
    return {
      id: r.id, guideId: r.guideId, guide: guides.find((g) => g.guideId === r.guideId)?.displayName ?? r.guideId,
      type: r.type as SupplementalType, typeLabel: SUPPLEMENTAL_LABEL[r.type as SupplementalType]?.en ?? r.type,
      grossAmount: Number(r.grossAmount), whtPct: Number(r.whtPct), wht: Number(r.wht), netAmount: Number(r.netAmount),
      accountingCategory: r.accountingCategory, whtSource: r.whtSource, reason: r.reason, note: r.note, jobs: jobsOf(r.jobs),
      whtBearer: r.whtBearer, reviewCount: r.reviewCount, workMonth: r.workMonth, eWithholding: r.eWithholding,
      peakStatus: r.peakStatus, peakError: r.peakError, peakDocumentLink: r.peakDocumentLink,
      legacyBonus: r.legacyBonus ? { id: r.legacyBonus.id, period: r.legacyBonus.period } : null,
      originalPaymentNo: originals.find((o) => o.id === r.originalPaymentId)?.paymentNo ?? null,
      duplicateOverrideReason: r.duplicateOverrideReason,
      payment: state.payment, accounting: state.accounting,
      paymentNo: h?.paymentNo ?? null, paymentId: h?.paymentId ?? null, paidDate: h?.paymentDate ?? null,
      peakRef: r.peakRef, voidReason: r.voidReason, createdAt: r.createdAt,
    };
  });
}

export type SupplementalSummary = { unpaid: { count: number; total: number }; accountingPending: { count: number; total: number }; paidInPeriod: { count: number; total: number } };

/**
 * The figures the Payments month view shows: what is still owed, what was paid but is not
 * in PEAK yet (whatever month it was paid in — it stays until a reference is entered), and
 * what was paid in this month.
 */
export async function supplementalSummary(db: Db, period: string): Promise<SupplementalSummary> {
  const rows = await listSupplementals(db);
  const sum = (xs: SupplementalView[]) => ({ count: xs.length, total: Math.round(xs.reduce((s, x) => s + Math.round(x.netAmount * 100), 0)) / 100 });
  return {
    unpaid: sum(rows.filter((r) => r.payment === "UNPAID")),
    accountingPending: sum(rows.filter((r) => r.accounting === "ACCOUNTING_PENDING")),
    paidInPeriod: sum(rows.filter((r) => r.payment === "PAID" && (r.paidDate ?? "").startsWith(period))),
  };
}
