import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { bangkokToday, blockReason, pendingJobsInMonth } from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

// GET ?guideId=G-…&date=YYYY-MM-DD — the guide's unpaid jobs in that month, for "Put
// these jobs in one PEAK document" on a job sheet: each with its payout, and whether it
// can go in now (ready) or what it is waiting for. Read-only; creating the document is
// POST /api/pay/peak-document, which applies the same rules again.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") ?? "";
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  const [jobs, tours, guide] = await Promise.all([
    pendingJobsInMonth(guideId, date, bangkokToday()),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.user.findFirst({ where: { guideId }, select: { displayName: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  return NextResponse.json({
    guideId, guide: guide?.displayName ?? guideId, period: date.slice(0, 7),
    jobs: jobs.map((j) => ({
      date: j.date, slotIdx: j.slotIdx, ref: j.ref, tour: tourName.get(j.tourId) ?? j.tourId, amount: j.payout,
      ready: !j.block, waiting: j.block ? blockReason(j.ref ?? `${j.date} slot ${j.slotIdx}`, j.block) : null,
    })),
  });
}
