import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { recordAndMatch } from "@/lib/payments/record";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

// POST (multipart) { file, transactionId, memo, amount, guideId?, paidAt? }
// Operator records a K BIZ slip WITH its bank Transaction ID and memo typed in, stores
// it as evidence in Drive, and runs the matcher. Only a clean job/payout match marks the
// tour Paid; a duplicate is skipped; anything else lands in the review queue. The bank
// Transaction ID and the memo are kept as separate fields throughout. Operator/admin only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Connect Google Drive first." }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  const transactionId = String(form?.get("transactionId") || "").trim() || null;
  const memo = String(form?.get("memo") || "").trim() || null;
  const amountRaw = String(form?.get("amount") || "").trim();
  const amount = amountRaw ? Number(amountRaw.replace(/,/g, "")) : null;
  const guideId = String(form?.get("guideId") || "").trim() || null;
  const paidAtRaw = String(form?.get("paidAt") || "").trim();
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;

  if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "bad-body", hint: "A slip file is required." }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });
  if (amount != null && !isFinite(amount)) return NextResponse.json({ error: "bad-amount", hint: "Amount must be a number." }, { status: 400 });
  if (paidAt && isNaN(paidAt.getTime())) return NextResponse.json({ error: "bad-date" }, { status: 400 });

  const refreshToken = await folkpathsDriveToken(session!.user!.id ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect the Folkpaths Google account first." }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer!());
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const mime = file.type || "image/jpeg";
  const label = [transactionId, memo].filter(Boolean).join(" — ") || "slip";
  const name = `${label} — e-slip.${extOf(mime)}`;

  let drive: { id: string; link: string };
  try {
    drive = await saveBufferToDrive({ refreshToken, name, base64: bytes.toString("base64"), mimeType: mime, folderPath: ["Folkpaths E-slips", "Matched"] });
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  const result = await recordAndMatch(prisma, {
    evidence: { googleDriveFileId: drive.id, fileHash, driveLink: drive.link, originalFilename: name, mimeType: mime, fileSize: bytes.length, guideId },
    bankTransactionId: transactionId,
    memoRaw: memo,
    transferAmount: amount,
    paidAt,
    uploadedBy: session!.user!.id ?? null,
  });

  if (result.duplicate) {
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payment.slip_skipped_duplicate", entityType: "PaymentEvidence", entityId: result.evidenceId, detail: { transactionId } });
    return NextResponse.json({ ok: true, duplicate: true, evidenceId: result.evidenceId, message: "This slip was already recorded." });
  }

  const d = result.decision;
  await audit({
    actorId: session!.user!.id ?? null,
    actorRole: session!.user!.role ?? null,
    action: "payment.slip_matched",
    entityType: "PaymentTransaction",
    entityId: result.transactionRowId,
    detail: { transactionId, memo, amount, status: d.overallStatus, memoValidationStatus: d.memoValidationStatus, matchedJobNo: d.matchedJobNo, markedPaid: d.shouldMarkPaid },
  });

  return NextResponse.json({
    ok: true,
    duplicate: false,
    status: d.overallStatus,
    memoValidationStatus: d.memoValidationStatus,
    transactionValidationStatus: d.transactionValidationStatus,
    matchedJobNo: d.matchedJobNo,
    markedPaid: d.shouldMarkPaid,
    reason: d.reason,
    driveLink: drive.link,
  });
}
