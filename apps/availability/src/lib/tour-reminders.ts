import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { ymd, todayD, bangkokNowMinutes } from "@/lib/dates";
import { sendPushToUser } from "@/lib/push";
import { notifyOps } from "@/lib/booking-import";
import { tourReminderText } from "@/lib/tour-reminder-text";
export { tourReminderText, tourReminderHref } from "@/lib/tour-reminder-text";

// How long before a tour's departure the assigned guide gets their reminder (owner,
// 2026-10-20: one hour). FolkOPS sends it itself — the Google Calendar event's own
// reminder only applies to the organizer's copy, never the guide's, so it is secondary.
export const REMINDER_LEAD_MIN = 60;

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

const LIVE = ["PENDING", "OFFERED", "ASSIGNED"];

// Claim (date, slot, guide) once, across ticks and processes. The advisory lock makes the
// check-then-insert one step: two sweeps racing on the same key queue on the lock, and the
// second finds the first one's row. Claimed BEFORE sending, so a crash mid-send cannot
// remind twice (it may remind zero times, which is the safer failure).
async function claimReminder(key: string, detail: Record<string, unknown>): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`tour.reminder:${key}`}))::text`;
    if (await tx.auditLog.findFirst({ where: { action: "tour.reminder", entityId: key }, select: { id: true } })) return false;
    await tx.auditLog.create({ data: { action: "tour.reminder", entityType: "Assignment", entityId: key, detail: detail as object } });
    return true;
  });
}

// ONE reminder to each guide assigned to a departure, REMINDER_LEAD_MIN minutes before it
// starts, by FolkOPS push + the in-app bell. Never LINE: that is for exceptions.
//
//   - who: whoever holds the job when the reminder is due. The key is (date, slot, guide),
//     so a guide taken off the job before then gets nothing (no assignment) and the new
//     guide gets theirs, even if it is later than an hour out.
//   - cancelled: a departure whose bookings for the tour are all cancelled gets none, nor
//     does a removed assignment (it is gone). A job with no bookings at all (a private or
//     hand-made job) is still reminded.
//   - when: on the minute beat (lib/sync-loop), so at T-60 in Bangkok wall-clock time.
// Best-effort throughout: a failure never stops the loop.
export async function sweepTourReminders(): Promise<number> {
  const date = ymd(todayD());
  const now = bangkokNowMinutes();

  const dueSlots = slotsDueWithin(REMINDER_LEAD_MIN, now);
  if (!dueSlots.length) return 0;

  const [assignments, bookings] = await Promise.all([
    prisma.assignment.findMany({
      where: { date, slotIdx: { in: dueSlots } },
      select: { guideId: true, slotIdx: true, pax: true, tourId: true, tour: { select: { name: true, meetingPoint: true } } },
    }),
    prisma.booking.findMany({ where: { date, slotIdx: { in: dueSlots } }, select: { slotIdx: true, tourId: true, status: true } }),
  ]);

  let sent = 0;
  for (const a of assignments) {
    try {
      const forTour = bookings.filter((b) => b.slotIdx === a.slotIdx && (!b.tourId || b.tourId === a.tourId));
      if (forTour.length && !forTour.some((b) => LIVE.includes(b.status))) continue; // the tour was cancelled

      const guide = await prisma.user.findFirst({ where: { guideId: a.guideId, state: "ACTIVE" }, select: { id: true } });
      if (!guide) continue;

      const key = `${date}:${a.slotIdx}:${a.guideId}`;
      if (!(await claimReminder(key, { date, slotIdx: a.slotIdx, guideId: a.guideId, pax: a.pax, leadMin: REMINDER_LEAD_MIN }))) continue;

      const { title, body } = tourReminderText({ tourName: a.tour?.name ?? a.tourId, time: SLOT_TIMES[a.slotIdx] ?? "", meetingPoint: a.tour?.meetingPoint });
      const url = `/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${date}&slotIdx=${a.slotIdx}`;
      await prisma.notification.create({ data: { userId: guide.id, kind: "tour-reminder", message: `${title}\n${body}` } }).catch(() => {});
      await sendPushToUser(guide.id, { title, body, url, tag: `reminder-${key}` }).catch(() => {});
      sent++;
    } catch { /* one job must not stop the others */ }
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
