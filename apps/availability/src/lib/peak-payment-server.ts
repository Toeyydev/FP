// Server half of "Pay N jobs together": reads the jobs, enforces every guard that needs
// the database, and supplies the side effects lib/peak-payment-document orders.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { saveBufferToDrive } from "@/lib/google-drive";
import { DEFAULT_GUIDE_FEE, isApproved, type Expense, type GuideFee } from "@/lib/jobsheet";
import { guideFeeAccount, peakAccountMap, reviewRewardAccount } from "@/lib/peak-account-map";
import { createExpenseAllInOne, insertExpenseFile } from "@/lib/peak-api";
import { coveredByPayrollRun } from "@/lib/payment-coverage";
import { combinedPaymentBlock, sheetInPeak, type CombinedBlock } from "@/lib/combined-payment";
import {
  attachmentFileType, paymentDocumentLock, paymentRefFor,
  type GuidePaymentDocument, type PaymentAccounts, type PaymentJob, type PayTogetherDeps,
} from "@/lib/peak-payment-document";

export type JobKey = { date: string; slotIdx: number };
type Actor = { actorId: string | null; actorRole: string | null };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// The same fallback the Payments page uses: an auto-created sheet can store guideFee as
// {}, which must read as the standard fee — or the document and the page would disagree
// about what the guide is owed.
const guideFeeOf = (gf: unknown): GuideFee =>
  gf && typeof gf === "object" && (gf as GuideFee).price != null ? (gf as GuideFee) : DEFAULT_GUIDE_FEE;

export class PaymentClaimRefused extends Error {
  constructor(message: string) { super(message); this.name = "PaymentClaimRefused"; }
}
/** The generated FOLK-PAY ref collided with a concurrent payment. Nothing was written. */
export class PaymentRefTaken extends Error {
  constructor(readonly paymentRef: string) { super(`${paymentRef} was just taken`); this.name = "PaymentRefTaken"; }
}

export type PaymentContext = {
  guideId: string;
  guideName: string;
  peakContactId: string | null;
  jobs: PaymentJob[];
  /** Jobs refused only because their sheet is not approved yet. Never paid — the
   *  preview reads their rows so every fix a payment needs is listed at once. */
  awaitingApproval: PaymentJob[];
  accounts: PaymentAccounts;
};

/**
 * Everything the builder needs, or every database-side reason these jobs cannot be paid
 * together. Pure-data refusals (accounts, categories, dates) come from the builder.
 */
export async function loadPaymentContext(
  guideId: string,
  keys: JobKey[],
): Promise<{ ok: true; ctx: PaymentContext } | { ok: false; reasons: string[]; ctx: PaymentContext }> {
  const or = keys.map((k) => ({ guideId, date: k.date, slotIdx: k.slotIdx }));
  const periods = [...new Set(keys.map((k) => k.date.slice(0, 7)))];
  const [user, sheets, assigns, pays, payrolls, categories, feeAccount, rewardAccount] = await Promise.all([
    prisma.user.findFirst({ where: { guideId }, select: { peakContactId: true, fullName: true, displayName: true } }),
    prisma.jobSheet.findMany({
      where: { OR: or },
      select: { date: true, slotIdx: true, ref: true, expenses: true, guideFee: true, origin: true, createdAt: true, peakDocumentNo: true, peakDocumentId: true, approvalStatus: true },
    }),
    prisma.assignment.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, createdAt: true } }),
    prisma.tourPayment.findMany({
      where: { OR: or },
      select: { date: true, slotIdx: true, status: true, eslipUrl: true, slips: true, peakPaymentRef: true, peakRef: true },
    }),
    prisma.payrollStatus.findMany({ where: { guideId, period: { in: periods } }, select: { period: true, status: true, paidAt: true } }),
    peakAccountMap(),
    guideFeeAccount(),
    reviewRewardAccount(),
  ]);

  const reasons: string[] = [];
  const at = (list: { date: string; slotIdx: number }[], k: JobKey) => list.find((x) => x.date === k.date && x.slotIdx === k.slotIdx);
  const jobs: PaymentJob[] = [];
  const awaitingApproval: PaymentJob[] = [];
  const toJob = (sheet: (typeof sheets)[number], k: JobKey): PaymentJob => ({
    date: k.date, slotIdx: k.slotIdx, ref: sheet.ref ?? null, origin: sheet.origin,
    expenses: (sheet.expenses as unknown as Expense[]) ?? [],
    guideFee: guideFeeOf(sheet.guideFee),
  });

  for (const k of keys) {
    const sheet = at(sheets, k) as (typeof sheets)[number] | undefined;
    const pay = at(pays, k) as (typeof pays)[number] | undefined;
    const label = sheet?.ref || `${k.date} slot ${k.slotIdx}`;
    const assignment = at(assigns, k) as (typeof assigns)[number] | undefined;
    const payroll = payrolls.find((p) => p.period === k.date.slice(0, 7));
    // The same rule the Payments page counts with (lib/combined-payment), so the page
    // and this refusal can never disagree about which jobs may go together.
    const block = combinedPaymentBlock({
      sheet: sheet ?? null,
      payment: pay ?? null,
      coveredByPayroll: !!sheet && coveredByPayrollRun(payroll, k.date, assignment?.createdAt ?? sheet.createdAt),
      period: k.date.slice(0, 7),
    });
    if (block) {
      reasons.push(blockReason(label, block));
      if (block.code === "not-approved" && sheet) awaitingApproval.push(toJob(sheet, k));
      continue;
    }
    if (!sheet) continue; // unreachable: no sheet is a block — narrows the type
    jobs.push(toJob(sheet, k));
  }

  const ctx: PaymentContext = {
    guideId,
    guideName: user?.fullName || user?.displayName || guideId,
    peakContactId: user?.peakContactId ?? null,
    jobs,
    awaitingApproval,
    accounts: { guideFee: feeAccount, reviewReward: rewardAccount, categories },
  };
  if (reasons.length) return { ok: false, reasons, ctx };
  return { ok: true, ctx };
}

