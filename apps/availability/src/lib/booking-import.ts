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

// If the same booking number turns up from more than one channel (e.g. the same
// ref on GetYourGuide AND Viator), it's likely a duplicate. Hold every copy as
// PENDING (never auto-offer/attach) and alert the operator to double-check.
// Returns true if it flagged a duplicate. Never throws.
async function flagCrossChannelDuplicate(rec: { confirmationCode: string | null; externalRef: string | null }): Promise<boolean> {
  try {
    const ref = (rec.confirmationCode || rec.externalRef || "").trim();
    if (!ref) return false;
    const twins = await prisma.booking.findMany({
      where: { OR: [{ confirmationCode: ref }, { externalRef: ref }], status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { id: true, source: true },
    });
    const sources = [...new Set(twins.map((t) => (t.source || "").trim()).filter(Boolean))];
    if (twins.length < 2 || sources.length < 2) return false;
    await prisma.booking.updateMany({
      where: { id: { in: twins.map((t) => t.id) } },
      data: { status: "PENDING", notes: `⚠ Possible duplicate across ${sources.join(" + ")} — verify before dispatch` },
    });
    await notifyOps(`Possible duplicate booking ${ref} on ${sources.join(" + ")}. Held as pending — please double-check before dispatching.`, "Duplicate booking — verify", `${ref} · ${sources.join(" + ")}`);
    return true;
  } catch { return false; }
}

// If the SAME customer name is already booked on the SAME date + time slot, this
// new copy is a true duplicate: auto-remove it (hidden from the inbox, recoverable)
// and tell the operator. Scoped to date+slot so two different tours for the same
// person are never touched. Returns true if it removed a duplicate. Never throws.
async function autoRemoveNameDuplicate(rec: { id: string; customerName: string | null; date: string | null; slotIdx: number | null }): Promise<boolean> {
  try {
    const name = (rec.customerName || "").trim().toLowerCase();
    if (!name || !rec.date || rec.slotIdx == null) return false;
    const others = await prisma.booking.findMany({
      where: { id: { not: rec.id }, date: rec.date, slotIdx: rec.slotIdx, status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { id: true, customerName: true },
    });
    if (!others.some((o) => (o.customerName || "").trim().toLowerCase() === name)) return false;
    await prisma.booking.update({ where: { id: rec.id }, data: { status: "IGNORED", notes: "Auto-removed: same name already booked on this slot" } });
    await notifyOps(`Removed a duplicate booking for "${rec.customerName}" on ${rec.date} — that name was already booked on this slot.`, "Duplicate removed", `${rec.customerName} · ${rec.date}`);
    return true;
  } catch { return false; }
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
// is already assigned to a guide, THEN re-sync every assignment's pax to the real
// booking total so the operator's board/dashboard never shows a stale number.
// Idempotent — safe to call on every inbox / dashboard load.
export async function reconcileAssignedBookings(): Promise<number> {
  const today = ymd(todayD());
  const pending = await prisma.booking.findMany({
    where: { status: "PENDING", tourId: { not: null }, date: { gte: today }, slotIdx: { not: null } },
    select: { id: true, tourId: true, date: true, slotIdx: true, pax: true, customerName: true, confirmationCode: true, status: true },
  });
  let combined = 0;
  for (const b of pending) if (await autoAttachLate(b)) combined++;

  // Re-sync assignment.pax = the slot's live booking total (split-aware).
  const assigns = await prisma.assignment.findMany({ where: { date: { gte: today } }, select: { id: true, guideId: true, date: true, slotIdx: true, pax: true } });
  for (const a of assigns) {
    const bks = await prisma.booking.findMany({ where: { date: a.date, slotIdx: a.slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { pax: true, assignedGuideId: true } });
    const split = bks.some((b) => b.assignedGuideId);
    const mine = split ? bks.filter((b) => !b.assignedGuideId || b.assignedGuideId === a.guideId) : bks;
    const sum = mine.reduce((s, b) => s + (b.pax ?? 0), 0);
    if (sum > 0 && sum !== a.pax) await prisma.assignment.update({ where: { id: a.id }, data: { pax: sum } });
  }
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
    if (!existing && !(await autoRemoveNameDuplicate(rec)) && !(await flagCrossChannelDuplicate(rec))) await autoAttachLate(rec);
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
  if (!(await autoRemoveNameDuplicate(rec)) && !(await flagCrossChannelDuplicate(rec))) await autoAttachLate(rec);
  return "created";
}

// A GetYourGuide booking reference looks like "GET-xxxx".
function isGetYourGuideRef(p: { confirmationCode?: string; externalRef?: string }): boolean {
  return [p.confirmationCode, p.externalRef].some((r) => /^GET-/i.test((r ?? "").trim()));
}

// Import a raw Bokun/channel payload (deep-parsed). With { getYourGuideOnly },
// skips anything whose reference isn't GET-xxxx — used by the historical sync so
// website / payment-link / test bookings never land in the inbox. The live
// webhook leaves it off, so nothing real is missed in real time.
export async function importRawBooking(raw: unknown, opts?: { getYourGuideOnly?: boolean }): Promise<ImportResult> {
  const parsed = parseBokun(raw);
  const source = detectChannel(raw);
  // GetYourGuide = a GET-xxxx reference, OR Bokun tags the channel as GetYourGuide.
  if (opts?.getYourGuideOnly && !isGetYourGuideRef(parsed) && source !== "GetYourGuide") return "skipped";
  return importParsed(parsed, { source, cancelled: isCancellation(raw), raw });
}
