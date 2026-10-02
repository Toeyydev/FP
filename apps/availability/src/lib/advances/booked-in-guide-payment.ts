import { Prisma, type PrismaClient } from "@prisma/client";
import { peakDocumentOwners, type PeakOwner } from "@/lib/advances/peak-ownership";
import { BOOKED_IN_GUIDE_PAYMENT as MARKER, isBookedInGuidePayment } from "@/lib/advances/rules";
import type { Actor, Fail } from "@/lib/advances/service";

const MIN_REASON = 8;

export type BookedInGuidePaymentInput = {
  entryId: string;
  expenseDocumentNo: string;
  paymentEvidenceNo: string;
  reason: string;
  actor: Actor;
};

type Success = {
  ok: true;
  replayed: boolean;
  entryId: string;
  expenseDocumentNo: string;
  paymentEvidenceNo: string;
};

const fail = (status: number, ...reasons: string[]): Fail => ({ ok: false, status, reasons });
const documentNo = (value: string) => value.trim().toUpperCase();

export function bookedInGuidePaymentInputProblems(input: Omit<BookedInGuidePaymentInput, "actor">): string[] {
  const reasons: string[] = [];
  if (!input.entryId.trim()) reasons.push("Choose the expense settlement");
  if (!/^EXP-[A-Z0-9-]+$/i.test(input.expenseDocumentNo.trim())) reasons.push("Enter the guide-payment expense document number (EXP-…)");
  if (!/^PV-[A-Z0-9-]+$/i.test(input.paymentEvidenceNo.trim())) reasons.push("Enter the PEAK payment voucher used as evidence (PV-…)");
  if (input.reason.trim().length < MIN_REASON) reasons.push(`Give the accounting reason (at least ${MIN_REASON} characters)`);
  return reasons;
}

function ownerMatchesJob(owner: PeakOwner, job: { guideId: string; date: string; slotIdx: number }): boolean {
  if (owner.guideId !== job.guideId) return false;
  if (owner.domain === "GUIDE_PAYMENT") return owner.job?.date === job.date && owner.job.slotIdx === job.slotIdx;
  if (owner.domain === "COMBINED_PAYMENT") return !!owner.jobs?.some((j) => j.date === job.date && j.slotIdx === job.slotIdx);
  return false;
}

/**
 * One transfer to a guide is one PEAK document, with a line per job (owner rule) — so the
 * document that carries this job normally names the guide's OTHER jobs in the same payment
 * too. Those are the same payment chain, not a second owner. Anything else that names the
 * document — another guide's payment, an advance event, a supplemental payment, payroll, a
 * job sheet's own document — is outside the chain and refuses the action.
 */
const samePaymentChain = (owner: PeakOwner, job: { guideId: string }) =>
  (owner.domain === "GUIDE_PAYMENT" || owner.domain === "COMBINED_PAYMENT") && owner.guideId === job.guideId;

/**
 * Close a settlement outbox item when its expense is already part of the same job's
 * guide-payment document. This records accounting evidence; it never calls PEAK and
 * deliberately creates no AdvancePeakDocumentLink because that document remains owned
 * by the guide payment.
 */