/** One job's refusal, as the preview and the post both word it. */
export function blockReason(label: string, block: CombinedBlock): string {
  return block.code === "payment-document" ? `${label}: ${block.message}` : `${label} ${block.message}`;
}

/**
 * The guide's other unpaid jobs this month that could still be paid together in one
 * document — what "Sync to PEAK" on one sheet would split off from. The month's jobs
 * that have already run (the ones Payments lists), minus any that can never join a
 * combined payment anyway: paid, covered by payroll, given a slip, held by a payment
 * document, historical, or already in PEAK from their own sheet. A job still waiting
 * for approval, or for its sheet to be saved, does count: it is only not ready yet.
 */
export async function otherUnpaidJobsInMonth(guideId: string, job: JobKey, today: string): Promise<{ date: string; slotIdx: number; ref: string | null }[]> {
  const period = job.date.slice(0, 7);
  const monthEnd = `${period}-31`;
  const where = { guideId, date: { gte: `${period}-01`, lte: today < monthEnd ? today : monthEnd } };
  const [assigns, sheets, pays, payroll] = await Promise.all([
    prisma.assignment.findMany({ where, select: { date: true, slotIdx: true, createdAt: true } }),
    prisma.jobSheet.findMany({ where, select: { date: true, slotIdx: true, ref: true, createdAt: true, origin: true, peakDocumentNo: true, peakDocumentId: true, approvalStatus: true } }),
    prisma.tourPayment.findMany({ where, select: { date: true, slotIdx: true, status: true, peakPaymentRef: true, peakRef: true, eslipUrl: true, slips: true } }),
    prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId, period } }, select: { status: true, paidAt: true } }),
  ]);
  const keyOf = (x: JobKey) => `${x.date}|${x.slotIdx}`;
  const keys = new Map<string, JobKey>();
  for (const x of [...assigns, ...sheets]) keys.set(keyOf(x), { date: x.date, slotIdx: x.slotIdx });
  keys.delete(keyOf(job));

  const out: { date: string; slotIdx: number; ref: string | null }[] = [];
  for (const k of [...keys.values()].sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx)) {
    const sheet = sheets.find((s) => keyOf(s) === keyOf(k));
    const assignment = assigns.find((a) => keyOf(a) === keyOf(k));
    const created = assignment?.createdAt ?? sheet?.createdAt;
    const block = combinedPaymentBlock({
      sheet: sheet ?? null,
      payment: pays.find((p) => keyOf(p) === keyOf(k)) ?? null,
      coveredByPayroll: !!created && coveredByPayrollRun(payroll, k.date, created),
      period,
    });
    if (!block || block.code === "not-approved" || block.code === "no-job-sheet") out.push({ ...k, ref: sheet?.ref ?? null });
  }
  return out;
}

export async function nextPaymentRef(paymentDate: string): Promise<string> {
  const prefix = paymentRefFor(paymentDate, 0).slice(0, -2); // "FOLK-PAY-202609-"
  const used = await prisma.guidePaymentDocument.count({ where: { paymentRef: { startsWith: prefix } } });
  return paymentRefFor(paymentDate, used + 1);
}

