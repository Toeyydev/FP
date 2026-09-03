import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { SLOT_TIMES } from "@/lib/slots";
import { bookingRef } from "@/lib/booking-ref";

export const dynamic = "force-dynamic";

// "Who guided that day?" — search history by booking reference or guest name.
//
// Answers a question the Tour Log could not: it filtered by date only, so finding
// a past job meant knowing when it ran, which is exactly what you have forgotten
// when a guest writes back weeks later quoting a booking number.
//
// Two places hold guests, and both are searched:
//   * the Booking table — everything the channels synced
//   * JobSheet.bookings — the snapshot, which also carries rows an operator typed
//     in by hand and rows whose booking has since been cancelled
// A guest can appear in one and not the other, so results are merged on
// (guide, date, slot) — the identity of a job.

const MAX = 60;

type Hit = {
  date: string; slotIdx: number; time: string;
  tourId: string | null; tourName: string | null;
  guideId: string | null; guideName: string | null;
  sheetRef: string | null;
  guests: { name: string; ref: string; pax: number | null; status: string | null }[];
  source: ("booking" | "sheet")[];
};

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  // Two characters would match half the database and return noise, not an answer.
  if (q.length < 3) return NextResponse.json({ q, hits: [], hint: "Type at least 3 characters — a booking number or part of a guest's name." });

  const [bookings, sheets, guides, tours] = await Promise.all([
    prisma.booking.findMany({
      where: {
        OR: [
          { externalRef: { contains: q, mode: "insensitive" } },
          { confirmationCode: { contains: q, mode: "insensitive" } },
          { customerName: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        date: true, slotIdx: true, tourId: true, customerName: true, pax: true, status: true,
        externalRef: true, confirmationCode: true, assignedGuideId: true,
      },
      orderBy: { date: "desc" },
      take: MAX,
    }),
    // JSON columns cannot be indexed for a substring search, so this scans the
    // sheets' text. Bounded by the same cap; the table is small (hundreds).
    prisma.$queryRaw<{ ref: string; guideId: string; date: string; slotIdx: number; tourId: string | null; bookings: unknown }[]>`
      SELECT ref, "guideId", date, "slotIdx", "tourId", bookings
      FROM "JobSheet"
      WHERE bookings::text ILIKE ${"%" + q + "%"}
      ORDER BY date DESC
      LIMIT ${MAX}
    `,
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, fullName: true, displayName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);

  const guideName = new Map(guides.map((g) => [g.guideId!, g.fullName || g.displayName || g.guideId!]));
  const tourName = new Map(tours.map((t) => [t.id, t.name]));

  // Assignments tell us who actually ran each job the hits point at.
  const keys = [
    ...bookings.filter((b) => b.date && b.slotIdx != null).map((b) => ({ date: b.date!, slotIdx: b.slotIdx! })),
    ...sheets.map((s) => ({ date: s.date, slotIdx: s.slotIdx })),
  ];
  const assigns = keys.length
    ? await prisma.assignment.findMany({
        where: { OR: keys.map((k) => ({ date: k.date, slotIdx: k.slotIdx })) },
        select: { date: true, slotIdx: true, guideId: true, tourId: true },
      })
    : [];
  const guidesAt = new Map<string, string[]>();
  for (const a of assigns) {
    const k = `${a.date}|${a.slotIdx}`;
    guidesAt.set(k, [...(guidesAt.get(k) ?? []), a.guideId]);
  }

  const byJob = new Map<string, Hit>();
  const touch = (date: string, slotIdx: number, guideId: string | null, tourId: string | null, src: "booking" | "sheet"): Hit => {
    const k = `${guideId ?? "?"}|${date}|${slotIdx}`;
    let h = byJob.get(k);
    if (!h) {
      h = {
        date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "",
        tourId, tourName: tourId ? tourName.get(tourId) ?? tourId : null,
        guideId, guideName: guideId ? guideName.get(guideId) ?? guideId : null,
        sheetRef: null, guests: [], source: [],
      };
      byJob.set(k, h);
    }
    if (!h.source.includes(src)) h.source.push(src);
    return h;
  };

  for (const b of bookings) {
    if (!b.date || b.slotIdx == null) continue;
    // An unassigned booking still answers "when was this" — name every guide on
    // the slot rather than claiming there was none.
    const who = b.assignedGuideId ? [b.assignedGuideId] : guidesAt.get(`${b.date}|${b.slotIdx}`) ?? [null];
    for (const g of who) {
      const h = touch(b.date, b.slotIdx, g, b.tourId, "booking");
      h.guests.push({
        name: b.customerName ?? "", ref: bookingRef(b.externalRef, b.confirmationCode),
        pax: b.pax, status: b.status,
      });
    }
  }

  for (const s of sheets) {
    const h = touch(s.date, s.slotIdx, s.guideId, s.tourId, "sheet");
    h.sheetRef = s.ref;
    const rows = Array.isArray(s.bookings) ? (s.bookings as { name?: string; bookingNo?: string; bookedPax?: number | null }[]) : [];
    const needle = q.toLowerCase();
    for (const r of rows) {
      const name = (r.name || "").trim(), ref = (r.bookingNo || "").trim();
      if (!name.toLowerCase().includes(needle) && !ref.toLowerCase().includes(needle)) continue;
      // Do not list the same guest twice when both sources carried them.
      if (h.guests.some((g) => g.ref && g.ref === ref)) continue;
      h.guests.push({ name, ref, pax: r.bookedPax ?? null, status: null });
    }
  }

  const hits = [...byJob.values()]
    .filter((h) => h.guests.length)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slotIdx - b.slotIdx);

  return NextResponse.json({ q, hits, truncated: bookings.length >= MAX || sheets.length >= MAX });
}
