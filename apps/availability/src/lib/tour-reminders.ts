import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { ymd, todayD, bangkokNowMinutes } from "@/lib/dates";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";
import { notifyOps } from "@/lib/booking-import";

// How long before a tour's departure the assigned guide gets their heads-up.
export const REMINDER_LEAD_MIN = 45;

// When nobody is rostered, the operator is told instead — far enough ahead that a
// guide can still be found, and once more when the departure is close.
export const UNSTAFFED_LEAD_MIN = [180, 45] as const;

/** Slot indexes departing within `leadMin` minutes, and not yet gone. */
function slotsDueWithin(leadMin: number, now: number): number[] {
  const due: number[] = [];
  SLOT_TIMES.forEach((t, idx) => {
    const [hh, mm] = t.split(":").map(Number);
    const until = hh * 60 + mm - now;
    if (until > 0 && until <= leadMin) due.push(idx);
  });
  return due;
}

// Fire ONE pre-tour reminder to each assigned guide, REMINDER_LEAD_MIN minutes
// before their departure, carrying the pax count as it stands at that moment.
// Deliberately not a live feed: the operator asked for a single heads-up, not a
// ping on every new booking. Idempotency is enforced via an audit-log row keyed
// on (date, slot, guide), so repeated ticks — and multiple Railway replicas —
// each send at most once. Best-effort throughout: a failure never stops the loop.
export async function sweepTourReminders(): Promise<number> {
  const date = ymd(todayD());
  const now = bangkokNowMinutes();

  // Slots that depart within the lead window but haven't left yet.
  const dueSlots = slotsDueWithin(REMINDER_LEAD_MIN, now);
  if (!dueSlots.length) return 0;

  const assignments = await prisma.assignment.findMany({
    where: { date, slotIdx: { in: dueSlots } },
    select: {
      guideId: true,
      slotIdx: true,
      pax: true,
      tourId: true,
      tour: { select: { name: true, meetingPoint: true } },
    },
  });

  let sent = 0;
  for (const a of assignments) {
    const key = `${date}:${a.slotIdx}:${a.guideId}`;

    // Already reminded on this tick/earlier tick/another replica? Skip.
    const done = await prisma.auditLog.findFirst({
      where: { action: "tour.reminder", entityId: key },
      select: { id: true },
    });
    if (done) continue;

    const guide = await prisma.user.findFirst({
      where: { guideId: a.guideId, state: "ACTIVE" },
      select: { id: true, displayName: true, lineUserId: true },
    });
    if (!guide) continue;

    // Claim the send BEFORE dispatching so a crash mid-send can't double-notify.
    await prisma.auditLog.create({
      data: {
        action: "tour.reminder",
        entityType: "Assignment",
        entityId: key,
        detail: { date, slotIdx: a.slotIdx, guideId: a.guideId, pax: a.pax },
      },
    });

    const time = SLOT_TIMES[a.slotIdx] ?? "";
    const tour = a.tour?.name ?? a.tourId;
    const paxTxt = a.pax == null ? "—" : `${a.pax} guest${a.pax === 1 ? "" : "s"}`;
    const first = guide.displayName?.split(" ")[0] ?? "";
    const summary = `${tour} at ${time} — ${paxTxt}.`;

    await sendPushToUser(guide.id, {
      title: `Tour in ${REMINDER_LEAD_MIN} min`,
      body: summary,
      url: "/",
      tag: `reminder-${key}`,
    }).catch(() => {});

    if (lineEnabled && guide.lineUserId) {
      const msg = [
        `${first ? first + ", y" : "Y"}our next tour departs in ${REMINDER_LEAD_MIN} minutes.`,
        summary,
        a.tour?.meetingPoint ? `Meet: ${a.tour.meetingPoint}` : "",
      ].filter(Boolean).join("\n");
      await linePush(guide.lineUserId, msg).catch(() => {});
    }

    sent++;
  }
  return sent;
}

/**
 * A tour today with guests and NOBODY rostered.
 *
 * sweepTourReminders walks assignments, so the one case nothing warns about is the
 * worst one: a slot with real bookings and no guide. It happened — an afternoon
 * departure came within two hours with its guests booked and nobody rostered. The
 * board listed it under "needs a guide", and nothing else said a word.
 *
 * Operators are told at each lead time in UNSTAFFED_LEAD_MIN. Idempotent per
 * (date, slot, lead) through an audit row claimed before the alert goes out, so
 * repeated ticks and several replicas each send at most once. Best-effort: a
 * failure here never stops the loop.
 */
export async function sweepUnstaffedDepartures(): Promise<number> {
  const date = ymd(todayD());
  const now = bangkokNowMinutes();
  const widest = Math.max(...UNSTAFFED_LEAD_MIN);
  let sent = 0;

  for (const slotIdx of slotsDueWithin(widest, now)) {
    const [hh, mm] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number);
    const until = hh * 60 + mm - now;
    // The tightest lead this departure has reached — a slot 40 minutes out is inside
    // the three-hour window too, and must not raise both alerts in one sweep.
    const lead = [...UNSTAFFED_LEAD_MIN].sort((a, b) => a - b).find((l) => until <= l);
    if (lead == null) continue;

    const key = `${date}:${slotIdx}:${lead}`;
    const done = await prisma.auditLog.findFirst({ where: { action: "tour.unstaffed", entityId: key }, select: { id: true } });
    if (done) continue;

    // Guests who are still coming, and anyone rostered for the slot.
    const [bookings, staffed] = await Promise.all([
      prisma.booking.findMany({
        where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
        select: { pax: true, tourId: true },
      }),
      prisma.assignment.count({ where: { date, slotIdx } }),
    ]);
    if (staffed > 0 || !bookings.length) continue;

    const pax = bookings.reduce((s, b) => s + (b.pax ?? 0), 0);
    const tourId = bookings.find((b) => b.tourId)?.tourId ?? null;
    const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId }, select: { name: true } }) : null;
    const time = SLOT_TIMES[slotIdx] ?? "";

    // Claim it BEFORE sending, so a crash mid-send cannot alert twice.
    await prisma.auditLog.create({
      data: { action: "tour.unstaffed", entityType: "Assignment", entityId: key, detail: { date, slotIdx, lead, until, pax, bookings: bookings.length, tourId } },
    });

    const what = `${tour?.name ?? tourId ?? "A tour"} at ${time}`;
    const who = `${pax} guest${pax === 1 ? "" : "s"} on ${bookings.length} booking${bookings.length === 1 ? "" : "s"}`;
    await notifyOps(
      `No guide for ${what} — ${who}, departing in ${until} minutes. Offer it or assign someone now.`,
      "Tour with no guide",
      `${what} · ${who} · in ${until} min`,
      { date, dedupe: false },
    );
    sent++;
  }
  return sent;
}
