import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { checkWaiver, evidenceState, MIN_WAIVER_REASON, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { expenseAmount } from "@/lib/jobsheet";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// POST — an admin accepts one reimbursement row without a receipt, and says why.
//
// Not a settings toggle and not a blanket exemption: it names one row on one job
// sheet, and it records who decided and what they said. A temple that prints no
// ticket is a real case; "we lost it" is a decision someone should have to sign.
const body = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotIdx: z.number().int().min(0),
  index: z.number().int().min(0),          // the row's position in the sheet's expenses
  reason: z.string().min(MIN_WAIVER_REASON).max(500),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can accept a reimbursement without a receipt"] }, { status: 403 });
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const { guideId, date, slotIdx, index, reason } = parsed.data;

  const by = session!.user!.id ?? null;
  const problems = checkWaiver({ reason, by });
  if (problems.length) return NextResponse.json({ error: "bad-body", reasons: problems, detail: problems.join("\n") }, { status: 400 });

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true, ref: true, expenses: true } });
  if (!sheet) return NextResponse.json({ error: "not-found", reasons: ["No such job sheet"] }, { status: 404 });

  const rows = ((sheet.expenses as unknown as ExpenseWithEvidence[]) ?? []);
  const row = rows[index];
  if (!row) return NextResponse.json({ error: "not-found", reasons: [`That job sheet has no row ${index + 1}`] }, { status: 404 });

  const state = evidenceState(row);
  // Waiving anything else would be recording a decision nobody needed: the row either
  // has its receipt, is not a reimbursement, or has been accepted already.
  if (state.state !== "BLOCKED") {
    return NextResponse.json({
      error: "not-allowed",
      reasons: [`"${row.description ?? "That row"}" does not need a waiver (${state.state.toLowerCase().replace("_", " ")})`],
    }, { status: 409 });
  }

  const waiver = { by: by!, at: new Date().toISOString(), reason: reason.trim() };
  const next = rows.map((r, i) => (i === index ? { ...r, evidenceWaiver: waiver } : r));
  await prisma.jobSheet.update({ where: { id: sheet.id }, data: { expenses: next as unknown as Prisma.InputJsonValue } });

  await audit({
    actorId: by, actorRole: session!.user!.role ?? null,
    action: "jobsheet.evidence_waived", entityType: "JobSheet", entityId: sheet.id,
    detail: { ref: sheet.ref, guideId, date, slotIdx, row: index + 1, description: row.description ?? null, amount: expenseAmount(row), reason: waiver.reason },
  });

  return NextResponse.json({ ok: true, waiver });
}
