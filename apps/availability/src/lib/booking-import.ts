import { prisma } from "@/lib/db";
import { DEFAULT_GUIDE_FEE, defaultExpensesForTour } from "@/lib/jobsheet";
import { parseBokun, isCancellation, productKey, detectChannel, isChannelProductName, type ParsedBooking } from "@/lib/bookings";
import { isEveningSlot } from "@/lib/slots";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";
import { sendEmail } from "@/lib/email";
import { todayD, ymd } from "@/lib/dates";
import { bokunApiEnabled, searchBookings } from "@/lib/bokun-api";
import { removeTourEvents } from "@/lib/tour-calendar-sync";
import { bookingRef } from "@/lib/booking-ref";

export type ImportResult = "created" | "updated" | "skipped";

const CAP = 10; // max pax per guide / job

export type SheetRow = { name?: string; bookingNo?: string; bookedPax?: number | null; actualPax?: number | null; tickets?: string; status?: string; noShowPax?: number };
type LiveActive = { customerName: string | null; externalRef: string | null; confirmationCode: string | null; pax: number | null; noShow?: boolean };

// Rebuild a saved job sheet's booking rows from the live ACTIVE bookings for its slot
// (already split-filtered to this guide). Adds a booking that's missing from the sheet
// (e.g. one that became OFFERED without going through the PENDING auto-attach path),
// drops a numbered row whose booking is no longer active here (cancelled / re-slotted /
// handed to another guide), keeps manual rows (no booking number), collapses duplicate
// rows for the same booking, and PRESERVES the operator's per-row edits (actual pax /
// tickets / status / no-show) on rows that survive. Pure — no IO — so it's unit-tested
// directly. This is the single source of truth for "what guests belong on this sheet",
// so nothing a guide is actually taking can silently fall off it again.
export function reconcileSheetRows(saved: SheetRow[], mine: LiveActive[]): SheetRow[] {
  const liveRef = (b: LiveActive) => bookingRef(b.externalRef, b.confirmationCode).toLowerCase();
  const rowRef = (r: SheetRow) => (r.bookingNo || "").trim().toLowerCase();
  const liveByRef = new Map(mine.map((b) => [liveRef(b), b] as const));
  const seen = new Set<string>();
  const kept: SheetRow[] = [];
  for (const r of saved) {
    const rr = rowRef(r);
    if (!rr) { kept.push(r); continue; }              // manual row (no booking number) — always keep
    if (seen.has(rr)) continue;                        // duplicate row for the same booking — collapse
    const lb = liveByRef.get(rr);
    if (!lb) continue;                                 // booking no longer active at this slot — drop
    seen.add(rr);
    kept.push({ ...r, name: lb.customerName ?? r.name ?? "", bookingNo: bookingRef(lb.externalRef, lb.confirmationCode), bookedPax: lb.pax ?? r.bookedPax ?? null });
  }
  const added: SheetRow[] = mine
    .filter((b) => !seen.has(liveRef(b)))
    .map((b) => ({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: null, tickets: "", status: b.noShow ? "no-show" : "" }));
  return kept.concat(added);
}

// Persist reconcileSheetRows for one guide's saved sheet: only for upcoming/today tours
// (a past tour is a finished record — never touched), only when a sheet already exists
// (an unassigned-yet slot is scaffolded on demand by GET /api/jobsheet), and only writes
// when something actually changed. Best-effort caller contract: returns null when there's
// nothing to do. Split-aware — on a split slot the guide keeps only their tagged guests.
export async function syncSheetToLiveBookings(guideId: string, date: string, slotIdx: number): Promise<{ added: number; removed: number } | null> {
  if (date < ymd(todayD())) return null;                                   // finished tour — leave the record as saved
  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true, bookings: true } });
  if (!sheet) return null;                                                 // no saved sheet yet — GET scaffolds from live bookings
  const saved = (Array.isArray(sheet.bookings) ? sheet.bookings : []) as SheetRow[];
  const allAtSlot = await prisma.booking.findMany({
    where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
    select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true },
    orderBy: { createdAt: "asc" },
  });
  const split = allAtSlot.some((b) => b.assignedGuideId);
  const mine = split ? allAtSlot.filter((b) => !b.assignedGuideId || b.assignedGuideId === guideId) : allAtSlot;
  const next = reconcileSheetRows(saved, mine);
  if (JSON.stringify(next) === JSON.stringify(saved)) return { added: 0, removed: 0 };
  await prisma.jobSheet.update({ where: { id: sheet.id }, data: { bookings: next as object } });
  const refs = (rows: SheetRow[]) => new Set(rows.map((r) => (r.bookingNo || "").trim().toLowerCase()).filter(Boolean));
  const before = refs(saved), after = refs(next);
  let added = 0, removed = 0;
  after.forEach((r) => { if (!before.has(r)) added++; });
  before.forEach((r) => { if (!after.has(r)) removed++; });
  return { added, removed };
}

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
    const u = await prisma.user.findFirst({ where: { guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true, email: true } });
    if (!u) return;
    await prisma.notification.create({ data: { userId: u.id, kind: "job-change", message } });
    await sendPushToUser(u.id, { title, body, url: "/", tag: "job-change" });
    if (lineEnabled && u.lineUserId) await linePush(u.lineUserId, message);
    // Email is the catch-all: most guides have no push or LINE, so without this a
    // cancellation / group-change notice would never reach them. Skip placeholders.
    const realEmail = u.email && !/@(?:guides\.)?folkpath\.local$/i.test(u.email);
    if (realEmail) await sendEmail({ to: u.email!, subject: title, text: message, html: `<p>${message}</p><p style="font-size:13px;color:#888"><a href="https://guide.folkpaths.com/">Open Folkpaths</a></p>` }).catch(() => {});
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

