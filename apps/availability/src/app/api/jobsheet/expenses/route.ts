import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { guideExpenseZ, submitGuideExpenses, MAX_EXPENSE_LINES } from "@/lib/guide-expenses";
import { expenseReportAccess } from "@/lib/expense-report-access";
import { isOps } from "@/lib/roles";

// POST { guideId, date, slotIdx, expenses } — the assigned guide (or an operator on
// their behalf) reports the expenses they paid on tour. Who may do so, for which job,
// is checked on the server before anything is written (lib/expense-report-access).
// Stored SEPARATELY on the sheet as `guideExpenses` so it never overwrites the
// operator's official set — the operator cross-checks and accepts. Operators are
// notified on each guide submission.
//
// The rules live in lib/guide-expenses, so FolkOPS Mobile files the same report.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role, myGuideId = session.user.guideId;
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
    expenses: z.array(guideExpenseZ).max(MAX_EXPENSE_LINES),
    note: z.string().max(500).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, expenses } = parsed.data;
  const actor = isOps(role) ? { kind: "operator" as const } : myGuideId ? { kind: "guide" as const, guideId: myGuideId } : null;
  const access = await expenseReportAccess(actor, { guideId, date, slotIdx });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  return NextResponse.json(await submitGuideExpenses({
    guideId, date, slotIdx, expenses, note: parsed.data.note,
    actorId: session.user.id ?? null, actorRole: role ?? "GUIDE",
  }));
}
