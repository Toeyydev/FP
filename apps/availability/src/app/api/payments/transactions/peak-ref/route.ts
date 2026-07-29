import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";

// POST { id, peakExpenseNo } — record (or clear) the PEAK expense number for a parsed
// payment. Stored on peakExpenseNo, SEPARATE from the bank transactionId and the memo
// reference (never overwrites either). Operator/admin only. Sending an empty value
// clears it.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || "").trim();
  const peakExpenseNo = String(body?.peakExpenseNo || "").trim().slice(0, 64) || null;
  if (!id) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const existing = await prisma.paymentTransaction.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "not-found" }, { status: 404 });

  await prisma.paymentTransaction.update({ where: { id }, data: { peakExpenseNo } });
  await audit({
    actorId: session!.user!.id ?? null,
    actorRole: session!.user!.role ?? null,
    action: "payment.peak_ref_set",
    entityType: "PaymentTransaction",
    entityId: id,
    detail: { peakExpenseNo },
  });

  return NextResponse.json({ ok: true, peakExpenseNo });
}
