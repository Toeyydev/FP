import { SLOT_TIMES } from "@/lib/slots";

// Build a Google Calendar "add event" link — one tap saves the tour to the guide's
// calendar (Google then sends its own reminders). Bangkok wall-clock → UTC.
export function gcalUrl(opts: { title: string; date: string; slotIdx: number; durationMin?: number | null; details?: string; location?: string }): string {
  const [y, m, d] = opts.date.split("-").map(Number);
  const [h, mn] = (SLOT_TIMES[opts.slotIdx] || "09:00").split(":").map(Number);
  const startMs = Date.UTC(y, m - 1, d, h, mn) - 7 * 3600 * 1000;
  const dur = opts.durationMin && opts.durationMin > 0 ? opts.durationMin : 180;
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const p = new URLSearchParams({ action: "TEMPLATE", text: opts.title, dates: `${f(startMs)}/${f(startMs + dur * 60000)}` });
  if (opts.details) p.set("details", opts.details);
  if (opts.location) p.set("location", opts.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
