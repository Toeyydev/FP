import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { SLOT_TIMES } from "@/lib/slots";
import { calendarInvitesActive } from "@/lib/tour-calendar-sync";

// Bangkok (UTC+7) local start → UTC epoch ms.
function bangkokStartMs(date: string, slotIdx: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = (SLOT_TIMES[slotIdx] ?? "09:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - 7 * 3600 * 1000;
}
const fmtUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const esc = (s: string) => (s || "").replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");

// A calendar event with two reminders (12h + 1h before). Google Calendar reads
// the VALARMs and notifies the guide automatically once they add it.
export function makeIcs(o: { uid: string; startMs: number; durationMin: number; summary: string; description?: string; location?: string; status?: "CONFIRMED" | "CANCELLED"; method?: "REQUEST" | "CANCEL"; sequence?: number }): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Folkpaths//Guide//EN", "CALSCALE:GREGORIAN", `METHOD:${o.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${o.uid}`,
    o.sequence ? `SEQUENCE:${o.sequence}` : "",
    `DTSTAMP:${fmtUtc(o.startMs)}`,
    `DTSTART:${fmtUtc(o.startMs)}`,
    `DTEND:${fmtUtc(o.startMs + o.durationMin * 60000)}`,
    `SUMMARY:${esc(o.summary)}`,
    o.description ? `DESCRIPTION:${esc(o.description)}` : "",
    o.location ? `LOCATION:${esc(o.location)}` : "",
    `STATUS:${o.status ?? "CONFIRMED"}`,
    "BEGIN:VALARM", "TRIGGER:-PT12H", "ACTION:DISPLAY", "DESCRIPTION:Folkpaths tour reminder", "END:VALARM",
    "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", "DESCRIPTION:Folkpaths tour reminder", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.filter(Boolean).join("\r\n");
}

// Email the guide a calendar invite for a job given to them by an operator (fire-and-forget).
// Not sent when the company Google connection exists, and never for a job that has a company
// calendar event for this guide: that event invites them, and when Google is failing the
// calendar sync emails its own fallback .ics with the event's identifier
// (lib/tour-calendar-sync). A guide's own Accept never comes here.
export async function sendTourCalendarInvite(guideId: string, date: string, slotIdx: number) {
  if (await calendarInvitesActive()) return;
  if (await prisma.tourCalendarEvent.findFirst({ where: { date, slotIdx, attendeeGuideId: guideId }, select: { id: true } })) return;
  const [guide, assignment] = await Promise.all([
    prisma.user.findUnique({ where: { guideId }, select: { email: true, displayName: true } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: true } }),
  ]);
  if (!guide?.email || guide.email.endsWith("@folkpath.local")) return; // no real email
  if (!assignment) return;

  const startMs = bangkokStartMs(date, slotIdx);
  const durationMin = assignment.tour?.durationMin ?? 180;
  const time = SLOT_TIMES[slotIdx] ?? "";
  const tourName = assignment.tour?.name ?? assignment.tourId;
  const summary = `Folkpaths tour — ${tourName}`;
  const description = `Guide: ${guide.displayName}\nTime: ${time}${assignment.pax != null ? `\nPax: ${assignment.pax}` : ""}${assignment.note ? `\nNote: ${assignment.note}` : ""}\nOpen the Folkpaths app for full job details.`;
  const ics = makeIcs({ uid: `${guideId}-${date}-${slotIdx}@folkpaths.com`, startMs, durationMin, summary, description, location: assignment.tour?.meetingPoint ?? undefined });

  await sendEmail({
    to: guide.email,
    subject: `Tour confirmed: ${tourName} — ${date} ${time}`,
    text: `Hi ${guide.displayName},\n\nYou're confirmed for:\n${tourName}\n${date} at ${time}${assignment.pax != null ? ` · ${assignment.pax} pax` : ""}\n\nAdd the attached calendar invite to get reminders. Full details are in the Folkpaths app.`,
    icalEvent: { method: "REQUEST", content: ics },
    attachments: [{ filename: "folkpath-tour.ics", content: ics, contentType: "text/calendar; method=REQUEST" }],
  });
}
