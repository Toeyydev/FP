// Move departure: guests whose tour cannot run at its time (the venue closed, a guest fell
// ill…) go to another date or time in one act — every chosen booking, its guest data with
// it, the guide's job at the new time if the operator keeps the guide, and the job sheet the
// guests left. Owner decisions 2026-10-25: three reasons (venue closed, guest sick, other
// with a written reason); the guide fee for the departure left is set by hand on its sheet,
// never by this move.
//
// Pure: the route (api/departures/move) loads the facts and writes the result.
import { SLOT_TIMES } from "@/lib/slots";

export const MOVE_REASONS = {
  "venue-closed": "สถานที่ปิด",
  "guest-sick": "แขกไม่สบาย",
  other: "อื่นๆ",
} as const;
export type MoveReason = keyof typeof MOVE_REASONS;

export type Departure = { date: string; slotIdx: number };
const norm = (s?: string | null) => (s ?? "").trim().toLowerCase();
const when = (d: Departure) => `${d.date} ${SLOT_TIMES[d.slotIdx] ?? ""}`.trim();

/** The reason as written on the sheet and in the history. */
export function reasonLabel(reason: MoveReason, text?: string | null): string {
  const t = (text ?? "").trim();
  if (reason === "other") return t;
  return t ? `${MOVE_REASONS[reason]} — ${t}` : MOVE_REASONS[reason];
}

export type MoveFacts = {
  from: Departure;
  to: Departure;
  today: string;
  reason: MoveReason;
  reasonText?: string | null;
  /** Booking numbers the operator ticked. */
  refs: string[];
  /** Of those, the ones with no live booking at this departure (a row typed by hand, say). */
  unmatched: string[];
  sheet: { approved: boolean; paid: boolean; inPayment: boolean; peakDocumentNo: string | null } | null;
};

/** Every reason the move cannot be made — all at once; [] when it can. Nothing moves otherwise. */
export function moveBlockers(f: MoveFacts): string[] {
  const r: string[] = [];
  if (!f.refs.length) r.push("Choose the guests to move");
  if (f.to.date === f.from.date && f.to.slotIdx === f.from.slotIdx) r.push("Choose a different date or time to move to");
  if (f.to.date < f.today) r.push("The new date has already passed");
  if (f.reason === "other" && (f.reasonText ?? "").trim().length < 3) r.push("Write the reason");
  if (f.unmatched.length) r.push(`No booking at this departure for ${f.unmatched.join(", ")} — move it from Bookings`);
  if (f.sheet?.approved) r.push("This job sheet is approved — unapprove it first");
  if (f.sheet?.paid || f.sheet?.inPayment) r.push("This job is already paid — the guests cannot leave its sheet");
  if (f.sheet?.peakDocumentNo) r.push(`This job is in PEAK (${f.sheet.peakDocumentNo}) — the guests cannot leave its sheet`);
  return r;
}

/** The booking numbers a booking is known by on a sheet row. */
export const bookingKeys = (b: { externalRef?: string | null; confirmationCode?: string | null }) =>
  [b.externalRef, b.confirmationCode].map(norm).filter(Boolean);

/**
 * The sheet's guest rows without the moved bookings. A row someone recorded on (an actual
 * count, a no-show) goes too: the guests did not miss this tour, it moved — what was on the
 * row is kept in the move's history.
 */
export function removeMovedRows<R extends { bookingNo?: string | null }>(rows: R[], movedKeys: Set<string>): { kept: R[]; removed: R[] } {
  const kept: R[] = [], removed: R[] = [];
  for (const row of rows) (movedKeys.has(norm(row.bookingNo)) ? removed : kept).push(row);
  return { kept, removed };
}

/** The line the move adds to the operator note of the sheet the guests left. */
export function moveNote(existing: string | null | undefined, m: { to: Departure; reason: string; refs: string[] }): string {
  const line = `ย้ายรอบ → ${when(m.to)} · ${m.reason} · ${m.refs.join(", ")}`;
  const prev = (existing ?? "").trim();
  return prev ? `${prev}\n${line}` : line;
}

/** The WhatsApp message the operator can send the guest — never sent by the system. */
export function guestMoveMessage(m: { name?: string | null; tourName: string; to: Departure }): string {
  const day = new Date(`${m.to.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const hello = (m.name ?? "").trim() ? `Hello ${(m.name ?? "").trim()},` : "Hello,";
  return `${hello} this is Folkpaths. Your ${m.tourName} is now on ${day} at ${SLOT_TIMES[m.to.slotIdx] ?? ""}. Please reply to confirm — thank you!`;
}
