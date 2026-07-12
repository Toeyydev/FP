import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { noShowStatus, syncAttractionTickets, type Booking, type Expense } from "@/lib/jobsheet";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { guideId, date, slotIdx, bookingNo, noShowPax } — the assigned guide (or an
// operator) records how many of one booking's guests didn't arrive (0 = all came,
// pax = whole booking absent, in between = partial, e.g. booked 8, came 5 → 3).
// Flags the matching Booking (so it appears in the operator's Tour Log) and mirrors
// the count / status / actual pax onto a saved sheet, re-syncing ticket expenses.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role, myGuideId = session.user.guideId;
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0), bookingNo: z.string().min(1), noShowPax: z.number().int().min(0).max(100),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, bookingNo } = parsed.data;
  if (!ops(role) && myGuideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // A guide may report a no-show only AFTER checking in and within 30 min of the tour
  // start (operators are exempt — they can correct any time).
  if (!ops(role)) {
    const started = await prisma.checkin.count({ where: { guideId, date, slotIdx } });
    const [h, m] = (SLOT_TIMES[slotIdx] || "00:00").split(":").map(Number);
    const startMs = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600 * 1000;
    const inWindow = Date.now() >= startMs && Date.now() <= startMs + 30 * 60_000;
    if (!started || !inWindow) return NextResponse.json({ error: "not-in-window" }, { status: 403 });
  }

  // Clamp the count to the booking's group size and persist it.
  const b = await prisma.booking.findFirst({ where: { date, slotIdx, OR: [{ externalRef: bookingNo }, { confirmationCode: bookingNo }] }, select: { pax: true } });
  const noShowPax = Math.min(parsed.data.noShowPax, b?.pax ?? parsed.data.noShowPax);
  await prisma.booking.updateMany({
    where: { date, slotIdx, OR: [{ externalRef: bookingNo }, { confirmationCode: bookingNo }] },
    data: { noShowPax, noShow: noShowPax > 0 },
  });

  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const sheet = await prisma.jobSheet.findUnique({ where: key });
  if (sheet && Array.isArray(sheet.bookings)) {
    const rows = (sheet.bookings as Booking[]).map((r) => {
      if (r?.bookingNo !== bookingNo) return r;
      const ns = Math.min(noShowPax, r.bookedPax ?? noShowPax);
      return { ...r, noShowPax: ns, status: noShowStatus(ns, r.bookedPax), actualPax: Math.max(0, (r.bookedPax ?? 0) - ns) };
    });
    const expenses = syncAttractionTickets(rows, (sheet.expenses as Expense[]) ?? []);
    await prisma.jobSheet.update({ where: key, data: { bookings: rows as object, expenses: expenses as object } });
  }
  await audit({ actorId: session.user.id ?? null, actorRole: role ?? "GUIDE", action: noShowPax > 0 ? "booking.noshow" : "booking.noshow_cleared", entityType: "Booking", detail: { guideId, date, slotIdx, bookingNo, noShowPax, by: "guide-list" } });
  return NextResponse.json({ ok: true });
}
