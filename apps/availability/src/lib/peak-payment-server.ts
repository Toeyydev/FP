// Server half of "Pay N jobs together": reads the jobs, enforces every guard that needs
// the database, and supplies the side effects lib/peak-payment-document orders — for
// stage 1 (create the PEAK expense document) and stage 2 (record its payment).
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { downloadDriveFile, saveBufferToDrive } from "@/lib/google-drive";
import { DEFAULT_GUIDE_FEE, guideFeeOrStandard, isApproved, thb, type Expense, type GuideFee } from "@/lib/jobsheet";
import { currentJobFigures, documentChangeReasons, documentDrift, type Figures } from "@/lib/payment-document-drift";
import { guideFeeAccount, peakAccountMap, reviewRewardAccount } from "@/lib/peak-account-map";
import { createExpenseAllInOne, getExpense, getPaymentMethods, insertExpenseFile, payExistingExpense } from "@/lib/peak-api";
import { coveredByPayrollRun } from "@/lib/payment-coverage";
import { combinedPaymentBlock, paidJobPeakBlock, paidTransferOf, sheetInPeak, type CombinedBlock } from "@/lib/combined-payment";
import { paidAtFor } from "@/lib/payments-v2/rules";
import { recordPaymentInTx } from "@/lib/payments-v2/service";
import {
  bankAccountKey, bankNote, canTransfer, displayBankRef, normalizeBankRef, paymentPayloadHash,
  slipExtension, slipFileName, transferFigures, transferStage, STAGE_LABEL, VERIFICATION_SOURCE,
  type TransferStage,
} from "@/lib/payment-transfer";
import { guidePayoutTotal } from "@/lib/peak-sync";
import { sendPaymentNotice } from "@/lib/jobsheet-send";
import {
  attachmentFileType, documentStatus, paymentDocumentLock, paymentRefFor, peakPaymentPlan,
  type CreateDocumentDeps, type GuidePaymentDocument, type PayDocumentDeps, type PaymentAccounts, type PaymentJob, type PaymentLineTrace,
} from "@/lib/peak-payment-document";

export type JobKey = { date: string; slotIdx: number };
type Actor = { actorId: string | null; actorRole: string | null };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const round2 = (n: number) => Math.round(n * 100) / 100;
const compact = (d: string) => d.replace(/-/g, "");
/** Today's date in Bangkok, "YYYY-MM-DD". */
export const bangkokToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** The combined documents behind a set of payment refs, for lock messages. */
async function documentsByRef(refs: (string | null | undefined)[]) {
  const wanted = [...new Set(refs.filter((r): r is string => !!r))];
  if (!wanted.length) return new Map<string, { status: string; peakDocumentNo: string | null }>();
  const docs = await prisma.guidePaymentDocument.findMany({ where: { paymentRef: { in: wanted } }, select: { paymentRef: true, status: true, peakDocumentNo: true } });
  return new Map(docs.map((d) => [d.paymentRef, { status: d.status, peakDocumentNo: d.peakDocumentNo }]));
}

// The same fallback the Payments page uses: an auto-created sheet can store guideFee as
// {}, which must read as the standard fee — or the document and the page would disagree
// about what the guide is owed.
const guideFeeOf = (gf: unknown): GuideFee => guideFeeOrStandard(gf);

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
  /** Jobs already paid, going into a PEAK document afterwards: the day their one transfer
   *  was made and its slip (lib/combined-payment paidTransferOf). Null otherwise. */
  alreadyPaid: boolean;
  paidDate: string | null;
  slipLink: string | null;
};

/**
 * Everything the builder needs, or every database-side reason these jobs cannot be paid
 * together. Pure-data refusals (accounts, categories, dates) come from the builder.
 */
