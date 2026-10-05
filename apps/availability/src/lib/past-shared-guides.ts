import type { Prisma, PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { isApproved } from "@/lib/jobsheet";
import { SLOT_TIMES } from "@/lib/slots";

// Recording that a tour which already ran had MORE THAN ONE guide.
//
// "Record who guided" names one guide for a past departure, and Split — the tool for two
// guides — is a dispatch tool: it tells each guide they have been assigned a tour. For a
// tour from months ago that message is wrong, so this records the same fact quietly:
// each guide gets their own job (assignment), each booking is placed with exactly one
// guide, and nobody is notified. A guide may hold no booking at all — one large booking
// guided by two people is still two jobs and two fees.
//
// What it will not do: touch a tour that has not happened, leave a booking with no guide,
// drop a guide who is already recorded, or take a guest off a job sheet that is approved
// or paid. Each of those is refused with the reason.

export type SharedGroup = { guideId: string; bookingIds: string[] };
export type SharedInput = { date: string; slotIdx: number; tourId: string; groups: SharedGroup[]; actor: { actorId: string | null; actorRole: string | null }; today: string };
export type SharedResult =
  | { ok: true; guides: { guideId: string; pax: number | null; bookings: number; added: boolean }[] }
  | { ok: false; status: number; reasons: string[] };

export const MAX_SHARED_GUIDES = 4;
const LIVE = ["PENDING", "OFFERED", "ASSIGNED"];
type SheetRow = { bookingNo?: string; [k: string]: unknown };
const keysOf = (b: { externalRef: string | null; confirmationCode: string | null }) => [b.externalRef, b.confirmationCode].map((x) => (x ?? "").trim().toLowerCase()).filter(Boolean);

export async function recordPastSharedGuides(prisma: PrismaClient, input: SharedInput): Promise<SharedResult> {
  const { date, slotIdx, tourId, groups } = input;
  const no = (reasons: string[], status = 409): SharedResult => ({ ok: false, status, reasons });
  if (date >= input.today) return no(["This tour has not finished — share it between guides with Split in Bookings, so each guide is told"], 400);
  if (groups.length < 2) return no(["Name at least two guides — for one guide, use Record guide"], 400);
  if (groups.length > MAX_SHARED_GUIDES) return no([`At most ${MAX_SHARED_GUIDES} guides on one tour`], 400);
  const guideIds = groups.map((g) => g.guideId);
  if (new Set(guideIds).size !== guideIds.length) return no(["A guide is named twice"], 400);
  const placed = groups.flatMap((g) => g.bookingIds);
  if (new Set(placed).size !== placed.length) return no(["A booking is placed with two guides — each booking goes with one"], 400);

  const [guides, tour, bookings, prior, sheets, pays] = await Promise.all([
    prisma.user.findMany({ where: { guideId: { in: guideIds }, role: "GUIDE" }, select: { guideId: true } }),
    prisma.tour.findUnique({ where: { id: tourId }, select: { id: true } }),
    prisma.booking.findMany({ where: { date, slotIdx, status: { in: LIVE } }, select: { id: true, pax: true, externalRef: true, confirmationCode: true, assignedGuideId: true } }),
    prisma.assignment.findMany({ where: { date, slotIdx }, select: { guideId: true } }),
    prisma.jobSheet.findMany({ where: { date, slotIdx }, select: { guideId: true, ref: true, bookings: true, approvalStatus: true } }),
    prisma.tourPayment.findMany({ where: { date, slotIdx, status: "PAID" }, select: { guideId: true } }),
  ]);
  const reasons: string[] = [];
  for (const g of guideIds) if (!guides.some((u) => u.guideId === g)) reasons.push(`${g} is not a guide`);
  if (!tour) reasons.push("Unknown tour");
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const stray = placed.filter((id) => !byId.has(id));
  if (stray.length) reasons.push(`${stray.length} booking(s) are not live bookings of this tour — reload the day`);
  const unplaced = bookings.filter((b) => !placed.includes(b.id));
  if (unplaced.length) reasons.push(`${unplaced.length} booking(s) of this tour are not placed with a guide — every booking goes with one`);
  const dropped = prior.filter((a) => !guideIds.includes(a.guideId)).map((a) => a.guideId);
  if (dropped.length) reasons.push(`${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} already recorded on this tour — keep them in the list`);
  if (reasons.length) return no(reasons);

  // A guest may not leave a job sheet that is approved or paid: its figures are settled.
  const prune: { guideId: string; kept: SheetRow[] }[] = [];
  for (const s of sheets) {
    const g = groups.find((x) => x.guideId === s.guideId);
    if (!g || !Array.isArray(s.bookings)) continue;
    const mine = new Set(g.bookingIds.flatMap((id) => keysOf(byId.get(id)!)));
    const others = new Set(bookings.filter((b) => !g.bookingIds.includes(b.id)).flatMap(keysOf));
    const rows = s.bookings as SheetRow[];
    const kept = rows.filter((r) => { const n = (r.bookingNo ?? "").trim().toLowerCase(); return !n || mine.has(n) || !others.has(n); });
    if (kept.length === rows.length) continue;
    if (isApproved(s.approvalStatus) || pays.some((p) => p.guideId === s.guideId)) {
      reasons.push(`${s.guideId}'s job sheet${s.ref ? ` (${s.ref})` : ""} is ${pays.some((p) => p.guideId === s.guideId) ? "paid" : "approved"} and lists a guest being placed with another guide — its guests cannot be changed here`);
    } else prune.push({ guideId: s.guideId, kept });
  }
  if (reasons.length) return no(reasons);

  const out = groups.map((g) => {
    const bks = g.bookingIds.map((id) => byId.get(id)!);
    return { guideId: g.guideId, bookings: bks.length, pax: bks.length ? bks.reduce((s, b) => s + (b.pax ?? 0), 0) : null, added: !prior.some((a) => a.guideId === g.guideId) };
  });
  const when = `${date} · ${SLOT_TIMES[slotIdx] ?? ""}`;
  await prisma.$transaction(async (tx) => {
    for (const [i, g] of groups.entries()) {
      const note = `Recorded after the tour · shared by ${groups.length} guides · ${out[i].bookings} booking(s)`.slice(0, 280);
      await tx.assignment.upsert({
        where: { guideId_date_slotIdx: { guideId: g.guideId, date, slotIdx } },
        create: { guideId: g.guideId, date, slotIdx, tourId, pax: out[i].pax, note },
        update: { tourId, pax: out[i].pax, note },
      });
      if (g.bookingIds.length) await tx.booking.updateMany({ where: { id: { in: g.bookingIds } }, data: { assignedGuideId: g.guideId, status: "ASSIGNED" } });
    }
    for (const p of prune) {
      await tx.jobSheet.update({ where: { guideId_date_slotIdx: { guideId: p.guideId, date, slotIdx } }, data: { bookings: p.kept as unknown as Prisma.InputJsonValue } });
    }
  });
  await audit({
    ...input.actor, action: "assign.recorded_past_shared", entityType: "Assignment",
    detail: { date, slotIdx, tourId, when, notified: false, reason: "tour already ran — guides recorded by operator",
      guides: out, sheetsPruned: prune.map((p) => p.guideId), before: { guides: prior.map((a) => a.guideId) } },
  });
  return { ok: true, guides: out };
}
