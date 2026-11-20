import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { SLOT_TIMES } from "@/lib/slots";
import { groupDepartures, readRange } from "@/lib/upcoming-assigned";

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&q=<guide name or id>
// Every guide's assigned jobs in the range (default tomorrow + 30 days), for operators and
// admins. The source is Assignment — a job a guide accepted or was assigned to. An offer
// still waiting for an answer is a JobOffer and lives under Offers; a removed assignment is
// gone. No row cap: the guide filter is applied in the query, so nothing that matches is
// cut off by a page size (the range is at most a year).

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const range = readRange(sp.get("from"), sp.get("to"));
  if (!range) return NextResponse.json({ error: "bad-range", hint: "Pick a From date on or before To, at most a year apart." }, { status: 400 });
  const q = (sp.get("q") ?? "").trim().slice(0, 60);

  let guideFilter: { guideId?: { in: string[] } } = {};
  if (q) {
    const users = await prisma.user.findMany({
      where: { guideId: { not: null }, OR: [
        { guideId: { contains: q, mode: "insensitive" } },
        { displayName: { contains: q, mode: "insensitive" } },
        { fullName: { contains: q, mode: "insensitive" } },
        { fullNameThai: { contains: q, mode: "insensitive" } },
      ] },
      select: { guideId: true },
    });
    // Every assignment's guide is a user (foreign key), so the users are the whole answer.
    const ids = users.map((u) => u.guideId!).filter(Boolean);
    guideFilter = { guideId: { in: ids } };
  }

  const rows = await prisma.assignment.findMany({
    where: { date: { gte: range.from, lte: range.to }, ...guideFilter },
    select: { date: true, slotIdx: true, tourId: true, guideId: true },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { guideId: "asc" }],
  });
  const guideIds = [...new Set(rows.map((r) => r.guideId))];
  const tourIds = [...new Set(rows.map((r) => r.tourId).filter((x): x is string => !!x))];
  const [users, tours] = await Promise.all([
    guideIds.length ? prisma.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true } }) : [],
    tourIds.length ? prisma.tour.findMany({ where: { id: { in: tourIds } }, select: { id: true, name: true } }) : [],
  ]);
  const names = new Map(users.map((u) => [u.guideId!, u.displayName ?? ""]));
  const tourNames = new Map(tours.map((t) => [t.id, t.name]));
  const departures = groupDepartures(rows, names, tourNames, SLOT_TIMES);
  return NextResponse.json({ ...range, q, departures, jobs: rows.length });
}
