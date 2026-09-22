import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { settleFromExpenses } from "@/lib/advances/service";
import { expenseAmount, expenseCategory, type Expense } from "@/lib/jobsheet";

export const dynamic = "force-dynamic";

// The job sheet by its house key (guideId + date + slot), which every screen already has.
const body = z.object({
  guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
  amount: z.number().finite().positive(), requestKey: z.string().min(8).max(120),
});

// POST — settle part of an advance with the expenses on one approved job sheet that the
// advance paid for. The rows tagged "from the advance" are the proposal; this records the
// decision, with a snapshot of the rows it covered, so a later edit to the sheet cannot
// quietly change a settled balance.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });

  const { guideId, date, slotIdx } = parsed.data;
  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true, ref: true, guideId: true, date: true, expenses: true, approvalStatus: true } });
  if (!sheet) return NextResponse.json({ error: "not-found", reasons: ["No such job sheet"] }, { status: 404 });
  const advance = await prisma.guideAdvance.findUnique({ where: { id }, select: { guideId: true } });
  if (!advance) return NextResponse.json({ error: "not-found", reasons: ["No such advance"] }, { status: 404 });
  if (advance.guideId !== sheet.guideId) return NextResponse.json({ error: "not-allowed", reasons: ["That job sheet belongs to another guide"] }, { status: 409 });
  if (sheet.approvalStatus !== "APPROVED") return NextResponse.json({ error: "not-allowed", reasons: ["Approve the job sheet before settling an advance against its expenses"] }, { status: 409 });

  const rows = ((sheet.expenses as unknown as Expense[]) ?? []).filter((e) => e.paidBy === "advance" && expenseCategory(e) === "entrance" && expenseAmount(e) > 0);
  const tagged = Math.round(rows.reduce((s, e) => s + expenseAmount(e), 0) * 100) / 100;
  if (parsed.data.amount > tagged) {
    const reason = `This job sheet marks ${tagged.toFixed(2)} of ticket costs as paid from an advance — a ticket-advance settlement cannot be larger than that`;
    return NextResponse.json({ error: "not-allowed", reasons: [reason], detail: reason }, { status: 409 });
  }

  const result = await settleFromExpenses(prisma, {
    advanceId: id, jobSheetId: sheet.id, jobNo: sheet.ref, amount: parsed.data.amount, effectiveDate: sheet.date,
    snapshot: { rows: rows.map((e) => ({ description: e.description, amount: expenseAmount(e), category: e.expenseType ?? null, peakAccountCode: e.peakAccountCode ?? null })), tagged },
    requestKey: parsed.data.requestKey,
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true, entryId: result.entryId, replayed: result.replayed });
}