export async function markBookedInGuidePayment(
  prisma: PrismaClient,
  input: BookedInGuidePaymentInput,
): Promise<Success | Fail> {
  const problems = bookedInGuidePaymentInputProblems(input);
  if (problems.length) return fail(400, ...problems);

  const expenseNo = documentNo(input.expenseDocumentNo);
  const paymentNo = documentNo(input.paymentEvidenceNo);
  const reason = input.reason.trim();
  const id = `EXPENSE:${input.entryId}`;

  const entry = await prisma.guideAdvanceEntry.findUnique({
    where: { id: input.entryId },
    select: { id: true, type: true, sourceType: true, sourceId: true, reversedByEntryId: true, amountSatang: true, jobNo: true },
  });
  if (!entry || entry.type !== "EXPENSE_SETTLEMENT" || entry.sourceType !== "JOB_SHEET") return fail(404, "No live job-sheet expense settlement has that id");
  if (entry.reversedByEntryId) return fail(409, "That expense settlement has been reversed");

  const [sheet, outbox, existingLink, owners] = await Promise.all([
    prisma.jobSheet.findUnique({ where: { id: entry.sourceId }, select: { id: true, ref: true, guideId: true, date: true, slotIdx: true } }),
    prisma.advancePeakSync.findUnique({ where: { id }, select: { status: true, documentNo: true, error: true } }),
    prisma.advancePeakDocumentLink.findUnique({ where: { kind_sourceId: { kind: "EXPENSE", sourceId: entry.id } }, select: { documentNo: true } }),
    peakDocumentOwners(prisma, expenseNo),
  ]);
  if (!sheet) return fail(409, "The job sheet behind that settlement no longer exists");
  if (existingLink) return fail(409, `That settlement is already linked to ${existingLink.documentNo}`);
  if (!outbox) return fail(409, "That settlement has no PEAK outbox item to close");
  if (isBookedInGuidePayment(outbox)) {
    // A replay is the same statement again — the same document AND the same payment evidence.
    // Anything else is a different claim about a closed item, and is refused, not echoed back.
    const same = outbox.documentNo?.toUpperCase() === expenseNo && (outbox.error ?? "").includes(`payment evidence ${paymentNo}.`);
    return same
      ? { ok: true, replayed: true, entryId: entry.id, expenseDocumentNo: expenseNo, paymentEvidenceNo: paymentNo }
      : fail(409, `That settlement is already recorded as booked in ${outbox.documentNo} with other evidence — it was not changed`);
  }
  if (!["PENDING", "BLOCKED"].includes(outbox.status)) {
    return fail(409, outbox.status === "POSTED"
      ? `That settlement is already posted as ${outbox.documentNo ?? "a PEAK document"}`
      : `The PEAK outbox item is ${outbox.status}; only PENDING or BLOCKED items can be closed this way`);
  }

  // The document must be recorded as the guide payment of THIS job (guide + date + slot), and
  // every other record naming it must belong to the same guide's payment chain (legacy and
  // current payment tables, and the guide's other jobs paid in the same transfer).
  const matchingOwners = owners.filter((o) => ownerMatchesJob(o, sheet));
  if (!matchingOwners.length) return fail(409, `${expenseNo} is not recorded as the guide-payment document for ${sheet.ref ?? `${sheet.guideId} ${sheet.date}`}`);
  const incompatible = owners.filter((o) => !samePaymentChain(o, sheet));
  if (incompatible.length) return fail(409, `${expenseNo} has another recorded owner; reconcile its ownership before closing this item`);

  const error = `${MARKER}: expense already booked in ${expenseNo}; payment evidence ${paymentNo}. ${reason}`;
  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.advancePeakSync.updateMany({
      where: { id, status: { in: ["PENDING", "BLOCKED"] } },
      data: { status: "CANCELLED", documentNo: expenseNo, documentId: null, error, nextAttemptAt: new Date() },
    });
    if (moved.count !== 1) return false;
    await tx.auditLog.create({
      data: {
        actorId: input.actor.actorId,
        actorRole: input.actor.actorRole,
        action: "advance.settlement_booked_in_guide_payment",
        entityType: "GuideAdvanceEntry",
        entityId: entry.id,
        detail: {
          advanceEntryId: entry.id,
          jobSheetId: sheet.id,
          jobNo: sheet.ref ?? entry.jobNo,
          amount: entry.amountSatang / 100,
          expenseDocumentNo: expenseNo,
          paymentEvidenceNo: paymentNo,
          guidePaymentOwners: matchingOwners.map((owner) => ({ domain: owner.domain, id: owner.id, label: owner.label })),
          reason,
          result: "OUTBOX_CANCELLED_WITHOUT_POSTING",
        } as Prisma.InputJsonValue,
      },
    });
    return true;
  });
  if (!result) return fail(409, "That outbox item changed while you were confirming it — reload and check it");
  return { ok: true, replayed: false, entryId: entry.id, expenseDocumentNo: expenseNo, paymentEvidenceNo: paymentNo };
}