// A re-import can create a second row for the SAME booking (a different confirmation
// code carrying the same GYG ref, or a cross-listed copy). Auto-remove ONLY a true
// duplicate — one that shares this booking's NUMBER (bookingRef of externalRef /
// confirmation code) with an existing row on the same date+slot. A matching NAME but a
// DIFFERENT booking number is two real reservations (a repeat customer, or two guests
// who happen to share a name), so we keep BOTH and only alert ops to eyeball it — never
// drop a paid booking on a name clash. Scoped to date+slot so two different tours for
// the same person are untouched. Returns true only when it removed a genuine duplicate.
async function autoRemoveExactDuplicate(rec: { id: string; customerName: string | null; date: string | null; slotIdx: number | null; externalRef: string | null; confirmationCode: string | null }): Promise<boolean> {
  try {
    const name = (rec.customerName || "").trim().toLowerCase();
    if (!name || !rec.date || rec.slotIdx == null) return false;
    const newRef = (bookingRef(rec.externalRef, rec.confirmationCode) || "").trim().toLowerCase();
    const others = await prisma.booking.findMany({
      where: { id: { not: rec.id }, date: rec.date, slotIdx: rec.slotIdx, status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { customerName: true, externalRef: true, confirmationCode: true },
    });
    const sameName = others.filter((o) => (o.customerName || "").trim().toLowerCase() === name);
    if (!sameName.length) return false;
    // Shares a booking number with an existing same-name row → genuine re-import: remove it.
    if (newRef && sameName.some((o) => (bookingRef(o.externalRef, o.confirmationCode) || "").trim().toLowerCase() === newRef)) {
      await prisma.booking.update({ where: { id: rec.id }, data: { status: "IGNORED", notes: "Auto-removed: identical booking (same booking number) already on this slot" } });
      await notifyOps(`Removed a re-imported duplicate of "${rec.customerName}" on ${rec.date} — same booking number already on this slot.`, "Duplicate removed", `${rec.customerName} · ${rec.date}`, { push: false, date: rec.date });
      return true;
    }
    // Same name, DIFFERENT booking number → two real bookings. Keep both; flag for a look.
    await notifyOps(`Two bookings under "${rec.customerName}" on ${rec.date} have different booking numbers — both kept. Please verify they're separate guests.`, "Same name, different booking", `${rec.customerName} · ${rec.date}`, { push: false, date: rec.date });
    return false;
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
    const list = Array.isArray(js?.bookings) ? (js!.bookings as Array<{ bookingNo?: string; name?: string; bookedPax?: number | null; actualPax?: number | null; tickets?: string; status?: string }>) : [];
    // Don't append a guest who's already a row. A re-import / re-slot can arrive with a
    // different name spelling ("Romel Sierra" vs "Sierra, Romel"), so match on the
    // booking ref (stable) first, then name — otherwise the sheet double-lists the guest
    // and inflates the booked pax.
    const newRef = (bookingRef(b.externalRef, b.confirmationCode) || "").trim().toLowerCase();
    const newName = (b.customerName || "").trim().toLowerCase();
    const already = list.some((r) => {
      const rRef = (r.bookingNo || "").trim().toLowerCase();
      return newRef ? rRef === newRef : newName ? (r.name || "").trim().toLowerCase() === newName : false;
    });
    if (!already) list.push({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: null, tickets: "", status: "" });
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
//
// Throttled: this ~70-query sweep fires from every dashboard AND inbox load, so with
// a few operators/tabs polling it used to re-run many times a minute for no gain (the
// data barely moves between calls) — a big driver of general DB contention / slowness.
// We now run it at most once per RECONCILE_MIN_GAP_MS across the process; the 30-min
// background loop and the manual Sync path pass force=true for an immediate real sweep.
let lastReconcileAt = 0;
const RECONCILE_MIN_GAP_MS = 45_000;
export async function reconcileAssignedBookings(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastReconcileAt < RECONCILE_MIN_GAP_MS) return 0;
  lastReconcileAt = now;
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
    // Keep the SAVED job sheet's guest list in sync too — pax alone isn't enough: the
    // job order, PDF, LINE sheet and payment all read the stored rows, so an OFFERED
    // late-add or a cancellation that only moved the pax would otherwise leave a guest
    // missing (or a cancelled one lingering) on the printed/sent sheet. Only on the
    // FORCED sweep (30-min loop + manual Sync) — these are extra per-assignment queries,
    // so we keep them off the dashboard/inbox request path. onBookingCancelled prunes a
    // cancellation immediately, and autoAttachLate adds PENDING right away, so the
    // request path stays fast without letting the sheet fall behind.
    if (force) { try { await syncSheetToLiveBookings(a.guideId, a.date, a.slotIdx); } catch { /* best-effort; never block the sweep */ } }
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
    const assigns = await prisma.assignment.findMany({ where: { date: b.date, slotIdx: b.slotIdx }, select: { id: true, guideId: true, pax: true, googleEventId: true, opsGoogleEventId: true, date: true, slotIdx: true } });
    if (!assigns.length) return;
    const bks = await prisma.booking.findMany({ where: { date: b.date, slotIdx: b.slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { pax: true, assignedGuideId: true } });
    const split = bks.some((x) => x.assignedGuideId);
    const upcoming = b.date >= ymd(todayD());
    const who = b.customerName ? `${b.customerName} ` : "";
    for (const a of assigns) {
      // Split-aware: this guide's remaining guests (on a split slot, only theirs).
      const mine = split ? bks.filter((x) => !x.assignedGuideId || x.assignedGuideId === a.guideId) : bks;
      const sum = mine.reduce((acc, x) => acc + (x.pax ?? 0), 0);

      if (sum === 0 && upcoming) {
        // Whole tour cancelled \u2014 remove it from the guide entirely (calendar, job
        // sheet, check-ins, any open offer, and the assignment) so it disappears
        // from their schedule. Never touch a tour that's already been paid.
        const paid = await prisma.tourPayment.findFirst({ where: { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, status: "PAID" }, select: { id: true } });
        try { await removeTourEvents(a); } catch { /* calendar cleanup is best-effort */ }
        if (!paid) {
          const where = { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx };
          await prisma.$transaction([
            prisma.jobOffer.updateMany({ where: { date: a.date, slotIdx: a.slotIdx, status: "OPEN" }, data: { status: "EXPIRED" } }),
            prisma.checkin.deleteMany({ where }),
            prisma.tourReport.deleteMany({ where }),
            prisma.guideRating.deleteMany({ where }),
            prisma.tourPayment.deleteMany({ where }),
            prisma.jobSheet.deleteMany({ where }),
            prisma.assignment.deleteMany({ where }),
          ]);
        }
        await notifyGuide(a.guideId, `Your ${b.date} tour was cancelled \u2014 all guests cancelled. It has been removed from your schedule.`, "Tour cancelled", `${b.date} \u00b7 removed`);
        await notifyOps(`Cancellation on ${b.date}: ${who}was the last guest \u2014 ${a.guideId}'s tour removed from the board.`, "Tour cancelled", `${b.date} \u00b7 ${a.guideId} \u00b7 removed`, { push: false, date: b.date });
      } else {
        if (sum !== a.pax) await prisma.assignment.update({ where: { id: a.id }, data: { pax: sum } });
        // Drop the cancelled guest's row from the saved sheet right away so the job
        // order / PDF / LINE sheet don't keep listing someone who cancelled.
        try { await syncSheetToLiveBookings(a.guideId, a.date, a.slotIdx); } catch { /* best-effort */ }
        await notifyGuide(a.guideId, `A guest cancelled on your ${b.date} tour. You now have ${sum} guest${sum === 1 ? "" : "s"}.`, "A guest cancelled", `${b.date} \u00b7 ${sum} guests`);
        await notifyOps(`Cancellation on ${b.date}: ${who}left ${a.guideId}'s job \u2014 now ${sum} guests.`, "Booking cancelled", `${b.date} \u00b7 ${a.guideId} \u00b7 ${sum} pax`, { push: false, date: b.date });
      }
    }
  } catch { /* real-time alert + calendar sync are best-effort; the cancellation is already saved */ }
}

export async function importParsed(p: ParsedBooking, opts: { source: string; cancelled: boolean; raw?: unknown }): Promise<ImportResult> {
  let tourId: string | null = null;
  if (p.productName) {
    const map = await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null);
    if (map) {
      // A channel-only "product" (e.g. "GetYourGuide") maps to the daytime default
      // (Grand Palace). That's wrong for an evening slot (16:30+) — those are the
      // China Town food tours — so leave it UNMAPPED for the operator to connect,
      // rather than silently filing it under Grand Palace.
      const eveningChannelOnly = isChannelProductName(p.productName) && isEveningSlot(p.slotIdx);
      if (!eveningChannelOnly) tourId = map.tourId;
    }
  }
  const { source, cancelled } = opts;
  const raw = (opts.raw ?? undefined) as object | undefined;

  // A booking whose date/slot an operator pinned by hand (a rebooking arranged outside
  // the OTA) must survive the sync: when pinned, an import updates everything EXCEPT the
  // date/slot/time, so the channel's original date can't drag it back. Non-pinned (the
  // default) behaves exactly as before.
  const slotFields = (pinned: boolean) =>
    pinned ? {} : { date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined };

  if (p.externalId) {
    const existing = await prisma.booking.findUnique({ where: { source_externalId: { source, externalId: p.externalId } }, select: { id: true, status: true, datePinned: true } });
    // The SAME OTA booking can re-arrive under a different Bokun externalId (a
    // re-issue / channel remap). If we already hold this externalRef, update THAT
    // record in place instead of creating a duplicate.
    if (!existing && p.externalRef) {
      const byRef = await prisma.booking.findFirst({ where: { externalRef: p.externalRef }, select: { id: true, status: true, datePinned: true } });
      if (byRef) {
        const updated = await prisma.booking.update({ where: { id: byRef.id }, data: { confirmationCode: p.confirmationCode ?? undefined, productName: p.productName ?? undefined, tourId: tourId ?? undefined, ...slotFields(byRef.datePinned), pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, status: cancelled ? "CANCELLED" : undefined, raw } });
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
        tourId: tourId ?? undefined, ...slotFields(existing?.datePinned ?? false),
        pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, status: cancelled ? "CANCELLED" : undefined, raw,
      },
    });
    if (!existing && !(await autoRemoveExactDuplicate(rec)) && !(await flagCrossChannelDuplicate(rec))) await autoAttachLate(rec);
    if (cancelled && existing?.status !== "CANCELLED") await onBookingCancelled(rec);
    return existing ? "updated" : "created";
  }

  // No externalId: dedupe on confirmationCode / externalRef so re-import is safe.
  const ref = p.confirmationCode || p.externalRef;
  if (ref) {
    const dup = await prisma.booking.findFirst({ where: { OR: [{ confirmationCode: ref }, { externalRef: ref }] }, select: { id: true, status: true, datePinned: true } });
    if (dup) {
      const updated = await prisma.booking.update({ where: { id: dup.id }, data: { tourId: tourId ?? undefined, ...slotFields(dup.datePinned), pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, productName: p.productName ?? undefined, status: cancelled ? "CANCELLED" : undefined } });
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
  if (!(await autoRemoveExactDuplicate(rec)) && !(await flagCrossChannelDuplicate(rec))) await autoAttachLate(rec);
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
// stays current even when the live webhook is down. Cached to once / 30 min via the
// audit log (works across instances) plus a per-instance in-flight guard.
// Best-effort and meant to be fire-and-forget — never throws into the caller.
let autoSyncInFlight = false;
export async function autoSyncBokun(): Promise<void> {
  if (!bokunApiEnabled || autoSyncInFlight) return;
  autoSyncInFlight = true;
  try {
    // Refresh Bokun every 30 min: if we pulled within the last 30 min, serve the
    // board from the DB and don't hit Bokun again. The operator's manual "Sync"
    // button (/api/bokun/sync) bypasses this for anything that can't wait.
    const throttleAgo = new Date(Date.now() - 30 * 60_000); // dedupes page-loads + the background loop / replicas
    const recent = await prisma.auditLog.findFirst({ where: { action: "bokun.autosync", createdAt: { gte: throttleAgo } }, select: { id: true } });
    if (recent) return; // pulled within the 30-min refresh window — skip
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
