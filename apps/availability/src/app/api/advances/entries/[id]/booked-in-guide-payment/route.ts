import { accountingWriteRefusal } from "@/lib/advances/write-guard";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { markBookedInGuidePayment } from "@/lib/advances/booked-in-guide-payment";

export const dynamic = "force-dynamic";

const body = z.object({
  expenseDocumentNo: z.string().min(1).max(60),
  paymentEvidenceNo: z.string().min(1).max(60),
  reason: z.string().min(8).max(500),
}).strict();

// Records that PEAK already carries this settlement inside the same job's guide payment.
// It writes only FolkOPS evidence and the outbox status; it never calls or writes to PEAK.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can close a PEAK outbox item without posting it"] }, { status: 403 });
  { const refused = await accountingWriteRefusal(prisma); if (refused) return NextResponse.json(refused.body, { status: refused.status }); }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const { id } = await ctx.params;
  const result = await markBookedInGuidePayment(prisma, {
    entryId: id,
    ...parsed.data,
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
