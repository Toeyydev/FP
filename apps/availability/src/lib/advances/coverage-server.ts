// The live company advances of a job — the fact lib/advances/coverage needs.
import type { Prisma, PrismaClient } from "@prisma/client";
import { advanceJobKey, type JobAdvance } from "@/lib/advances/coverage";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Each job's (`guideId|date|slotIdx`) live advances: issued for that job and not reversed,
 * with what each handed over and what it may pay for. Read with the caller's client, so a
 * payment being recorded sees the same advances as the rest of its transaction.
 */
export async function liveAdvancesByJob(db: Db, where: { guideId?: string; jobs?: { guideId: string; date: string; slotIdx: number }[]; from?: string; to?: string }): Promise<Map<string, JobAdvance[]>> {
  const out = new Map<string, JobAdvance[]>();
  if (where.jobs && !where.jobs.length) return out;
  const rows = await db.guideAdvance.findMany({
    where: {
      reversedAt: null,
      ...(where.guideId ? { guideId: where.guideId } : {}),
      ...(where.jobs ? { OR: where.jobs.map((j) => ({ guideId: j.guideId, date: j.date, slotIdx: j.slotIdx })) } : {}),
      ...(where.from || where.to ? { date: { ...(where.from ? { gte: where.from } : {}), ...(where.to ? { lte: where.to } : {}) } } : {}),
    },
    select: { guideId: true, date: true, slotIdx: true, amountSatang: true, allowedCategories: true },
  });
  for (const r of rows) {
    const k = advanceJobKey(r);
    out.set(k, [...(out.get(k) ?? []), { amount: r.amountSatang / 100, allowedCategories: r.allowedCategories }]);
  }
  return out;
}