export async function loadPaymentContext(
  guideId: string,
  keys: JobKey[],
  opts: { alreadyPaid?: boolean } = {},
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
      select: { date: true, slotIdx: true, status: true, eslipUrl: true, slips: true, peakPaymentRef: true, peakRef: true, paidAt: true },
    }),
    prisma.payrollStatus.findMany({ where: { guideId, period: { in: periods } }, select: { period: true, status: true, paidAt: true } }),
    peakAccountMap(),
    guideFeeAccount(),
    reviewRewardAccount(),
  ]);
  const docs = await documentsByRef(pays.map((p) => p.peakPaymentRef));

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
    // and this refusal can never disagree about which jobs may go together. Jobs whose
    // money already moved are checked the other way round (paidJobPeakBlock).
    const block = (opts.alreadyPaid ? paidJobPeakBlock : combinedPaymentBlock)({
      sheet: sheet ?? null,
      payment: pay ? { ...pay, document: pay.peakPaymentRef ? docs.get(pay.peakPaymentRef) ?? null : null } : null,
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

  // Already paid: one transfer is one document, and the payment recorded against it
  // later carries that transfer's own date and slip — so they must be one transfer.
  let transfer: { paidDate: string | null; slipLink: string | null } = { paidDate: null, slipLink: null };
  if (opts.alreadyPaid) {
    // Unpaid jobs were refused above; only the paid ones say which transfer it was.
    const paid = keys.flatMap((k) => {
      const pay = at(pays, k) as (typeof pays)[number] | undefined;
      return pay?.status === "PAID" ? [{ ref: (at(sheets, k) as (typeof sheets)[number] | undefined)?.ref || `${k.date} slot ${k.slotIdx}`, paidAt: pay.paidAt, eslipUrl: pay.eslipUrl, slips: pay.slips }] : [];
    });
    const t = paidTransferOf(paid);
    reasons.push(...t.reasons);
    const latest = [...keys.map((k) => k.date)].sort().pop() ?? "";
    if (t.paidDate && latest && t.paidDate < latest) reasons.push(`These jobs are recorded as paid on ${t.paidDate}, before the tour on ${latest} — correct the payment first`);
    transfer = t;
  }

  const ctx: PaymentContext = {
    guideId,
    guideName: user?.fullName || user?.displayName || guideId,
    peakContactId: user?.peakContactId ?? null,
    jobs,
    awaitingApproval,
    accounts: { guideFee: feeAccount, reviewReward: rewardAccount, categories },
    alreadyPaid: !!opts.alreadyPaid,
    paidDate: transfer.paidDate,
    slipLink: transfer.slipLink,
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

export type PendingJob = { date: string; slotIdx: number; ref: string | null; tourId: string; payout: number; block: CombinedBlock | null };

/**
 * The guide's unpaid jobs in the month of `date` (tours that already ran), with what
 * each would pay and why it cannot go into a combined PEAK document yet, if it cannot.
 * What the job sheet offers under "Put these jobs in one PEAK document": one month,
 * because a document books into one period (lib/peak-payment-document). Paid, payroll,
 * slipped, locked, historical and already-in-PEAK jobs are left out entirely; a job
 * only waiting for approval or for its sheet is listed as not ready.
 */
export async function pendingJobsInMonth(guideId: string, date: string, today: string): Promise<PendingJob[]> {
  const period = date.slice(0, 7);
  const monthEnd = `${period}-31`;
  const where = { guideId, date: { gte: `${period}-01`, lte: today < monthEnd ? today : monthEnd } };
  const [assigns, sheets, pays, payroll] = await Promise.all([
    prisma.assignment.findMany({ where, select: { date: true, slotIdx: true, createdAt: true, tourId: true } }),
    prisma.jobSheet.findMany({ where, select: { date: true, slotIdx: true, ref: true, tourId: true, createdAt: true, origin: true, peakDocumentNo: true, peakDocumentId: true, approvalStatus: true, expenses: true, guideFee: true } }),
    prisma.tourPayment.findMany({ where, select: { date: true, slotIdx: true, status: true, peakPaymentRef: true, peakRef: true, eslipUrl: true, slips: true } }),
    prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId, period } }, select: { status: true, paidAt: true } }),
  ]);
  const docs = await documentsByRef(pays.map((p) => p.peakPaymentRef));
  const keyOf = (x: JobKey) => `${x.date}|${x.slotIdx}`;
  const keys = new Map<string, JobKey>();
  for (const x of [...assigns, ...sheets]) keys.set(keyOf(x), { date: x.date, slotIdx: x.slotIdx });
  const out: PendingJob[] = [];
  for (const k of [...keys.values()].sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx)) {
    const sheet = sheets.find((s) => keyOf(s) === keyOf(k));
    const assignment = assigns.find((a) => keyOf(a) === keyOf(k));
    const pay = pays.find((p) => keyOf(p) === keyOf(k));
    const created = assignment?.createdAt ?? sheet?.createdAt;
    const block = combinedPaymentBlock({
      sheet: sheet ?? null,
      payment: pay ? { ...pay, document: pay.peakPaymentRef ? docs.get(pay.peakPaymentRef) ?? null : null } : null,
      coveredByPayroll: !!created && coveredByPayrollRun(payroll, k.date, created),
      period,
    });
    if (block && block.code !== "not-approved" && block.code !== "no-job-sheet") continue;
    const payout = sheet ? round2(guidePayoutTotal((sheet.expenses as unknown as Expense[]) ?? [], guideFeeOf(sheet.guideFee)).payout) : round2(guidePayoutTotal([], DEFAULT_GUIDE_FEE).payout);
    out.push({ ...k, ref: sheet?.ref ?? null, tourId: sheet?.tourId ?? assignment?.tourId ?? "", payout, block });
  }
  return out;
}

/** The next FOLK-PAY-YYYYMM-NN for the month of `date` — stage 1 numbers by the day
 *  the document is created, since no payment date exists yet. */
export async function nextPaymentRef(date: string): Promise<string> {
  const prefix = paymentRefFor(date, 0).slice(0, -2); // "FOLK-PAY-202609-"
  const used = await prisma.guidePaymentDocument.count({ where: { paymentRef: { startsWith: prefix } } });
  return paymentRefFor(date, used + 1);
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
    select: { date: true, slotIdx: true, peakPaymentRef: true, peakRef: true, status: true },
  });
  const docs = await documentsByRef(rows.map((r) => r.peakPaymentRef));
  return rows.map((r) => `${r.date} slot ${r.slotIdx}: ${paymentDocumentLock(r, docs.get(r.peakPaymentRef ?? ""))}`);
}

/** The same, for a guide's whole month. `unresolvedOnly` skips documents PEAK already
 *  confirmed — those jobs are PAID, and re-stating that they are paid changes nothing. */
export async function paymentDocumentLocksInMonth(guideId: string, period: string, opts: { unresolvedOnly?: boolean } = {}): Promise<string[]> {
  const rows = await prisma.tourPayment.findMany({
    where: {
      guideId, date: { gte: `${period}-01`, lte: `${period}-31` }, peakPaymentRef: { not: null },
      ...(opts.unresolvedOnly ? { status: { not: "PAID" } } : {}),
    },
    select: { date: true, slotIdx: true, peakPaymentRef: true, peakRef: true, status: true },
  });
  const docs = await documentsByRef(rows.map((r) => r.peakPaymentRef));
  return rows.map((r) => `${r.date} slot ${r.slotIdx}: ${paymentDocumentLock(r, docs.get(r.peakPaymentRef ?? ""))}`);
}

const key = (guideId: string, j: JobKey) => ({ guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } });

// ── Stage 1: create the PEAK expense document ────────────────────────────────

