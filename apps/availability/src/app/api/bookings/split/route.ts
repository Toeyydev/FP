import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { bookingRef } from "@/lib/booking-ref";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";
import { pushTourToCalendars, removeTourEvents } from "@/lib/tour-calendar-sync";
import { PAX_PER_GUIDE } from "@/lib/capacity";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const CAP = PAX_PER_GUIDE;

type SheetRow = { name?: string; bookingNo?: string; [k: string]: unknown };

// POST { date, slotIdx, tourId, groups:[{ guideId, bookingIds[] }] } — split a slot
// across guides. Each booking (whole, never a family) is tagged to its guide, an
// assignment is created/updated per guide with that guide's pax, and each guide's
// job sheet is pruned to just their guests (the sheets stay separated). Works on an
// UNASSIGNED slot (first dispatch) OR an already-assigned one (re-split into a hybrid
// two-guide tour) — a guide left with no guests is dropped and told. Every guide on
// the split is notified (in-app + push + LINE) and their calendar is refreshed.
// Enforces the 10-seat cap per group.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    tourId: z.string().min(1),
    groups: z.array(z.object({ guideId: z.string().min(1), bookingIds: z.array(z.string().min(1)).min(1) })).min(1),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, tourId, groups } = parsed.data;

  const ids = groups.flatMap((g) => g.bookingIds);
  // A booking may belong to at most ONE group — otherwise it would be counted and
  // listed under two guides (the duplicated-booking bug). Reject overlaps outright.
  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupIds.length) return NextResponse.json({ error: "duplicate-booking", ids: dupIds }, { status: 400 });
  const bookings = await prisma.booking.findMany({ where: { id: { in: ids } }, select: { id: true, pax: true, confirmationCode: true, customerName: true, externalRef: true } });
  const byId = new Map(bookings.map((b) => [b.id, b]));

  // Validate every group is within the seat cap before writing anything.
  for (const g of groups) {
    const pax = g.bookingIds.reduce((s, id) => s + (byId.get(id)?.pax ?? 0), 0);
    if (pax > CAP) return NextResponse.json({ error: "over-cap", guideId: g.guideId, pax, cap: CAP }, { status: 400 });
  }

  // Guides already holding this slot before the split — any not in the new split are
  // being dropped from the tour and get cleaned up + notified below.
  const priorAssignments = await prisma.assignment.findMany({ where: { date, slotIdx } });
  const newGuideIds = new Set(groups.map((g) => g.guideId));

  // A booking's identity keys (GYG ref / confirmation code), used to prune a stale
  // saved job sheet down to only the guests that stayed with this guide.
  const refKeysOf = (b: { externalRef: string | null; confirmationCode: string | null }) =>
    [b.externalRef, b.confirmationCode].map((x) => (x || "").trim().toLowerCase()).filter(Boolean);

  for (const g of groups) {
    const groupBookings = g.bookingIds.map((id) => byId.get(id)).filter(Boolean) as { id: string; pax: number | null; confirmationCode: string | null; customerName: string | null; externalRef: string | null }[];
    const pax = groupBookings.reduce((s, b) => s + (b.pax ?? 0), 0) || null;
    const note = `${groupBookings.length} booking(s): ${groupBookings.map((b) => bookingRef(b.externalRef, b.confirmationCode) || b.customerName || "—").join(", ")}`.slice(0, 280);
    await prisma.booking.updateMany({ where: { id: { in: g.bookingIds } }, data: { assignedGuideId: g.guideId, status: "OFFERED" } });
    await prisma.assignment.upsert({
      where: { guideId_date_slotIdx: { guideId: g.guideId, date, slotIdx } },
      create: { guideId: g.guideId, date, slotIdx, tourId, pax, note },
      update: { tourId, pax, note },
    });

    // Prune this guide's saved sheet (if any) to their guests only — drop rows whose
    // booking number now belongs to another guide. Manual rows (no number) stay.
    const accepted = new Set(groupBookings.flatMap(refKeysOf));
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: g.guideId, date, slotIdx } } });
    if (sheet && Array.isArray(sheet.bookings)) {
      const rows = sheet.bookings as SheetRow[];
      const kept = rows.filter((r) => { const rn = (r.bookingNo || "").trim().toLowerCase(); return !rn || accepted.has(rn); });
      if (kept.length !== rows.length) await prisma.jobSheet.update({ where: { guideId_date_slotIdx: { guideId: g.guideId, date, slotIdx } }, data: { bookings: kept as unknown as Prisma.InputJsonValue } });
    }
  }

  // Guides who held the slot but got no guests in the new split: undo their job
  // (mirrors the assignment DELETE cleanup) so it doesn't linger as a phantom.
  const removed = priorAssignments.filter((a) => !newGuideIds.has(a.guideId));
  for (const a of removed) {
    try { await removeTourEvents(a); } catch { /* calendar cleanup is best-effort */ }
    await prisma.assignment.deleteMany({ where: { guideId: a.guideId, date, slotIdx } });
    // Any guest still tagged to this dropped guide (not moved into a new group) is
    // freed back to the inbox, so it isn't left orphaned on a guide with no assignment.
    await prisma.booking.updateMany({ where: { date, slotIdx, assignedGuideId: a.guideId }, data: { assignedGuideId: null, status: "PENDING" } });
    await Promise.all([
      prisma.jobSheet.deleteMany({ where: { guideId: a.guideId, date, slotIdx } }),
      prisma.checkin.deleteMany({ where: { guideId: a.guideId, date, slotIdx } }),
      prisma.tourReport.deleteMany({ where: { guideId: a.guideId, date, slotIdx } }),
      prisma.guideRating.deleteMany({ where: { guideId: a.guideId, date, slotIdx } }),
      prisma.jobOffer.updateMany({ where: { date, slotIdx, assignedGuideId: a.guideId, status: { not: "EXPIRED" } }, data: { status: "CANCELLED", assignedGuideId: null } }),
    ]);
  }

  // Tell everyone affected + refresh calendars. All best-effort — never block the split.
  const tour = await prisma.tour.findUnique({ where: { id: tourId }, select: { name: true } });
  const when = `${date} · ${SLOT_TIMES[slotIdx] ?? ""}`;
  const tname = tour?.name ?? tourId;
  const shared = groups.length > 1;
  for (const g of groups) {
    const pax = g.bookingIds.reduce((s, id) => s + (byId.get(id)?.pax ?? 0), 0);
    try { await pushTourToCalendars(g.guideId, date, slotIdx); } catch { /* never block on calendar */ }
    try {
      const u = await prisma.user.findFirst({ where: { guideId: g.guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true } });
      if (u) {
        const msg = shared
          ? `Shared tour: ${tname} · ${when} · your group ${pax} pax. You're guiding this alongside another guide.`
          : `You're assigned: ${tname} · ${when} · ${pax} pax.`;
        await prisma.notification.create({ data: { userId: u.id, kind: "job-change", message: msg } });
        await sendPushToUser(u.id, { title: shared ? "Tour split — your group" : "New tour assigned", body: `${tname} · ${when} · ${pax} pax`, url: "/", tag: `split-${date}-${slotIdx}-${g.guideId}` });
        if (lineEnabled && u.lineUserId) await linePush(u.lineUserId, msg);
      }
    } catch { /* notifying the guide is best-effort */ }
  }
  for (const a of removed) {
    try {
      const u = await prisma.user.findFirst({ where: { guideId: a.guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true } });
      if (u) {
        const msg = `Your tour was reassigned: ${tname} · ${when}. You are no longer on it.`;
        await prisma.notification.create({ data: { userId: u.id, kind: "job-change", message: msg } });
        await sendPushToUser(u.id, { title: "Tour removed", body: `${tname} · ${when}`, url: "/", tag: `removed-${date}-${slotIdx}` });
        if (lineEnabled && u.lineUserId) await linePush(u.lineUserId, msg);
      }
    } catch { /* best-effort */ }
  }

  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bookings.split", entityType: "Booking", detail: { date, slotIdx, groups: groups.length, removed: removed.length } });
  return NextResponse.json({ ok: true, groups: groups.length });
}
