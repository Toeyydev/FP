import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { resolveReview, type ReviewAction } from "@/lib/payments/resolve-review";

// POST { id, action: "confirm" | "dismiss", note? }
// Operator resolves a PAYMENT_NEEDS_REVIEW payment: confirm marks the linked job
// sheet's tour Paid; dismiss drops it from the queue. Operator/admin only — the
// Accountant role is read-only and may not move money.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || "").trim();
  const action = body?.action as ReviewAction;
  const jobNo = body?.jobNo ? String(body.jobNo).trim().slice(0, 64) : null;
  const guideId = body?.guideId ? String(body.guideId).trim().slice(0, 64) : null;
  const slotIdx = body?.slotIdx == null ? null : Number(body.slotIdx);
  if (slotIdx != null && (!Number.isInteger(slotIdx) || slotIdx < 0)) return NextResponse.json({ error: "bad-slot" }, { status: 400 });
  const note = body?.note ? String(body.note).slice(0, 500) : null;
  if (!id || (action !== "confirm" && action !== "dismiss")) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const res = await resolveReview(prisma, { id, action, jobNo, guideId, slotIdx, note, actorId: session!.user!.id ?? null });
  if (!res.ok) {
    const reasons = res.error === "payment-refused" ? res.reasons : undefined;
    return NextResponse.json({ error: res.error, ...(reasons ? { reasons, detail: reasons.join("\n") } : {}) }, { status: res.error === "not-found" ? 404 : res.error === "payment-refused" ? 409 : 400 });
  }

  await audit({
    actorId: session!.user!.id ?? null,
    actorRole: session!.user!.role ?? null,
    action: `payment.review_${action}`,
    entityType: "PaymentTransaction",
    entityId: id,
    detail: { action, jobNo, guideId, slotIdx, note, markedPaid: res.markedPaid, status: res.status, paymentNo: res.paymentNo ?? null },
  });

  return NextResponse.json({ ok: true, status: res.status, markedPaid: res.markedPaid, paymentNo: res.paymentNo ?? null });
}