export function prismaCreateDeps(opts: { guideId: string; actor: Actor; alreadyPaid?: boolean }): CreateDocumentDeps {
  const { guideId, actor } = opts;
  const alreadyPaid = !!opts.alreadyPaid;
  return {
    async claim(doc: GuidePaymentDocument) {
      try {
        await prisma.$transaction(async (tx) => {
          // Re-read inside the transaction: a sheet synced to PEAK on its own, or one
          // whose approval was withdrawn, since the jobs were loaded must not go into this
          // document. Checked for every job before anything is written, so one refusal
          // refuses the whole document.
          for (const j of doc.jobs) {
            const sheetNow = await tx.jobSheet.findUnique({ where: key(guideId, j), select: { peakDocumentNo: true, peakDocumentId: true, approvalStatus: true } });
            if (sheetInPeak(sheetNow)) {
              throw new PaymentClaimRefused(`${j.ref} was just posted to PEAK from its job sheet${sheetNow?.peakDocumentNo ? ` (${sheetNow.peakDocumentNo})` : ""} — leave it out of this payment`);
            }
            if (!isApproved(sheetNow?.approvalStatus)) {
              throw new PaymentClaimRefused(`${j.ref} is no longer approved — approve the job sheet again before paying it`);
            }
          }
          await tx.guidePaymentDocument.create({
            data: {
              paymentRef: doc.paymentRef, guideId,
              jobs: doc.jobs as unknown as Prisma.InputJsonValue,
              lines: doc.traces as unknown as Prisma.InputJsonValue,
              total: doc.total, status: "CREATING", createdById: actor.actorId, alreadyPaid,
              // The fingerprint of what PEAK is about to be sent, written before the call:
              // a document whose answer is lost still knows what it asked for.
              peakPayloadHash: paymentPayloadHash(doc.expense),
            },
          });
          for (const j of doc.jobs) {
            if (!alreadyPaid) {
              const a = await tx.assignment.findUnique({ where: key(guideId, j), select: { tourId: true } });
              const s = a ? null : await tx.jobSheet.findUnique({ where: key(guideId, j), select: { tourId: true } });
              await tx.tourPayment.upsert({
                where: key(guideId, j),
                create: { guideId, date: j.date, slotIdx: j.slotIdx, tourId: a?.tourId ?? s?.tourId ?? "", status: "PENDING" },
                update: {},
              });
            }
            // The lock itself. Conditional, so two requests racing for the same job
            // cannot both win: the second waits on the row, then matches nothing. An
            // already-paid job must still be paid, with no EXP number typed meanwhile.
            const locked = await tx.tourPayment.updateMany({
              where: alreadyPaid
                ? { guideId, date: j.date, slotIdx: j.slotIdx, peakPaymentRef: null, status: "PAID", OR: [{ peakRef: null }, { peakRef: "" }] }
                : { guideId, date: j.date, slotIdx: j.slotIdx, peakPaymentRef: null, status: { not: "PAID" }, eslipUrl: null },
              data: { peakPaymentRef: doc.paymentRef },
            });
            if (locked.count !== 1) {
              throw new PaymentClaimRefused(alreadyPaid
                ? `${j.ref} was just given a PEAK document number, marked unpaid, or put into another PEAK payment — reload and try again`
                : `${j.ref} was just paid, given a slip, or put into another PEAK payment — reload and try again`);
            }
          }
        }, { timeout: 20_000 });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new PaymentRefTaken(doc.paymentRef);
        throw e;
      }
      await audit({ ...actor, action: "pay.peak_document_claimed", entityType: "GuidePaymentDocument", detail: { paymentRef: doc.paymentRef, guideId, jobs: doc.jobs, total: doc.total, gross: doc.gross, wht: doc.wht, lines: doc.lines.length, alreadyPaid } });
    },

    // An UNPAID expense: the document the builder makes carries no paidPayments.
    createExpense: (expense) => createExpenseAllInOne(expense),

    async recordCreated(p) {
      const moved = await prisma.guidePaymentDocument.updateMany({
        where: { paymentRef: p.paymentRef, status: { in: ["CREATING", "CREATE_UNCERTAIN"] } },
        data: {
          status: "AWAITING_PAYMENT", error: null, peakDocumentNo: p.documentNo, peakDocumentId: p.documentId, peakDocumentLink: p.documentLink,
          // When PEAK accepted the document, not when the row was made: the two differ by
          // however long PEAK took, and a retried create by much more.
          peakPostedAt: new Date(), peakDocumentStatus: "OPEN",
        },
      });
      if (moved.count !== 1) throw new Error(`${p.paymentRef} is no longer waiting for its PEAK document`);
      await audit({ ...actor, action: "pay.peak_document_created", entityType: "GuidePaymentDocument", detail: { paymentRef: p.paymentRef, guideId, documentNo: p.documentNo, documentId: p.documentId } });
    },

    async recordCreateFailed({ paymentRef, reason, uncertain }) {
      if (uncertain) {
        await prisma.guidePaymentDocument.update({ where: { paymentRef }, data: { status: "CREATE_UNCERTAIN", error: reason } });
        await audit({ ...actor, action: "pay.peak_document_create_uncertain", entityType: "GuidePaymentDocument", detail: { paymentRef, guideId, reason } });
        return;
      }
      await releaseDocument(paymentRef, "FAILED", reason, null);
      await audit({ ...actor, action: "pay.peak_document_create_failed", entityType: "GuidePaymentDocument", detail: { paymentRef, guideId, reason } });
    },
  };
}

// ── Stage 2: record the payment against that same document ───────────────────

type DocRow = {
  paymentRef: string; guideId: string; status: string; total: number; jobs: unknown; lines: unknown;
  peakDocumentNo: string | null; peakDocumentId: string | null; peakDocumentLink: string | null;
  paymentDate: string | null; slipUrl: string | null;
  /** Jobs paid before the document existed (see schema): recording the payment only adds the EXP. */
  alreadyPaid?: boolean;
};
type DocJob = { date: string; slotIdx: number; ref: string; payout: number };
export const documentJobs = (doc: { jobs: unknown }): DocJob[] => (Array.isArray(doc.jobs) ? (doc.jobs as DocJob[]) : []);
/** Gross and withholding exactly as the document was created, from its stored line trace. */
export const documentFigures = (doc: { lines: unknown; total: number }) => {
  const traces = (Array.isArray(doc.lines) ? doc.lines : []) as PaymentLineTrace[];
  const gross = round2(traces.reduce((s, t) => s + (Number(t.price) || 0), 0));
  const wht = round2(traces.reduce((s, t) => s + (Number(t.wht) || 0), 0));
  return { gross, wht, net: round2(doc.total), lines: traces.length };
};

/**
 * Every reason the jobs in this document may not be paid now. The document was made
 * for exact figures; if any job changed since — its payout, its approval, its lock —
 * paying the EXP would settle a document that no longer matches the jobs. Stop instead:
 * nothing here ever makes another EXP.
 */
