import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { reversePayment } from "@/lib/payments-v2/service";

export const dynamic = "force-dynamic";

// POST { reason } — reverse a payment recorded by mistake. Nothing is deleted: the payment
// stays as REVERSED, with who, when and why, and its jobs are unpaid again.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  // Cutover: a payment that settled an advance is not reversed while advance writes are paused.
  if (advanceWritesFrozen() && (await prisma.guideAdvanceEntry.count({ where: { paymentId: id, type: "PAYMENT_DEDUCTION", reversedByEntryId: null } }))) {
    return NextResponse.json(advanceFrozenBody, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const reason = String(body?.reason ?? "").slice(0, 500);
  const result = await reversePayment(prisma, { paymentId: id, reason, actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  if (!result.ok) return NextResponse.json({ error: "not-reversed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  // A job another ACTIVE payment owns stays paid — the operator is told which, rather than
  // being left to assume every job on the payment is unpaid again.
  const stillPaid = await prisma.guidePaymentJob.findMany({
    where: { jobNo: { in: result.jobs }, active: true },
    select: { jobNo: true, paymentId: true },
  });
  const others = stillPaid.length
    ? await prisma.guidePayment.findMany({ where: { id: { in: [...new Set(stillPaid.map((s) => s.paymentId))] } }, select: { id: true, paymentNo: true } })
    : [];
  return NextResponse.json({
    ok: true, paymentNo: result.paymentNo, jobs: result.jobs,
    // Advances this payment had settled are open again — the deduction never happened.
    advancesReopened: result.advancesReopened,
    unpaidJobs: result.jobs.filter((j) => !stillPaid.some((s) => s.jobNo === j)),
    stillPaid: stillPaid.map((s) => ({ jobNo: s.jobNo, paymentNo: others.find((o) => o.id === s.paymentId)?.paymentNo ?? "another payment" })),
  });
}