/**
 * The messages for any of these jobs that a payment document has locked. Every route
 * that pays, un-pays, posts or deletes a specific job asks this first — otherwise the
 * same cost could be settled or booked a second time around the document.
 */
export async function paymentDocumentLocks(jobs: { guideId: string; date: string; slotIdx: number }[]): Promise<string[]> {
  if (!jobs.length) return [];
  const rows = await prisma.tourPayment.findMany({
    where: { OR: jobs.map((j) => ({ guideId: j.guideId, date: j.date, slotIdx: j.slotIdx })), peakPaymentRef: { not: null } },
    select: { date: true, slotIdx: true, peakPaymentRef: true, peakRef: true },
  });
  return rows.map((r) => `${r.date} slot ${r.slotIdx}: ${paymentDocumentLock(r)}`);
}

/** The same, for a guide's whole month. `unresolvedOnly` skips documents PEAK already
 *  confirmed — those jobs are PAID, and re-stating that they are paid changes nothing. */
export async function paymentDocumentLocksInMonth(guideId: string, period: string, opts: { unresolvedOnly?: boolean } = {}): Promise<string[]> {
  const rows = await prisma.tourPayment.findMany({
    where: {
      guideId, date: { gte: `${period}-01`, lte: `${period}-31` }, peakPaymentRef: { not: null },
      ...(opts.unresolvedOnly ? { status: { not: "PAID" } } : {}),
    },
    select: { date: true, slotIdx: true, peakPaymentRef: true, peakRef: true },
  });
  return rows.map((r) => `${r.date} slot ${r.slotIdx}: ${paymentDocumentLock(r)}`);
}

export function prismaPayTogetherDeps(opts: {
  guideId: string;
  guideName: string;
  paymentDate: string;
  paymentMethodId: string;
  paymentMethodName: string | null;
  file: { base64: string; mime: string };
  refreshToken: string;
  actor: Actor;
}): PayTogetherDeps {
  const { guideId, guideName, paymentDate, paymentMethodId, paymentMethodName, file, refreshToken, actor } = opts;
  const ext = extOf(file.mime);

  return {
    async claim(doc: GuidePaymentDocument) {
      try {
        await prisma.$transaction(async (tx) => {
          // Re-read inside the transaction: a sheet synced to PEAK on its own, or one
          // whose approval was withdrawn, since the jobs were loaded must not go into this
          // document. Checked for every job before anything is written, so one refusal
          // refuses the whole payment.
          for (const j of doc.jobs) {
            const sheetNow = await tx.jobSheet.findUnique({
              where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } },
              select: { peakDocumentNo: true, peakDocumentId: true, approvalStatus: true },
            });
            if (sheetInPeak(sheetNow)) {
              throw new PaymentClaimRefused(`${j.ref} was just posted to PEAK from its job sheet${sheetNow?.peakDocumentNo ? ` (${sheetNow.peakDocumentNo})` : ""} — leave it out of this payment`);
            }
            if (!isApproved(sheetNow?.approvalStatus)) {
              throw new PaymentClaimRefused(`${j.ref} is no longer approved — approve the job sheet again before paying it`);
            }
          }
          await tx.guidePaymentDocument.create({
            data: {
              paymentRef: doc.paymentRef, guideId, paymentDate, paymentMethodId, paymentMethodName,
              jobs: doc.jobs as unknown as Prisma.InputJsonValue,
              lines: doc.traces as unknown as Prisma.InputJsonValue,
              total: doc.total, status: "POSTING", createdById: actor.actorId,
            },
          });
          for (const j of doc.jobs) {
            const key = { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } };
            const a = await tx.assignment.findUnique({ where: key, select: { tourId: true } });
            const s = a ? null : await tx.jobSheet.findUnique({ where: key, select: { tourId: true } });
            await tx.tourPayment.upsert({
              where: key,
              create: { guideId, date: j.date, slotIdx: j.slotIdx, tourId: a?.tourId ?? s?.tourId ?? "", status: "PENDING" },
              update: {},
            });
            // The lock itself. Conditional, so two requests racing for the same job
            // cannot both win: the second waits on the row, then matches nothing.
            const locked = await tx.tourPayment.updateMany({
              where: { guideId, date: j.date, slotIdx: j.slotIdx, peakPaymentRef: null, status: { not: "PAID" }, eslipUrl: null },
              data: { peakPaymentRef: doc.paymentRef },
            });
            if (locked.count !== 1) {
              throw new PaymentClaimRefused(`${j.ref} was just paid, given a slip, or put into another PEAK payment — reload and try again`);
            }
          }
        }, { timeout: 20_000 });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new PaymentRefTaken(doc.paymentRef);
        throw e;
      }
      await audit({ ...actor, action: "pay.peak_document_claimed", entityType: "GuidePaymentDocument", detail: { paymentRef: doc.paymentRef, guideId, jobs: doc.jobs, total: doc.total } });
    },

    async uploadSlip(doc) {
      const earliest = [...doc.jobs.map((j) => j.date)].sort()[0];
      const monthFolder = `${earliest.slice(0, 7)} ${MONTHS[Number(earliest.slice(5, 7)) - 1] ?? ""}`.trim();
      const name = `${guideId} ${guideName} — ${doc.paymentRef} (${doc.jobs.length} tour${doc.jobs.length === 1 ? "" : "s"}) — e-slip.${ext}`;
      const { link } = await saveBufferToDrive({ refreshToken, name, base64: file.base64, mimeType: file.mime, folderPath: ["Folkpaths E-slips", monthFolder] });
      // Stored now, so a payment that later needs resolving by hand still has its slip.
      await prisma.guidePaymentDocument.update({ where: { paymentRef: doc.paymentRef }, data: { slipUrl: link } });
      return { link };
    },

    createExpense: (expense) => createExpenseAllInOne(expense),

    async recordPosted(p) {
      await markDocumentPaid({ ...p, paymentDate, actor });
    },

    async recordFailed({ paymentRef, reason, uncertain }) {
      if (uncertain) {
        await prisma.guidePaymentDocument.update({ where: { paymentRef }, data: { status: "UNCERTAIN", error: reason } });
        await audit({ ...actor, action: "pay.peak_document_uncertain", entityType: "GuidePaymentDocument", detail: { paymentRef, guideId, reason } });
        return;
      }
      await releaseDocument(paymentRef, "FAILED", reason, null);
      await audit({ ...actor, action: "pay.peak_document_failed", entityType: "GuidePaymentDocument", detail: { paymentRef, guideId, reason } });
    },

    async attachSlip({ documentId, documentNo }) {
      const r = await insertExpenseFile({
        transactionId: documentId, transactionCode: documentNo,
        fileName: `${documentNo}-slip.${ext}`, base64: file.base64, fileType: attachmentFileType(file.mime),
      });
      return { ok: r.ok, reason: r.ok ? undefined : r.desc };
    },

    async recordAttachment({ paymentRef, ok, reason }) {
      await prisma.guidePaymentDocument.update({
        where: { paymentRef },
        data: { attachmentStatus: ok ? "ATTACHED" : "FAILED", attachmentError: ok ? null : reason },
      });
      if (!ok) await audit({ ...actor, action: "pay.peak_document_attach_failed", entityType: "GuidePaymentDocument", detail: { paymentRef, reason } });
    },
  };
}

