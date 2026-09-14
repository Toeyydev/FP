import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { isApproved, DEFAULT_GUIDE_FEE, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";
import { createExpenseAllInOne, peakEnabled, sanitizePeakError } from "@/lib/peak-api";
import {
  buildJobSheetExpense, defaultAccountingDates, peakPayloadHash, peakSyncEligibility, JobSheetNotPostable,
} from "@/lib/peak-sync";
import { peakAccountMap, guideFeeAccount } from "@/lib/peak-account-map";
import { otherUnpaidJobsInMonth, paymentDocumentLocks } from "@/lib/peak-payment-server";
import { separateSyncWarning } from "@/lib/peak-payment-document";
import { sheetInPeak } from "@/lib/combined-payment";

const bangkokToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// POST { guideId, date, slotIdx } — operator/admin only.
//
// Post ONE approved job sheet to PEAK as an expense document. This is the job-sheet
// route to the ledger, as opposed to lib/peak-payout, which posts a TRANSFER when a
// payment slip is uploaded. The two must never both run for the same cost: the
// e-slip path skips a sheet that already carries a peakDocumentId.
//
// Every account comes from the chart the operator configured in the app, so this
// path needs none of the PEAK_ACCT_* variables the payout path reads.
//
// The document is NOT marked paid. A sheet is approved before the transfer happens,
// so what PEAK receives is an expense still to be settled — saying otherwise would
// record a payment nobody has made.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };

  const parsed = z.object({
    guideId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    // An explicit second act by the operator, for a sheet that changed after it was
    // already posted. Never defaulted to true.
    confirmRepost: z.boolean().optional(),
    // The operator has seen that the guide has other unpaid jobs this month and still
    // wants this job in a PEAK document of its own. Never defaulted to true.
    confirmSeparateDocument: z.boolean().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, confirmRepost, confirmSeparateDocument } = parsed.data;
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };

  if (!peakEnabled) return NextResponse.json({ error: "peak-not-connected" }, { status: 503 });

  // The other direction of the duplicate guard. "Pay N jobs together" books this job's
  // fee and reimbursements inside ONE payment document; posting the sheet as well would
  // put the same cost in PEAK twice.
  const locks = await paymentDocumentLocks([{ guideId, date, slotIdx }]);
  if (locks.length) return NextResponse.json({ error: "paid-in-payment-document", reason: locks[0], reasons: locks }, { status: 409 });

  const [sheet, guide, accounts, feeAccount] = await Promise.all([
    prisma.jobSheet.findUnique({ where: key }),
    prisma.user.findFirst({ where: { guideId }, select: { peakContactId: true } }),
    peakAccountMap(),
    guideFeeAccount(),
  ]);
  if (!sheet) return NextResponse.json({ error: "no-sheet" }, { status: 404 });

  const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
  const guideFee = sheet.guideFee && Object.keys(sheet.guideFee as object).length
    ? (sheet.guideFee as unknown as GuideFee) : DEFAULT_GUIDE_FEE;
  const dates = defaultAccountingDates(date, { accountingDate: sheet.accountingDate, documentDate: sheet.documentDate });

  // One gate, shared with the screen that shows the button — so "Sync" is never
  // offered for a sheet this would refuse, and the refusal names what to go fix.
  const eligibility = peakSyncEligibility({
    expenses, guideFee, approved: isApproved(sheet.approvalStatus),
    peakContactId: guide?.peakContactId, accountingDate: dates.accountingDate,
    origin: sheet.origin, accounts, jobRef: sheet.ref,
    bookings: (sheet.bookings as unknown as Booking[]) ?? [],
    state: {
      peakSyncStatus: sheet.peakSyncStatus, peakDocumentId: sheet.peakDocumentId,
      peakDocumentNo: sheet.peakDocumentNo, syncedAt: sheet.syncedAt,
      syncError: sheet.syncError, lastPayloadHash: sheet.lastPayloadHash,
    },
  });
  if (!eligibility.canSync) {
    return NextResponse.json({ error: "not-eligible", status: eligibility.status, reasons: eligibility.reasons }, { status: 409 });
  }

  // A sheet that was posted and has CHANGED since is a human decision, not an
  // automatic re-post: PEAK cannot amend the first document, so posting again leaves
  // two documents for one job and an accountant to work out which is real.
  // peakSyncEligibility deliberately reports this as canSync + changedSinceSync
  // rather than blocking, so the refusal — and the confirmation — belong here.
  if (eligibility.changedSinceSync && !confirmRepost) {
    return NextResponse.json({
      error: "changed-since-sync",
      documentNo: sheet.peakDocumentNo,
      reason: "Already posted to PEAK, and this sheet has changed since. Posting again adds a SECOND document for the same job — confirm to proceed.",
    }, { status: 409 });
  }

  // A job posted from its own sheet can no longer go into "Pay N jobs together". If the
  // guide has other unpaid jobs this month, posting this one now splits the transfer
  // that pays them across several PEAK documents. Ask first — and before anything is
  // written, so answering no leaves the sheet exactly as it was.
  let separateDocument: { confirmed: true; otherUnpaid: number; otherJobs: string[] } | null = null;
  if (!sheetInPeak(sheet)) {
    const others = await otherUnpaidJobsInMonth(guideId, { date, slotIdx }, bangkokToday());
    const warning = separateSyncWarning(others.length, date.slice(0, 7));
    if (warning && !confirmSeparateDocument) {
      return NextResponse.json({
        error: "separate-document-warning", reason: warning, otherUnpaid: others.length,
        otherJobs: others.map((j) => ({ date: j.date, slotIdx: j.slotIdx, ref: j.ref })),
      }, { status: 409 });
    }
    if (warning) separateDocument = { confirmed: true, otherUnpaid: others.length, otherJobs: others.map((j) => j.ref ?? `${j.date} slot ${j.slotIdx}`) };
  }

  let doc;
  try {
    doc = buildJobSheetExpense({
      guideId, peakContactId: guide!.peakContactId!, expenses, guideFee, accounts,
      guideFeeAccount: feeAccount, accountingDate: dates.accountingDate,
      documentDate: dates.documentDate, jobRef: sheet.ref, bookings: (sheet.bookings as unknown as Booking[]) ?? [],
    });
  } catch (e) {
    // The builder refuses rather than post a line to a blank account. Record why.
    const reason = e instanceof JobSheetNotPostable ? e.message : sanitizePeakError(e);
    await prisma.jobSheet.update({ where: key, data: { peakSyncStatus: "FAILED", syncError: reason } });
    await audit({ ...actor, action: "jobsheet.peak_sync_failed", entityType: "JobSheet", entityId: sheet.id, detail: { ref: sheet.ref, reason } });
    return NextResponse.json({ error: "not-postable", reason }, { status: 409 });
  }

  // Claim the sheet before the network call, so a second click is refused by
  // peakSyncEligibility ("A sync is already in progress") instead of posting twice.
  await prisma.jobSheet.update({ where: key, data: { peakSyncStatus: "SYNCING", syncError: null } });

  let res: Awaited<ReturnType<typeof createExpenseAllInOne>>;
  try {
    res = await createExpenseAllInOne(doc.expense);
  } catch (e) {
    const reason = sanitizePeakError(e);
    await prisma.jobSheet.update({ where: key, data: { peakSyncStatus: "FAILED", syncError: reason } });
    await audit({ ...actor, action: "jobsheet.peak_sync_failed", entityType: "JobSheet", entityId: sheet.id, detail: { ref: sheet.ref, reason } });
    return NextResponse.json({ error: "peak-failed", reason }, { status: 502 });
  }

  // ok without a document number is still a failure: there would be nothing to
  // record against the sheet, and the next click would post a second document.
  if (!res.ok || !(res.code ?? "").trim()) {
    const reason = (res.desc ?? "").trim() || "PEAK returned no document number and no reason";
    await prisma.jobSheet.update({ where: key, data: { peakSyncStatus: "FAILED", syncError: reason } });
    await audit({ ...actor, action: "jobsheet.peak_sync_failed", entityType: "JobSheet", entityId: sheet.id, detail: { ref: sheet.ref, reason } });
    return NextResponse.json({ error: "peak-refused", reason }, { status: 502 });
  }

  const documentNo = res.code!.trim();
  await prisma.jobSheet.update({
    where: key,
    data: {
      peakSyncStatus: "SYNCED",
      peakDocumentId: res.id ?? null,
      peakDocumentNo: documentNo,
      syncedAt: new Date(),
      syncError: null,
      // The fingerprint of exactly what was posted. Re-posting an unchanged sheet is
      // refused; a changed one surfaces as changedSinceSync for a human to decide.
      lastPayloadHash: peakPayloadHash({
        expenses, guideFee, accountingDate: dates.accountingDate,
        peakContactId: guide!.peakContactId!, accounts,
      }),
      accountingDate: dates.accountingDate,
      documentDate: dates.documentDate,
    },
  });
  await audit({
    ...actor, action: "jobsheet.peak_synced", entityType: "JobSheet", entityId: sheet.id,
    // separateDocument: the operator was told about the guide's other unpaid jobs and
    // confirmed this job should still be a document of its own.
    detail: { ref: sheet.ref, guideId, date, slotIdx, documentNo, lines: doc.lines.length, total: doc.total, ...(separateDocument ? { separateDocument } : {}) },
  });
  return NextResponse.json({ ok: true, documentNo, documentId: res.id ?? null, lines: doc.lines.length, total: doc.total });
}
