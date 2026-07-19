import { prisma } from "@/lib/db";
import { SLOT_TIMES, clashingSlotIdxs } from "@/lib/slots";
import { sendTourCalendarInvite } from "@/lib/calendar";
import { linePushButtons, linePush, lineEnabled } from "@/lib/line";
import { sendPushToUser } from "@/lib/push";
import { sendEmail } from "@/lib/email";
import { signOfferAction } from "@/lib/offer-token";

// Create and broadcast a job offer to every available guide (in-app + push +
// LINE buttons). Reused by the operator endpoint and by auto re-offer on cancel.
// Delete a "prepped" job sheet (one the operator made before a guide accepted) once
// that guide is out of the running — only if they have NO assignment and NO check-in
// for the slot, so a real or imported sheet is never touched.
async function cleanupPreppedSheet(guideId: string, date: string, slotIdx: number) {
  try {
    const [assigned, checked] = await Promise.all([
      prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true } }),
      prisma.checkin.count({ where: { guideId, date, slotIdx } }),
    ]);
    if (assigned || checked > 0) return;
    await prisma.jobSheet.deleteMany({ where: { guideId, date, slotIdx } });
  } catch { /* best-effort cleanup */ }
}

export async function createOffer(o: {
  tourId: string; date: string; slotIdx: number; pax?: number | null; note?: string | null;
  durationMin?: number | null; ttlMinutes?: number; createdById?: string | null; excludeGuideId?: string | null;
  onlyGuideId?: string | null;
}): Promise<{ offerId: string | null; candidates: number; lineSent: number; noTour?: boolean }> {
  const tour = await prisma.tour.findUnique({ where: { id: o.tourId } });
  if (!tour) return { offerId: null, candidates: 0, lineSent: 0, noTour: true };

  let candidates;
  if (o.onlyGuideId) {
    // Manual pick: offer to this one guide — but only if they're genuinely free
    // for the slot (not busy/blocked, not on leave, not already assigned). Same
    // rule as a broadcast, so a guide who blocked the slot can't be offered it.
    const free = await availableGuides(o.date, o.slotIdx);
    const g = free.find((x) => x.guideId === o.onlyGuideId);
    candidates = g ? [g] : [];
  } else {
    candidates = await availableGuides(o.date, o.slotIdx);
    if (o.excludeGuideId) candidates = candidates.filter((g) => g.guideId !== o.excludeGuideId);
  }
  if (candidates.length === 0) return { offerId: null, candidates: 0, lineSent: 0 };

  // A job offered to one specific guide gets a 2-hour accept-or-return window;
  // a broadcast-to-all offer keeps the shorter default.
  const ttl = o.ttlMinutes ?? (o.onlyGuideId ? 120 : 60);
  const dateLabel = new Date(`${o.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const timeLabel = timeRangeLabel(o.slotIdx, o.durationMin ?? undefined);
  const summary = `Folkpaths job offer\n${tour.name}\n${dateLabel} · ${timeLabel}${o.pax != null ? `\nTotal: ${o.pax} Pax · 1 Job` : ""}${o.note ? `\n${o.note}` : ""}`;
  const btnText = `${tour.name} · ${dateLabel} · ${timeLabel}${o.pax != null ? ` · ${o.pax} pax` : ""}`;

  // Never leave two open offers on one slot: close any existing one first AND clear
  // it from the previously-offered guides' bells, so a later action (e.g. assign to a
  // specific guide after an "offer to all") fully supersedes the earlier broadcast —
  // the other guides no longer see a stale offer they can't take.
  const superseded = await prisma.jobOffer.findMany({ where: { date: o.date, slotIdx: o.slotIdx, status: "OPEN" }, select: { id: true } });
  if (superseded.length) {
    const ids = superseded.map((x) => x.id);
    await prisma.jobOffer.updateMany({ where: { id: { in: ids } }, data: { status: "EXPIRED" } });
    await prisma.notification.deleteMany({ where: { offerId: { in: ids } } });
  }
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
    if (g.email) {
      const acceptUrl = `https://guide.folkpaths.com/api/offers/respond?token=${signOfferAction(offer.id, g.guideId!, "accept")}`;
      const denyUrl = `https://guide.folkpaths.com/api/offers/respond?token=${signOfferAction(offer.id, g.guideId!, "deny")}`;
      await sendEmail({
        to: g.email,
        subject: `New job offer \u2014 ${tour.name}`,
        text: `${summary}\n\n\u2705 Accept this job: ${acceptUrl}\n\u274c Pass: ${denyUrl}\n\n(or open the app: https://guide.folkpaths.com/)`,
        html: `<p>You have a new job offer:</p><p><b>${tour.name}</b><br>${dateLabel} \u00b7 ${timeLabel}${o.pax != null ? ` \u00b7 ${o.pax} pax` : ""}${o.note ? `<br>${o.note}` : ""}</p><p><a href="${acceptUrl}" style="display:inline-block;background:#2e7d4f;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px">\u2705 Accept this job</a>&nbsp;&nbsp;<a href="${denyUrl}" style="color:#c2604a">Pass</a></p><p style="font-size:13px;color:#888">One tap \u2014 no login needed. Or <a href="https://guide.folkpaths.com/">open the app</a>.</p>`,
      }).catch(() => {});
    }
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
//  - NOT already assigned that slot OR a slot that clashes in time (same or within
//    the clash gap — a guide can't run two overlapping tours)
//  - the day is not company-blocked
export async function availableGuides(date: string, slotIdx: number) {
  const blocked = await prisma.blockedDate.findUnique({ where: { date } }).catch(() => null);
  if (blocked) return [];
  const slotBlocked = await prisma.blockedSlot.findUnique({ where: { date_slotIdx: { date, slotIdx } } }).catch(() => null);
  if (slotBlocked) return [];

  const [guides, avail, assigned, leaves] = await Promise.all([
    prisma.user.findMany({
      where: { role: "GUIDE", state: "ACTIVE", guideId: { not: null }, offerBlocked: false },
      select: { id: true, guideId: true, displayName: true, lineUserId: true, email: true },
    }),
    prisma.availability.findMany({ where: { date }, select: { guideId: true, slots: true } }),
    // Include any slot that clashes in time, not just this exact one, so a guide
    // already booked at (e.g.) 13:30 is not offered the 14:00 slot.
    prisma.assignment.findMany({ where: { date, slotIdx: { in: clashingSlotIdxs(slotIdx) } }, select: { guideId: true } }),
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
  | { ok: false; reason: "taken" | "expired" | "closed" | "not-offered" | "clash"; clashSlotIdx?: number };

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

  // Don't let one guide hold two tours that clash in time. Offers are broadcast
  // while the guide is still free, so a second offer for a nearby slot can be
  // sitting in their bell after they've taken the first — this is the accept-time
  // backstop availableGuides() can't provide at broadcast time. Checked before the
  // claim so a rejected accept leaves the offer OPEN for another guide.
  const clashSlots = clashingSlotIdxs(offer.slotIdx).filter((i) => i !== offer.slotIdx);
  if (clashSlots.length) {
    const clash = await prisma.assignment.findFirst({
      where: { guideId, date: offer.date, slotIdx: { in: clashSlots } },
      select: { slotIdx: true },
    });
    if (clash) return { ok: false, reason: "clash", clashSlotIdx: clash.slotIdx };
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
      prisma.user.findFirst({ where: { guideId }, select: { displayName: true, lineUserId: true } }),
      prisma.tour.findUnique({ where: { id: offer.tourId }, select: { name: true, meetingPoint: true } }),
      prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } }),
    ]);
    const who = `${guideId}${g?.displayName ? ` ${g.displayName}` : ""}`;
    const msg = `${who} accepted ${tour?.name ?? offer.tourId} · ${slotLabel(offer.slotIdx)} · ${offer.date}`;
    for (const o of opsUsers) {
      await prisma.notification.create({ data: { userId: o.id, kind: "offer", message: msg } });
      await sendPushToUser(o.id, { title: "Job accepted", body: msg, url: "/jobs", tag: `accepted-${offer.id}` });
    }

    // Congratulate the guide on LINE — mirrors the in-app celebration.
    if (lineEnabled && g?.lineUserId) {
      const first = (g.displayName ?? "").trim().split(/\s+/)[0];
      const dateLabel = new Date(`${offer.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      const lines = [
        `🎉 Congratulations${first ? ` ${first}` : ""}! You've got the job.`,
        ``,
        `${tour?.name ?? offer.tourId}`,
        `${dateLabel} · ${slotLabel(offer.slotIdx)}${offer.pax != null ? ` · ${offer.pax} pax` : ""}`,
        ...(tour?.meetingPoint ? [`📍 ${tour.meetingPoint}`] : []),
        ``,
        `It's now in your schedule. See you there!`,
      ];
      await linePush(g.lineUserId, lines.join("\n"));
    }
  } catch { /* never block accept on notifying the operator/guide */ }

  // The other candidates didn't get it — clear any sheet they had prepped for the slot.
  try {
    const others = await prisma.jobOfferResponse.findMany({ where: { offerId, guideId: { not: guideId } }, select: { guideId: true } });
    for (const r of others) await cleanupPreppedSheet(r.guideId, offer.date, offer.slotIdx);
  } catch { /* best-effort */ }

  return { ok: true, offer: { id: offer.id, date: offer.date, slotIdx: offer.slotIdx, tourId: offer.tourId } };
}

