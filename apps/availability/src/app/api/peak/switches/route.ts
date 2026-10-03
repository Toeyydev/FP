import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { readPeakSafety } from "@/lib/peak-switches";

export const dynamic = "force-dynamic";

// GET — the PEAK switches as BOTH services hold them, their builds and last runs, the
// combined state, and the advance outbox counts (lib/peak-switches). Switch states, build
// ids and counts only: never a value of any configuration.
export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const safety = await readPeakSafety(prisma);
  const [byStatus, linked, staleSending] = await Promise.all([
    prisma.advancePeakSync.groupBy({ by: ["status"], _count: { _all: true } }).catch(() => []),
    prisma.advancePeakDocumentLink.count().catch(() => 0),
    prisma.advancePeakSync.count({ where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } } }).catch(() => 0),
  ]);
  const n = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  return NextResponse.json({
    ...safety,
    counts: {
      readyToPost: n("PENDING"),
      failed: n("BLOCKED"),
      needsReview: n("UNCERTAIN") + staleSending,
      sending: n("SENDING") - staleSending,
      inPeak: n("POSTED"),
      inPeakLinked: linked,
      closed: n("CANCELLED"),
    },
  }, { headers: { "cache-control": "no-store" } });
}
