import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const CAP = 10;

// POST { date, slotIdx, tourId, groups:[{ guideId, bookingIds[] }] } — split an
// over-capacity slot across guides. Each booking (whole, never a family) is
// tagged to its guide, an assignment is created per guide, and the bookings leave
// the inbox. Enforces the 10-seat cap per group.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    tourId: z.string().min(1),
    groups: z.array(z.object({ guideId: z.string().min(1), bookingIds: z.array(z.string().min(1)).min(1) })).min(1),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, tourId, groups } = parsed.data;

  const ids = groups.flatMap((g) => g.bookingIds);
  const bookings = await prisma.booking.findMany({ where: { id: { in: ids } }, select: { id: true, pax: true, confirmationCode: true, customerName: true } });
  const byId = new Map(bookings.map((b) => [b.id, b]));

  // Validate every group is within the seat cap before writing anything.
  for (const g of groups) {
    const pax = g.bookingIds.reduce((s, id) => s + (byId.get(id)?.pax ?? 0), 0);
    if (pax > CAP) return NextResponse.json({ error: "over-cap", guideId: g.guideId, pax, cap: CAP }, { status: 400 });
  }

  for (const g of groups) {
    const groupBookings = g.bookingIds.map((id) => byId.get(id)).filter(Boolean) as { id: string; pax: number | null; confirmationCode: string | null; customerName: string | null }[];
    const pax = groupBookings.reduce((s, b) => s + (b.pax ?? 0), 0) || null;
    const note = `${groupBookings.length} booking(s): ${groupBookings.map((b) => b.confirmationCode || b.customerName || "—").join(", ")}`.slice(0, 280);
    await prisma.booking.updateMany({ where: { id: { in: g.bookingIds } }, data: { assignedGuideId: g.guideId, status: "OFFERED" } });
    await prisma.assignment.upsert({
      where: { guideId_date_slotIdx: { guideId: g.guideId, date, slotIdx } },
      create: { guideId: g.guideId, date, slotIdx, tourId, pax, note },
      update: { tourId, pax, note },
    });
  }

  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bookings.split", entityType: "Booking", detail: { date, slotIdx, groups: groups.length } });
  return NextResponse.json({ ok: true, groups: groups.length });
}
