import { SLOT_TIMES } from "@/lib/slots";

// What a guide is told when an operator puts them on a tour directly (no offer to accept).
// One text for every channel — the in-app bell, the push, LINE — so they all say the same.
// Nothing about the guests: names and phones stay on the job screen behind the login.

export function directAssignmentNotice(o: {
  guideName: string | null; tourName: string; meetingPoint: string | null;
  date: string; slotIdx: number; pax: number | null;
}): { title: string; body: string; message: string } {
  const first = (o.guideName ?? "").trim().split(/\s+/)[0] ?? "";
  const dateLabel = new Date(`${o.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const when = `${dateLabel} · ${SLOT_TIMES[o.slotIdx] ?? ""}${o.pax != null ? ` · ${o.pax} pax` : ""}`;
  const title = "📌 You're booked";
  const message = [
    `📌 You're booked${first ? `, ${first}` : ""}.`,
    "",
    o.tourName,
    when,
    ...(o.meetingPoint ? [`📍 ${o.meetingPoint}`] : []),
    "",
    "It's in your schedule in the Folkpaths app.",
  ].join("\n");
  return { title, body: `${o.tourName} · ${when}`, message };
}