// Clear a guide's tag from a slot's bookings and return them to the operator inbox
// (PENDING). Called whenever a guide leaves a slot — assignment removed/cancelled,
// or a pre-tagged split offer declined — so a departing guide never leaves an
// "orphaned" tag: a booking still pointing at a guide who has no assignment for the
// slot, which silently jams re-dispatch (the offer/reassign actions can't act on
// it). Scoped to THIS guide, so a co-guide sharing the slot (hybrid split) is
// untouched.
export async function untagGuideSlotBookings(guideId: string, date: string, slotIdx: number): Promise<void> {
  await prisma.booking.updateMany({
    where: { date, slotIdx, assignedGuideId: guideId },
    data: { assignedGuideId: null, status: "PENDING" },
  });
}

export async function denyOffer(offerId: string, guideId: string): Promise<"ok" | "closed"> {
  const offer = await prisma.jobOffer.findUnique({ where: { id: offerId } });
  if (!offer) return "closed";
  await prisma.jobOfferResponse.updateMany({ where: { offerId, guideId }, data: { response: "DENIED", respondedAt: new Date() } });
  // Remove the offer from the denying guide's bell.
  const u = await prisma.user.findUnique({ where: { guideId }, select: { id: true } });
  if (u) await prisma.notification.deleteMany({ where: { offerId, userId: u.id } });
  await cleanupPreppedSheet(guideId, offer.date, offer.slotIdx);
  // If this offer had pre-tagged the guide's bookings (a hybrid-split offer), free
  // them back to the inbox so the declined group doesn't linger tagged to them.
  await untagGuideSlotBookings(guideId, offer.date, offer.slotIdx);

  // Once nobody who was offered this job can still accept it (a single-guide
  // assignment that was declined, or a broadcast everyone passed on), the job goes
  // straight back to the operators to reassign by hand. We never auto-offer it to a
  // fresh guide — the operator chooses who gets it.
  if (offer.status === "OPEN") {
    const stillOpen = await prisma.jobOfferResponse.count({ where: { offerId, response: "OFFERED" } });
    if (stillOpen === 0) await returnOfferToOperators(offer, guideId);
  }
  return "ok";
}

