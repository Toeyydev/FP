import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { guideId, date, slotIdx, bookingNo, tickets } — the assigned guide (or an
// operator) ticks whether a guest's tour tickets are included. Mirrors onto the
// saved job sheet's booking row so the operator's sheet and expenses agree.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role, myGuideId = session.user.guideId;
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0), bookingNo: z.string().min(1),
    tickets: z.enum(["included", "not"]),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, bookingNo, tickets } = parsed.data;
  if (!ops(role) && myGuideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const sheet = await prisma.jobSheet.findUnique({ where: key });
  if (sheet && Array.isArray(sheet.bookings)) {
    const rows = (sheet.bookings as Array<{ bookingNo?: string }>).map((b) =>
      b?.bookingNo === bookingNo ? { ...b, tickets } : b);
    await prisma.jobSheet.update({ where: key, data: { bookings: rows as object } });
  }
  await audit({ actorId: session.user.id ?? null, actorRole: role ?? "GUIDE", action: "booking.tickets", entityType: "JobSheet", detail: { guideId, date, slotIdx, bookingNo, tickets } });
  return NextResponse.json({ ok: true });
}
