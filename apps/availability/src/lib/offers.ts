import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { sendTourCalendarInvite } from "@/lib/calendar";
import { linePushButtons, lineEnabled } from "@/lib/line";
import { sendPushToUser } from "@/lib/push";

// Create and broadcast a job offer to every available guide (in-app + push +
// LINE buttons). Reused by the operator endpoint and by auto re-offer on cancel.
export async function createOffer(o: {
  tourId: string; date: string; slotIdx: number; pax?: number | null; note?: string | null;
  durationMin?: number | null; ttlMinutes?: number; createdById?: string | null; excludeGuideId?: string | null;
  onlyGuideId?: string | null;
}): Promise<{ offerId: string | null; candidates: number; lineSent: number; noTour?: boolean }> {
  const tour = await prisma.tour.findUnique({ where: { id: o.tourId } });
  if (!tour) return { offerId: null, candidates: 0, lineSent: 0, noTour: true };

  let candidates;
  if (o.onlyGuideId) {
    // Manual pick: offer to this one guide (operator override), unless they're
    // already booked that slot.
    const [g, assigned] = await Promise.all([
      prisma.user.findFirst({ where: { guideId: o.onlyGuideId, role: "GUIDE", state: "ACTIVE" }, select: { id: true, guideId: true, displayName: true, lineUserId: true } }),
      prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId: o.onlyGuideId, date: o.date, slotIdx: o.slotIdx } } }),
    ]);
    candidates = g && g.guideId && !assigned ? [g] : [];
  } else {
    candidates = await availableGuides(o.date, o.slotIdx);
    if (o.excludeGuideId) candidates = candidates.filter((g) => g.guideId !== o.excludeGuideId);
  }
  if (candidates.length === 0) return { offerId: null, candidates: 0, lineSent: 0 };

  const ttl = o.ttlMinutes ?? 60;
  const dateLabel = new Date(`${o.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const timeLabel = timeRangeLabel(o.slotIdx, o.durationMin ?? undefined);
  const summary = `Folkpath job offer\n${tour.name}\n${dateLabel} · ${timeLabel}${o.pax != null ? `\nTotal: ${o.pax} Pax · 1 Job` : ""}${o.note ? `\n${o.note}` : ""}`;
  const btnText = `${tour.name} · ${dateLabel} · ${timeLabel}${o.pax != null ? ` · ${o.pax} pax` : ""}`;

  const offer = await prisma.jobOffer.create({
    data: {
      tourId: o.tourId, date: o.date, slotIdx: o.slotIdx, durationMin: o.durationMin ?? null, pax: o.pax ?? null, note: o.note ?? null,
      status: "OPEN", expiresAt: new Date(Date.now() + ttl * 60_000), createdById: o.createdById ?? null,
      responses: { create: candidates.map((g) => ({ guideId: g.guideId!, response: "OFFERED" })) },
    },
  });

  let lineSent = 0;
  for (const g of candidates) {
    await prisma.notification.create({ data: { userId: g.id, kind: "offer", offerId: offer.id, message: `${summary}\n(open the app to Accept or Deny)` } });
    await sendPushToUser(g.id, { title: "New job offer", body: btnText, url: "/", tag: `offer-${offer.id}` });
    if (lineEnabled && g.lineUserId) {
      const firstName = (g.displayName || "").split(" ")[0];
      await linePushButtons(g.lineUserId, `Folkpath job offer for ${g.displayName}`, `${firstName ? firstName + ", " : ""}${btnText}`, [
        { label: "✅ Accept", data: `offer:accept:${offer.id}`, displayText: "Accept" },
        { label: "❌ Deny", data: `offer:deny:${offer.id}`, displayText: "Deny" },
      ]);
      lineSent++;
    }
  }
  return { offerId: offer.id, candidates: candidates.length, lineSent };
}

// Guides who are AVAILABLE for a given date + slot:
//  - active guide with a G-id
//  - NOT marked busy for that slot (availability.slots[idx] === true means busy)
//  - NOT already assigned that slot
//  - the day is not company-blocked
export async function availableGuides(date: string, slotIdx: number) {
  const blocked = await prisma.blockedDate.findUnique({ where: { date } }).catch(() => null);
  if (blocked) return [];

  const [guides, avail, assigned, leaves] = await Promise.all([
    prisma.user.findMany({
      where: { role: "GUIDE", state: "ACTIVE", guideId: { not: null } },
      select: { id: true, guideId: true, displayName: true, lineUserId: true },
    }),
    prisma.availability.findMany({ where: { date }, select: { guideId: true, slots: true } }),
    prisma.assignment.findMany({ where: { date, slotIdx }, select: { guideId: true } }),
    prisma.leaveRequest.findMany({ where: { status: "APPROVED", fromDate: { lte: date }, toDate: { gte: date } }, select: { guideId: true } }),
  ]);

  const busy = new Set(avail.filter((a) => a.slots[slotIdx] === true).map((a) => a.guideId));
  const taken = new Set(assigned.map((a) => a.guideId));
  const onLeave = new Set(leaves.map((l) => l.guideId));
  return guides.filter((g) => g.guideId && !busy.has(g.guideId) && !taken.has(g.guideId) && !onLeave.has(g.guideId));
}

export function slotLabel(slotIdx: number) {
  return SLOT_TIMES[slotIdx] ?? `slot ${slotIdx}`;
}

// "10:00–13:00 (3h)" so the guide can see when they're free again. If no
// duration is given, just the start time.
export function timeRangeLabel(slotIdx: number, durationMin?: number | null): string {
  const start = SLOT_TIMES[slotIdx] ?? "";
  if (!durationMin || durationMin <= 0) return start;
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  const eh = Math.floor(total / 60) % 24, em = total % 60;
  const end = `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
  const hrs = durationMin % 60 === 0 ? `${durationMin / 60}h` : `${Math.floor(durationMin / 60)}h${durationMin % 60}m`;
  return `${start}–${end} (${hrs})`;
}

