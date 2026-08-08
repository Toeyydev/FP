import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { toggleApproval, isApproved } from "@/lib/jobsheet";

// POST { guideId, date, slotIdx, approve? } — operator/admin only.
// Records the operator's finance sign-off on a SAVED job sheet: sets
// approvalStatus = "APPROVED" (+ approvedBy/approvedAt) or clears it. Approval is
// the gate a later PEAK sync will require; it moves no money on its own. `approve`
// is optional — omit it to toggle. Idempotent: re-approving an approved sheet is a
// no-op state-wise (still re-audited so the trail shows the click).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    guideId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    approve: z.boolean().optional(), // omitted → toggle current state
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, approve } = parsed.data;
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };

  // Approve only a persisted sheet — the caller saves first, so the approval always
  // ties to a real ref and the actual figures the operator signed off on.
  const existing = await prisma.jobSheet.findUnique({ where: key, select: { id: true, ref: true, approvalStatus: true } });
  if (!existing) return NextResponse.json({ error: "no-sheet" }, { status: 404 });

  const next = approve === undefined ? toggleApproval(existing.approvalStatus) : approve ? "APPROVED" : null;
  const nowApproved = isApproved(next);
  const sheet = await prisma.jobSheet.update({
    where: key,
    data: {
      approvalStatus: next,
      approvedBy: nowApproved ? session!.user!.id ?? null : null,
      approvedAt: nowApproved ? new Date() : null,
    },
    select: { approvalStatus: true, approvedBy: true, approvedAt: true },
  });

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: nowApproved ? "jobsheet.approved" : "jobsheet.unapproved",
    entityType: "JobSheet", entityId: existing.id,
    detail: { guideId, date, slotIdx, ref: existing.ref },
  });
  return NextResponse.json({ ok: true, ...sheet });
}
