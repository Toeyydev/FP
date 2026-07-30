import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { saveEslip, eslipIdFromUrl } from "@/lib/eslip-store";
import { sendPaymentNotice } from "@/lib/jobsheet-send";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

// POST (multipart) { period, guideId, file } — upload a bank payment slip (e-slip)
// as evidence, store it (encrypted) in our own DB, and put its /api/eslip link on
// the guide's monthly payroll row. Operator/admin only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const period = String(form?.get("period") || "");
  const guideId = String(form?.get("guideId") || "");
  // Duck-type the file: the File global isn't defined in the Node server runtime.
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!/^\d{4}-\d{2}$/.test(period) || !guideId || !file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", hint: "Max 10 MB." }, { status: 400 });

  const u = await prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } });
  const guideName = u?.fullName || u?.displayName || guideId;
  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const mime = file.type || "image/jpeg";
  const monthFolder = `${period} ${MONTHS[Number(period.slice(5, 7)) - 1] ?? ""}`.trim();
  // Name the e-slip by the job sheet no. so it's easy to match later. The monthly
  // payout may cover several tours; use the single ref when there's one, else list.
  const sheets = await prisma.jobSheet.findMany({ where: { guideId, date: { gte: `${period}-01`, lte: `${period}-31` }, ref: { not: null } }, select: { ref: true }, orderBy: { date: "asc" } });
  const refs = sheets.map((sh) => sh.ref).filter((r): r is string => !!r);
  const base = refs.length === 1 ? `${refs[0]} — ${guideName}` : refs.length > 1 ? `${refs[0]} +${refs.length - 1} more — ${guideName}` : `${guideId} ${guideName} ${period}`;
  const name = `${base} — e-slip.${extOf(mime)}`;

  // Was this month already paid? If so, this is a re-upload / "Replace slip" — we
  // refresh the stored file (replacing the old one) but must NOT notify the guide
  // again (caused duplicate "payment transferred" messages).
  const prior = await prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId, period } }, select: { status: true, eslipUrl: true } });
  const alreadyPaid = prior?.status === "paid";
  const { link } = await saveEslip({ base64, mimeType: mime, filename: name, replaceUrl: prior?.eslipUrl });

  // The e-slip is stored → it's evidence of payment, so mark the guide's month PAID,
  // and flip each of that month's tours to PAID so the per-tour badges agree.
  const now = new Date();
  await prisma.payrollStatus.upsert({
    where: { guideId_period: { guideId, period } },
    create: { guideId, period, status: "paid", paidAt: now, eslipUrl: link },
    update: { eslipUrl: link, status: "paid", paidAt: now },
  });
  // Only mark tours that had already happened by the payment date PAID — a slip
  // uploaded mid-month must not stamp tours later in the month as paid before they
  // even run (the paid-before-tour bug).
  const payThrough = new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10); // Bangkok date of the payment
  const lteDate = payThrough < `${period}-31` ? payThrough : `${period}-31`;
  const assigns = await prisma.assignment.findMany({ where: { guideId, date: { gte: `${period}-01`, lte: lteDate } }, select: { date: true, slotIdx: true, tourId: true } });
  for (const a of assigns) {
    await prisma.tourPayment.upsert({
      where: { guideId_date_slotIdx: { guideId, date: a.date, slotIdx: a.slotIdx } },
      create: { guideId, date: a.date, slotIdx: a.slotIdx, tourId: a.tourId, status: "PAID", paidAt: now },
      update: { status: "PAID", paidAt: now },
    });
  }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.eslip_uploaded_paid", entityType: "PayrollStatus", detail: { period, guideId, tours: assigns.length } });

  // Let the guide know their payment was transferred (in-app + push + LINE).
  // Only on the FIRST time the month flips to paid — never on a slip replacement.
  if (!alreadyPaid) try {
    const monthLabel = `${MONTHS[Number(period.slice(5, 7)) - 1] ?? ""} ${period.slice(0, 4)}`.trim();
    await sendPaymentNotice(guideId, assigns.map((a) => ({ date: a.date, slotIdx: a.slotIdx })), monthLabel, link);
  } catch { /* notifying the guide is best-effort */ }
  return NextResponse.json({ ok: true, link, markedPaid: true });
}

// DELETE { period, guideId } — clear the e-slip link and remove the stored slip.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const period = String(body?.period || ""), guideId = String(body?.guideId || "");
  if (!/^\d{4}-\d{2}$/.test(period) || !guideId) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const row = await prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId, period } }, select: { eslipUrl: true } });
  const oldId = eslipIdFromUrl(row?.eslipUrl);
  if (oldId) await prisma.eslip.delete({ where: { id: oldId } }).catch(() => {});
  await prisma.payrollStatus.updateMany({ where: { guideId, period }, data: { eslipUrl: null } });
  return NextResponse.json({ ok: true });
}
