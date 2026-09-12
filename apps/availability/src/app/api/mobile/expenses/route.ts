import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMobile } from "@/lib/mobile-auth";
import { assignedTourId } from "@/lib/guide-lifecycle";
import { guideExpenseZ, submitGuideExpenses, MAX_EXPENSE_LINES } from "@/lib/guide-expenses";

// POST { date, slotIdx, expenses, note? } — FolkOPS Mobile files what the token's
// guide spent on their own tour. Same rules as the web /api/jobsheet/expenses: the
// report is stored beside the operator's official set, never over it.
//
// Stricter than the web route in one way: the guide must actually be assigned to
// that departure, so a report can never scaffold a job sheet for a day they were
// never given.
export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    expenses: z.array(guideExpenseZ).max(MAX_EXPENSE_LINES),
    note: z.string().max(500).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const guideId = a.user.guideId;
  const { date, slotIdx, expenses } = parsed.data;
  if (!(await assignedTourId(guideId, date, slotIdx))) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  return NextResponse.json(await submitGuideExpenses({
    guideId, date, slotIdx, expenses, note: parsed.data.note,
    actorId: a.user.id, actorRole: a.user.role,
  }));
}
