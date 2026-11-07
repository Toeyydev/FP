import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { redactRowsForNonAdmin } from "@/lib/certificates/access";
import { attachmentsFor, type Actor } from "@/lib/expense-attachments/service";
import { setNoReceipt } from "@/lib/expense-attachments/no-receipt";

// "No receipt" + why, on one Tour Expense row (lib/expense-attachments/no-receipt).
//   POST { guideId, date, slotIdx, rowId | expenseIndex, reason }   reason "" or null clears it

const HINTS: Record<string, string> = {
  "no-sheet": "Save the job sheet first.",
  forbidden: "You can only do this on your own jobs.",
  approved: "The job sheet is approved. Unapprove it first.",
  "row-not-found": "That expense row is no longer on the sheet. Reload and try again.",
  "has-receipt": "This row already has a file attached.",
  "reason-short": "Say why there is no receipt.",
  "reason-long": "Keep the reason under 300 characters.",
  busy: "The sheet was being saved. Try again.",
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = z.object({
    guideId: z.string().min(1).max(20), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0).max(20),
    rowId: z.string().max(40).optional(), expenseIndex: z.number().int().min(0).max(100).optional(),
    reason: z.string().max(1000).nullable(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success || (parsed.data.rowId == null && parsed.data.expenseIndex == null)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  const actor: Actor = { id: session.user.id ?? null, role: session.user.role, guideId: session.user.guideId ?? null };
  const key = { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx };
  const r = await setNoReceipt({ actor, sheet: key, rowId: d.rowId ?? null, expenseIndex: d.expenseIndex ?? null, reason: d.reason });
  if (!r.ok) return NextResponse.json({ error: r.error, hint: HINTS[r.error] ?? "Couldn't save — try again." }, { status: r.status });
  const s = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key } });
  const sheet = s && (isAdmin(session.user.role) ? s : { ...s, expenses: redactRowsForNonAdmin(s.expenses as Record<string, unknown>[]) });
  const attachments = s ? await attachmentsFor(prisma, s, actor) : {};
  return NextResponse.json({ ok: true, rowId: r.rowId, sheet, attachments });
}
