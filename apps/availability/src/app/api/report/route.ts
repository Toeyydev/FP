import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { notifyOps } from "@/lib/booking-import";
import { applyReportedAttendance, type Booking, type Expense } from "@/lib/jobsheet";

// GET ?date&slotIdx — the bookings for the signed-in guide's own tour (for the
// no-show checklist in the report). Guide-only; returns [] if not assigned.
export async function GET(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true } });
  if (!a) return NextResponse.json({ bookings: [] });
  const bookings = await prisma.booking.findMany({ where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { id: true, customerName: true, confirmationCode: true, externalRef: true, pax: true, noShow: true } });
  return NextResponse.json({ bookings: bookings.map((b) => ({ id: b.id, name: b.customerName || b.confirmationCode || b.externalRef || "Guest", ref: b.externalRef || b.confirmationCode || "", pax: b.pax ?? 0, noShow: b.noShow })) });
}

// POST { date, slotIdx, bookedPax, noShow, leftEarly, comments? } — guide submits
// the end-of-tour report for their assignment. Also records the COMPLETE check-in.
// Attendance is recorded for quality/disputes — it does NOT change payout.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    bookedPax: z.number().int().min(0).max(100).optional(),
    noShow: z.number().int().min(0).max(100).default(0),
    noShowIds: z.array(z.string()).max(100).optional(),
    leftEarly: z.number().int().min(0).max(100).default(0),
    comments: z.string().max(1000).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, bookedPax, leftEarly, comments } = parsed.data;
  let noShow = parsed.data.noShow;
  // Per-booking no-show ticks (from the checklist): set the flags on the slot's
  // bookings and derive the no-show pax count from them.
  if (parsed.data.noShowIds) {
    const ids = parsed.data.noShowIds;
    await prisma.booking.updateMany({ where: { date, slotIdx }, data: { noShow: false } });
    if (ids.length) await prisma.booking.updateMany({ where: { id: { in: ids }, date, slotIdx }, data: { noShow: true } });
    const ns = await prisma.booking.findMany({ where: { id: { in: ids }, date, slotIdx }, select: { pax: true } });
    noShow = ns.reduce((s, b) => s + (b.pax ?? 0), 0);
  }

  const [sh, sm] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number);
  const [yy, mm, dd] = date.split("-").map(Number);
  if (Date.now() < Date.UTC(yy, mm - 1, dd, sh, sm) - 7 * 3600 * 1000 - 90 * 60 * 1000) return NextResponse.json({ error: "too-early" }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const completedPax = bookedPax != null ? Math.max(0, bookedPax - noShow - leftEarly) : null;
  await prisma.tourReport.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId: assignment.tourId, bookedPax: bookedPax ?? null, noShow, leftEarly, completedPax, comments: comments ?? null },
    update: { bookedPax: bookedPax ?? null, noShow, leftEarly, completedPax, comments: comments ?? null, submittedAt: new Date() },
  });
  // Completing the report completes the tour.
  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type: "COMPLETE" } });

  // Auto-update the job sheet to match the reported attendance: drop the absent
  // guests (no-show + left-early) from the booking rows, re-sync the attraction
  // ticket expenses to who actually showed, and flag the sheet so the operator
  // confirms the money before it's paid. The guide's fixed fee is never changed.
  const absent = noShow + leftEarly;
  if (absent > 0) {
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
    if (sheet) {
      const applied = applyReportedAttendance((sheet.bookings as Booking[]) ?? [], (sheet.expenses as Expense[]) ?? [], absent);
      await prisma.jobSheet.update({ where: { id: sheet.id }, data: { bookings: applied.bookings, expenses: applied.expenses, status: "Review: no-show" } });
      await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: "jobsheet.attendance_synced", entityType: "JobSheet", detail: { date, slotIdx, absent } });
    }
  }
  if (noShow > 0) {
    const gName = (await prisma.user.findFirst({ where: { guideId }, select: { displayName: true } }))?.displayName ?? guideId;
    await notifyOps(`${guideId} ${gName} reported ${noShow} no-show${noShow === 1 ? "" : "s"} on the ${date} tour.`, "Guide reported a no-show", `${date} · ${noShow} no-show`);
  }
  await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: "tour.reported", entityType: "Assignment", detail: { date, slotIdx, noShow, leftEarly } });
  return NextResponse.json({ ok: true });
}
