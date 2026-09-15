// Naming the guide for a tour still to come, directly — no offer to accept.
//
// Offers are the normal way to dispatch, but they depend on the guide tapping Accept
// (in the app or on LINE). When the job is agreed by phone, or the LINE accept is not
// reaching FolkOPS, the operator must still be able to put the guide on the tour —
// otherwise it runs with nobody on the system and the guide goes unpaid.
//
// The rules an accept enforces still apply here: a real, active guide; not a one-off
// guide (never rebooked, owner rule); not a blocked day; not on approved leave; not a
// tour at a clashing time that day; and not a slot somebody already has.
//
// Pure: the route (api/assignments, direct) loads the facts and writes the result.
import { SLOT_TIMES } from "@/lib/slots";

export type ManualAssignFacts = {
  guideId: string;
  date: string;
  today: string;
  guide: { role: string; state: string; external: boolean } | null;
  tourExists: boolean;
  dateBlocked: boolean;
  onLeave: boolean;
  /** Guides already assigned to this slot. */
  staffedBy: string[];
  /** The guide's own tour that day at a clashing time, if any. */
  clashSlotIdx: number | null;
};

/** Every reason the guide cannot be put on this tour directly — all at once. */
export function manualAssignBlockers(f: ManualAssignFacts): string[] {
  const r: string[] = [];
  if (f.date < f.today) r.push("This tour already ran — use Record who guided");
  if (!f.guide || f.guide.role !== "GUIDE") r.push(`${f.guideId} is not a guide`);
  else {
    if (f.guide.state !== "ACTIVE") r.push(`${f.guideId} is not active`);
    if (f.guide.external) r.push(`${f.guideId} is a one-off guide and is not booked again`);
  }
  if (!f.tourExists) r.push("Unknown tour");
  if (f.dateBlocked) r.push("This day is blocked");
  if (f.onLeave) r.push(`${f.guideId} is on approved leave that day`);
  const others = f.staffedBy.filter((g) => g !== f.guideId);
  if (others.length) r.push(`${others.join(", ")} already ${others.length === 1 ? "has" : "have"} this tour — use Split to add a second guide`);
  if (f.staffedBy.includes(f.guideId)) r.push(`${f.guideId} already has this tour`);
  if (f.clashSlotIdx != null) r.push(`${f.guideId} already has a tour at ${SLOT_TIMES[f.clashSlotIdx] ?? "a clashing time"} that day`);
  return r;
}
