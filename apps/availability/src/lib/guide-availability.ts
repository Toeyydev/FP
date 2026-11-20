import { prisma } from "@/lib/db";
import { SLOT_COUNT } from "@/lib/slots";
import { guideProfileStatus, PROFILE_STATUS_SELECT } from "@/lib/profile";
import { dayOf } from "@/lib/dates";

/**
 * When a guide cannot take work.
 *
 * `Availability.slots[i] === true` means BUSY on that slot — the array says when
 * the guide is NOT available (see lib/offers, which reads it the same way). The
 * web week grid and FolkOPS Mobile both go through here, because getting the sense
 * of that boolean backwards would quietly take a guide off the roster for a month.
 */

/** One guide's own month: day of month → the slot array they saved. */
export async function guideMonthAvailability(guideId: string, month: string): Promise<Record<number, boolean[]>> {
  const rows = await prisma.availability.findMany({
    where: { guideId, date: { startsWith: month } },
    select: { date: true, slots: true },
  });
  const out: Record<number, boolean[]> = {};
  for (const r of rows) out[dayOf(r.date)] = r.slots;
  return out;
}

export type SetAvailabilityResult =
  | { ok: true }
  | { ok: false; status: 403; error: "profile-incomplete" }
  | { ok: false; status: 409; error: "date-blocked" }
  | { ok: false; status: 409; error: "slot-assigned"; slots: number[] };

/**
 * Replace one day's slot array for a guide.
 *
 * The caller sends the WHOLE array, including any slot that already carries a job:
 * those are locked, and a save that would change one is refused rather than
 * silently dropping work the guide has already accepted.
 */
export async function setGuideAvailability(o: {
  guideId: string;
  /** The signed-in user's id, for the profile-completeness check. */
  userId: string | null;
  date: string;
  slots: boolean[];
}): Promise<SetAvailabilityResult> {
  const { guideId, date, slots } = o;

  // Account details must be complete before a guide can offer their time.
  if (o.userId) {
    const me = await prisma.user.findUnique({ where: { id: o.userId }, select: PROFILE_STATUS_SELECT });
    if (me && !guideProfileStatus(me).complete) return { ok: false, status: 403, error: "profile-incomplete" };
  }

  if (await prisma.blockedDate.findUnique({ where: { date } })) {
    return { ok: false, status: 409, error: "date-blocked" };
  }

  const assigned = await prisma.assignment.findMany({ where: { guideId, date }, select: { slotIdx: true } });
  // An out-of-range slotIdx is ignored rather than trusted: treating corrupt data
  // as a lock would refuse every future save for that day, with no way back.
  const locked = assigned.map((a) => a.slotIdx).filter((i) => i >= 0 && i < SLOT_COUNT);
  if (locked.length) {
    const current = await prisma.availability.findUnique({ where: { guideId_date: { guideId, date } }, select: { slots: true } });
    const stored = current?.slots ?? [];
    // No row yet means the guide has never marked this day: everything reads free.
    const changed = locked.filter((i) => slots[i] !== (stored[i] ?? false)).sort((a, b) => a - b);
    if (changed.length) return { ok: false, status: 409, error: "slot-assigned", slots: changed };
  }

  await prisma.availability.upsert({
    where: { guideId_date: { guideId, date } },
    create: { guideId, date, slots },
    update: { slots },
  });
  return { ok: true };
}
