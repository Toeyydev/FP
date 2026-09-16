import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps, canViewFinance } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { sendPaymentNotice } from "@/lib/jobsheet-send";
import { ADJUSTMENT_TYPES, bangkokToday } from "@/lib/payments-v2/rules";
import { previewPayment, recordPayment, type RecordPaymentInput } from "@/lib/payments-v2/service";

export const dynamic = "force-dynamic";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

export const paymentBody = z.object({
  guideId: z.string().min(1),
  jobs: z.array(z.object({ jobNo: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1).max(60),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountTransferred: z.number(),
  adjustments: z.array(z.object({ type: z.enum(ADJUSTMENT_TYPES), amount: z.number(), description: z.string().min(1).max(300), jobNo: z.string().max(64).nullish() })).max(20).optional(),
  bankRef: z.string().max(120).nullish(),
  noSlipReason: z.string().max(500).nullish(),
  mismatchReason: z.string().max(500).nullish(),
  periodOverrideReason: z.string().max(500).nullish(),
  note: z.string().max(500).nullish(),
});

// GET ?guideId=&period=YYYY-MM — what a payment for this guide could hold: the jobs waiting
// for money with their current figures, and the payments already recorded for that month.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") ?? "";
  const period = req.nextUrl.searchParams.get("period") ?? "";
  if (!guideId || !/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  const payments = await prisma.guidePayment.findMany({
    where: { guideId, OR: [{ accountingPeriod: period }, { paymentDate: { startsWith: period } }] },
    orderBy: { createdAt: "desc" },
    include: { jobs: true, adjustments: true },
  });
  return NextResponse.json({
    guideId, period, today: bangkokToday(),
    payments: payments.map((p) => ({
      id: p.id, paymentNo: p.paymentNo, status: p.status, source: p.source, paymentDate: p.paymentDate, accountingPeriod: p.accountingPeriod,
      jobTotal: Number(p.jobTotal), adjustmentTotal: Number(p.adjustmentTotal), amountTransferred: Number(p.amountTransferred),
      bankRef: p.bankRef, slipUrl: p.slipUrl, noSlipReason: p.noSlipReason, mismatchReason: p.mismatchReason, note: p.note,
      reversedAt: p.reversedAt, reversalReason: p.reversalReason,
      jobs: p.jobs.map((j) => ({ jobNo: j.jobNo, date: j.date, slotIdx: j.slotIdx, payable: Number(j.payable), feeGross: Number(j.feeGross), wht: Number(j.wht), reimbursement: Number(j.reimbursement), reviewReward: Number(j.reviewReward), peakDocumentNo: j.peakDocumentNo })),
      adjustments: p.adjustments.map((a) => ({ type: a.type, amount: Number(a.amount), description: a.description, jobNo: a.jobNo })),
    })),
  });
}

// POST (multipart: payload = JSON, file = the bank slip) — record ONE transfer.
// The slip goes to Drive and becomes PaymentEvidence; lib/payments-v2 validates the jobs,
// the date, the amount and the adjustments, and only then are the jobs paid.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };

  const form = await req.formData().catch(() => null);
  const parsed = paymentBody.safeParse(JSON.parse(String(form?.get("payload") ?? "null")));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const body = parsed.data;

  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  const hasFile = !!file && typeof file.arrayBuffer === "function" && (file.size ?? 0) > 0;
  if (hasFile && (file!.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", reasons: ["The slip is over 10 MB"] }, { status: 400 });
  const mime = (hasFile && file!.type) || "image/jpeg";
  if (hasFile && !/^image\//.test(mime) && mime !== "application/pdf") return NextResponse.json({ error: "bad-file", reasons: ["The slip must be an image or a PDF"] }, { status: 400 });
  if (hasFile && !googleDriveEnabled) return NextResponse.json({ error: "not-configured", reasons: ["Connect Google Drive first — the slip is filed there"] }, { status: 400 });

  // Check everything BEFORE the slip is filed, so a refused payment leaves no stray file.
  const dry = await previewPayment(prisma, { ...body, source: "MANUAL", slip: hasFile ? { url: "pending" } : null, actor });
  if (dry.reasons.length) return NextResponse.json({ error: "not-recordable", reasons: dry.reasons, reconciliation: dry.reconciliation }, { status: 409 });

  let slip: RecordPaymentInput["slip"] = null;
  if (hasFile) {
    const refreshToken = await folkpathsDriveToken(actor.actorId ?? undefined);
    if (!refreshToken) return NextResponse.json({ error: "not-connected", reasons: ["Connect the Folkpaths Google account first"] }, { status: 400 });
    const bytes = Buffer.from(await file!.arrayBuffer!());
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const guide = await prisma.user.findUnique({ where: { guideId: body.guideId }, select: { displayName: true, fullName: true } });
    const guideName = guide?.fullName || guide?.displayName || body.guideId;
    const monthFolder = `${body.paymentDate.slice(0, 7)} ${MONTHS[Number(body.paymentDate.slice(5, 7)) - 1] ?? ""}`.trim();
    // Named after the transfer and the jobs it pays — never after another job's EXP.
    const first = body.jobs[0].jobNo;
    const name = `${body.guideId} ${guideName} — ${body.paymentDate} — ${first}${body.jobs.length > 1 ? ` +${body.jobs.length - 1} more` : ""} — e-slip.${extOf(mime)}`;
    let link: string, fileId: string;
    try {
      ({ link, id: fileId } = await saveBufferToDrive({ refreshToken, name, base64: bytes.toString("base64"), mimeType: mime, folderPath: ["Folkpaths E-slips", monthFolder] }));
    } catch (e) {
      return NextResponse.json({ error: "drive-failed", reasons: [(e as Error).message.slice(0, 200)] }, { status: 502 });
    }
    // One slip, one evidence row: the same file recorded twice is the same evidence.
    const prior = await prisma.paymentEvidence.findFirst({ where: { OR: [{ googleDriveFileId: fileId }, { fileHash }] }, select: { id: true } });
    const evidence = prior ?? await prisma.paymentEvidence.create({
      data: {
        guideId: body.guideId, evidenceType: "K_BIZ_SLIP", googleDriveFileId: fileId, fileHash, driveLink: link,
        originalFilename: name, mimeType: mime, fileSize: bytes.length,
        slipUploadedAt: new Date(), slipUploadedBy: actor.actorId, extractionMethod: "MANUAL_CORRECTION", processingStatus: "COMPLETED",
      },
      select: { id: true },
    });
    slip = { url: link, evidenceId: evidence.id, uploadedAt: new Date(), uploadedById: actor.actorId };
  }

  const result = await recordPayment(prisma, { ...body, source: "MANUAL", slip, actor });
  if (!result.ok) return NextResponse.json({ error: result.code === "conflict" ? "conflict" : "not-recordable", reasons: result.reasons, reconciliation: result.reconciliation ?? null }, { status: 409 });

  // Tell the guide their money is on the way — best effort, never blocks the record.
  try { await sendPaymentNotice(body.guideId, result.payment.jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })), undefined, slip?.url); } catch { /* notifying is best-effort */ }
  return NextResponse.json({ ok: true, payment: result.payment, reconciliation: result.reconciliation });
}
