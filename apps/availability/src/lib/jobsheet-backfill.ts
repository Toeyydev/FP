import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ensureJobSheetForAssignment } from "@/lib/jobsheet-auto";
import { SLOT_TIMES } from "@/lib/slots";

// Job sheets for upcoming jobs assigned before 2026-10-15, when sheets started being made
// at assignment (lib/jobsheet-auto). An admin previews the list, then creates exactly that
// list — the same sheet each job would have got had it been assigned today. Past jobs are
// left alone: their sheets are the operator's to fill in from what happened.

export type MissingSheet = { guideId: string; guide: string; date: string; slotIdx: number; time: string; tour: string };

export async function upcomingJobsWithoutSheet(prisma: PrismaClient, today: string): Promise<{ jobs: MissingSheet[]; hash: string }> {
  const [assignments, sheets] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: today } }, select: { guideId: true, date: true, slotIdx: true, guide: { select: { displayName: true } }, tour: { select: { name: true } } }, orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { guideId: "asc" }] }),
    prisma.jobSheet.findMany({ where: { date: { gte: today } }, select: { guideId: true, date: true, slotIdx: true } }),
  ]);
  const has = new Set(sheets.map((s) => `${s.guideId}|${s.date}|${s.slotIdx}`));
  const jobs = assignments
    .filter((a) => !has.has(`${a.guideId}|${a.date}|${a.slotIdx}`))
    .map((a) => ({ guideId: a.guideId, guide: a.guide.displayName, date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "", tour: a.tour?.name ?? "" }));
  const hash = createHash("md5").update(jobs.map((j) => `${j.guideId}|${j.date}|${j.slotIdx}`).join(",")).digest("hex");
  return { jobs, hash };
}

export async function createMissingSheets(prisma: PrismaClient, o: { hash: string; today: string; actor: { actorId: string | null; actorRole: string | null } }):
  Promise<{ ok: true; created: { guideId: string; date: string; slotIdx: number; ref: string | null }[] } | { ok: false; status: number; reason: string }> {
  const now = await upcomingJobsWithoutSheet(prisma, o.today);
  if (now.hash !== o.hash) return { ok: false, status: 409, reason: "The list changed since the preview (a job was assigned, removed, or got its sheet). Preview again." };
  const created: { guideId: string; date: string; slotIdx: number; ref: string | null }[] = [];
  for (const j of now.jobs) {
    const r = await ensureJobSheetForAssignment(j.guideId, j.date, j.slotIdx, "admin-backfill");
    created.push({ guideId: j.guideId, date: j.date, slotIdx: j.slotIdx, ref: r.ref });
  }
  await audit({ ...o.actor, action: "jobsheet.backfill_created", entityType: "JobSheet",
    detail: { count: created.length, made: created.filter((c) => c.ref).length, jobs: created, rule: "upcoming jobs assigned before sheets were made at assignment (2026-10-15)" } });
  return { ok: true, created };
}