async function paymentBlockers(tx: Prisma.TransactionClient | typeof prisma, doc: DocRow): Promise<string[]> {
  const reasons: string[] = [];
  const docNo = doc.peakDocumentNo ?? doc.paymentRef;
  const jobs = documentJobs(doc);
  const current = new Map<string, Figures>();
  const held = await tx.tourPayment.findMany({ where: { peakPaymentRef: doc.paymentRef }, select: { guideId: true, date: true, slotIdx: true, status: true } });
  if (held.length !== jobs.length) reasons.push(`${doc.paymentRef} holds ${held.length} of its ${jobs.length} jobs — a job was released or changed since ${docNo} was created`);
  for (const j of jobs) {
    const tp = held.find((h) => h.date === j.date && h.slotIdx === j.slotIdx && h.guideId === doc.guideId);
    if (!tp) reasons.push(`${j.ref} is no longer part of ${doc.paymentRef}`);
    else if (doc.alreadyPaid ? tp.status !== "PAID" : tp.status === "PAID") reasons.push(doc.alreadyPaid ? `${j.ref} is no longer marked paid` : `${j.ref} is already marked paid`);
    const sheet = await tx.jobSheet.findUnique({ where: key(doc.guideId, j), select: { approvalStatus: true, peakDocumentNo: true, peakDocumentId: true, expenses: true, guideFee: true } });
    if (!sheet) continue; // reported below, with the figures the document was created for
    if (!isApproved(sheet.approvalStatus)) reasons.push(`${j.ref} is no longer approved`);
    if (sheetInPeak(sheet)) reasons.push(`${j.ref} was posted to PEAK from its own job sheet${sheet.peakDocumentNo ? ` (${sheet.peakDocumentNo})` : ""}`);
    current.set(`${j.date}|${j.slotIdx}`, currentJobFigures((sheet.expenses as unknown as Expense[]) ?? [], guideFeeOf(sheet.guideFee)));
  }
  // Every job's gross, WHT and payout against what the document was created with
  // (lib/payment-document-drift) — a fee set to ฿0 after the EXP was made changes gross and
  // WHT, not only the payout, and PEAK would be paid for figures no job sheet holds.
  const drift = documentDrift({ document: doc, currentOf: (j) => current.get(`${j.date}|${j.slotIdx}`) ?? null, leftOut: [] });
  reasons.push(...documentChangeReasons(drift, docNo));
  if (reasons.length) reasons.push(`Nothing was paid. Put the job back as it was, or void ${docNo} in PEAK and record that here, then create a new document`);
  return reasons;
}

/**
 * What has moved under the document since it was created, in the words an operator
 * reads. Read-only, and the same comparison stage 2 refuses on.
 */
export async function documentDriftReasons(doc: DocRow): Promise<string[]> {
  const jobs = documentJobs(doc);
  const current = new Map<string, Figures>();
  for (const j of jobs) {
    const sheet = await prisma.jobSheet.findUnique({ where: key(doc.guideId, j), select: { expenses: true, guideFee: true } });
    if (sheet) current.set(`${j.date}|${j.slotIdx}`, currentJobFigures((sheet.expenses as unknown as Expense[]) ?? [], guideFeeOf(sheet.guideFee)));
  }
  const drift = documentDrift({ document: doc, currentOf: (j) => current.get(`${j.date}|${j.slotIdx}`) ?? null, leftOut: [] });
  return documentChangeReasons(drift, doc.peakDocumentNo ?? doc.paymentRef);
}

/**
 * Where one payment stands, checked now rather than remembered.
 *
 * Read-only: it reads the document, recomputes every job's figures from the job sheets
 * as they are at this moment, and asks PEAK what it still holds. Nothing is written and
 * no PEAK document is created — reads cost nothing.
 *
 * This is what turns "PEAK created" into "Ready to transfer". Until a check has passed,
 * the screen does not offer a bank note or an amount, because a document can be voided
 * in PEAK, or a job sheet edited, between the page loading and someone opening their
 * banking app.
 */
export async function transferReadiness(paymentRef: string): Promise<{
  stage: TransferStage;
  label: string;
  canTransfer: boolean;
  reasons: string[];
  documentNo: string | null;
  documentLink: string | null;
  bankNote: string | null;
  figures: ReturnType<typeof transferFigures>;
  payloadHash: string | null;
  peakStatus: string | null;
  bankRef: string | null;
} | null> {
  const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef } });
  if (!doc) return null;

  const figures = transferFigures(doc);
  const reasons: string[] = [];
  let peakOpen: boolean | undefined;
  let peakStatus: string | null = doc.peakDocumentStatus ?? null;

  // Only a document waiting to be paid is worth checking; a paid or voided one is settled.
  if (doc.status === "AWAITING_PAYMENT" && doc.peakDocumentNo) {
    const blockers = await paymentBlockers(prisma, doc);
    reasons.push(...blockers);
    const r = await getExpense({ id: doc.peakDocumentId, code: doc.peakDocumentNo });
    if (!r.ok) reasons.push(`Could not read ${doc.peakDocumentNo} from PEAK: ${r.desc ?? "no answer"}`);
    else if (r.notFound || !r.expense) {
      peakOpen = false;
      peakStatus = "NOT_FOUND";
      reasons.push(`${doc.peakDocumentNo} is not in PEAK — it was deleted or never created. Create the document again before transferring.`);
    } else {
      const plan = peakPaymentPlan({
        expense: r.expense, documentNo: doc.peakDocumentNo, documentId: doc.peakDocumentId,
        paymentRef, peakContactId: r.expense.contactId, gross: figures.gross, wht: figures.wht, net: figures.net,
      });
      peakStatus = r.expense.isVoid ? "VOID" : r.expense.status ?? null;
      peakOpen = !r.expense.isVoid && plan.ok;
      if (!plan.ok) reasons.push(...plan.reasons);
    }
  }

  // Drift outranks a clean PEAK read: the document can be perfectly good in PEAK and no
  // longer match the jobs it was made for. Asked as its own question rather than read
  // back out of the sentences above.
  const drift = doc.status === "AWAITING_PAYMENT" ? (await documentDriftReasons(doc)).length > 0 : false;
  const stage = transferStage(doc, { drift, peakOpen });
  return {
    stage,
    label: STAGE_LABEL[stage],
    canTransfer: canTransfer(stage) && reasons.length === 0,
    reasons,
    documentNo: doc.peakDocumentNo,
    documentLink: doc.peakDocumentLink,
    bankNote: canTransfer(stage) && reasons.length === 0 ? bankNote(doc.peakDocumentNo, paymentRef) : null,
    figures,
    payloadHash: doc.peakPayloadHash,
    peakStatus,
    bankRef: doc.bankRef,
  };
}

/**
 * Which bank account a PEAK payment method draws on, asked of PEAK rather than taken
 * from the browser. Reads are free and create nothing.
 *
 * Fails closed: if PEAK cannot be reached, or does not know the method the operator
 * chose, no payment is recorded. The alternative — trusting an account key sent by the
 * page — would let the same transfer be recorded twice by sending a different one.
 */
