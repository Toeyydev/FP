import { prisma } from "@/lib/db";
import { parseBokun, isCancellation, productKey, detectChannel, type ParsedBooking } from "@/lib/bookings";
import { sendPushToUser } from "@/lib/push";
import { todayD, ymd } from "@/lib/dates";

export type ImportResult = "created" | "updated" | "skipped";

const CAP = 10; // max pax per guide / job

async function notifyOps(message: string, title: string, body: string) {
  try {
    const opsUsers = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
    for (const o of opsUsers) {
      await prisma.notification.create({ data: { userId: o.id, kind: "late-booking", message } });
      await sendPushToUser(o.id, { title, body, url: "/", tag: "late-booking" });
    }
  } catch { /* alerts are best-effort; never block import */ }
}

async function notifyGuide(guideId: string, message: string, title: string, body: string) {
  try {
    const u = await prisma.user.findFirst({ where: { guideId, state: "ACTIVE" }, select: { id: true } });
    if (!u) return;
    await prisma.notification.create({ data: { userId: u.id, kind: "job-change", message } });
    await sendPushToUser(u.id, { title, body, url: "/", tag: "job-change" });
  } catch { /* best-effort */ }
}

// When a NEW booking lands for a slot already assigned to a guide: auto-add it to
// that guide's job if it stays within the 10-pax cap, and ALWAYS alert the
// operator to confirm. If it would breach the cap (or the slot is split across
// guides), leave it pending and alert for a manual decision. Never throws.
export async function autoAttachLate(b: { id: string; tourId: string | null; date: string | null; slotIdx: number | null; pax: number | null; customerName: string | null; confirmationCode: string | null; status: string }): Promise<boolean> {
  try {
    // Attach by date + slot — the assigned guide owns that time slot, so a new
    // booking lands on their job even if it arrived without a tour mapping yet.
    if (b.status !== "PENDING" || !b.date || b.slotIdx == null) return false;
    const assigns = await prisma.assignment.findMany({ where: { date: b.date, slotIdx: b.slotIdx } });
    if (assigns.length === 0) return false; // not dispatched yet — the normal inbox grouping handles it
    const ref = b.confirmationCode || b.customerName || "a new booking";
    if (assigns.length > 1) {
      await notifyOps(`Booking ${ref} for ${b.date} matches a slot already split across ${assigns.length} guides. Assign it manually.`, "Late booking needs assigning", `${ref} · ${b.date}`);
      return false;
    }
    const a = assigns[0];
    const addPax = b.pax ?? 0;
    const newTotal = (a.pax ?? 0) + addPax;
    if (newTotal > CAP) {
      await notifyOps(`Booking ${ref} (+${addPax}) for ${b.date} puts ${a.guideId} over ${CAP} guests. Held — split it across guides.`, "Late booking over capacity", `${ref} · ${b.date} · ${a.guideId}`);
      return false;
    }
    const key = { guideId_date_slotIdx: { guideId: a.guideId, date: b.date, slotIdx: b.slotIdx } };
    // Mark OFFERED so it leaves the "ready to offer" inbox, and link it to the
    // guide's tour if it arrived unmapped.
    await prisma.booking.update({ where: { id: b.id }, data: { status: "OFFERED", tourId: b.tourId ?? a.tourId } });
    await prisma.assignment.update({ where: key, data: { pax: newTotal } });
    const js = await prisma.jobSheet.findUnique({ where: key });
    const list = Array.isArray(js?.bookings) ? (js!.bookings as unknown[]) : [];
    list.push({ name: b.customerName ?? "", bookingNo: b.confirmationCode ?? "", bookedPax: b.pax ?? null, actualPax: null, tickets: "", status: "" });
    await prisma.jobSheet.upsert({
      where: key,
      create: { guideId: a.guideId, date: b.date, slotIdx: b.slotIdx, tourId: a.tourId, bookings: list as object },
      update: { bookings: list as object },
    });
    await notifyGuide(a.guideId, `A booking was added to your ${b.date} tour. You now have ${newTotal} guests.`, "Your tour group grew", `${b.date} · now ${newTotal} guests`);
    await notifyOps(`Booking ${ref} (+${addPax}) added to ${a.guideId}'s job on ${b.date} — now ${newTotal} guests.`, "Booking combined into a job", `${ref} → ${a.guideId} · ${b.date} · ${newTotal} pax`);
    return true;
  } catch { return false; /* import must succeed regardless of attach errors */ }
}

