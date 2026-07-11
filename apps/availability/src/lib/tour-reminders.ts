import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { ymd, todayD, bangkokNowMinutes } from "@/lib/dates";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";

// How long before a tour's departure the assigned guide gets their heads-up.
export const REMINDER_LEAD_MIN = 45;

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
  const dueSlots: number[] = [];
  SLOT_TIMES.forEach((t, idx) => {
    const [hh, mm] = t.split(":").map(Number);
    const until = hh * 60 + mm - now;
    if (until > 0 && until <= REMINDER_LEAD_MIN) dueSlots.push(idx);
  });
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