export async function resolveBankAccount(paymentMethodId: string): Promise<{ ok: true; key: string; name: string | null } | { ok: false; reasons: string[] }> {
  const r = await getPaymentMethods();
  if (!r.ok) return { ok: false, reasons: [`Could not read the payment accounts from PEAK: ${r.desc ?? "no answer"} — nothing was paid`] };
  const method = (r.methods ?? []).find((m) => m.id === paymentMethodId);
  if (!method) return { ok: false, reasons: ["PEAK does not have the account this payment says it left from — reload Payments and choose it again"] };
  const key = bankAccountKey(method);
  if (!key) return { ok: false, reasons: ["That PEAK payment account has no identity FolkOPS can record a transfer against"] };
  return { ok: true, key, name: [method.bankName, method.accountNumber].filter(Boolean).join(" ") || method.name || null };
}

/** One sentence, whichever way the duplicate was caught. */
const bankRefTaken = (bankRef: string, other: { paymentRef: string; peakDocumentNo: string | null } | null) =>
  `Bank reference ${bankRef} is already recorded on ${other ? `${other.paymentRef}${other.peakDocumentNo ? ` (${other.peakDocumentNo})` : ""}` : "another payment"} — one transfer settles one document. Nothing was paid.`;

export function prismaPayDeps(opts: {
  document: DocRow;
  /** Kept for callers; the slip is named from the document itself now, not the person. */
  guideName?: string;
  peakContactId: string | null;
  /** The slip uploaded now. Optional only for an already-paid document, which uses the
   *  slip saved when its jobs were paid (`savedSlip`), if there is one. */
  file: { base64: string; mime: string } | null;
  savedSlip?: string | null;
  /** Folkpaths Drive — needed to save `file` or read `savedSlip` back. */
  refreshToken: string | null;
  /** The bank's own reference for the transfer, and the amount printed on the slip. */
  bankRef: string;
  slipAmount: number | null;
  /** The operator states they checked both against the slip. There is no OCR. */
  verified: boolean;
  /** The bank account the money left from, resolved from PEAK (never from the page). */
  bankAccountKey: string | null;
  /** The uploaded file's own name, so the slip keeps the extension it really has. */
  fileName?: string | null;
  actor: Actor;
}): PayDocumentDeps {
  const { document: doc, peakContactId, file, refreshToken, actor } = opts;
  // Stored trimmed and upper-cased so the screen and the slip read alike; compared in the
  // stricter form, where spacing does not make two transfers out of one.
  const bankRef = displayBankRef(opts.bankRef);
  const bankRefNormalized = normalizeBankRef(bankRef) || null;
  const savedSlip = (opts.savedSlip ?? "").trim() || null;
  const ext = slipExtension(opts.fileName, file?.mime ?? null);
  const docNo = doc.peakDocumentNo ?? "";
  const jobs = documentJobs(doc);

  return {
    async claimPayment(p) {
      // Said plainly before the write: which payment this reference already settles. The
      // unique index below still decides — two operators pressing at the same moment both
      // pass this check — but nobody should have to read a constraint violation to learn
      // something the database could have been asked.
      if (bankRefNormalized) {
        const holders = await prisma.guidePaymentDocument.findMany({
          where: { bankRefNormalized, bankAccountKey: opts.bankAccountKey },
          select: { paymentRef: true, peakDocumentNo: true },
        });
        const held = holders.find((h) => h.paymentRef !== p.paymentRef);
        if (held) throw new PaymentClaimRefused(bankRefTaken(bankRef, held));
      }
      try {
        await prisma.$transaction(async (tx) => {
          const blockers = await paymentBlockers(tx, doc);
          if (blockers.length) throw new PaymentClaimRefused(blockers.join("\n"));
          const moved = await tx.guidePaymentDocument.updateMany({
            where: { paymentRef: p.paymentRef, status: "AWAITING_PAYMENT", peakDocumentNo: docNo },
            data: {
              status: "PAYING", error: null, paymentDate: p.paymentDate, paymentMethodId: p.paymentMethodId, paymentMethodName: p.paymentMethodName,
              // The transfer's evidence is written HERE, before PEAK is touched: a bank
              // reference already used by another document has to lose now, not after the
              // money has been recorded. Two operators pressing at the same moment is the
              // race an application check cannot win, so the unique index decides.
              ...(doc.alreadyPaid ? {} : {
                bankRef: bankRef || null, bankRefNormalized,
                // Always written together: a reference means nothing without the account.
                bankAccountKey: bankRefNormalized ? opts.bankAccountKey : null,
                slipAmount: opts.slipAmount,
                slipVerifiedById: opts.verified ? actor.actorId : null,
                slipVerifiedAt: opts.verified ? new Date() : null,
                verificationSource: opts.verified ? VERIFICATION_SOURCE : null,
              }),
            },
          });
          // A second press, or another operator paying the same document, matches nothing.
          if (moved.count !== 1) throw new PaymentClaimRefused(`${p.paymentRef} is no longer awaiting payment — reload Payments`);
        }, { timeout: 20_000 });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          // The race: the other request won between the check above and this write.
          const other = bankRefNormalized
            ? await prisma.guidePaymentDocument.findFirst({
                where: { bankRefNormalized, bankAccountKey: opts.bankAccountKey, NOT: { paymentRef: p.paymentRef } },
                select: { paymentRef: true, peakDocumentNo: true },
              })
            : null;
          throw new PaymentClaimRefused(bankRefTaken(bankRef, other));
        }
        throw e;
      }
      await audit({
        ...actor, action: "pay.peak_payment_claimed", entityType: "GuidePaymentDocument",
        detail: {
          paymentRef: p.paymentRef, documentNo: docNo, paymentDate: p.paymentDate, paymentMethodName: p.paymentMethodName, amount: doc.total,
          oldStatus: "AWAITING_PAYMENT", newStatus: "PAYING",
          // The evidence, as recorded — the normalised reference, never the file itself.
          bankRef: bankRefNormalized, slipAmount: opts.slipAmount,
          verificationSource: opts.verified ? VERIFICATION_SOURCE : null,
        },
      });
    },

    async checkExpense() {
      const r = await getExpense({ id: doc.peakDocumentId, code: docNo });
      if (!r.ok) return { ok: false, reasons: [`Could not read ${docNo} from PEAK: ${r.desc ?? "no answer"} — nothing was paid`] };
      if (r.notFound || !r.expense) return { ok: false, reasons: [`${docNo} was not found in PEAK — nothing was paid`] };
      const f = documentFigures(doc);
      return peakPaymentPlan({ expense: r.expense, documentNo: docNo, documentId: doc.peakDocumentId, paymentRef: doc.paymentRef, peakContactId, gross: f.gross, wht: f.wht, net: f.net });
    },

    async uploadSlip() {
      if (!file) {
        if (!doc.alreadyPaid) throw new Error("no slip was uploaded");
        // The transfer was made and its slip saved long ago: keep that one.
        if (savedSlip) await prisma.guidePaymentDocument.update({ where: { paymentRef: doc.paymentRef }, data: { slipUrl: savedSlip } });
        return { link: savedSlip ?? "" };
      }
      if (!refreshToken) throw new Error("Google Drive is not connected");
      const earliest = [...jobs.map((j) => j.date)].sort()[0] ?? bangkokToday();
      const monthFolder = `${earliest.slice(0, 7)} ${MONTHS[Number(earliest.slice(5, 7)) - 1] ?? ""}`.trim();
      // <EXP>_<FOLK-PAY>_<GUIDE_ID>_<NET>_<BANK_REF>.<ext> — the document it settles, the
      // payment it belongs to, whose it is, what left the bank and the bank's own
      // reference, so a slip found on its own can be placed without opening it.
      const name = slipFileName({ documentNo: docNo, paymentRef: doc.paymentRef, guideId: doc.guideId, net: Number(doc.total) || 0, bankRef, ext });
      const { link } = await saveBufferToDrive({ refreshToken, name, base64: file.base64, mimeType: file.mime, folderPath: ["Folkpaths E-slips", monthFolder] });
      // Stored now, so a payment that later needs resolving by hand still has its slip.
      // The bank reference and the amount were written with the claim, before PEAK.
      await prisma.guidePaymentDocument.update({
        where: { paymentRef: doc.paymentRef },
        data: { slipUrl: link, slipUploadedAt: new Date() },
      });
      return { link };
    },

    payExpense: (p) => payExistingExpense({ documentNo: p.documentNo, documentId: p.documentId, paymentDate: compact(p.paymentDate), paymentMethodId: p.paymentMethodId, amount: p.amount, withholdingTaxAmount: p.withholdingTaxAmount }),

    async recordPaid({ paymentRef, slipLink }) {
      const current = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef }, select: { paymentDate: true } });
      await markDocumentPaid({ paymentRef, documentNo: docNo, documentId: doc.peakDocumentId, slipLink: slipLink || null, bankRef: bankRefNormalized, slipAmount: opts.slipAmount, verified: opts.verified, paymentDate: current?.paymentDate ?? bangkokToday(), actor, alreadyPaid: !!doc.alreadyPaid });
    },

    async recordPaymentFailed({ paymentRef, reason, uncertain }) {
      if (uncertain) {
        await prisma.guidePaymentDocument.updateMany({ where: { paymentRef, status: "PAYING" }, data: { status: "PAYMENT_UNCERTAIN", error: reason } });
        await audit({ ...actor, action: "pay.peak_payment_uncertain", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo: docNo, reason } });
        return;
      }
      // Nothing was recorded in PEAK: the document is awaiting payment again, exactly as before.
      await prisma.guidePaymentDocument.updateMany({
        where: { paymentRef, status: "PAYING" },
        // Exactly as before, evidence included: nothing was recorded, so the bank
        // reference must not stay claimed against a document that settles nothing.
        data: {
          status: "AWAITING_PAYMENT", error: reason, paymentDate: null, paymentMethodId: null, paymentMethodName: null, slipUrl: null,
          bankRef: null, bankRefNormalized: null, bankAccountKey: null, slipAmount: null, slipUploadedAt: null,
          slipVerifiedById: null, slipVerifiedAt: null, verificationSource: null,
        },
      });
      await audit({ ...actor, action: "pay.peak_payment_failed", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo: docNo, reason } });
    },

    async attachSlip({ documentId, documentNo }) {
      let slip = file;
      if (!slip) {
        if (!savedSlip) return { ok: false, reason: "No slip on record in FolkOPS for this transfer — attach it in PEAK by hand" };
        const saved = refreshToken ? await downloadDriveFile(refreshToken, savedSlip).catch(() => null) : null;
        if (!saved) return { ok: false, reason: "Could not read the saved slip back from Drive — attach it in PEAK by hand" };
        slip = { base64: saved.base64, mime: saved.mime };
      }
      const r = await insertExpenseFile({
        transactionId: documentId, transactionCode: documentNo,
        fileName: `${documentNo}-slip.${extOf(slip.mime)}`, base64: slip.base64, fileType: attachmentFileType(slip.mime), mime: slip.mime,
      });
      return { ok: r.ok, reason: r.ok ? undefined : r.desc };
    },

    async recordAttachment({ paymentRef, ok, reason }) {
      await prisma.guidePaymentDocument.update({ where: { paymentRef }, data: { attachmentStatus: ok ? "ATTACHED" : "FAILED", attachmentError: ok ? null : reason } });
      if (!ok) await audit({ ...actor, action: "pay.peak_document_attach_failed", entityType: "GuidePaymentDocument", detail: { paymentRef, reason } });
    },

    async notifyGuide({ paymentRef, slipLink }) {
      // The guide was told when the money moved; putting it in PEAK afterwards is bookkeeping.
      if (doc.alreadyPaid) return;
      await sendPaymentNotice(doc.guideId, jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })), undefined, slipLink);
      await audit({ ...actor, action: "pay.peak_payment_notice_sent", entityType: "GuidePaymentDocument", detail: { paymentRef, guideId: doc.guideId, jobs: jobs.length } });
    },
  };
}

