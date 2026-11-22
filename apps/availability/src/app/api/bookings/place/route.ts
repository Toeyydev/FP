import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { PAX_PER_GUIDE } from "@/lib/capacity";
import { bookingRef } from "@/lib/booking-ref";
import { handoverLock } from "@/lib/tour-handover-server";
import { reconcileDeparture } from "@/lib/booking-reconcile";
import { pushTourToCalendars } from "@/lib/tour-calendar-sync";
import { tourStartMs } from "@/lib/no-show-count";

export const dynamic = "force-dynamic";

const LIVE = ["PENDING", "OFFERED", "ASSIGNED"];

// POST { bookingIds[], guideId } — give new bookings to one of the guides already on their
// tour (owner, 22 Nov 2026): on a departure several guides share, a booking that arrives later
// is tagged to none of them, and an operator decides who takes it to balance the groups.
//
// Only bookings nobody has yet, all at one departure and tour, to a guide who runs that tour
// there, within the seat cap, before the tour starts. The booking is tagged, then the
// departure is reconciled (lib/booking-reconcile) — the one path that puts guests on a job
// sheet, updates the guide's pax and tells the guide. Nobody else on the tour is touched.
export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "OPERATOR" && role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ bookingIds: z.array(z.string().min(1)).min(1).max(50), guideId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const ids = [...new Set(parsed.data.bookingIds)];
  const { guideId } = parsed.data;

  const bookings = await prisma.booking.findMany({ where: { id: { in: ids } }, select: { id: true, date: true, slotIdx: true, tourId: true, status: true, assignedGuideId: true, pax: true, externalRef: true, confirmationCode: true } });
  if (bookings.length !== ids.length) return NextResponse.json({ error: "not-found", detail: "A booking is no longer there — reload Bookings." }, { status: 404 });
  const [first] = bookings;
  const { date, slotIdx, tourId } = first;
  if (!date || slotIdx == null || !tourId || bookings.some((b) => b.date !== date || b.slotIdx !== slotIdx || b.tourId !== tourId)) {
    return NextResponse.json({ error: "mixed-departure", detail: "The bookings must all be on one tour at one time." }, { status: 400 });
  }
  if (bookings.some((b) => !LIVE.includes(b.status))) return NextResponse.json({ error: "not-live", detail: "A booking was cancelled or removed — reload Bookings." }, { status: 409 });
  if (bookings.some((b) => b.assignedGuideId)) return NextResponse.json({ error: "already-placed", detail: "A booking already has a guide — reload Bookings." }, { status: 409 });
  if (tourStartMs(date, slotIdx) <= Date.now()) return NextResponse.json({ error: "started", detail: "This tour has started — change its guests on the job sheet." }, { status: 409 });

  const onTour = await prisma.assignment.findFirst({ where: { guideId, date, slotIdx, tourId }, select: { id: true } });
  if (!onTour) return NextResponse.json({ error: "guide-not-on-tour", detail: `${guideId} does not run this tour at this time.` }, { status: 400 });
  const handover = await handoverLock(date, slotIdx);
  if (handover) return NextResponse.json({ error: "handover-on-slot", detail: handover }, { status: 409 });

  const adding = bookings.reduce((s, b) => s + (b.pax ?? 0), 0);
  const held = (await prisma.booking.aggregate({ where: { date, slotIdx, tourId, assignedGuideId: guideId, status: { in: LIVE } }, _sum: { pax: true } }))._sum.pax ?? 0;
  if (held + adding > PAX_PER_GUIDE) {
    return NextResponse.json({ error: "over-cap", detail: `${guideId} would have ${held + adding} guests — over ${PAX_PER_GUIDE}. Give them to another guide, or Split.` }, { status: 400 });
  }

  // Tag only what is still untagged: two operators pressing at once cannot both win.
  const tagged = await prisma.booking.updateMany({ where: { id: { in: ids }, assignedGuideId: null, status: { in: LIVE } }, data: { assignedGuideId: guideId, status: "OFFERED" } });
  if (tagged.count !== ids.length) {
    if (tagged.count) await prisma.booking.updateMany({ where: { id: { in: ids }, assignedGuideId: guideId }, data: { assignedGuideId: null, status: "PENDING" } });
    return NextResponse.json({ error: "already-placed", detail: "Someone placed these bookings at the same time — reload Bookings." }, { status: 409 });
  }

  const refs = bookings.map((b) => bookingRef(b.externalRef, b.confirmationCode) || b.id);
  await audit({ actorId: session!.user!.id ?? null, actorRole: role, action: "bookings.placed", entityType: "Booking", detail: { date, slotIdx, tourId, guideId, bookings: refs, pax: adding, guidePaxBefore: held } });

  await reconcileDeparture({ date, slotIdx }, { source: "manual-sync", reason: `operator gave ${refs.join(", ")} to ${guideId}` });
  try { await pushTourToCalendars(guideId, date, slotIdx); } catch { /* the calendar never blocks this */ }
  // On the guide's job sheet now? Read it back rather than trust the run's bookkeeping.
  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { bookings: true } });
  const onRows = new Set(((sheet?.bookings as unknown as { bookingNo?: string }[]) ?? []).map((r) => (r.bookingNo ?? "").trim().toLowerCase()));
  const onSheet = bookings.every((b) => [b.externalRef, b.confirmationCode].some((k) => k && onRows.has(k.trim().toLowerCase())));
  return NextResponse.json({
    ok: true, guideId, pax: held + adding, onSheet,
    // Tagged either way; if the job sheet could not take the rows now (e.g. it is approved),
    // the review it raised says why and the sweep retries.
    detail: onSheet ? null : "Given to the guide, but the job sheet was not updated — check it.",
  });
}