// Close an OPEN offer and hand it back to the operator team (in-app + push) to
// reassign manually — used when a guide declines or cancels and no other candidate
// remains. Deliberately does NOT create a new offer: no random reassignment.
async function returnOfferToOperators(
  offer: { id: string; tourId: string; date: string; slotIdx: number },
  declinedByGuideId?: string,
): Promise<void> {
  // Race-safe close so a concurrent accept can't still win it.
  const won = await prisma.jobOffer.updateMany({ where: { id: offer.id, status: "OPEN" }, data: { status: "EXPIRED" } });
  if (won.count !== 1) return;
  await prisma.notification.deleteMany({ where: { offerId: offer.id } });
  // Return the slot's bookings to the inbox so the operator sees the job to dispatch
  // (unless another guide is still assigned the slot, e.g. a hybrid split).
  const stillAssigned = await prisma.assignment.findFirst({ where: { date: offer.date, slotIdx: offer.slotIdx }, select: { id: true } });
  if (!stillAssigned) await prisma.booking.updateMany({ where: { date: offer.date, slotIdx: offer.slotIdx, status: "OFFERED" }, data: { status: "PENDING" } });

  const [tour, ops, decliner] = await Promise.all([
    prisma.tour.findUnique({ where: { id: offer.tourId }, select: { name: true } }),
    prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } }),
    declinedByGuideId ? prisma.user.findFirst({ where: { guideId: declinedByGuideId }, select: { displayName: true } }) : Promise.resolve(null),
  ]);
  const job = `${tour?.name ?? offer.tourId} · ${slotLabel(offer.slotIdx)} · ${offer.date}`;
  const who = declinedByGuideId ? `${declinedByGuideId}${decliner?.displayName ? ` ${decliner.displayName}` : ""}` : null;
  const msg = who ? `${who} declined ${job}. It's back with you — please assign another guide.` : `No guide accepted ${job}. Please assign a guide.`;
  for (const op of ops) {
    await prisma.notification.create({ data: { userId: op.id, kind: "offer", message: msg } });
    await sendPushToUser(op.id, { title: "Job needs assigning", body: msg, url: "/jobs", tag: `returned-${offer.id}` });
  }
}