/** The selected payment date as an instant. Noon in Bangkok, so it reads as the same
 *  calendar date in any timezone an operator views it from. */
export { paidAtFor };

/** Every job locked to this document becomes PAID and points at the same PEAK document. */
async function markDocumentPaid(p: {
  paymentRef: string; documentNo: string; documentId: string | null; slipLink: string | null;
  /** The bank's reference for the transfer, normalised. payments-v2 refuses it twice. */
  bankRef?: string | null;
  slipAmount?: number | null;
  verified?: boolean;
  paymentDate: string; actor: Actor; resolvedBy?: string | null;
  /** The jobs were paid before the document existed: they only take its EXP; their paid
   *  date, slip and approver stay as recorded when the money moved. */
  alreadyPaid?: boolean;
}) {
  const now = new Date();
  // paidAt is the date the money moved — the one sent to PEAK — not the moment someone
  // pressed the button. A transfer recorded the next morning still happened yesterday.
  const paidAt = paidAtFor(p.paymentDate);
  const audits: Parameters<typeof audit>[0][] = [];
  await prisma.$transaction(async (tx) => {
    const doc = await tx.guidePaymentDocument.findUnique({ where: { paymentRef: p.paymentRef }, select: { jobs: true, guideId: true, total: true } });
    const expected = Array.isArray(doc?.jobs) ? doc!.jobs.length : -1;
    const moved = await tx.guidePaymentDocument.updateMany({
      where: { paymentRef: p.paymentRef, status: { in: ["PAYING", "PAYMENT_UNCERTAIN"] } },
      data: {
        status: "PAID", error: null, peakDocumentNo: p.documentNo, peakDocumentId: p.documentId,
        peakDocumentStatus: "PAID",
        ...(p.slipLink ? { slipUrl: p.slipLink } : {}),
        // The bank reference was written with the claim, before PEAK was touched, and
        // is not rewritten here — only an already-paid document, which never had one,
        // can still take it now.
        ...((p.bankRef ?? "").trim() && p.alreadyPaid ? { bankRef: p.bankRef!.trim(), bankRefNormalized: p.bankRef!.trim() } : {}),
        ...(p.resolvedBy !== undefined ? { resolvedById: p.resolvedBy, resolvedAt: now } : {}),
      },
    });
    if (moved.count !== 1) throw new Error(`${p.paymentRef} is not waiting on a payment`);
    if (p.alreadyPaid) {
      // The transfer happened before this document existed: the jobs only take its EXP.
      const paid = await tx.tourPayment.updateMany({
        where: { peakPaymentRef: p.paymentRef, status: "PAID" },
        data: { peakRef: p.documentNo, peakDocumentId: p.documentId },
      });
      if (paid.count !== expected) throw new Error(`expected ${expected} locked job(s) for ${p.paymentRef}, found ${paid.count}`);
      return;
    }
    // Payments v2: PEAK confirmed the payment, so the transfer is real — it becomes a
    // GuidePayment (FOLK-PMT-…), and THAT is what makes these jobs paid. One canonical
    // path, whether an operator records a transfer or a PEAK document is settled.
    const locked = await tx.tourPayment.findMany({ where: { peakPaymentRef: p.paymentRef }, select: { guideId: true, date: true, slotIdx: true } });
    if (locked.length !== expected) throw new Error(`expected ${expected} locked job(s) for ${p.paymentRef}, found ${locked.length}`);
    const sheets = await tx.jobSheet.findMany({ where: { OR: locked.map((l) => ({ guideId: l.guideId, date: l.date, slotIdx: l.slotIdx })) }, select: { date: true, slotIdx: true, ref: true } });
    const recorded = await recordPaymentInTx(tx, {
      guideId: doc!.guideId,
      jobs: locked.map((l) => ({ jobNo: sheets.find((x) => x.date === l.date && x.slotIdx === l.slotIdx)?.ref ?? "", date: l.date, slotIdx: l.slotIdx })),
      paymentDate: p.paymentDate, amountTransferred: Number(doc!.total), source: "PEAK_DOCUMENT", peakPaymentRef: p.paymentRef,
      bankRef: (p.bankRef ?? "").trim() || null,
      slip: p.slipLink ? { url: p.slipLink, uploadedById: p.actor.actorId } : null,
      noSlipReason: p.slipLink ? null : `Paid through PEAK document ${p.documentNo}, which holds the slip`,
      note: `Recorded with PEAK document ${p.documentNo}`, actor: p.actor,
    });
    if (!recorded.ok) throw new PaymentClaimRefused(`The payment of ${p.documentNo} could not be recorded: ${recorded.reasons.join(" · ")}`);
    audits.push(...recorded.audits);
    // The jobs are paid by the payment above; here they take the document's EXP.
    const stamped = await tx.tourPayment.updateMany({
      where: { peakPaymentRef: p.paymentRef },
      data: { peakRef: p.documentNo, peakDocumentId: p.documentId, ...(p.slipLink ? { eslipUrl: p.slipLink } : {}) },
    });
    if (stamped.count !== expected) throw new Error(`expected ${expected} locked job(s) for ${p.paymentRef}, found ${stamped.count}`);
  });
  for (const a of audits) await audit(a);
  await audit({
    ...p.actor, action: "pay.peak_payment_recorded", entityType: "GuidePaymentDocument",
    detail: {
      paymentRef: p.paymentRef, documentNo: p.documentNo, paymentDate: p.paymentDate, alreadyPaid: !!p.alreadyPaid,
      oldStatus: "PAYING", newStatus: "PAID",
      // The reference as it is compared, the amount the operator read, and who says so.
      // Never the slip itself: a file does not belong in an audit row.
      bankRef: (p.bankRef ?? "").trim() || null, slipAmount: p.slipAmount ?? null,
      verificationSource: p.verified ? VERIFICATION_SOURCE : null,
    },
  });
}