/** The selected payment date as an instant. Noon in Bangkok, so it reads as the same
 *  calendar date in any timezone an operator views it from. */
export const paidAtFor = (paymentDate: string) => new Date(`${paymentDate}T12:00:00+07:00`);

/** Every job locked to this document becomes PAID and points at the same PEAK document. */
async function markDocumentPaid(p: {
  paymentRef: string; documentNo: string; documentId: string | null; documentLink: string | null; slipLink: string | null;
  paymentDate: string; actor: Actor; resolvedBy?: string | null;
}) {
  const now = new Date();
  // paidAt is the date the money moved — the one sent to PEAK — not the moment someone
  // pressed the button. A transfer recorded the next morning still happened yesterday.
  const paidAt = paidAtFor(p.paymentDate);
  await prisma.$transaction(async (tx) => {
    const doc = await tx.guidePaymentDocument.findUnique({ where: { paymentRef: p.paymentRef }, select: { jobs: true } });
    const expected = Array.isArray(doc?.jobs) ? doc!.jobs.length : -1;
    const paid = await tx.tourPayment.updateMany({
      where: { peakPaymentRef: p.paymentRef },
      data: {
        status: "PAID", paidAt, approvedBy: p.actor.actorId, approvedAt: null,
        peakRef: p.documentNo, peakDocumentId: p.documentId, ...(p.slipLink ? { eslipUrl: p.slipLink } : {}),
      },
    });
    // A job that lost its lock in the meantime would be missing from the paid set while
    // PEAK holds its line. Refuse to half-record it; the document stays open to resolve.
    if (paid.count !== expected) throw new Error(`expected ${expected} locked job(s) for ${p.paymentRef}, found ${paid.count}`);
    await tx.guidePaymentDocument.update({
      where: { paymentRef: p.paymentRef },
      data: {
        status: "POSTED", error: null,
        peakDocumentNo: p.documentNo, peakDocumentId: p.documentId, peakDocumentLink: p.documentLink,
        ...(p.slipLink ? { slipUrl: p.slipLink } : {}),
        ...(p.resolvedBy !== undefined ? { resolvedById: p.resolvedBy, resolvedAt: now } : {}),
      },
    });
  });
  await audit({ ...p.actor, action: "pay.peak_document_posted", entityType: "GuidePaymentDocument", detail: { paymentRef: p.paymentRef, documentNo: p.documentNo, documentId: p.documentId } });
}

