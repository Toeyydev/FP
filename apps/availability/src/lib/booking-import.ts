import { prisma } from "@/lib/db";
import { DEFAULT_GUIDE_FEE, defaultExpensesForTour } from "@/lib/jobsheet";
import { parseBokun, isCancellation, productKey, detectChannel, type ParsedBooking } from "@/lib/bookings";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";
import { todayD, ymd } from "@/lib/dates";
import { bokunApiEnabled, searchBookings } from "@/lib/bokun-api";
import { removeTourEvents } from "@/lib/tour-calendar-sync";
import { bookingRef } from "@/lib/booking-ref";

export type ImportResult = "created" | "updated" | "skipped";

const CAP = 10; // max pax per guide / job

export async function notifyOps(message: string, title: string, body: string, opts?: { push?: boolean; date?: string }) {
  // A finished job shouldn't alert: skip entirely if the tour date is in the past.
  if (opts?.date) { const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); if (opts.date < today) return; }
  try {
    const opsUsers = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
    for (const o of opsUsers) {
      // De-dupe: an unresolved alert (e.g. an over-capacity booking re-seen on every
      // 2.5-min auto-sync) must not stack up. If this exact message is already in the
      // operator's inbox, skip it — no second row, no second push.
      const dup = await prisma.notification.findFirst({ where: { userId: o.id, kind: "late-booking", message }, select: { id: true } });
      if (dup) continue;
      // Always record it in the in-app inbox; only PUSH (phone/browser ping) for
      // actionable alerts. Routine auto-handled events pass { push: false } so the
      // operator isn't pinged constantly.
      await prisma.notification.create({ data: { userId: o.id, kind: "late-booking", message } });
      if (opts?.push !== false) await sendPushToUser(o.id, { title, body, url: "/", tag: "late-booking" });
    }
  } catch { /* alerts are best-effort; never block import */ }
}

export async function notifyGuide(guideId: string, message: string, title: string, body: string) {
  try {
    const u = await prisma.user.findFirst({ where: { guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true } });
    if (!u) return;
    await prisma.notification.create({ data: { userId: u.id, kind: "job-change", message } });
    await sendPushToUser(u.id, { title, body, url: "/", tag: "job-change" });
    if (lineEnabled && u.lineUserId) await linePush(u.lineUserId, message);
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
    await notifyOps(`Removed a duplicate booking for "${rec.customerName}" on ${rec.date} — that name was already booked on this slot.`, "Duplicate removed", `${rec.customerName} · ${rec.date}`, { push: false, date: rec.date });
    return true;
  } catch { return false; }
}

