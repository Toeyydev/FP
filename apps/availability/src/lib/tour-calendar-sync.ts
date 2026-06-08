import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { SLOT_TIMES } from "@/lib/slots";
import { googleEnabled, insertEvent, patchEvent, deleteEvent, type CalEvent } from "@/lib/google-calendar";

const TZ = "Asia/Bangkok";
function endTime(slotIdx: number, durationMin: number | null): string {
  const [h, m] = (SLOT_TIMES[slotIdx] || "09:00").split(":").map(Number);
  const total = h * 60 + m + (durationMin && durationMin > 0 ? durationMin : 180);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Build the calendar event for one assignment (optionally labelled with the guide
// for the operator's master calendar).
async function buildEvent(guideId: string, date: string, slotIdx: number, opts: { forOps?: boolean } = {}): Promise<CalEvent | null> {
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: true } });
  if (!a) return null;
  const bookings = await prisma.booking.findMany({
    where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
    select: { customerName: true, pax: true, assignedGuideId: true, confirmationCode: true, specialRequests: true },
  });
  const mine = bookings.filter((b) => !bookings.some((x) => x.assignedGuideId) || !b.assignedGuideId || b.assignedGuideId === guideId);
  const pax = mine.reduce((s, b) => s + (b.pax ?? 0), 0);
  const guideName = (await prisma.user.findUnique({ where: { guideId }, select: { displayName: true } }))?.displayName ?? guideId;
  const lines = mine.map((b) => `• ${b.customerName || b.confirmationCode || "—"} (${b.pax ?? "?"})${b.specialRequests ? ` — ${b.specialRequests}` : ""}`);
  const start = SLOT_TIMES[slotIdx] || "09:00";
  return {
    summary: opts.forOps ? `${a.tour?.name ?? a.tourId} — ${guideName}` : `Folkpaths · ${a.tour?.name ?? a.tourId}`,
    location: a.tour?.meetingPoint ?? undefined,
    description: [`${pax} pax`, opts.forOps ? `Guide: ${guideName} (${guideId})` : "", a.tour?.meetingPoint ? `Meeting: ${a.tour.meetingPoint}` : "", "", ...lines].filter(Boolean).join("\n"),
    start: { dateTime: `${date}T${start}:00`, timeZone: TZ },
    end: { dateTime: `${date}T${endTime(slotIdx, a.tour?.durationMin ?? null)}:00`, timeZone: TZ },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 120 }] },
  };
}

async function conn(userId: string) {
  const c = await prisma.googleCalendar.findUnique({ where: { userId } }).catch(() => null);
  if (!c) return null;
  return { refreshToken: decrypt(c.refreshToken), calendarId: c.calendarId };
}

// The userId of the first connected operator/admin (for the master calendar).
async function firstOpsCalendarUserId(): Promise<string | null> {
  const opIds = (await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] } }, select: { id: true } })).map((u) => u.id);
  if (!opIds.length) return null;
  const cal = await prisma.googleCalendar.findFirst({ where: { userId: { in: opIds } }, select: { userId: true } }).catch(() => null);
  return cal?.userId ?? null;
}

// Create or update the calendar events for a tour (guide + operator master).
// Safe no-op if Google isn't configured or the user hasn't connected.
export async function pushTourToCalendars(guideId: string, date: string, slotIdx: number): Promise<void> {
  if (!googleEnabled) return;
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { guide: { select: { id: true } } } });
  if (!a) return;

  // Guide's own calendar
  const gc = a.guide?.id ? await conn(a.guide.id) : null;
  if (gc) {
    const ev = await buildEvent(guideId, date, slotIdx);
    if (ev) {
      if (a.googleEventId) await patchEvent(gc.refreshToken, gc.calendarId, a.googleEventId, ev);
      else { const id = await insertEvent(gc.refreshToken, gc.calendarId, ev); if (id) await prisma.assignment.update({ where: { id: a.id }, data: { googleEventId: id } }); }
    }
  }

  // Operator master calendar (first connected operator/admin)
  const opCal = await firstOpsCalendarUserId();
  if (opCal) {
    const oc = await conn(opCal);
    if (oc) {
      const ev = await buildEvent(guideId, date, slotIdx, { forOps: true });
      if (ev) {
        if (a.opsGoogleEventId) await patchEvent(oc.refreshToken, oc.calendarId, a.opsGoogleEventId, ev);
        else { const id = await insertEvent(oc.refreshToken, oc.calendarId, ev); if (id) await prisma.assignment.update({ where: { id: a.id }, data: { opsGoogleEventId: id } }); }
      }
    }
  }
}

// Delete the calendar events for an assignment (on cancel / reassign-off).
export async function removeTourEvents(a: { id: string; guideId: string; googleEventId: string | null; opsGoogleEventId: string | null }): Promise<void> {
  if (!googleEnabled) return;
  const guideUser = await prisma.user.findUnique({ where: { guideId: a.guideId }, select: { id: true } });
  if (a.googleEventId && guideUser?.id) { const gc = await conn(guideUser.id); if (gc) await deleteEvent(gc.refreshToken, gc.calendarId, a.googleEventId); }
  if (a.opsGoogleEventId) {
    const opId = await firstOpsCalendarUserId();
    if (opId) { const oc = await conn(opId); if (oc) await deleteEvent(oc.refreshToken, oc.calendarId, a.opsGoogleEventId); }
  }
}
