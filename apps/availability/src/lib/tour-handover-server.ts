// Database half of lib/tour-handover: what an active handover on a tour forbids.
import { prisma } from "@/lib/db";

/**
 * Why a guide's job on this tour must not be removed, re-split or deleted while a
 * handover is active on it — or null. Removing either guide would strand the other half
 * of the record (a replacement with no one they replaced, or a fee that moved to nobody).
 * Pass no guideId to ask about the whole slot (a Split re-cuts every guide on it).
 */
export async function handoverLock(date: string, slotIdx: number, guideId?: string): Promise<string | null> {
  const h = await prisma.tourHandover.findFirst({
    where: { date, slotIdx, revokedAt: null, ...(guideId ? { OR: [{ fromGuideId: guideId }, { toGuideId: guideId }] } : {}) },
    select: { fromGuideId: true, toGuideId: true, handedOverAt: true },
  });
  if (!h) return null;
  return `${h.fromGuideId} handed this tour over to ${h.toGuideId} at ${h.handedOverAt}. Undo the handover on the job sheet first.`;
}
