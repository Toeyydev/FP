import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_COUNT } from "@/lib/slots";
import { productKey } from "@/lib/bookings";
import { todayD, ymd } from "@/lib/dates";
import { reconcileAssignedBookings } from "@/lib/booking-import";

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
    const q = (sp.get("q") || "").trim();
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (source) where.source = source;
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
    return NextResponse.json({ bookings, tours });
  }

  // Auto-combine: fold any pending booking whose slot is already assigned into that
  // guide's job before listing, so the inbox self-reconciles with no manual step.
  await reconcileAssignedBookings();

  // Hide bookings whose tour date has already passed (Bangkok civil date) from the
  // incoming inbox — keep undated bookings (date == null) because those still need
  // the operator to map a date. Past bookings remain in the full ?view=all history.
  const today = ymd(todayD());
  const [bookings, tours] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: ["PENDING", "OFFERED", "ASSIGNED"] },
        OR: [{ date: null }, { date: { gte: today } }],
      },
      orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { createdAt: "asc" }],
      take: 500,
      select: { id: true, source: true, confirmationCode: true, productName: true, tourId: true, date: true, startTime: true, slotIdx: true, pax: true, customerName: true, status: true },
    }),
    prisma.tour.findMany({ orderBy: { id: "asc" } }),
  ]);
  return NextResponse.json({ bookings, tours });
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
    // and back-apply it to other pending bookings of the same product.
    if (rest.tourId && b.productName) {
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