// A pending (unaccepted) job must be locked in by this many hours before the
// tour. If it's still open when the tour is this close, it's handed back to the
// operators so they can assign someone in time.
const ESCALATE_HOURS_BEFORE_TOUR = 2;

// Bangkok start time (ms since epoch) of an offer's tour slot.
function tourStartMs(date: string, slotIdx: number): number {
  const [h, m] = (SLOT_TIMES[slotIdx] || "00:00").split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600 * 1000;
}

// Hand an OPEN offer back to the operators when nobody has accepted: either it
// passed its TTL, or the tour is now within 2 hours. Alerts the whole operator
// team (in-app + push) to assign a guide manually, and clears it from guides'
// bells. Runs from the cron AND on every operator dashboard load, so it fires
// even without a scheduler. Idempotent — an already-EXPIRED offer is skipped.
export async function sweepExpiredOffers(): Promise<number> {
  const now = Date.now();
  const open = await prisma.jobOffer.findMany({ where: { status: "OPEN" }, include: { responses: true } });
  const due = open.filter((o) => o.expiresAt.getTime() < now || tourStartMs(o.date, o.slotIdx) - now <= ESCALATE_HOURS_BEFORE_TOUR * 3600_000);
  if (due.length === 0) return 0;

  // For single-guide offers (one candidate) we name the guide who didn't accept.
  const soloGuideIds = [...new Set(due.filter((o) => o.responses.length === 1).map((o) => o.responses[0].guideId))];
  const [tours, opsUsers, soloGuides] = await Promise.all([
    prisma.tour.findMany({ where: { id: { in: due.map((o) => o.tourId) } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } }),
    soloGuideIds.length ? prisma.user.findMany({ where: { guideId: { in: soloGuideIds } }, select: { guideId: true, displayName: true } }) : Promise.resolve([]),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const guideLabel = new Map(soloGuides.map((g) => [g.guideId, `${g.guideId}${g.displayName ? ` ${g.displayName}` : ""}`]));
  for (const o of due) {
    // Close the offer (race-safe) and clear it from every guide's bell.
    const won = await prisma.jobOffer.updateMany({ where: { id: o.id, status: "OPEN" }, data: { status: "EXPIRED" } });
    if (won.count !== 1) continue; // someone else handled it
    await prisma.notification.deleteMany({ where: { offerId: o.id } });
    // Nobody took it: return its bookings to the inbox as pending (if unassigned).
    const stillAssigned = await prisma.assignment.findFirst({ where: { date: o.date, slotIdx: o.slotIdx }, select: { id: true } });
    if (!stillAssigned) {
      await prisma.booking.updateMany({ where: { date: o.date, slotIdx: o.slotIdx, status: "OFFERED" }, data: { status: "PENDING" } });
      for (const r of o.responses) await cleanupPreppedSheet(r.guideId, o.date, o.slotIdx);
    }
    const job = `${tourName.get(o.tourId) ?? o.tourId} · ${slotLabel(o.slotIdx)} · ${o.date}`;
    // Single-guide offer → name them; broadcast offer → generic "nobody accepted".
    const solo = o.responses.length === 1 ? guideLabel.get(o.responses[0].guideId) : null;
    const msg = solo
      ? `${solo} didn't accept ${job} within 2h — it's back with you to reassign.`
      : `No guide accepted ${job}. Please assign a guide.`;
    for (const op of opsUsers) {
      await prisma.notification.create({ data: { userId: op.id, kind: "offer", message: msg } });
      await sendPushToUser(op.id, { title: "Job needs assigning", body: msg, url: "/jobs", tag: `unfilled-${o.id}` });
    }
  }
  return due.length;
}
