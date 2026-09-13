import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { id, noShow, reason? } — operator marks a booking as a no-show (or clears it). Can be
// done any time, including before the tour (e.g. a known last-minute cancellation).
// Owner rule (2026-09-13): withdrawing a reported no-show is a deliberate edit — it needs a
// reason, and the audit keeps who changed it, the count before and after, and why.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1), noShow: z.boolean(), reason: z.string().max(500).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  // Whole-booking toggle (pre-tour inbox): keep noShowPax in sync with the flag so the
  // two never disagree — true = the whole group's pax absent, false = none.
  const cur = await prisma.booking.findUnique({ where: { id: parsed.data.id }, select: { pax: true, noShow: true, noShowPax: true } });
  if (!cur) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const previousNoShowPax = cur.noShowPax || (cur.noShow ? cur.pax ?? 0 : 0);
  const reason = parsed.data.reason?.trim() || null;
  if (!parsed.data.noShow && previousNoShowPax > 0 && !reason) return NextResponse.json({ error: "reason-required", detail: "Withdrawing a reported no-show needs a reason." }, { status: 400 });
  const b = await prisma.booking.update({ where: { id: parsed.data.id }, data: { noShow: parsed.data.noShow, noShowPax: parsed.data.noShow ? (cur?.pax ?? 0) : 0 }, select: { confirmationCode: true, customerName: true } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: parsed.data.noShow ? "booking.noshow" : "booking.noshow_cleared", entityType: "Booking", entityId: parsed.data.id, detail: { ref: b.confirmationCode, name: b.customerName, previousNoShowPax, noShowPax: parsed.data.noShow ? (cur.pax ?? 0) : 0, ...(reason ? { reason } : {}) } });
  return NextResponse.json({ ok: true });
}