// Sweep existing PENDING bookings (today onward) and auto-combine any whose slot
// is already assigned to a guide. Idempotent — safe to call on every inbox load.
export async function reconcileAssignedBookings(): Promise<number> {
  const today = ymd(todayD());
  const pending = await prisma.booking.findMany({
    where: { status: "PENDING", tourId: { not: null }, date: { gte: today }, slotIdx: { not: null } },
    select: { id: true, tourId: true, date: true, slotIdx: true, pax: true, customerName: true, confirmationCode: true, status: true },
  });
  let combined = 0;
  for (const b of pending) if (await autoAttachLate(b)) combined++;
  return combined;
}

// Upsert one already-parsed booking. Dedupes by (source, externalId); when no
// externalId, falls back to confirmationCode so re-imports don't duplicate.
// Auto-maps the tour from a learned product→tour mapping. Shared by the webhook,
// the Bokun API sync, and the CSV import.
export async function importParsed(p: ParsedBooking, opts: { source: string; cancelled: boolean; raw?: unknown }): Promise<ImportResult> {
  let tourId: string | null = null;
  if (p.productName) {
    const map = await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null);
    if (map) tourId = map.tourId;
  }
  const { source, cancelled } = opts;
  const raw = (opts.raw ?? undefined) as object | undefined;

  if (p.externalId) {
    const existing = await prisma.booking.findUnique({ where: { source_externalId: { source, externalId: p.externalId } }, select: { id: true } });
    const rec = await prisma.booking.upsert({
      where: { source_externalId: { source, externalId: p.externalId } },
      create: {
        source, externalId: p.externalId, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null,
        productName: p.productName ?? null, tourId, date: p.date ?? null, startTime: p.startTime ?? null,
        slotIdx: p.slotIdx ?? null, pax: p.pax ?? null, customerName: p.customerName ?? null,
        status: cancelled ? "CANCELLED" : "PENDING", raw,
      },
      update: {
        confirmationCode: p.confirmationCode ?? undefined, externalRef: p.externalRef ?? undefined, productName: p.productName ?? undefined,
        tourId: tourId ?? undefined, date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined,
        pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, status: cancelled ? "CANCELLED" : undefined, raw,
      },
    });
    if (!existing) await autoAttachLate(rec);
    return existing ? "updated" : "created";
  }

  // No externalId: dedupe on confirmationCode / externalRef so re-import is safe.
  const ref = p.confirmationCode || p.externalRef;
  if (ref) {
    const dup = await prisma.booking.findFirst({ where: { OR: [{ confirmationCode: ref }, { externalRef: ref }] }, select: { id: true } });
    if (dup) {
      await prisma.booking.update({ where: { id: dup.id }, data: { tourId: tourId ?? undefined, date: p.date ?? undefined, slotIdx: p.slotIdx ?? undefined, pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, productName: p.productName ?? undefined, status: cancelled ? "CANCELLED" : undefined } });
      return "updated";
    }
  }
  const rec = await prisma.booking.create({
    data: {
      source, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null, productName: p.productName ?? null, tourId,
      date: p.date ?? null, startTime: p.startTime ?? null, slotIdx: p.slotIdx ?? null,
      pax: p.pax ?? null, customerName: p.customerName ?? null, status: cancelled ? "CANCELLED" : "PENDING",
    },
  });
  await autoAttachLate(rec);
  return "created";
}

// Import a raw Bokun/channel webhook payload (deep-parsed).
export async function importRawBooking(raw: unknown): Promise<ImportResult> {
  return importParsed(parseBokun(raw), { source: detectChannel(raw), cancelled: isCancellation(raw), raw });
}
