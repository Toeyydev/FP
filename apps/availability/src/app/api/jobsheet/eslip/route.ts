import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notifyGuide } from "@/lib/booking-import";
import { saveEslip } from "@/lib/eslip-store";
import { computeTotals, thb, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const extOf = (m: string) => (m.includes("png") ? "png" : m.includes("pdf") ? "pdf" : m.includes("webp") ? "webp" : "jpg");

// POST { guideId, date, slotIdx, eslipBase64, eslipMime } — upload a tour's bank
// e-slip from the printed job sheet. Attaching the slip IS the proof of (daily)
// payment, so it marks THIS tour PAID and stores the slip (evidence) on the tour's
// payment row. Operator/admin only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  const eslipBase64 = typeof body?.eslipBase64 === "string" ? body.eslipBase64 : "";
  const eslipMime = typeof body?.eslipMime === "string" ? body.eslipMime : "image/jpeg";
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (!eslipBase64) return NextResponse.json({ error: "no-eslip", hint: "Choose a payment slip to upload." }, { status: 400 });

  const [sheet, assignment, u] = await Promise.all([
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } }),
  ]);
  const tourId = sheet?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId }, select: { name: true } }) : null;
  const expenses = (sheet?.expenses as Expense[]) ?? [];
  const guideFee = (sheet?.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE;
  const t = computeTotals(expenses, guideFee);
  const ref = sheet?.ref || `FOLK-BKK-${date.replace(/-/g, "")}`;
  const guideName = u?.fullName || u?.displayName || guideId;

  // Store the slip in our own DB (replacing any prior slip on this tour).
  const prior = await prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { status: true, eslipUrl: true } });
  const { link } = await saveEslip({ base64: eslipBase64, mimeType: eslipMime, filename: `${ref} — ${guideName} — ${date} — e-slip.${extOf(eslipMime)}`, replaceUrl: prior?.eslipUrl });

  const now = new Date();
  const alreadyPaid = prior?.status === "PAID";
  await prisma.tourPayment.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId, status: "PAID", paidAt: now, eslipUrl: link },
    update: { status: "PAID", paidAt: now, eslipUrl: link },
  });

  // Tell the guide their payment landed — only the first time this tour flips to paid.
  if (!alreadyPaid) try {
    await notifyGuide(guideId, `Your payment for the ${date} tour (${tour?.name ?? tourId}) has been transferred — ${thb(t.grandTotal)}. Thank you!`, "Payment transferred 💸", `${date} · ${thb(t.grandTotal)}`);
  } catch { /* best-effort */ }

  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.eslip_uploaded_paid", entityType: "TourPayment", detail: { guideId, date, slotIdx, ref } });
  return NextResponse.json({ ok: true, paid: true, link, eslipUrl: link });
}