export type AcceptResult =
  | { ok: true; offer: { id: string; date: string; slotIdx: number; tourId: string } }
  | { ok: false; reason: "taken" | "expired" | "closed" | "not-offered" };

// Atomic first-wins accept. The conditional updateMany (status OPEN + not expired)
// can only succeed for ONE concurrent caller, so a race resolves to a single winner.
export async function acceptOffer(offerId: string, guideId: string): Promise<AcceptResult> {
  const offer = await prisma.jobOffer.findUnique({ where: { id: offerId } });
  if (!offer) return { ok: false, reason: "closed" };
  if (offer.status === "ASSIGNED") return { ok: false, reason: "taken" };
  if (offer.status !== "OPEN") return { ok: false, reason: "closed" };
  if (offer.expiresAt.getTime() < Date.now()) {
    await prisma.jobOffer.updateMany({ where: { id: offerId, status: "OPEN" }, data: { status: "EXPIRED" } });
    return { ok: false, reason: "expired" };
  }

  // The race-safe claim: only one updateMany matches status=OPEN and flips it.
  const won = await prisma.jobOffer.updateMany({
    where: { id: offerId, status: "OPEN", expiresAt: { gt: new Date() } },
    data: { status: "ASSIGNED", assignedGuideId: guideId },
  });
  if (won.count !== 1) return { ok: false, reason: "taken" };

  await prisma.assignment.upsert({
    where: { guideId_date_slotIdx: { guideId, date: offer.date, slotIdx: offer.slotIdx } },
    create: { guideId, date: offer.date, slotIdx: offer.slotIdx, tourId: offer.tourId, pax: offer.pax ?? null, note: offer.note ?? null },
    update: { tourId: offer.tourId, pax: offer.pax ?? null, note: offer.note ?? null },
  });
  await prisma.jobOfferResponse.updateMany({ where: { offerId, guideId }, data: { response: "ACCEPTED", respondedAt: new Date() } });
  // Offer is resolved — clear its notification from EVERY candidate's bell.
  await prisma.notification.deleteMany({ where: { offerId } });
  // Email the guide a calendar invite (with reminders).
  await sendTourCalendarInvite(guideId, offer.date, offer.slotIdx);

  return { ok: true, offer: { id: offer.id, date: offer.date, slotIdx: offer.slotIdx, tourId: offer.tourId } };
}

export async function denyOffer(offerId: string, guideId: string): Promise<"ok" | "closed"> {
  const offer = await prisma.jobOffer.findUnique({ where: { id: offerId } });
  if (!offer) return "closed";
  await prisma.jobOfferResponse.updateMany({ where: { offerId, guideId }, data: { response: "DENIED", respondedAt: new Date() } });
  // Remove the offer from the denying guide's bell.
  const u = await prisma.user.findUnique({ where: { guideId }, select: { id: true } });
  if (u) await prisma.notification.deleteMany({ where: { offerId, userId: u.id } });
  return "ok";
}

// Expire OPEN offers past their deadline and alert the operator who made them,
// so a job that nobody accepted never goes silently unfilled.
export async function sweepExpiredOffers(): Promise<number> {
  const stale = await prisma.jobOffer.findMany({ where: { status: "OPEN", expiresAt: { lt: new Date() } } });
  if (stale.length === 0) return 0;
  const tours = await prisma.tour.findMany({ where: { id: { in: stale.map((o) => o.tourId) } }, select: { id: true, name: true } });
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  for (const o of stale) {
    await prisma.jobOffer.updateMany({ where: { id: o.id, status: "OPEN" }, data: { status: "EXPIRED" } });
    await prisma.notification.deleteMany({ where: { offerId: o.id } }); // clear the dead offer from guides' bells
    if (o.createdById) {
      await prisma.notification.create({
        data: { userId: o.createdById, kind: "offer", message: `⏰ No one accepted: ${tourName.get(o.tourId) ?? o.tourId} · ${slotLabel(o.slotIdx)} · ${o.date}. Needs manual assignment.` },
      });
    }
  }
  return stale.length;
}
