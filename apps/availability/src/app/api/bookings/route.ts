import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_COUNT, SLOT_TIMES } from "@/lib/slots";
import { productKey, isChannelProductName } from "@/lib/bookings";
import { todayD, ymd } from "@/lib/dates";
import { reconcileAssignedBookings, autoAttachLate, autoSyncBokun } from "@/lib/booking-import";
import { withTimeout } from "@/lib/api-cache";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// GET — operator inbox: recent non-ignored bookings + tours for mapping.
// With ?id=… returns that single booking in full (incl. the raw Bokun payload).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return NextResponse.json({ error: "not-found" }, { status: 404 });
    return NextResponse.json({ booking });
  }
  // Full Bookings table view: ?view=all with optional status / source / q filters.
  const sp = req.nextUrl.searchParams;
  if (sp.get("view") === "all") {
    const status = sp.get("status") || "";
    const source = sp.get("source") || "";
    const month = sp.get("month") || ""; // YYYY-MM — show only that month's bookings
    const q = (sp.get("q") || "").trim();
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (source) where.source = source;
    if (/^\d{4}-\d{2}$/.test(month)) where.date = { gte: `${month}-01`, lte: `${month}-31` };
    if (q) where.OR = [
      { customerName: { contains: q, mode: "insensitive" } },
      { confirmationCode: { contains: q, mode: "insensitive" } },
      { externalRef: { contains: q, mode: "insensitive" } },
      { productName: { contains: q, mode: "insensitive" } },
    ];
    const [bookings, tours] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 1000,
        select: { id: true, source: true, confirmationCode: true, externalRef: true, productName: true, tourId: true, date: true, startTime: true, slotIdx: true, pax: true, customerName: true, status: true, createdAt: true },
      }),
      prisma.tour.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true } }),
    ]);
    // Attach the assigned guide (if any) so the All-bookings view tracks who is
    // handling each tour — turning the list into a follow-everything board.
    const dates = [...new Set(bookings.filter((b) => b.date && b.slotIdx != null).map((b) => b.date!))];
    const assigns = dates.length ? await prisma.assignment.findMany({ where: { date: { in: dates } }, select: { date: true, slotIdx: true, guideId: true } }) : [];
    const guideIds = [...new Set(assigns.map((a) => a.guideId))];
    const guideUsers = guideIds.length ? await prisma.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true } }) : [];
    const gName = new Map(guideUsers.map((g) => [g.guideId, g.displayName]));
    const aMap = new Map(assigns.map((a) => [`${a.date}|${a.slotIdx}`, a.guideId]));
    const withGuide = bookings.map((b) => {
      const gid = b.date && b.slotIdx != null ? aMap.get(`${b.date}|${b.slotIdx}`) : undefined;
      return { ...b, guideId: gid ?? null, guide: gid ? (gName.get(gid) ?? gid) : null };
    });
    return NextResponse.json({ bookings: withGuide, tours });
  }

  // Auto-combine: fold any pending booking whose slot is already assigned into that
  // guide's job before listing, so the inbox self-reconciles with no manual step.
  void autoSyncBokun(); // background: keep the inbox current with Bokun (throttled), non-blocking
  // Best-effort auto-combine: race it against a timeout so a large/slow reconcile can
  // never block the inbox response (it keeps running in the background and is idempotent,
  // so anything it doesn't finish in time is folded in on the next load). Mirrors how the
  // dashboard guards the same sweep. This was previously an unbounded blocking await —
  // the main cause of the inbox getting slow as bookings accumulate.
  await withTimeout(reconcileAssignedBookings().catch(() => {}), 5_000, undefined);

  // Hide bookings whose tour date has already passed (Bangkok civil date) from the
  // incoming inbox — keep undated bookings (date == null) because those still need
  // the operator to map a date. Past bookings remain in the full ?view=all history.
  const today = ymd(todayD());
  const [bookings, tours] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: ["PENDING", "OFFERED", "ASSIGNED"] },
        OR: [{ date: null }, { date: { gte: today } }],
        // Incoming bookings are OTA only (GetYourGuide GET-xxxx, Viator). Hide direct
        // FOLK-xxxx website bookings so they never clutter the dispatch inbox.
        NOT: {
          OR: [
            { confirmationCode: { startsWith: "FOLK-", mode: "insensitive" } },
            { externalRef: { startsWith: "FOLK-", mode: "insensitive" } },
          ],
        },
      },
      orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { createdAt: "asc" }],
      take: 500,
      select: { id: true, source: true, confirmationCode: true, externalRef: true, productName: true, tourId: true, date: true, startTime: true, slotIdx: true, pax: true, customerName: true, status: true },
    }),
    prisma.tour.findMany({ orderBy: { id: "asc" } }),
  ]);
  // Attach the assigned guide (if the slot is already dispatched) so the inbox can
  // badge those groups as handled instead of offering them again.
  const aDates = [...new Set(bookings.filter((b) => b.date && b.slotIdx != null).map((b) => b.date!))];
  const aRows = aDates.length ? await prisma.assignment.findMany({ where: { date: { in: aDates } }, select: { date: true, slotIdx: true, guideId: true } }) : [];
  const aGuideIds = [...new Set(aRows.map((a) => a.guideId))];
  const aUsers = aGuideIds.length ? await prisma.user.findMany({ where: { guideId: { in: aGuideIds } }, select: { guideId: true, displayName: true } }) : [];
  const aName = new Map(aUsers.map((g) => [g.guideId, g.displayName]));
  const aMap = new Map(aRows.map((a) => [`${a.date}|${a.slotIdx}`, a.guideId]));
  const withGuide = bookings.map((b) => { const gid = b.date && b.slotIdx != null ? aMap.get(`${b.date}|${b.slotIdx}`) : undefined; return { ...b, guideId: gid ?? null, guide: gid ? (aName.get(gid) ?? gid) : null }; });
  // "Incoming" = tours still to come: drop today's slots whose start time has already
  // passed (e.g. this morning's 08:30 once it's run). Future + undated bookings stay.
  const nowMin = (() => { const d = new Date(Date.now() + 7 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
  const slotMin = (i: number | null) => { const t = i != null ? SLOT_TIMES[i] : undefined; if (!t) return 24 * 60; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const upcoming = withGuide.filter((b) => !(b.date === today && slotMin(b.slotIdx) <= nowMin));
  return NextResponse.json({ bookings: upcoming, tours });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actorId = session!.user!.id ?? null, actorRole = session!.user!.role ?? null;
  const body = await req.json().catch(() => null);
  const action = body?.action;

  // Manually add a booking (e.g. Viator) into the same inbox.
  if (action === "add") {
    const parsed = z.object({
      confirmationCode: z.string().max(80).optional(), productName: z.string().max(160).optional(),
      tourId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1), pax: z.number().int().min(1).max(50).optional(),
      customerName: z.string().max(160).optional(), source: z.string().max(20).optional(),
      nationality: z.string().max(80).optional(), email: z.string().max(160).optional(), phone: z.string().max(40).optional(),
      specialRequests: z.string().max(500).optional(), notes: z.string().max(500).optional(),
      bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), paymentStatus: z.string().max(20).optional(),
    }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const d = parsed.data;
    const b = await prisma.booking.create({
      data: {
        source: d.source || "manual", confirmationCode: d.confirmationCode ?? null, productName: d.productName ?? null,
        tourId: d.tourId, date: d.date, slotIdx: d.slotIdx, pax: d.pax ?? null, customerName: d.customerName ?? null,
        nationality: d.nationality ?? null, email: d.email ?? null, phone: d.phone ?? null,
        specialRequests: d.specialRequests ?? null, notes: d.notes ?? null,
        bookingDate: d.bookingDate ?? null, paymentStatus: d.paymentStatus || "unpaid", status: "PENDING",
      },
    });
    // If the slot is already assigned to a guide, attach this booking to their job now.
    await autoAttachLate(b);
    await audit({ actorId, actorRole, action: "booking.added", entityType: "Booking", entityId: b.id });
    return NextResponse.json({ ok: true, booking: b });
  }

  // Edit / map a booking (fix the tour, slot, date, pax).
  if (action === "update") {
    const parsed = z.object({
      id: z.string().min(1), tourId: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1).optional(), pax: z.number().int().min(1).max(50).optional(),
      confirmationCode: z.string().max(80).optional(), customerName: z.string().max(160).optional(),
      nationality: z.string().max(80).optional(), email: z.string().max(160).optional(), phone: z.string().max(40).optional(),
      specialRequests: z.string().max(500).optional(), notes: z.string().max(500).optional(),
      paymentStatus: z.enum(["unpaid", "deposit", "paid"]).optional(),
      status: z.enum(["PENDING", "OFFERED", "ASSIGNED", "CANCELLED", "IGNORED"]).optional(),
    }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const { id, ...rest } = parsed.data;
    const b = await prisma.booking.update({ where: { id }, data: rest });
    // Learn the product → tour mapping so future bookings of this product auto-map,
    // and back-apply it to other pending bookings of the same product. NEVER learn
    // from a bare channel name (e.g. "GetYourGuide") — that would overwrite the
    // channel default and re-file every booking of that channel onto one tour. For
    // those, we just set this single booking's tour.
    if (rest.tourId && b.productName && !isChannelProductName(b.productName)) {
      const key = productKey(b.productName);
      await prisma.productMap.upsert({
        where: { productKey: key },
        create: { productKey: key, productName: b.productName, tourId: rest.tourId },
        update: { tourId: rest.tourId, productName: b.productName },
      });
      await prisma.booking.updateMany({
        where: { productName: b.productName, tourId: null, status: { in: ["PENDING"] } },
        data: { tourId: rest.tourId },
      });
    }
    // Setting a tour/slot may now match an assigned slot — attach to that guide.
    await autoAttachLate(b);
    return NextResponse.json({ ok: true, booking: b });
  }

  // Hide a booking from the inbox (sticky — survives a Bokun re-send).
  if (action === "ignore") {
    const id = z.string().min(1).safeParse(body?.id);
    if (!id.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    await prisma.booking.update({ where: { id: id.data }, data: { status: "IGNORED" } });
    return NextResponse.json({ ok: true });
  }

  // Permanently remove a booking (drafts can be removed anytime).
  if (action === "delete") {
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1) }).or(z.object({ id: z.string().min(1) })).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const ids = "ids" in parsed.data ? parsed.data.ids : [parsed.data.id];
    await prisma.booking.deleteMany({ where: { id: { in: ids } } });
    await audit({ actorId, actorRole, action: "booking.deleted", entityType: "Booking", detail: { count: ids.length } });
    return NextResponse.json({ ok: true });
  }

  // Mark a set of bookings as offered (after the operator sent the job offer).
  if (action === "markOffered") {
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    await prisma.booking.updateMany({ where: { id: { in: parsed.data.ids } }, data: { status: "OFFERED" } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
