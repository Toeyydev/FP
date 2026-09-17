import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { reversePayment } from "@/lib/payments-v2/service";
import { liveLedgerDeductions } from "@/lib/advances/freeze";

export const dynamic = "force-dynamic";

// POST { reason } — reverse a payment recorded by mistake. Nothing is deleted: the payment
// stays as REVERSED, with who, when and why, and its jobs are unpaid again.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = String(body?.reason ?? "").slice(0, 500);
  // A payment the ledger version recorded may have settled an advance. This version cannot
  // give that balance back, so reversing here would leave the advance settled by a payment
  // that no longer exists. Refused until the ledger version is live again.
  const deductions = await liveLedgerDeductions(prisma, id);
  if (deductions > 0) {
    const detail = `This payment settled ${deductions === 1 ? "an advance" : `${deductions} advances`} in the advance ledger. Reversing it from this version would not give that balance back, so it is paused — reverse it once the ledger version is running again.`;
    return NextResponse.json({ error: "advance-writes-frozen", reasons: [detail], detail }, { status: 503 });
  }
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
    unpaidJobs: result.jobs.filter((j) => !stillPaid.some((s) => s.jobNo === j)),
    stillPaid: stillPaid.map((s) => ({ jobNo: s.jobNo, paymentNo: others.find((o) => o.id === s.paymentId)?.paymentNo ?? "another payment" })),
  });
}
