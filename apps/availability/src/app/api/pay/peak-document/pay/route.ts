import { checkEvidenceBeforePaying } from "@/lib/certificates/gate";
import type { Expense as CertExpense } from "@/lib/jobsheet";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken } from "@/lib/google-drive";
import { peakEnabled } from "@/lib/peak-api";
import { buildPaymentInput, payCombinedDocument, PaymentNotRecordable } from "@/lib/peak-payment-document";
import { bangkokToday, documentJobs, PaymentClaimRefused, prismaPayDeps, resolveBankAccount } from "@/lib/peak-payment-server";
import { paidTransferOf } from "@/lib/combined-payment";
import { checkTransferEvidence } from "@/lib/payment-transfer";

export const dynamic = "force-dynamic";

// POST (multipart) { paymentRef, documentNo, paymentDate, paymentMethodId, paymentMethodName?,
//                     bankRef, slipAmount, file }
//
// STAGE 2 of "Pay N jobs together · one ref": record the actual bank payment against the
// EXISTING combined PEAK document. Never creates a document.
//
// Requires the document to be AWAITING_PAYMENT and `documentNo` to be its EXP — the one
// the operator reviewed. Every job must still be locked to it, unpaid, approved and
// unchanged since the EXP was created, and PEAK must still show that EXP unpaid and owing
// exactly this. Only after PEAK confirms the payment are the jobs marked PAID, the slip
// attached and the guide told.
//
// An ALREADY-PAID document (its jobs were paid before it existed) records the transfer
// that already happened: the payment date is that transfer's, read from the jobs — not
// typed — and the slip is optional, since the one saved then is used. Its jobs keep
// their paid date and slip, take the EXP, and the guide is not told again.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  if (!peakEnabled) return NextResponse.json({ error: "peak-not-connected", reasons: ["PEAK is not connected"] }, { status: 503 });

  const form = await req.formData().catch(() => null);
  const paymentRef = String(form?.get("paymentRef") || "").trim();
  const documentNo = String(form?.get("documentNo") || "").trim();
  let paymentDate = String(form?.get("paymentDate") || "").trim();
  const paymentMethodId = String(form?.get("paymentMethodId") || "").trim();
  const paymentMethodName = String(form?.get("paymentMethodName") || "").trim().slice(0, 120) || null;
  const bankRef = String(form?.get("bankRef") || "").trim();
  const slipAmountRaw = String(form?.get("slipAmount") || "").trim();
  const slipAmount = slipAmountRaw ? Number(slipAmountRaw.replace(/,/g, "")) : null;
  // The operator states they checked the amount and the reference against the slip.
  // Nothing reads the image: this is the verification, and it is recorded as such.
  const verified = ["1", "true", "on", "yes"].includes(String(form?.get("verifiedFromSlip") || "").trim().toLowerCase());
  const file = form?.get("file") as unknown as { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  const fileName = (file?.name ?? "") || null;
  if (!paymentRef || !documentNo) return NextResponse.json({ error: "bad-body", reasons: ["Which PEAK document is being paid?"] }, { status: 400 });
  const hasFile = !!file && typeof file.arrayBuffer === "function" && (file.size ?? 0) > 0;

  const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef } });
  if (!doc) return NextResponse.json({ error: "no-document", reasons: [`There is no combined PEAK document ${paymentRef} — create the document first`] }, { status: 404 });

  // The transfer's evidence, before anything is claimed: a bank reference that finds it in
  // the statement, and the amount read off the slip, which must be the amount this document
  // is for. A transfer that went out at another figure does not settle this document.
  //
  // An already-paid document is recording a transfer made before it existed; its slip and
  // amount were recorded then, so only the bank reference is asked for, if it is known.
  if (!doc.alreadyPaid) {
    const problems = checkTransferEvidence({ bankRef, slipAmount, hasSlip: hasFile, verified }, Number(doc.total) || 0);
    if (problems.length) return NextResponse.json({ error: "no-evidence", reasons: problems }, { status: 400 });
  }
  if (hasFile && (file!.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", reasons: ["The slip is over 10 MB"] }, { status: 400 });
  const mime = (hasFile && file!.type) || "image/jpeg";
  if (hasFile && !/^image\//.test(mime) && mime !== "application/pdf") return NextResponse.json({ error: "bad-file", reasons: ["The slip must be an image or a PDF"] }, { status: 400 });
  if (hasFile && !googleDriveEnabled) return NextResponse.json({ error: "not-configured", reasons: ["Connect Google Drive first — the slip is saved there"] }, { status: 400 });

  // Already paid: the transfer's own date and slip, from the jobs it paid.
  let savedSlip: string | null = null;
  if (doc.alreadyPaid) {
    const held = await prisma.tourPayment.findMany({ where: { peakPaymentRef: paymentRef }, select: { date: true, slotIdx: true, paidAt: true, eslipUrl: true, slips: true, status: true } });
    const t = paidTransferOf(held.map((h) => ({ ref: `${h.date} slot ${h.slotIdx}`, paidAt: h.status === "PAID" ? h.paidAt : null, eslipUrl: h.eslipUrl, slips: h.slips })));
    if (t.reasons.length || !t.paidDate) return NextResponse.json({ error: "not-payable", reasons: t.reasons.length ? t.reasons : ["These jobs have no paid date on record"] }, { status: 409 });
    paymentDate = t.paidDate;
    savedSlip = t.slipLink;
  }

  let input;
  try {
    input = buildPaymentInput({ document: { status: doc.status, peakDocumentNo: doc.peakDocumentNo, total: doc.total, jobs: documentJobs(doc) }, expectedDocumentNo: documentNo, paymentDate, paymentMethodId, today: bangkokToday() });
  } catch (e) {
    if (e instanceof PaymentNotRecordable) return NextResponse.json({ error: doc.status === "PAID" ? "already-paid" : "not-payable", reasons: e.reasons }, { status: 409 });
    throw e;
  }

  // The certificates these rows lean on, checked against what is in Drive right now.
  // Linking checked the document once; that was days ago and Drive is a folder people
  // have hands in. One that has changed since is refused here and marked stale, so it
  // stops being treated as evidence everywhere else too.
  const sheets = await prisma.jobSheet.findMany({
    where: { OR: documentJobs(doc).map((j) => ({ guideId: doc.guideId, date: j.date, slotIdx: j.slotIdx })) },
    select: { expenses: true },
  });
  const evidence = await checkEvidenceBeforePaying(sheets.map((s) => (s.expenses as unknown as CertExpense[]) ?? []), actor);
  if (!evidence.ok) {
    return NextResponse.json({ error: "evidence-stale", reasons: evidence.reasons, staleCertificates: evidence.stale }, { status: 409 });
  }

  // Drive saves an uploaded slip, or reads the saved one back to attach it in PEAK.
  const refreshToken = hasFile || savedSlip ? (googleDriveEnabled ? await folkpathsDriveToken(actor.actorId ?? undefined) : null) : null;
  if (hasFile && !refreshToken) return NextResponse.json({ error: "not-connected", reasons: ["Connect the Folkpaths Google account first"] }, { status: 400 });
  const user = await prisma.user.findFirst({ where: { guideId: doc.guideId }, select: { peakContactId: true, fullName: true, displayName: true } });

  // Which bank account the money left from, asked of PEAK rather than taken from the
  // page: a bank reference is unique within a bank, and the page could name another
  // account to get the same transfer recorded twice. Fails closed.
  let bankAccountKey: string | null = null;
  if (!doc.alreadyPaid) {
    const account = await resolveBankAccount(input.paymentMethodId);
    if (!account.ok) return NextResponse.json({ error: "peak-check-failed", reasons: account.reasons }, { status: 409 });
    bankAccountKey = account.key;
  }

  const base64 = hasFile ? Buffer.from(await file!.arrayBuffer!()).toString("base64") : null;
  const deps = prismaPayDeps({
    document: doc, guideName: user?.fullName || user?.displayName || doc.guideId, peakContactId: user?.peakContactId ?? null,
    file: base64 ? { base64, mime } : null, savedSlip, refreshToken: refreshToken ?? null,
    bankRef, slipAmount, verified, fileName, bankAccountKey, actor,
  });

  let result;
  try {
    result = await payCombinedDocument(deps, { paymentRef, documentNo: doc.peakDocumentNo!, documentId: doc.peakDocumentId, paymentMethodName, ...input });
  } catch (e) {
    if (e instanceof PaymentClaimRefused) return NextResponse.json({ error: "not-payable", reasons: e.message.split("\n") }, { status: 409 });
    throw e;
  }

  if (result.status === "FAILED") {
    return NextResponse.json({ error: result.stage === "check" ? "peak-check-failed" : result.stage === "slip" ? "slip-failed" : "peak-refused", paymentRef, documentNo, reasons: result.reasons ?? [result.reason] }, { status: result.stage === "check" ? 409 : 502 });
  }
  if (result.status === "UNCERTAIN") {
    return NextResponse.json({
      error: "peak-uncertain", paymentRef, documentNo,
      reasons: [
        `PEAK did not confirm the payment of ${documentNo}: ${result.reason}`,
        `Look at ${documentNo} in PEAK before doing anything else. The jobs stay unpaid and locked until you record what you find on the Payments page — do not pay again.`,
      ],
    }, { status: 502 });
  }
  return NextResponse.json({
    ok: true, status: "PAID", paymentRef, documentNo: result.documentNo, amount: result.amount, paymentDate: input.paymentDate,
    slipLink: result.slipLink || null, attachment: result.attachment, recordError: result.recordError,
    notified: doc.alreadyPaid ? false : result.notified, alreadyPaid: doc.alreadyPaid,
  });
}
