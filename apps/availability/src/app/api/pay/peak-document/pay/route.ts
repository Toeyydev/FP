import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken } from "@/lib/google-drive";
import { peakEnabled } from "@/lib/peak-api";
import { buildPaymentInput, payCombinedDocument, PaymentNotRecordable } from "@/lib/peak-payment-document";
import { bangkokToday, documentJobs, PaymentClaimRefused, prismaPayDeps } from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

// POST (multipart) { paymentRef, documentNo, paymentDate, paymentMethodId, paymentMethodName?, file }
//
// STAGE 2 of "Pay N jobs together · one ref": record the actual bank payment against the
// EXISTING combined PEAK document. Never creates a document.
//
// Requires the document to be AWAITING_PAYMENT and `documentNo` to be its EXP — the one
// the operator reviewed. Every job must still be locked to it, unpaid, approved and
// unchanged since the EXP was created, and PEAK must still show that EXP unpaid and owing
// exactly this. Only after PEAK confirms the payment are the jobs marked PAID, the slip
// attached and the guide told.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  if (!peakEnabled) return NextResponse.json({ error: "peak-not-connected", reasons: ["PEAK is not connected"] }, { status: 503 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", reasons: ["Connect Google Drive first — the slip is saved there"] }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const paymentRef = String(form?.get("paymentRef") || "").trim();
  const documentNo = String(form?.get("documentNo") || "").trim();
  const paymentDate = String(form?.get("paymentDate") || "").trim();
  const paymentMethodId = String(form?.get("paymentMethodId") || "").trim();
  const paymentMethodName = String(form?.get("paymentMethodName") || "").trim().slice(0, 120) || null;
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!paymentRef || !documentNo) return NextResponse.json({ error: "bad-body", reasons: ["Which PEAK document is being paid?"] }, { status: 400 });
  if (!file || typeof file.arrayBuffer !== "function" || !(file.size ?? 0)) return NextResponse.json({ error: "no-slip", reasons: ["Attach the payment slip"] }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", reasons: ["The slip is over 10 MB"] }, { status: 400 });
  const mime = file.type || "image/jpeg";
  if (!/^image\//.test(mime) && mime !== "application/pdf") return NextResponse.json({ error: "bad-file", reasons: ["The slip must be an image or a PDF"] }, { status: 400 });

  const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef } });
  if (!doc) return NextResponse.json({ error: "no-document", reasons: [`There is no combined PEAK document ${paymentRef} — create the document first`] }, { status: 404 });

  let input;
  try {
    input = buildPaymentInput({ document: { status: doc.status, peakDocumentNo: doc.peakDocumentNo, total: doc.total, jobs: documentJobs(doc) }, expectedDocumentNo: documentNo, paymentDate, paymentMethodId, today: bangkokToday() });
  } catch (e) {
    if (e instanceof PaymentNotRecordable) return NextResponse.json({ error: doc.status === "PAID" ? "already-paid" : "not-payable", reasons: e.reasons }, { status: 409 });
    throw e;
  }

  const refreshToken = await folkpathsDriveToken(actor.actorId ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", reasons: ["Connect the Folkpaths Google account first"] }, { status: 400 });
  const user = await prisma.user.findFirst({ where: { guideId: doc.guideId }, select: { peakContactId: true, fullName: true, displayName: true } });

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const deps = prismaPayDeps({
    document: doc, guideName: user?.fullName || user?.displayName || doc.guideId, peakContactId: user?.peakContactId ?? null,
    file: { base64, mime }, refreshToken, actor,
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
    slipLink: result.slipLink, attachment: result.attachment, recordError: result.recordError, notified: result.notified,
  });
}
