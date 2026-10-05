import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { bookingRef } from "@/lib/booking-ref";
import { z } from "zod";
import { pastDaySlots, suggestTourFor } from "@/lib/past-unstaffed";
import { recordPastSharedGuides } from "@/lib/past-shared-guides";
import { DASHBOARD_CACHE_KEY, forgetCached } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

const isOps = (role?: string) => role === "OPERATOR" || role === "ADMIN";
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// GET ?date=YYYY-MM-DD — a day that already happened, slot by slot: the guests, who
// is recorded as guiding each tour, and hints where a job sheet already lists guests
// of a tour with nobody on it. Feeds "Record who guided" (the dashboard and the
// Bookings table). Read-only; recording goes through POST /api/assignments.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "bad-date" }, { status: 400 });
  const today = bkkToday();
  if (date > today) return NextResponse.json({ error: "not-past", hint: "This tour has not run yet — offer it from the Bookings inbox" }, { status: 400 });
  // Today: only tours whose start time has passed. The Inbox stops listing those, so
  // this is the one place their guide can still be named.
  const nowMin = (() => { const d = new Date(Date.now() + 7 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
  const started = (slotIdx: number) => { const [h, m] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number); return date < today || h * 60 + m <= nowMin; };

  const [bookings, assignments, sheets, tours, guides] = await Promise.all([
    prisma.booking.findMany({
      // Bookings with no tour connected are included: a channel that sent no product
      // name leaves tourId empty, and those tours must not vanish from the record.
      where: { date, slotIdx: { not: null }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      select: { id: true, slotIdx: true, tourId: true, pax: true, externalRef: true, confirmationCode: true, customerName: true, source: true, status: true, assignedGuideId: true },
      orderBy: [{ slotIdx: "asc" }, { createdAt: "asc" }],
    }),
    prisma.assignment.findMany({ where: { date }, select: { guideId: true, slotIdx: true, tourId: true } }),
    prisma.jobSheet.findMany({ where: { date }, select: { guideId: true, slotIdx: true, ref: true, bookings: true } }),
    prisma.tour.findMany({ select: { id: true, name: true, time: true }, orderBy: { id: "asc" } }),
    prisma.user.findMany({ where: { role: "GUIDE", state: "ACTIVE", guideId: { not: null } }, select: { guideId: true, displayName: true, external: true }, orderBy: { guideId: "asc" } }),
  ]);
  const names = new Map((await prisma.user.findMany({ where: { guideId: { in: [...new Set([...assignments, ...sheets].map((x) => x.guideId))] } }, select: { guideId: true, displayName: true } })).map((u) => [u.guideId!, u.displayName]));
  const slots = pastDaySlots({
    bookings: bookings.map((b) => ({ id: b.id, slotIdx: b.slotIdx!, tourId: b.tourId ?? "", pax: b.pax, ref: bookingRef(b.externalRef, b.confirmationCode) || b.customerName || "—", keys: [b.externalRef, b.confirmationCode].filter((x): x is string => !!x), source: b.source, status: b.status })),
    assignments,
    sheets: sheets.map((s) => ({ guideId: s.guideId, slotIdx: s.slotIdx, ref: s.ref, bookingNos: Array.isArray(s.bookings) ? (s.bookings as { bookingNo?: string }[]).map((r) => String(r?.bookingNo ?? "")) : [] })),
  });
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  return NextResponse.json({
    date,
    slots: slots.filter((s) => started(s.slotIdx)).map((s) => ({
      ...s,
      time: SLOT_TIMES[s.slotIdx] ?? "",
      tours: s.tourIds.map((id) => ({ id, name: tourName.get(id) ?? id })),
      staffedBy: s.staffedBy.map((g) => ({ guideId: g, name: names.get(g) ?? g })),
      onSheets: s.onSheets.map((o) => ({ ...o, name: names.get(o.guideId) ?? o.guideId, time: SLOT_TIMES[o.slotIdx] ?? "" })),
      suggestTourId: s.unmappedIds.length ? suggestTourFor(SLOT_TIMES[s.slotIdx] ?? "", tours) : null,
      // Which guide each booking is placed with, when the tour is shared between guides.
      bookings: s.bookings.map((b) => ({ ...b, guideId: bookings.find((x) => x.id === b.id)?.assignedGuideId ?? null })),
    })),
    tours: tours.map((t) => ({ id: t.id, name: t.name, time: t.time })),
    guides: guides.map((g) => ({ guideId: g.guideId!, name: g.displayName, external: g.external })),
  });
}

// POST { date, slotIdx, tourId, groups: [{ guideId, bookingIds[] }] } — a tour that already
// ran had more than one guide: each gets their own job and each booking goes with one of
// them. Nobody is notified (lib/past-shared-guides). Operators only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0).max(SLOT_TIMES.length - 1), tourId: z.string().min(1),
    groups: z.array(z.object({ guideId: z.string().min(1), bookingIds: z.array(z.string().min(1)).max(60) })).min(1).max(8),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: ["The request was not understood"] }, { status: 400 });
  const r = await recordPastSharedGuides(prisma, { ...parsed.data, today: bkkToday(), actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  if (!r.ok) return NextResponse.json({ error: "not-recorded", reasons: r.reasons }, { status: r.status });
  forgetCached(DASHBOARD_CACHE_KEY);
  return NextResponse.json({ ok: true, guides: r.guides });
}
