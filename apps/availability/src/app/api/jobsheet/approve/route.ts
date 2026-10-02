import { NextRequest, NextResponse } from "next/server";
import { autoSettleSheet } from "@/lib/advances/auto";
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
//
// APPROVING needs the version the operator reviewed: `reviewedUpdatedAt`, the sheet's
// updatedAt as their screen shows it. Approval is a person signing off what they SAW; a
// sheet that changed since — an automatic booking update, another operator's save — is
// not what they saw, so it is refused with JOB_SHEET_CHANGED_REVIEW_AGAIN and nothing is
// changed. The check and the write are one statement (updatedAt in the WHERE), so a change
// landing in between cannot slip through. Removing an approval needs no version: it only
// ever makes a sheet reviewable again.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    guideId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    approve: z.boolean().optional(), // omitted → toggle current state
    reviewedUpdatedAt: z.string().datetime().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, approve, reviewedUpdatedAt } = parsed.data;
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };

  // Approve only a persisted sheet — the caller saves first, so the approval always
  // ties to a real ref and the actual figures the operator signed off on.
  const existing = await prisma.jobSheet.findUnique({ where: key, select: { id: true, ref: true, approvalStatus: true, updatedAt: true } });
  if (!existing) return NextResponse.json({ error: "no-sheet" }, { status: 404 });

  const next = approve === undefined ? toggleApproval(existing.approvalStatus) : approve ? "APPROVED" : null;
  const nowApproved = isApproved(next);
  const changedSinceReview = { error: "JOB_SHEET_CHANGED_REVIEW_AGAIN", reasons: ["Job Sheet changed since you reviewed it. Please review the latest version before approving."] };
  if (nowApproved && !isApproved(existing.approvalStatus)) {
    if (!reviewedUpdatedAt) return NextResponse.json({ error: "reviewed-version-required", reasons: ["Approving needs the version of the job sheet you reviewed. Reload the page and try again."] }, { status: 400 });
    if (new Date(reviewedUpdatedAt).getTime() !== existing.updatedAt.getTime()) return NextResponse.json(changedSinceReview, { status: 409 });
  }
  const hit = await prisma.jobSheet.updateMany({
    // Approving: only the version that was reviewed. Anything else: the row as read above.
    where: { id: existing.id, updatedAt: nowApproved && reviewedUpdatedAt ? new Date(reviewedUpdatedAt) : existing.updatedAt },
    data: {
      approvalStatus: next,
      approvedBy: nowApproved ? session!.user!.id ?? null : null,
      approvedAt: nowApproved ? new Date() : null,
    },
  });
  if (hit.count !== 1) return NextResponse.json(changedSinceReview, { status: 409 });
  // Approval is the decision; settling the advance rows it covers is arithmetic, so it
  // follows by itself (lib/advances/auto). Whatever the ledger refuses is reported and
  // left for a person — it never undoes the approval. Done before the sheet is re-read
  // below, because settling marks rows and moves the sheet's version.
  const advanceSettled = nowApproved && !isApproved(existing.approvalStatus)
    ? await autoSettleSheet(prisma, { guideId, date, slotIdx }, { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null })
    : [];
  // updatedAt too: this write moved the sheet's version, and the editor sends that version
  // back as baseUpdatedAt on its next Save. Without it the editor held the version from
  // before the approval and its next Save was refused as stale.
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: existing.id }, select: { approvalStatus: true, approvedBy: true, approvedAt: true, updatedAt: true } });

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: nowApproved ? "jobsheet.approved" : "jobsheet.unapproved",
    entityType: "JobSheet", entityId: existing.id,
    detail: { guideId, date, slotIdx, ref: existing.ref },
  });
  return NextResponse.json({ ok: true, ...sheet, advanceSettled });
}
