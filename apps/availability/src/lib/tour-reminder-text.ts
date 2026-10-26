import { SLOT_TIMES } from "@/lib/slots";

// The guide's one-hour reminder: its words, and where it leads from the bell. No server
// imports — the bell (components/AppClient) uses it in the browser. Sent by lib/tour-reminders.

/**
 * Where a reminder in the guide's bell leads: their job sheet for that departure. The bell
 * only has the message and its time, so the departure is read back from them — the start
 * time in the message ("· 13:30") and the Bangkok date it was sent on (always the tour day).
 */
export function tourReminderHref(guideId: string, message: string, createdAt: string | Date): string | null {
  const time = (message.match(/· (\d{2}:\d{2})$/m) || [])[1];
  const slotIdx = time ? SLOT_TIMES.indexOf(time) : -1;
  if (slotIdx < 0) return null;
  const date = new Date(new Date(createdAt).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  return `/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`;
}

/** The reminder's words. */
export function tourReminderText(o: { tourName: string; time: string; meetingPoint?: string | null }): { title: string; body: string } {
  return {
    title: "Tour starts in 1 hour",
    body: [`${o.tourName} · ${o.time}`, o.meetingPoint?.trim() ? `Meeting point: ${o.meetingPoint.trim()}` : ""].filter(Boolean).join("\n"),
  };
}

