import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { previewPayment } from "@/lib/payments-v2/service";
import { paymentBody } from "@/lib/payments-v2/request-schema";

export const dynamic = "force-dynamic";

// POST — the same checks Record payment runs, with nothing written: the reconciliation
// (jobs + adjustments = transfer) and every reason it would be refused.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = paymentBody.partial({ amountTransferred: true }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const body = parsed.data;
  const hasSlip = req.nextUrl.searchParams.get("slip") === "1";
  const check = await previewPayment(prisma, {
    ...body, jobs: body.jobs ?? [], amountTransferred: body.amountTransferred ?? 0,
    slip: hasSlip ? { url: "pending" } : null, source: "MANUAL", actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  return NextResponse.json({ ok: check.reasons.length === 0, reasons: check.reasons, reconciliation: check.reconciliation, jobs: check.jobs, accountingPeriod: check.accountingPeriod, periods: check.periods });
}
