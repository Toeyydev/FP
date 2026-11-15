import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { reviewExpense } from "@/lib/job-expense-review";

export const dynamic = "force-dynamic";

// POST — the operator's review of one of the guide's fixed items (Water / Bus / Ferry) on a job
// sheet (lib/job-expense-review). OPERATOR / ADMIN. Approve (optionally another amount, with a
// reason) or Reject (with a reason). Never adds an item, never touches PEAK.
const body = z.object({
  guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
  item: z.enum(["WATER", "BUS", "FERRY"]),
  action: z.enum(["APPROVE", "REJECT"]),
  verifiedAmount: z.number().min(0).max(1_000_000).nullable().optional(),
  reason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an operator can review expenses"] }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const { guideId, date, slotIdx, item, action, verifiedAmount, reason } = parsed.data;
  const r = await reviewExpense(prisma, {
    guideId, date, slotIdx, item,
    decision: action === "REJECT" ? { action, reason } : { action, verifiedAmount, reason },
    actor: { id: session!.user!.id ?? null, role: session!.user!.role ?? null },
  });
  if (!r.ok) return NextResponse.json({ error: "not-allowed", reasons: r.reasons, detail: r.reasons.join("\n") }, { status: r.status });
  return NextResponse.json(r);
}
