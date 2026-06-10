import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { sendTourCalendarInvite } from "@/lib/calendar";
import { linePushButtons, lineEnabled } from "@/lib/line";
import { sendPushToUser } from "@/lib/push";
import { sendEmail } from "@/lib/email";

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
      prisma.user.findFirst({ where: { guideId: o.onlyGuideId, role: "GUIDE", state: "ACTIVE" }, select: { id: true, guideId: true, displayName: true, lineUserId: true, email: true } }),
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
  const summary = `Folkpaths job offer\n${tour.name}\n${dateLabel} · ${timeLabel}${o.pax != null ? `\nTotal: ${o.pax} Pax · 1 Job` : ""}${o.note ? `\n${o.note}` : ""}`;
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
    // Email is the catch-all channel: reaches guides with no app install / no LINE.
    if (g.email) await sendEmail({
      to: g.email,
      subject: `New job offer \u2014 ${tour.name}`,
      text: `${summary}\n\nOpen the app to accept or pass: https://guide.folkpaths.com/`,
      html: `<p>You have a new job offer:</p><p><b>${tour.name}</b><br>${dateLabel} \u00b7 ${timeLabel}${o.pax != null ? ` \u00b7 ${o.pax} pax` : ""}${o.note ? `<br>${o.note}` : ""}</p><p><a href="https://guide.folkpaths.com/">Open the app to accept or pass</a></p>`,
    }).catch(() => {});
    if (lineEnabled && g.lineUserId) {
      const firstName = (g.displayName || "").split(" ")[0];
      await linePushButtons(g.lineUserId, `Folkpaths job offer for ${g.displayName}`, `${firstName ? firstName + ", " : ""}${btnText}`, [
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
      select: { id: true, guideId: true, displayName: true, lineUserId: true, email: true },
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
  // Push to connected Google Calendars (guide + operator master), if configured.
  try { await (await import("@/lib/tour-calendar-sync")).pushTourToCalendars(guideId, offer.date, offer.slotIdx); } catch { /* never block accept on calendar */ }

  // Tell the operator team a guide took the job (in-app + push). Covers BOTH the
  // in-app and LINE accept paths, and works even for auto re-offers (no creator).
  try {
    const [g, tour, opsUsers] = await Promise.all([
      prisma.user.findFirst({ where: { guideId }, select: { displayName: true } }),
      prisma.tour.findUnique({ where: { id: offer.tourId }, select: { name: true } }),
      prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } }),
    ]);
    const who = `${guideId}${g?.displayName ? ` ${g.displayName}` : ""}`;
    const msg = `${who} accepted ${tour?.name ?? offer.tourId} · ${slotLabel(offer.slotIdx)} · ${offer.date}`;
    for (const o of opsUsers) {
      await prisma.notification.create({ data: { userId: o.id, kind: "offer", message: msg } });
      await sendPushToUser(o.id, { title: "Job accepted", body: msg, url: "/jobs", tag: `accepted-${offer.id}` });
    }
  } catch { /* never block accept on notifying the operator */ }

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

// How many hours before the tour an unaccepted offer is handed back to operators.
const ESCALATE_HOURS_BEFORE_TOUR = 5;

// Bangkok start time (ms since epoch) of an offer's tour slot.
function tourStartMs(date: string, slotIdx: number): number {
  const [h, m] = (SLOT_TIMES[slotIdx] || "00:00").split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600 * 1000;
}

// Hand an OPEN offer back to the operators when nobody has accepted: either it
// passed its TTL, or the tour is now within 5 hours. Alerts the whole operator
// team (in-app + push) to assign a guide manually, and clears it from guides'
// bells. Runs from the cron AND on every operator dashboard load, so it fires
// even without a scheduler. Idempotent — an already-EXPIRED offer is skipped.
export async function sweepExpiredOffers(): Promise<number> {
  const now = Date.now();
  const open = await prisma.jobOffer.findMany({ where: { status: "OPEN" } });
  const due = open.filter((o) => o.expiresAt.getTime() < now || tourStartMs(o.date, o.slotIdx) - now <= ESCALATE_HOURS_BEFORE_TOUR * 3600_000);
  if (due.length === 0) return 0;

  const [tours, opsUsers] = await Promise.all([
    prisma.tour.findMany({ where: { id: { in: due.map((o) => o.tourId) } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  for (const o of due) {
    // Close the offer (race-safe) and clear it from every guide's bell.
    const won = await prisma.jobOffer.updateMany({ where: { id: o.id, status: "OPEN" }, data: { status: "EXPIRED" } });
    if (won.count !== 1) continue; // someone else handled it
    await prisma.notification.deleteMany({ where: { offerId: o.id } });
    const msg = `No guide accepted ${tourName.get(o.tourId) ?? o.tourId} · ${slotLabel(o.slotIdx)} · ${o.date}. Please assign a guide.`;
    for (const op of opsUsers) {
      await prisma.notification.create({ data: { userId: op.id, kind: "offer", message: msg } });
      await sendPushToUser(op.id, { title: "Job needs assigning", body: msg, url: "/jobs", tag: `unfilled-${o.id}` });
    }
  }
  return due.length;
}