/**
 * Let the jobs go. FAILED: PEAK holds no document. VOIDED: an operator voided the
 * document in PEAK, so the jobs are unpaid again and every trace of that document is
 * cleared from them — the document row itself, with its EXP, stays as the record.
 * Jobs that were paid before the document existed stay paid: voiding the bookkeeping
 * does not undo the transfer, it only takes the EXP back off them.
 */
async function releaseDocument(paymentRef: string, status: "FAILED" | "VOIDED", reason: string | null, resolvedBy: string | null) {
  const now = new Date();
  await prisma.$transaction([
    prisma.guidePaymentDocument.update({
      where: { paymentRef },
      data: { status, error: reason, ...(resolvedBy !== null ? { resolvedById: resolvedBy, resolvedAt: now } : {}) },
    }),
    // VOIDED: a job whose money actually moved STAYS paid — voiding the bookkeeping does
    // not undo a transfer. It only loses this document's EXP. Reverse its payment if the
    // transfer itself was wrong. A job that was never paid goes back to unpaid.
    ...(status === "VOIDED"
      ? [
          prisma.tourPayment.updateMany({ where: { peakPaymentRef: paymentRef, status: "PAID" }, data: { peakRef: null, peakDocumentId: null, peakPaymentRef: null } }),
          prisma.tourPayment.updateMany({
            where: { peakPaymentRef: paymentRef, status: { not: "PAID" } },
            data: { status: "PENDING", paidAt: null, approvedBy: null, peakRef: null, peakDocumentId: null, peakPaymentRef: null, eslipUrl: null },
          }),
        ]
      : [prisma.tourPayment.updateMany({ where: { peakPaymentRef: paymentRef }, data: { peakPaymentRef: null } })]),
  ]);
}

