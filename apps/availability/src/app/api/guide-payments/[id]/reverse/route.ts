import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { reversePayment } from "@/lib/payments-v2/service";

export const dynamic = "force-dynamic";

// POST { reason } — reverse a payment recorded by mistake. Nothing is deleted: the payment
// stays as REVERSED, with who, when and why, and its jobs are unpaid again.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = String(body?.reason ?? "").slice(0, 500);
  const result = await reversePayment(prisma, { paymentId: id, reason, actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  if (!result.ok) return NextResponse.json({ error: "not-reversed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true, paymentNo: result.paymentNo, jobs: result.jobs });
}
