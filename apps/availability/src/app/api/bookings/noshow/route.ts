import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { id, noShow } — operator marks a booking as a no-show (or clears it). Can be
// done any time, including before the tour (e.g. a known last-minute cancellation).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1), noShow: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  // Whole-booking toggle (pre-tour inbox): keep noShowPax in sync with the flag so the
  // two never disagree — true = the whole group's pax absent, false = none.
  const cur = await prisma.booking.findUnique({ where: { id: parsed.data.id }, select: { pax: true } });
  const b = await prisma.booking.update({ where: { id: parsed.data.id }, data: { noShow: parsed.data.noShow, noShowPax: parsed.data.noShow ? (cur?.pax ?? 0) : 0 }, select: { confirmationCode: true, customerName: true } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: parsed.data.noShow ? "booking.noshow" : "booking.noshow_cleared", entityType: "Booking", entityId: parsed.data.id, detail: { ref: b.confirmationCode, name: b.customerName } });
  return NextResponse.json({ ok: true });
}
