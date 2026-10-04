import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isAdmin } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";
import { notifyGuide } from "@/lib/booking-import";
import { thb } from "@/lib/jobsheet";
import { insertExpenseFile } from "@/lib/peak-api";
import { attachmentFileType } from "@/lib/peak-payment-document";
import { isHistoricalPayment } from "@/lib/payments-v2/rules";
import { addMissingTransfers, previewMissingTransfers, type MissingTransferInput } from "@/lib/payments-v2/service";

export const dynamic = "force-dynamic";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

const body = z.object({
  recordedAmount: z.number(),
  added: z.array(z.object({ amount: z.number(), date: z.string(), bankRef: z.string().max(200).nullish() })).max(20),
  reason: z.string().max(500),
});

// POST (multipart: payload = JSON, file_0, file_1, … = the slip of each missing transfer)
//
// A payment recorded as one transfer that the bank actually sent in several — the slip was
// read as the full amount but carried only part of it, and the rest went later. ADMIN only,
// with a reason: the recorded transfer is kept at the amount its slip really shows and the
// missing transfers are added with their own slips (lib/payments-v2 addMissingTransfers).
// Nothing that was paid changes — jobs, figures, WHT, payment date, PEAK document. The new
// slips are then attached to the payment's PEAK document (attaching is not a billed call),
// and the guide is told the rest has arrived.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can correct a recorded payment"] }, { status: 403 });
  // The role on the session is checked against the database too: a demoted user's old session does nothing.
  const me = session?.user?.id ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, state: true } }) : null;
  if (!me || me.role !== "ADMIN" || me.state !== "ACTIVE") return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can correct a recorded payment"] }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: "ADMIN" };
  const { id } = await params;

  const form = await req.formData().catch(() => null);
  let raw: unknown = null;
  try { raw = JSON.parse(String(form?.get("payload") ?? "null")); } catch { /* reported below */ }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const b = parsed.data;

  type Upload = { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> };
  const files = b.added.map((_, i) => {
    const f = form?.get(`file_${i}`) as unknown as Upload | null;
    return f && typeof f.arrayBuffer === "function" && (f.size ?? 0) > 0 ? f : null;
  });
  for (const f of files) {
    if (!f) continue;
    if ((f.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", reasons: ["A slip is over 10 MB"] }, { status: 400 });
    const m = f.type || "image/jpeg";
    if (!/^image\//.test(m) && m !== "application/pdf") return NextResponse.json({ error: "bad-file", reasons: ["A slip must be an image or a PDF"] }, { status: 400 });
    if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", reasons: ["Connect Google Drive first — the slip is filed there"] }, { status: 400 });
  }
  const input = (slips: MissingTransferInput["added"][number]["slip"][]): MissingTransferInput => ({
    paymentId: id, recordedAmount: b.recordedAmount, reason: b.reason, actor,
    added: b.added.map((a, i) => ({ amount: a.amount, date: a.date, bankRef: a.bankRef ?? null, slip: slips[i] ?? null })),
  });

  // Check everything BEFORE a slip is filed, so a refused correction leaves no stray file.
  const reasons = await previewMissingTransfers(prisma, input(files.map((f) => (f ? { url: "pending" } : null))));
  if (reasons.length) return NextResponse.json({ error: "not-recordable", reasons }, { status: 409 });

  const p = await prisma.guidePayment.findUnique({ where: { id }, include: { jobs: { where: { active: true } } } });
  if (!p) return NextResponse.json({ error: "not-found", reasons: ["No such payment"] }, { status: 404 });
  const guide = await prisma.user.findUnique({ where: { guideId: p.guideId }, select: { displayName: true, fullName: true } });
  const guideName = guide?.fullName || guide?.displayName || p.guideId;
  const what = p.jobs.length ? `${p.jobs[0].jobNo}${p.jobs.length > 1 ? ` +${p.jobs.length - 1} more` : ""}` : p.paymentNo;
  const total = b.added.length + 1;

  const refreshToken = await folkpathsDriveToken(actor.actorId ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", reasons: ["Connect the Folkpaths Google account first"] }, { status: 400 });
  const slips: MissingTransferInput["added"][number]["slip"][] = [];
  const bytesOf: { base64: string; mime: string }[] = [];
  for (const [i, f] of files.entries()) {
    const date = b.added[i].date;
    const mime = f!.type || "image/jpeg";
    const bytes = Buffer.from(await f!.arrayBuffer!());
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const monthFolder = `${date.slice(0, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""}`.trim();
    const name = `${p.guideId} ${guideName} — ${date} — ${what} — transfer ${i + 2} of ${total} — e-slip.${extOf(mime)}`;
    let link: string, fileId: string;
    try {
      ({ link, id: fileId } = await saveBufferToDrive({ refreshToken, name, base64: bytes.toString("base64"), mimeType: mime, folderPath: ["Folkpaths E-slips", monthFolder] }));
    } catch (e) {
      return NextResponse.json({ error: "drive-failed", reasons: [(e as Error).message.slice(0, 200)] }, { status: 502 });
    }
    const prior = await prisma.paymentEvidence.findFirst({ where: { OR: [{ googleDriveFileId: fileId }, { fileHash }] }, select: { id: true } });
    const evidence = prior ?? await prisma.paymentEvidence.create({
      data: {
        guideId: p.guideId, evidenceType: "K_BIZ_SLIP", googleDriveFileId: fileId, fileHash, driveLink: link,
        originalFilename: name, mimeType: mime, fileSize: bytes.length,
        slipUploadedAt: new Date(), slipUploadedBy: actor.actorId, extractionMethod: "MANUAL_CORRECTION", processingStatus: "COMPLETED",
      },
      select: { id: true },
    });
    slips.push({ url: link, evidenceId: evidence.id, uploadedAt: new Date(), uploadedById: actor.actorId });
    bytesOf.push({ base64: bytes.toString("base64"), mime });
  }

  const result = await addMissingTransfers(prisma, input(slips));
  if (!result.ok) return NextResponse.json({ error: "not-recordable", reasons: result.reasons }, { status: result.status });

  // The slips go on the payment's PEAK document as evidence — best effort; the record above
  // stands either way, and a failure says to attach the slip in PEAK by hand.
  let peak: { documentNo: string | null; attached: number; error: string | null } = { documentNo: null, attached: 0, error: null };
  const doc = p.peakPaymentRef
    ? await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: p.peakPaymentRef }, select: { peakDocumentId: true, peakDocumentNo: true } })
    : null;
  const jobDocs = [...new Map(p.jobs.filter((j) => j.peakDocumentNo).map((j) => [j.peakDocumentNo, { peakDocumentId: j.peakDocumentId, peakDocumentNo: j.peakDocumentNo }])).values()];
  const target = doc?.peakDocumentNo ? doc : jobDocs.length === 1 ? jobDocs[0] : null;
  if (!target) peak.error = jobDocs.length > 1 ? "This payment's jobs are in more than one PEAK document — attach the slip in PEAK by hand" : "This payment has no PEAK document to attach the slip to";
  else {
    peak.documentNo = target.peakDocumentNo;
    for (const [i, s] of bytesOf.entries()) {
      const r = await insertExpenseFile({
        transactionId: target.peakDocumentId, transactionCode: target.peakDocumentNo,
        fileName: `${target.peakDocumentNo}-slip-${i + 2}.${extOf(s.mime)}`, base64: s.base64, fileType: attachmentFileType(s.mime), mime: s.mime,
      }).catch((e) => ({ ok: false, desc: (e as Error).message.slice(0, 200) }));
      if (r.ok) peak.attached++;
      else { peak.error = `${r.desc} — attach the slip in PEAK by hand`; break; }
    }
  }
  await audit({ ...actor, action: peak.error ? "payment.transfer_slip_attach_failed" : "payment.transfer_slip_attached", entityType: "GuidePayment", entityId: id, detail: { paymentNo: result.paymentNo, documentNo: peak.documentNo, attached: peak.attached, of: bytesOf.length, error: peak.error } });

  // The guide was told the full amount was paid when only part had arrived: tell them the
  // rest is there now. Not for a transfer made long ago.
  let notified = false;
  const added = result.transfers.slice(1);
  const lastDate = added[added.length - 1]?.date;
  if (!isHistoricalPayment(lastDate)) {
    try {
      const amount = thb(added.reduce((s, x) => s + x.amount, 0));
      await notifyGuide(p.guideId, `💸 The rest of your payment has been transferred — ${amount} (${what}). With the earlier transfer you have been paid ${thb(Number(p.amountTransferred))} in full.`, "Rest of your payment transferred 💸", `${amount} · ${what}`, undefined, added[added.length - 1]?.slipUrl ? { url: added[added.length - 1].slipUrl! } : {});
      notified = true;
    } catch { /* notifying is best-effort */ }
  }
  return NextResponse.json({ ok: true, paymentNo: result.paymentNo, transfers: result.transfers, peak, notified });
}