/**
 * Let the jobs go. FAILED: PEAK holds nothing. VOIDED: an operator voided the document
 * in PEAK, so the jobs are unpaid again and every trace of that document is cleared.
 * The lock is cleared whatever the row's status — a stale ref would otherwise block
 * the job forever.
 */
async function releaseDocument(paymentRef: string, status: "FAILED" | "VOIDED", reason: string | null, resolvedBy: string | null) {
  const now = new Date();
  await prisma.$transaction([
    prisma.guidePaymentDocument.update({
      where: { paymentRef },
      data: { status, error: reason, ...(resolvedBy !== null ? { resolvedById: resolvedBy, resolvedAt: now } : {}) },
    }),
    status === "VOIDED"
      ? prisma.tourPayment.updateMany({
          where: { peakPaymentRef: paymentRef },
          data: { status: "PENDING", paidAt: null, approvedBy: null, peakRef: null, peakDocumentId: null, peakPaymentRef: null, eslipUrl: null },
        })
      : prisma.tourPayment.updateMany({ where: { peakPaymentRef: paymentRef }, data: { peakPaymentRef: null } }),
  ]);
}

// A POSTING document younger than this may still be in flight — its request can be
// waiting on PEAK (30 s write timeout) or on Drive. Resolving it by hand then would
// race the original request.
const IN_FLIGHT_MS = 5 * 60_000;

export type Resolution =
  | { resolution: "found"; documentNo: string }
  | { resolution: "not-found" }
  | { resolution: "voided" };

/**
 * A person settles what the system could not: whether PEAK has the document.
 *  found     — it exists in PEAK: record it and mark the jobs paid
 *  not-found — it does not: release the jobs so they can be paid again
 *  voided    — a posted document was voided in PEAK: the jobs are unpaid again
 */
export async function resolvePaymentDocument(
  paymentRef: string,
  r: Resolution,
  actor: Actor,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef } });
  if (!doc) return { ok: false, status: 404, error: "No such payment" };

  const open = doc.status === "UNCERTAIN" || doc.status === "POSTING";
  if (doc.status === "POSTING" && Date.now() - doc.createdAt.getTime() < IN_FLIGHT_MS) {
    return { ok: false, status: 409, error: "This payment may still be in progress — wait a few minutes, then check again" };
  }

  if (r.resolution === "found") {
    if (!open) return { ok: false, status: 409, error: `This payment is ${doc.status.toLowerCase()}, not waiting on PEAK` };
    const documentNo = r.documentNo.trim();
    if (!documentNo) return { ok: false, status: 400, error: "Enter the PEAK document number" };
    try {
      await markDocumentPaid({ paymentRef, documentNo, documentId: null, documentLink: null, slipLink: doc.slipUrl, paymentDate: doc.paymentDate, actor, resolvedBy: actor.actorId });
    } catch (e) {
      return { ok: false, status: 409, error: errText(e) };
    }
    await audit({ ...actor, action: "pay.peak_document_resolved_found", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo } });
    return { ok: true };
  }

  if (r.resolution === "not-found") {
    if (!open) return { ok: false, status: 409, error: `This payment is ${doc.status.toLowerCase()}, not waiting on PEAK` };
    await releaseDocument(paymentRef, "FAILED", "Not found in PEAK (confirmed by an operator)", actor.actorId);
    await audit({ ...actor, action: "pay.peak_document_resolved_not_found", entityType: "GuidePaymentDocument", detail: { paymentRef } });
    return { ok: true };
  }

  if (doc.status !== "POSTED") return { ok: false, status: 409, error: "Only a posted payment can be marked voided" };
  await releaseDocument(paymentRef, "VOIDED", `Voided in PEAK (${doc.peakDocumentNo ?? "no number"}), confirmed by an operator`, actor.actorId);
  await audit({ ...actor, action: "pay.peak_document_voided", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo: doc.peakDocumentNo } });
  return { ok: true };
}
