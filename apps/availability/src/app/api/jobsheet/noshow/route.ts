import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { guideId, date, slotIdx, bookingNo, noShow } — the assigned guide (or an
// operator) marks one guest in their customer list as a no-show. Flags the matching
// Booking (so it appears in the operator's Tour Log) and mirrors it on a saved sheet.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role, myGuideId = session.user.guideId;
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0), bookingNo: z.string().min(1), noShow: z.boolean(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, bookingNo, noShow } = parsed.data;
  if (!ops(role) && myGuideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  await prisma.booking.updateMany({
    where: { date, slotIdx, OR: [{ externalRef: bookingNo }, { confirmationCode: bookingNo }] },
    data: { noShow },
  });
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const sheet = await prisma.jobSheet.findUnique({ where: key });
  if (sheet && Array.isArray(sheet.bookings)) {
    const rows = (sheet.bookings as Array<{ bookingNo?: string; status?: string }>).map((b) =>
      b?.bookingNo === bookingNo ? { ...b, status: noShow ? "no-show" : "" } : b);
    await prisma.jobSheet.update({ where: key, data: { bookings: rows as object } });
  }
  await audit({ actorId: session.user.id ?? null, actorRole: role ?? "GUIDE", action: noShow ? "booking.noshow" : "booking.noshow_cleared", entityType: "Booking", detail: { guideId, date, slotIdx, bookingNo, by: "guide-list" } });
  return NextResponse.json({ ok: true });
}
