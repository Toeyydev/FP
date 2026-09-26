import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/app/api/admin/historical-evidence/access";
import { detachMisattributedSlip, MIN_REASON, SlipCorrectionRefused } from "@/lib/payment-slip-correction";

export const dynamic = "force-dynamic";

// POST: take a payment slip off the job it was wrongly attached to (lib/payment-slip-correction).
//
// ADMIN only, checked in the session and in the database. The body names the row, the slip
// and whose payment it really is; it never names who is acting or when — that comes from
// the session and the server clock. Strict, so a body that tries is refused, not trimmed.

const bodyZ = z.object({
  guideId: z.string().regex(/^G-\d{3,4}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotIdx: z.number().int().min(0).max(20),
  tourPaymentId: z.string().min(10).max(40),
  driveFileId: z.string().regex(/^[A-Za-z0-9_-]{10,}$/),
  rightfulGuideId: z.string().regex(/^G-\d{3,4}$/),
  reason: z.string().min(MIN_REASON).max(500),
  renameDriveFile: z.boolean(),
}).strict();

export async function POST(req: NextRequest) {
  const who = await requireAdmin();
  if (!who.ok) {
    await audit({ action: "pay.slip_detach_denied", entityType: "TourPayment", detail: { status: who.status } }).catch(() => {});
    return NextResponse.json({ error: "forbidden" }, { status: who.status });
  }
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, { status: 400 });
  const me = await prisma.user.findUnique({ where: { id: who.userId }, select: { id: true, role: true, fullName: true, displayName: true, email: true } });
  if (!me || me.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const result = await detachMisattributedSlip(parsed.data, { id: me.id, role: me.role, name: (me.fullName || me.displayName || me.email || me.id).trim() });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof SlipCorrectionRefused) return NextResponse.json({ error: "refused", reasons: e.reasons }, { status: e.status });
    throw e;
  }
}