// When a NEW booking lands for a slot already assigned to a guide: auto-add it to
// that guide's job if it stays within the 10-pax cap, and ALWAYS alert the
// operator to confirm. If it would breach the cap (or the slot is split across
// guides), leave it pending and alert for a manual decision. Never throws.
export async function autoAttachLate(b: { id: string; tourId: string | null; date: string | null; slotIdx: number | null; pax: number | null; customerName: string | null; confirmationCode: string | null; externalRef?: string | null; status: string }): Promise<boolean> {
  try {
    // Attach by date + slot — the assigned guide owns that time slot, so a new
    // booking lands on their job even if it arrived without a tour mapping yet.
    if (b.status !== "PENDING" || !b.date || b.slotIdx == null) return false;
    const assigns = await prisma.assignment.findMany({ where: { date: b.date, slotIdx: b.slotIdx } });
    if (assigns.length === 0) return false; // not dispatched yet — the normal inbox grouping handles it
    const ref = bookingRef(b.externalRef, b.confirmationCode) || b.customerName || "a new booking";
    if (assigns.length > 1) {
      await notifyOps(`Booking ${ref} for ${b.date} matches a slot already split across ${assigns.length} guides. Assign it manually.`, "Late booking needs assigning", `${ref} · ${b.date}`, { date: b.date });
      return false;
    }
    const a = assigns[0];
    const addPax = b.pax ?? 0;
    // The job's true total if this booking joins = every non-cancelled booking at the
    // slot (this PENDING one is already part of it), NOT assignment.pax + this booking
    // — which double-counts once assignment.pax has been re-synced to include it, and
    // wrongly holds a booking that actually fits under the cap.
    const slotBookings = await prisma.booking.findMany({ where: { date: b.date, slotIdx: b.slotIdx, status: { notIn: ["CANCELLED", "IGNORED"] } }, select: { pax: true } });
    const newTotal = slotBookings.reduce((s, x) => s + (x.pax ?? 0), 0) || ((a.pax ?? 0) + addPax);
    if (newTotal > CAP) {
      await notifyOps(`Booking ${ref} (+${addPax}) for ${b.date} puts ${a.guideId} over ${CAP} guests. Held — split it across guides.`, "Late booking over capacity", `${ref} · ${b.date} · ${a.guideId}`, { date: b.date });
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
    const tour = await prisma.tour.findUnique({ where: { id: a.tourId }, select: { name: true } });
    await prisma.jobSheet.upsert({
      where: key,
      create: { guideId: a.guideId, date: b.date, slotIdx: b.slotIdx, tourId: a.tourId, bookings: list as object, expenses: defaultExpensesForTour(tour?.name).map((e) => ({ ...e, pax: /inc\.?\s*guide/i.test(e.description) ? newTotal + 1 : newTotal })) as object, guideFee: DEFAULT_GUIDE_FEE as object },
      update: { bookings: list as object },
    });
    await notifyGuide(a.guideId, `A booking was added to your ${b.date} tour. You now have ${newTotal} guests.`, "Your tour group grew", `${b.date} · now ${newTotal} guests`);
    await notifyOps(`Booking ${ref} (+${addPax}) added to ${a.guideId}'s job on ${b.date} — now ${newTotal} guests.`, "Booking combined into a job", `${ref} → ${a.guideId} · ${b.date} · ${newTotal} pax`, { push: false, date: b.date });
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
    select: { id: true, tourId: true, date: true, slotIdx: true, pax: true, customerName: true, confirmationCode: true, externalRef: true, status: true },
  });
  let combined = 0;
  for (const b of pending) if (await autoAttachLate(b)) combined++;

  // Re-sync assignment.pax = the slot's live booking total (split-aware).
  const assigns = await prisma.assignment.findMany({ where: { date: { gte: today } }, select: { id: true, guideId: true, date: true, slotIdx: true, pax: true, googleEventId: true, opsGoogleEventId: true } });
  for (const a of assigns) {
    const bks = await prisma.booking.findMany({ where: { date: a.date, slotIdx: a.slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { pax: true, assignedGuideId: true } });
    const split = bks.some((b) => b.assignedGuideId);
    const mine = split ? bks.filter((b) => !b.assignedGuideId || b.assignedGuideId === a.guideId) : bks;
    const sum = mine.reduce((s, b) => s + (b.pax ?? 0), 0);
    if (sum > 0 && sum !== a.pax) await prisma.assignment.update({ where: { id: a.id }, data: { pax: sum } });
    // Safety net: a fully-cancelled slot (0 guests) loses its calendar events.
    else if (sum === 0 && (a.googleEventId || a.opsGoogleEventId)) {
      try { await removeTourEvents(a); } catch { /* best-effort */ }
      await prisma.assignment.update({ where: { id: a.id }, data: { googleEventId: null, opsGoogleEventId: null } });
    }
  }

  // Heal stranded bookings: a booking is only OFFERED while its slot is assigned to
  // a guide. If the assignment was removed (re-offer / unassign), return it to
  // PENDING so the job reappears in the inbox instead of vanishing.
  const assignedSlots = new Set(assigns.map((a) => `${a.date}|${a.slotIdx}`));
  const openOffers = await prisma.jobOffer.findMany({ where: { status: "OPEN", date: { gte: today } }, select: { date: true, slotIdx: true } });
  const liveOfferSlots = new Set(openOffers.map((o) => `${o.date}|${o.slotIdx}`));
  const offered = await prisma.booking.findMany({ where: { status: "OFFERED", date: { gte: today }, slotIdx: { not: null } }, select: { id: true, date: true, slotIdx: true } });
  const strand = offered.filter((b) => { const k = `${b.date}|${b.slotIdx}`; return !assignedSlots.has(k) && !liveOfferSlots.has(k); }).map((b) => b.id);
  if (strand.length) await prisma.booking.updateMany({ where: { id: { in: strand } }, data: { status: "PENDING" } });

  return combined;
}

// Upsert one already-parsed booking. Dedupes by (source, externalId); when no
// externalId, falls back to confirmationCode so re-imports don't duplicate.
// Auto-maps the tour from a learned product→tour mapping. Shared by the webhook,
// the Bokun API sync, and the CSV import.
// A live booking was cancelled (e.g. a GetYourGuide cancellation arriving via the
// Bokun webhook). If its slot is assigned to a guide, re-sync the guide's pax and
// tell them in real time so they aren't left expecting a guest who won't show.
async function onBookingCancelled(b: { date: string | null; slotIdx: number | null; customerName: string | null }): Promise<void> {
  try {
    if (!b.date || b.slotIdx == null) return;
    const assigns = await prisma.assignment.findMany({ where: { date: b.date, slotIdx: b.slotIdx }, select: { id: true, guideId: true, pax: true, googleEventId: true, opsGoogleEventId: true } });
    if (!assigns.length) return;
    const bks = await prisma.booking.findMany({ where: { date: b.date, slotIdx: b.slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { pax: true } });
    const sum = bks.reduce((acc, x) => acc + (x.pax ?? 0), 0);
    const who = b.customerName ? `${b.customerName} ` : "";
    for (const a of assigns) {
      if (sum !== a.pax) await prisma.assignment.update({ where: { id: a.id }, data: { pax: sum } });
      // Whole tour cancelled (no guests left) -> delete its Google Calendar events
      // from the guide + operator calendars so it doesn't linger.
      if (sum === 0 && (a.googleEventId || a.opsGoogleEventId)) {
        try { await removeTourEvents(a); } catch { /* calendar cleanup is best-effort */ }
        await prisma.assignment.update({ where: { id: a.id }, data: { googleEventId: null, opsGoogleEventId: null } });
      }
      const msg = sum === 0
        ? `Your ${b.date} tour was cancelled \u2014 all guests cancelled. It has been removed from your calendar.`
        : `A guest cancelled on your ${b.date} tour. You now have ${sum} guest${sum === 1 ? "" : "s"}.`;
      await notifyGuide(a.guideId, msg, sum === 0 ? "Tour cancelled" : "A guest cancelled", `${b.date} \u00b7 ${sum} guests`);
      await notifyOps(`Cancellation on ${b.date}: ${who}left ${a.guideId}'s job \u2014 now ${sum} guests.${sum === 0 ? " Calendar event removed." : ""}`, "Booking cancelled", `${b.date} \u00b7 ${a.guideId} \u00b7 ${sum} pax`, { push: false, date: b.date });
    }
  } catch { /* real-time alert + calendar sync are best-effort; the cancellation is already saved */ }
}

export async function importParsed(p: ParsedBooking, opts: { source: string; cancelled: boolean; raw?: unknown }): Promise<ImportResult> {
  let tourId: string | null = null;
  if (p.productName) {
    const map = await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null);
    if (map) tourId = map.tourId;
  }
  const { source, cancelled } = opts;
  const raw = (opts.raw ?? undefined) as object | undefined;

  if (p.externalId) {
    const existing = await prisma.booking.findUnique({ where: { source_externalId: { source, externalId: p.externalId } }, select: { id: true, status: true } });
    // The SAME OTA booking can re-arrive under a different Bokun externalId (a
    // re-issue / channel remap). If we already hold this externalRef, update THAT
    // record in place instead of creating a duplicate.
    if (!existing && p.externalRef) {
      const byRef = await prisma.booking.findFirst({ where: { externalRef: p.externalRef }, select: { id: true, status: true } });
      if (byRef) {
        const updated = await prisma.booking.update({ where: { id: byRef.id }, data: { confirmationCode: p.confirmationCode ?? undefined, productName: p.productName ?? undefined, tourId: tourId ?? undefined, date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined, pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, status: cancelled ? "CANCELLED" : undefined, raw } });
        if (cancelled && byRef.status !== "CANCELLED") await onBookingCancelled(updated);
        return "updated";
      }
    }
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
    if (cancelled && existing?.status !== "CANCELLED") await onBookingCancelled(rec);
    return existing ? "updated" : "created";
  }

  // No externalId: dedupe on confirmationCode / externalRef so re-import is safe.
  const ref = p.confirmationCode || p.externalRef;
  if (ref) {
    const dup = await prisma.booking.findFirst({ where: { OR: [{ confirmationCode: ref }, { externalRef: ref }] }, select: { id: true, status: true } });
    if (dup) {
      const updated = await prisma.booking.update({ where: { id: dup.id }, data: { tourId: tourId ?? undefined, date: p.date ?? undefined, slotIdx: p.slotIdx ?? undefined, pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, productName: p.productName ?? undefined, status: cancelled ? "CANCELLED" : undefined } });
      if (cancelled && dup.status !== "CANCELLED") await onBookingCancelled(updated);
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

// A direct/website Folkpaths booking reference looks like "FOLK-xxxx".
function isDirectFolkRef(p: { confirmationCode?: string; externalRef?: string }): boolean {
  return [p.confirmationCode, p.externalRef].some((r) => /^FOLK-/i.test((r ?? "").trim()));
}

// An OTA booking we want to sync: GetYourGuide (GET-xxxx) or Viator, i.e. anything
// sold through a marketplace channel — but never a direct FOLK-xxxx website booking.
function isOtaBooking(p: { confirmationCode?: string; externalRef?: string }, source: string): boolean {
  if (isDirectFolkRef(p)) return false;                                  // never sync direct/website bookings
  if ([p.confirmationCode, p.externalRef].some((r) => /^GET-/i.test((r ?? "").trim()))) return true; // GetYourGuide
  return /viator|getyourguide/i.test(source);                           // Viator / GYG by channel
}

// Import a raw Bokun/channel payload (deep-parsed). With { otaOnly }, syncs only
// marketplace bookings (GetYourGuide + Viator) and skips direct FOLK-xxxx website
// bookings — so the inbox stays clean. The live webhook leaves it off.
export async function importRawBooking(raw: unknown, opts?: { otaOnly?: boolean }): Promise<ImportResult> {
  const parsed = parseBokun(raw);
  const source = detectChannel(raw);
  if (opts?.otaOnly && !isOtaBooking(parsed, source)) return "skipped";
  return importParsed(parsed, { source, cancelled: isCancellation(raw), raw });
}


// Background safety net: pull recent Bokun bookings (incl. CANCELLED) so the board
// stays current even when the live webhook is down. Throttled to once / 10 min via
// the audit log (works across instances) plus a per-instance in-flight guard.
// Best-effort and meant to be fire-and-forget — never throws into the caller.
let autoSyncInFlight = false;
export async function autoSyncBokun(): Promise<void> {
  if (!bokunApiEnabled || autoSyncInFlight) return;
  autoSyncInFlight = true;
  try {
    const throttleAgo = new Date(Date.now() - 2 * 60_000); // de-dupe across page-loads + the background loop / replicas
    const recent = await prisma.auditLog.findFirst({ where: { action: "bokun.autosync", createdAt: { gte: throttleAgo } }, select: { id: true } });
    if (recent) return; // synced within the throttle window — skip
    await prisma.auditLog.create({ data: { action: "bokun.autosync", entityType: "Booking" } });
    // Occasionally prune the sync-log noise so the audit table stays small (keep 3
    // days — enough for the throttle + a little history). The action index keeps the
    // "last X" lookups fast regardless, this just bounds growth.
    if (Math.random() < 0.05) {
      await prisma.auditLog.deleteMany({ where: { action: { in: ["bokun.autosync", "bokun.autosync.done"] }, createdAt: { lt: new Date(Date.now() - 3 * 86400_000) } } }).catch(() => {});
    }
    const now = Date.now();
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const from = fmt(now - 14 * 86400_000);
    const to = fmt(now + 120 * 86400_000);
    let synced = 0;
    let firstPageFailed: { status: number; error?: string } | null = null;
    for (let page = 1; page <= 10; page++) {
      const res = await searchBookings({ from, to, page, pageSize: 100 });
      if (!res.ok) { if (page === 1) firstPageFailed = { status: res.status, error: res.error }; break; }
      if (res.items.length === 0) break;
      for (const item of res.items) { try { await importRawBooking(item, { otaOnly: true }); synced++; } catch { /* skip a bad item */ } }
      if (res.items.length < 100) break;
    }
    if (firstPageFailed) {
      // Don't fail silently: record the error, and if Bokun has been failing for a
      // while, alert the operators (at most once every 2h so it never spams).
      await prisma.auditLog.create({ data: { action: "bokun.autosync.error", entityType: "Booking", detail: firstPageFailed } });
      const fails = await prisma.auditLog.count({ where: { action: "bokun.autosync.error", createdAt: { gte: new Date(Date.now() - 30 * 60_000) } } });
      const alerted = await prisma.auditLog.findFirst({ where: { action: "bokun.alert", createdAt: { gte: new Date(Date.now() - 2 * 3600_000) } }, select: { id: true } });
      if (fails >= 3 && !alerted) {
        await notifyOps(`Bokun sync has been failing (${fails}\\u00d7 in 30 min, last status ${firstPageFailed.status}). Bookings & cancellations may be out of date \\u2014 check the Bokun connection.`, "\\u26a0\\ufe0f Bokun sync failing", `${fails} failures \\u00b7 status ${firstPageFailed.status}`);
        await prisma.auditLog.create({ data: { action: "bokun.alert", entityType: "Booking", detail: { fails, status: firstPageFailed.status } } });
      }
    }
    // (No per-tick "done" row — it was pure noise; the throttle marker above is enough.)
  } catch { /* auto-sync is best-effort */ }
  finally { autoSyncInFlight = false; }
}