// A CREATING or PAYING document younger than this may still be in flight — its request
// can be waiting on PEAK (30 s write timeout) or on Drive. Resolving it by hand then
// would race the original request.
const IN_FLIGHT_MS = 5 * 60_000;

export type Resolution =
  | { resolution: "found"; documentNo: string }
  | { resolution: "not-found" }
  | { resolution: "payment-found" }
  | { resolution: "payment-not-found" }
  | { resolution: "voided" };

/**
 * A person settles what the system could not: what PEAK actually holds.
 *  found              stage 1 — the document exists in PEAK: record its EXP; the jobs await payment (NOT paid)
 *  not-found          stage 1 — it does not: release the jobs
 *  payment-found      stage 2 — PEAK shows the payment on the EXP: mark the jobs paid, tell the guide
 *  payment-not-found  stage 2 — it does not: the document awaits payment again
 *  voided             the EXP was voided in PEAK (before or after payment): the jobs are unpaid and released
 */
export async function resolvePaymentDocument(
  paymentRef: string,
  r: Resolution,
  actor: Actor,
): Promise<{ ok: true; notify?: { guideId: string; jobs: { date: string; slotIdx: number }[]; slipUrl: string | null } } | { ok: false; status: number; error: string }> {
  const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef } });
  if (!doc) return { ok: false, status: 404, error: "No such payment" };
  const st = documentStatus(doc.status);
  const inFlight = (st === "CREATING" || st === "PAYING") && Date.now() - doc.updatedAt.getTime() < IN_FLIGHT_MS;
  if (inFlight) return { ok: false, status: 409, error: "This may still be in progress — wait a few minutes, then check again" };

  if (r.resolution === "found" || r.resolution === "not-found") {
    if (st !== "CREATE_UNCERTAIN" && st !== "CREATING") return { ok: false, status: 409, error: `This document is ${String(st ?? doc.status).toLowerCase()}, not waiting on PEAK to confirm it exists` };
    if (r.resolution === "not-found") {
      await releaseDocument(paymentRef, "FAILED", "Not found in PEAK (confirmed by an operator)", actor.actorId);
      await audit({ ...actor, action: "pay.peak_document_resolved_not_found", entityType: "GuidePaymentDocument", detail: { paymentRef } });
      return { ok: true };
    }
    const documentNo = r.documentNo.trim();
    if (!documentNo) return { ok: false, status: 400, error: "Enter the PEAK document number" };
    const moved = await prisma.guidePaymentDocument.updateMany({
      where: { paymentRef, status: { in: ["CREATE_UNCERTAIN", "CREATING", "UNCERTAIN", "POSTING"] } },
      data: { status: "AWAITING_PAYMENT", error: null, peakDocumentNo: documentNo, resolvedById: actor.actorId, resolvedAt: new Date() },
    });
    if (moved.count !== 1) return { ok: false, status: 409, error: "This document changed — reload Payments" };
    await audit({ ...actor, action: "pay.peak_document_resolved_found", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo } });
    return { ok: true };
  }

  if (r.resolution === "payment-found" || r.resolution === "payment-not-found") {
    if (st !== "PAYMENT_UNCERTAIN" && st !== "PAYING") return { ok: false, status: 409, error: `This document is ${String(st ?? doc.status).toLowerCase()}, not waiting on PEAK to confirm a payment` };
    if (r.resolution === "payment-not-found") {
      await prisma.guidePaymentDocument.updateMany({
        where: { paymentRef, status: { in: ["PAYMENT_UNCERTAIN", "PAYING"] } },
        // The whole claim is withdrawn, evidence included: a bank reference must not stay
        // recorded against a document that settles nothing.
        data: {
          status: "AWAITING_PAYMENT", error: "Payment not found in PEAK (confirmed by an operator)",
          paymentDate: null, paymentMethodId: null, paymentMethodName: null, slipUrl: null,
          bankRef: null, bankRefNormalized: null, bankAccountKey: null, slipAmount: null, slipUploadedAt: null,
          slipVerifiedById: null, slipVerifiedAt: null, verificationSource: null,
          resolvedById: actor.actorId, resolvedAt: new Date(),
        },
      });
      await audit({ ...actor, action: "pay.peak_payment_resolved_not_found", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo: doc.peakDocumentNo } });
      return { ok: true };
    }
    if (!doc.peakDocumentNo || !doc.paymentDate) return { ok: false, status: 409, error: "This payment has no PEAK document number or payment date on record" };
    try {
      await markDocumentPaid({ paymentRef, documentNo: doc.peakDocumentNo, documentId: doc.peakDocumentId, slipLink: doc.slipUrl, paymentDate: doc.paymentDate, actor, resolvedBy: actor.actorId, alreadyPaid: doc.alreadyPaid });
    } catch (e) {
      return { ok: false, status: 409, error: errText(e) };
    }
    await audit({ ...actor, action: "pay.peak_payment_resolved_found", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo: doc.peakDocumentNo } });
    // Already paid: the guide heard when the money moved.
    if (doc.alreadyPaid) return { ok: true };
    return { ok: true, notify: { guideId: doc.guideId, jobs: documentJobs(doc).map((j) => ({ date: j.date, slotIdx: j.slotIdx })), slipUrl: doc.slipUrl } };
  }

  if (st !== "AWAITING_PAYMENT" && st !== "PAID") return { ok: false, status: 409, error: "Only a document that exists in PEAK — awaiting payment or paid — can be marked voided" };
  await releaseDocument(paymentRef, "VOIDED", `Voided in PEAK (${doc.peakDocumentNo ?? "no number"}), confirmed by an operator`, actor.actorId);
  await audit({ ...actor, action: "pay.peak_document_voided", entityType: "GuidePaymentDocument", detail: { paymentRef, documentNo: doc.peakDocumentNo, wasPaid: st === "PAID", alreadyPaid: doc.alreadyPaid } });
  return { ok: true };
}
