import { prisma } from "@/lib/db";
import { parseBokun, isCancellation, productKey, detectChannel, isChannelProductName, slotAwareTourId, type ParsedBooking } from "@/lib/bookings";
import { isEveningSlot } from "@/lib/slots";
import { sendPushToUser } from "@/lib/push";
import { linePush, linePushFlex, lineEnabled } from "@/lib/line";
import { sendEmail } from "@/lib/email";
import { todayD, ymd } from "@/lib/dates";
import { bokunApiEnabled, searchBookings } from "@/lib/bokun-api";
import { removeTourEvents } from "@/lib/tour-calendar-sync";
import { bookingRef } from "@/lib/booking-ref";
import { siteUrl } from "@/lib/site";
import { hasHistoricalJobSheet } from "@/lib/historical-guard";
import { audit } from "@/lib/audit";
import { financialHistoryBlockers } from "@/lib/payments-v2/history";
import { tourStartMs } from "@/lib/no-show-count";
import { reconcileBookingChange, reconcileBookings, reconcileDeparture, planDeparture, depKey, type ReconcileSource, type Departure } from "@/lib/booking-reconcile";
import { SHEET_BOOKING_STATUSES, type SheetBooking } from "@/lib/sheet-bookings";

export type ImportResult = "created" | "updated" | "skipped";

// `dedupe: false` is for a caller that decided itself, against recorded state, that this is
// news — a count going 6 → 8 again after a stale 8 → 6 must be said again.
export async function notifyOps(message: string, title: string, body: string, opts?: { push?: boolean; date?: string; dedupe?: boolean }) {
  // A finished job shouldn't alert: skip entirely if the tour date is in the past.
  if (opts?.date) { const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); if (opts.date < today) return; }
  try {
    const opsUsers = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
    for (const o of opsUsers) {
      // De-dupe: an unresolved alert (e.g. an over-capacity booking re-seen on every
      // 2.5-min auto-sync) must not stack up. If this exact message is already in the
      // operator's inbox, skip it — no second row, no second push.
      const dup = opts?.dedupe === false ? null : await prisma.notification.findFirst({ where: { userId: o.id, kind: "late-booking", message }, select: { id: true } });
      if (dup) continue;
      // Always record it in the in-app inbox; only PUSH (phone/browser ping) for
      // actionable alerts. Routine auto-handled events pass { push: false } so the
      // operator isn't pinged constantly.
      await prisma.notification.create({ data: { userId: o.id, kind: "late-booking", message } });
      if (opts?.push !== false) await sendPushToUser(o.id, { title, body, url: "/", tag: "late-booking" });
    }
  } catch { /* alerts are best-effort; never block import */ }
}

// `opts.url` is where a tap on the push lands (default: the app home). `opts.email: false`
// skips the email copy — for a caller that already emails the guide something better
// (the direct-assignment calendar invite), so they do not get two.
export async function notifyGuide(guideId: string, message: string, title: string, body: string, lineFlex?: { altText: string; contents: Record<string, unknown> }, opts: { url?: string; email?: boolean } = {}) {
  try {
    const u = await prisma.user.findFirst({ where: { guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true, email: true } });
    if (!u) return;
    await prisma.notification.create({ data: { userId: u.id, kind: "job-change", message } });
    await sendPushToUser(u.id, { title, body, url: opts.url ?? "/", tag: "job-change" });
    // On LINE, send the rich Flex card when one is supplied (e.g. the payment
    // breakdown table); otherwise fall back to the plain-text message.
    if (lineEnabled && u.lineUserId) await (lineFlex ? linePushFlex(u.lineUserId, lineFlex.altText, lineFlex.contents) : linePush(u.lineUserId, message));
    // Email is the catch-all: most guides have no push or LINE, so without this a
    // cancellation / group-change notice would never reach them. Skip placeholders.
    const realEmail = u.email && !/@(?:guides\.)?folkpath\.local$/i.test(u.email);
    if (realEmail && opts.email !== false) await sendEmail({ to: u.email!, subject: title, text: message, html: `<p>${message}</p><p style="font-size:13px;color:#888"><a href="${siteUrl()}">Open Folkpaths</a></p>` }).catch(() => {});
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
async function autoRemoveExactDuplicate(rec: { id: string; customerName: string | null; date: string | null; slotIdx: number | null; externalRef: string | null; confirmationCode: string | null; phone?: string | null; tourId?: string | null }, phoneHidden = false, via: ReconcileSource = "autosync"): Promise<boolean> {
  try {
    const name = (rec.customerName || "").trim().toLowerCase();
    if (!name || !rec.date || rec.slotIdx == null) return false;
    const newRef = (bookingRef(rec.externalRef, rec.confirmationCode) || "").trim().toLowerCase();
    const others = await prisma.booking.findMany({
      where: { id: { not: rec.id }, date: rec.date, slotIdx: rec.slotIdx, status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { id: true, customerName: true, externalRef: true, confirmationCode: true, phone: true, tourId: true },
    });
    const sameName = others.filter((o) => (o.customerName || "").trim().toLowerCase() === name);
    if (!sameName.length) return false;
    // Shares a booking number with an existing same-name row → genuine re-import: remove it.
    const kept = newRef ? sameName.find((o) => (bookingRef(o.externalRef, o.confirmationCode) || "").trim().toLowerCase() === newRef) : undefined;
    if (kept) {
      await prisma.booking.update({ where: { id: rec.id }, data: { status: "IGNORED", notes: "Auto-removed: identical booking (same booking number) already on this slot" } });
      // The re-import may be the copy that carries the guest's number. Keep it on the row
      // that stays, when that row has none — never overwrite one it already holds.
      // And when the channel now hides the guest's details, the row that stays stops holding them.
      if (phoneHidden && kept.phone) await prisma.booking.update({ where: { id: kept.id }, data: { phone: null } });
      else if (rec.phone && !kept.phone) await prisma.booking.update({ where: { id: kept.id }, data: { phone: rec.phone } });
      // Likewise its tour. The copies come from different feeds with different product
      // names, and only one may be mapped yet — when the channel renames a product, the
      // webhook copy arrives with no tour while the search copy still has one. Hiding the
      // copy that knows its tour left the booking off every board (GYG ref, 3 Oct 2026).
      // Filled in on the row that stays when it has none; never overwrites a tour it has.
      if (rec.tourId && !kept.tourId) {
        await prisma.booking.update({ where: { id: kept.id }, data: { tourId: rec.tourId } });
        try { await reconcileBookingChange(kept.id, { source: via, reason: "tour taken from a duplicate copy" }); } catch { /* best-effort; the tour is saved */ }
      }
      await notifyOps(`Removed a re-imported duplicate of "${rec.customerName}" on ${rec.date} — same booking number already on this slot.`, "Duplicate removed", `${rec.customerName} · ${rec.date}`, { push: false, date: rec.date });
      return true;
    }
    // Same name, DIFFERENT booking number → two real bookings. Keep both; flag for a look.
    await notifyOps(`Two bookings under "${rec.customerName}" on ${rec.date} have different booking numbers — both kept. Please verify they're separate guests.`, "Same name, different booking", `${rec.customerName} · ${rec.date}`, { push: false, date: rec.date });
    return false;
  } catch { return false; }
}

// When a NEW booking lands for a slot already assigned to a guide: NEVER attach it
// automatically. The operator planned that group when they dispatched it, so a late
// arrival goes back to them — the booking stays PENDING in the Bookings inbox and
// ops get an actionable alert to review and place it themselves (add it to the
// guide, split the slot, or offer it out). Never throws.
export async function autoAttachLate(b: { id: string; tourId: string | null; date: string | null; slotIdx: number | null; pax: number | null; customerName: string | null; confirmationCode: string | null; externalRef?: string | null; status: string }, via: ReconcileSource = "sweep"): Promise<boolean> {
  // A booking that arrives after a guide was assigned used to be HELD as PENDING with an
  // alert asking an operator to place it — and on 13 Sep 2026 nobody did, so a job sheet
  // kept 6 guests while 8 came. It now goes through the one reconciliation service
  // (lib/booking-reconcile): placed on the guide's job when that is unambiguous, left for
  // an operator with a review alert when it is not. Never throws.
  try {
    const r = await reconcileBookingChange(b.id, { source: via, reason: "booking on an assigned departure" });
    return r.kind === "reconciled" && r.changed.includes("booking placed");
  } catch { return false; /* import must succeed regardless */ }
}

/** Booking ids an import touched, with where each was before — reconciled once per departure afterwards. */
export type DirtyBookings = Map<string, Departure[]>;

/** Every write in importParsed ends here: the booking's change is carried to the job(s) —
 *  now, or (a batch import passing `collect`) once per departure when the batch is done. */
async function reconcileAfterImport(id: string, via: ReconcileSource, before?: { date: string | null; slotIdx: number | null } | null, collect?: DirtyBookings): Promise<void> {
  const previous: Departure[] = before?.date && before.slotIdx != null ? [{ date: before.date, slotIdx: before.slotIdx }] : [];
  if (collect) { collect.set(id, [...(collect.get(id) ?? []), ...previous]); return; }
  try { await reconcileBookingChange(id, { source: via, reason: "booking imported", previous }); } catch { /* best-effort; the booking is saved */ }
}

/** Reconcile what a batch import collected: each affected departure once. Never throws. */
export async function reconcileCollected(collect: DirtyBookings, via: ReconcileSource): Promise<void> {
  try { await reconcileBookings([...collect].map(([id, previous]) => ({ id, previous })), { source: via, reason: "booking imported" }); } catch { /* best-effort */ }
}

// A payload saying a booking is live, for a booking FolkOPS already holds as CANCELLED, is an
// older event arriving late (a retried webhook, a stale page): Bokun does not un-cancel a
// booking — a rebooking is a new booking with its own code. Applying it would put stale
// pax, date or tour onto the record, so nothing is applied and the refusal is audited.
// Bokun sends no modification time or version to order other updates by (checked on the
// stored payloads, 2026-09-30: only creationDate and cancellationDate), so this is the one
// ordering FolkOPS can prove; for the rest, the last payload received is the booking, and
// the hourly autosync — which reads Bokun's CURRENT state — puts any late stale value right.
async function ignoreStaleLive(rec: { id: string; status: string }, cancelled: boolean, via: ReconcileSource): Promise<boolean> {
  if (cancelled || rec.status !== "CANCELLED") return false;
  await audit({ action: "booking.stale_update_ignored", entityType: "Booking", entityId: rec.id, detail: { via, reason: "a live payload arrived for a booking already cancelled at the source; nothing applied" } });
  return true;
}

// The sweep: every upcoming ASSIGNED departure whose jobs disagree with its bookings is
// reconciled (lib/booking-reconcile) — a PENDING booking a guide's job can take, an expected
// pax that no longer matches the job's own bookings, a sheet missing a guest or still
// listing a cancelled one. Which departures need it is decided from ONE read of all upcoming
// assignments, bookings and sheets with the same ownership rule the reconciliation uses, so
// the sweep never recounts a job the reconciliation would leave alone (two guides and
// untagged guests, an unmapped booking — those wait for an operator).
// Idempotent — safe to call on every inbox / dashboard load.
//
// Throttled: it fires from every dashboard AND inbox load, so it runs at most once per
// RECONCILE_MIN_GAP_MS across the process; the background loop and the manual Sync path
// pass force=true for an immediate real sweep.
let lastReconcileAt = 0;
const RECONCILE_MIN_GAP_MS = 45_000;
export async function reconcileAssignedBookings(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastReconcileAt < RECONCILE_MIN_GAP_MS) return 0;
  lastReconcileAt = now;
  const today = ymd(todayD());
  const [assigns, bks, sheets] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: today } }, select: { id: true, guideId: true, tourId: true, date: true, slotIdx: true, pax: true, googleEventId: true, opsGoogleEventId: true } }),
    prisma.booking.findMany({ where: { date: { gte: today }, slotIdx: { not: null }, status: { in: [...SHEET_BOOKING_STATUSES, "CANCELLED"] } }, select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true, date: true, slotIdx: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: today } }, select: { guideId: true, date: true, slotIdx: true, bookings: true } }),
  ]);
  const at = <T extends { date: string | null; slotIdx: number | null }>(xs: T[], d: Departure) => xs.filter((x) => x.date === d.date && x.slotIdx === d.slotIdx);
  const deps = new Map<string, Departure>();
  for (const a of assigns) deps.set(depKey(a), { date: a.date, slotIdx: a.slotIdx });

  let placed = 0;
  for (const d of deps.values()) {
    const ga = at(assigns, d), gb = at(bks, d), gs = at(sheets, d).map((s) => ({ guideId: s.guideId, rows: (s.bookings as unknown as SheetBooking[]) ?? [] }));
    if (sweepNeedsReconcile(ga, gb, gs)) {
      try {
        const r = await reconcileDeparture(d, { source: "sweep", reason: "departure out of step with its bookings" });
        placed += r.placed.size;
      } catch { /* one departure must not stop the sweep */ }
    }
    // Safety net: a departure with no live guests left for this tour loses its calendar events.
    for (const a of ga) {
      const anyLive = gb.some((b) => ["OFFERED", "ASSIGNED"].includes(b.status) && (!b.tourId || b.tourId === a.tourId));
      if (!anyLive && (a.googleEventId || a.opsGoogleEventId)) {
        try { await removeTourEvents(a); } catch { /* best-effort */ }
        await prisma.assignment.update({ where: { id: a.id }, data: { googleEventId: null, opsGoogleEventId: null } });
      }
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

  return placed;
}

/** Does this departure disagree with its bookings in a way the reconciliation would act on? Pure. */
export function sweepNeedsReconcile(
  assigns: { guideId: string; tourId: string; pax: number | null }[],
  bookings: { id: string; status: string; tourId: string | null; assignedGuideId: string | null; externalRef: string | null; confirmationCode: string | null; pax: number | null }[],
  sheets: { guideId: string; rows: SheetBooking[] }[],
): boolean {
  if (!assigns.length) return false;
  const plan = planDeparture(assigns, bookings, sheets);
  const keys = (b: { externalRef: string | null; confirmationCode: string | null }) => [b.externalRef, b.confirmationCode].map((x) => (x ?? "").trim().toLowerCase()).filter(Boolean);
  for (const a of assigns) {
    if (plan.frozen.has(a.guideId)) continue;
    const owned = bookings.filter((b) => plan.owner.get(b.id) === a.guideId);
    if (owned.some((b) => b.status === "PENDING")) return true;
    const rows = sheets.find((s) => s.guideId === a.guideId)?.rows;
    // The expected pax the reconciliation keeps: the sheet's guest total, or the bookings when there is no sheet.
    const target = rows ? rows.reduce((s, r) => s + (Number(r.bookedPax) || 0), 0) : owned.reduce((s, b) => s + (b.pax ?? 0), 0);
    if (owned.length && target !== (a.pax ?? 0)) return true;
    if (!rows) continue;
    for (const b of owned) {
      const row = rows.find((r) => keys(b).includes((r.bookingNo ?? "").trim().toLowerCase()));
      if (!row || (row.bookedPax ?? null) !== (b.pax ?? null)) return true;
    }
    for (const b of bookings) if (b.status === "CANCELLED" && plan.cancelHolder.get(b.id) === a.guideId) {
      const row = rows.find((r) => keys(b).includes((r.bookingNo ?? "").trim().toLowerCase()));
      if (row && row.actualPax == null && !(row.status ?? "").trim()) return true;
    }
  }
  return false;
}

// Upsert one already-parsed booking. Dedupes by (source, externalId); when no
// externalId, falls back to confirmationCode so re-imports don't duplicate.
// Auto-maps the tour from a learned product→tour mapping. Shared by the webhook,
// the Bokun API sync, and the CSV import.
// A live booking was cancelled (e.g. a GetYourGuide cancellation arriving via the
// Bokun webhook). Tell the guide whose job it was, in real time, so they aren't left
// expecting a guest who won't show — and when no guest is left for the tour, take the
// tour off their schedule. The job's own numbers (expected pax, sheet rows, expense
// counts) are NOT written here, and no new count is announced here either: the
// reconciliation that runs right after the import does both, atomically, and only says a
// count once it is committed.
async function onBookingCancelled(b: { id?: string; confirmationCode?: string | null; date: string | null; slotIdx: number | null; customerName: string | null }): Promise<void> {
  try {
    if (!b.date || b.slotIdx == null) return;
    const assigns = await prisma.assignment.findMany({ where: { date: b.date, slotIdx: b.slotIdx }, select: { id: true, guideId: true, tourId: true, pax: true, googleEventId: true, opsGoogleEventId: true, date: true, slotIdx: true } });
    if (!assigns.length) return;
    // Owner rule (2026-09-13): a cancellation that arrives after the departure has started is
    // history, not news. The booking keeps its CANCELLED status (and any no-show the guide
    // reported), but nobody is messaged about a tour that already ran, and the tour's own
    // records — assignment pax, job sheet, check-ins, report, payment — are left as they were.
    // (FolkOPS stores no tour end time, so the departure's start on Bangkok time is the line.)
    if (tourStartMs(b.date, b.slotIdx) <= Date.now()) {
      await audit({
        action: "booking.cancelled_after_start", entityType: "Booking", entityId: b.id,
        detail: { ref: b.confirmationCode ?? null, date: b.date, slotIdx: b.slotIdx, guides: assigns.map((a) => a.guideId), kept: "status CANCELLED; no-show, assignment, job sheet and payment unchanged", notified: "nobody" },
      }).catch(() => {});
      return;
    }
    const bks = (await prisma.booking.findMany({ where: { date: b.date, slotIdx: b.slotIdx, status: { in: [...SHEET_BOOKING_STATUSES, "CANCELLED"] } }, select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true } })) ?? [];
    const sheets = (await prisma.jobSheet.findMany({ where: { date: b.date, slotIdx: b.slotIdx }, select: { guideId: true, bookings: true } })) ?? [];
    const plan = planDeparture(assigns, bks, sheets.map((s) => ({ guideId: s.guideId, rows: (s.bookings as unknown as SheetBooking[]) ?? [] })));
    const me = bks.find((x) => x.id === b.id);
    const tourOf = me?.tourId ?? null;
    // The one job this booking was on: the sheet listing it, else its tag, else the only
    // guide running its tour. Anything less certain tells ops, not a guess at a guide.
    const onTour = assigns.filter((a) => tourOf != null && a.tourId === tourOf);
    const holder = (b.id ? plan.cancelHolder.get(b.id) : undefined)
      ?? (me?.assignedGuideId && assigns.some((a) => a.guideId === me.assignedGuideId) ? me.assignedGuideId : undefined)
      ?? (onTour.length === 1 ? onTour[0].guideId : undefined);
    const live = bks.filter((x) => SHEET_BOOKING_STATUSES.includes(x.status));
    const upcoming = b.date >= ymd(todayD());
    const who = b.customerName ? `${b.customerName} ` : "";
    if (!holder) await notifyOps(`Cancellation on ${b.date}: ${who}was on no single guide's job — check the departure's guest lists.`, "Booking cancelled", `${b.date} · check guests`, { push: false, date: b.date });
    for (const a of assigns) {
      const concerned = a.guideId === holder || onTour.some((x) => x.guideId === a.guideId);
      if (!concerned) continue;
      // Nobody left who could be this job's guest: no live booking on its tour, none unmapped, none tagged to it.
      const anyLeft = live.some((x) => x.assignedGuideId === a.guideId || !x.tourId || x.tourId === a.tourId);

      if (!anyLeft && upcoming) {
        // Whole tour cancelled \u2014 remove it from the guide entirely (calendar, job
        // sheet, check-ins, any open offer, and the assignment) so it disappears
        // from their schedule. Never touch a tour that's already been paid.
        const paid = await prisma.tourPayment.findFirst({ where: { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, status: "PAID" }, select: { id: true } });
        try { await removeTourEvents(a); } catch { /* calendar cleanup is best-effort */ }
        // A reconstructed historical sheet is evidence an operator built by hand;
        // a later OTA cancellation must not delete it. Skip this assignment's
        // cleanup entirely rather than let the FK abort the whole sync loop —
        // and skip the notifications with it, since nothing was removed.
        if (await hasHistoricalJobSheet({ guideId: a.guideId, date: a.date, slotIdx: a.slotIdx })) {
          // Leave a trail so this is visible without reading logs. Ids and dates
          // only: no customer name, no contact detail, nothing from the payload.
          await audit({
            action: "historical.cleanup_skipped", entityType: "JobSheet",
            detail: { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, reason: "reconstructed historical sheet protected" },
          }).catch(() => {});
          continue;
        }
        // A job with payment, slip, PEAK or advance history is never swept away by a
        // channel cancellation. Skip it, audibly, and leave the record standing.
        const history = await financialHistoryBlockers(prisma, [{ guideId: a.guideId, date: a.date, slotIdx: a.slotIdx }]);
        if (history.length) {
          await audit({ action: "payment.cleanup_skipped", entityType: "JobSheet", detail: { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, reasons: history } }).catch(() => {});
          continue;
        }
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
      }
      // Otherwise nothing is said here. The reconciliation that runs right after this import
      // tells the guide and ops the job's new guest count once it is COMMITTED — or, when the
      // job cannot change (approved, certified, paid), that a guest cancelled, with no count.
    }
  } catch { /* real-time alert + calendar sync are best-effort; the cancellation is already saved */ }
}

const LIVE_STATUSES = ["PENDING", "OFFERED", "ASSIGNED"];

// One Bokun booking can sit in FolkOPS twice: the webhook stored it under its product
// confirmation code (with Bokun's booking id as externalId), and the booking search later
// stored it again under the channel's code ("GET-…"). Dedupe hid one of the two, and each
// path only ever updates the copy carrying its own identity — so a cancellation could land
// on the hidden copy while the copy on the guide's job stayed live. A cancellation therefore
// also cancels the other copies of the SAME Bokun booking, matched on exact Bokun identity
// only — never on a name, a date or an OTA ref alone:
//   * the product confirmation code (unique per product booking; a booking id alone can
//     cover several products, and an OTA ref is shared by every version of an amended
//     booking), or
//   * the Bokun booking's own confirmation code ("GET-…"), which the parser reads only for a
//     single-product booking — and which must name exactly ONE live record: two live
//     records under one booking code cannot both be this booking, so neither is touched and
//     an operator is asked instead (CANCEL_MATCH_AMBIGUOUS).
// A copy is refused when it carries a different Bokun booking id or a different OTA ref. A
// rebooking is a NEW product booking with a new code, so the confirmed new booking is never
// touched. Hidden (IGNORED) copies are left alone; a copy already cancelled only gains the
// channel's time if it has none — so a second report of the same cancellation changes nothing.
type CopyRow = { id: string; date: string | null; slotIdx: number | null; customerName: string | null };
async function cancelOtherCopies(p: ParsedBooking, exceptId: string, cancelledAtSource: Date | undefined, via?: ReconcileSource): Promise<{ cancelledNow: CopyRow[]; matched: number; ambiguous: boolean }> {
  const productCode = p.productConfirmationCode?.trim();
  const byProduct = productCode && productCode !== (p.confirmationCode || p.externalRef) ? productCode : undefined;
  const bookingCode = p.bookingConfirmationCode?.trim() || undefined;
  const codes = [...new Set([byProduct, bookingCode].filter((c): c is string => !!c))];
  if (!codes.length) return { cancelledNow: [], matched: 0, ambiguous: false };
  const found = await prisma.booking.findMany({
    where: { id: { not: exceptId }, confirmationCode: codes.length === 1 ? codes[0] : { in: codes }, status: { in: [...LIVE_STATUSES, "CANCELLED"] } },
    select: { id: true, status: true, date: true, slotIdx: true, customerName: true, cancelledAtSource: true, externalId: true, externalRef: true, confirmationCode: true },
  });
  const copies = (found ?? []).filter((c) =>
    !(c.externalId && p.bokunBookingId && c.externalId !== p.bokunBookingId)        // contradicting source identity
    && !(c.externalRef && p.externalRef && c.externalRef !== p.externalRef));        // a different OTA booking
  // Matched by the booking code alone: it must point at one live record, or nothing is guessed.
  const byBookingCodeOnly = (c: (typeof copies)[number]) => !!bookingCode && c.confirmationCode === bookingCode && c.confirmationCode !== byProduct;
  const liveByBookingCode = copies.filter((c) => byBookingCodeOnly(c) && LIVE_STATUSES.includes(c.status));
  const ambiguous = liveByBookingCode.length > 1;
  if (ambiguous) await raiseCancelReview(p, liveByBookingCode.map((c) => c.id), via);
  const cancelledNow: CopyRow[] = [];
  for (const c of copies) {
    if (ambiguous && byBookingCodeOnly(c)) continue;
    if (c.status === "CANCELLED") {
      if (!c.cancelledAtSource && cancelledAtSource) await prisma.booking.update({ where: { id: c.id }, data: { cancelledAtSource } });
      continue;
    }
    await prisma.booking.update({ where: { id: c.id }, data: { status: "CANCELLED", cancelledAtSource } });
    await audit({
      action: "booking.cancelled", entityType: "Booking", entityId: c.id,
      detail: {
        ref: c.confirmationCode ?? byProduct ?? bookingCode, from: c.status, to: "CANCELLED", channelCode: p.confirmationCode ?? null,
        cancelledAtSource: cancelledAtSource?.toISOString() ?? null, via: via ?? null,
        // How this record was recognised as the booking Bokun cancelled.
        resolvedBy: byBookingCodeOnly(c) ? "bokun-booking-confirmation-code" : "product-confirmation-code",
        incoming: { bokunBookingId: p.bokunBookingId ?? null, productConfirmationCode: productCode ?? null, bookingConfirmationCode: bookingCode ?? null },
        reason: "the channel cancelled this booking; this record is another copy of it",
      },
    });
    cancelledNow.push(c);
  }
  const matched = copies.filter((c) => !(ambiguous && byBookingCodeOnly(c))).length;
  return { cancelledNow, matched, ambiguous };
}

// Two live records answer to one Bokun booking code. Cancelling either would be a guess, so
// neither is touched: ops are asked, once per booking code (the same issue log the job
// reconciliation uses — lib/booking-reconcile).
async function raiseCancelReview(p: ParsedBooking, candidateIds: string[], via?: ReconcileSource): Promise<void> {
  try {
    const code = p.bookingConfirmationCode ?? p.confirmationCode ?? "";
    const sig = `CANCEL_MATCH_AMBIGUOUS|${code}`;
    const seen = await prisma.auditLog.findFirst({ where: { action: "booking.reconciliation_required", detail: { path: ["sig"], equals: sig } }, select: { id: true } });
    if (seen) return;
    await audit({
      action: "booking.reconciliation_required", entityType: "Booking", entityId: candidateIds[0],
      detail: { code: "CANCEL_MATCH_AMBIGUOUS", sig, via: via ?? null, bookingConfirmationCode: code, bokunBookingId: p.bokunBookingId ?? null, candidates: candidateIds, kept: "no booking cancelled" },
    });
    await notifyOps(`Bókun cancelled booking ${code}, but ${candidateIds.length} live FolkOPS bookings carry that code — none was cancelled. Check which one it is.`, "Cancellation needs review", `${code} · ${candidateIds.length} matches`, { push: true, ...(p.date ? { date: p.date } : {}) });
  } catch { /* best-effort: the refusal to guess already stands */ }
}

async function announceCancelled(bookings: { date: string | null; slotIdx: number | null; customerName: string | null }[]): Promise<void> {
  const bySlot = new Map<string, (typeof bookings)[number]>();
  for (const b of bookings) if (!bySlot.has(`${b.date}|${b.slotIdx}`)) bySlot.set(`${b.date}|${b.slotIdx}`, b);
  for (const b of bySlot.values()) await onBookingCancelled(b);
}

export async function importParsed(p: ParsedBooking, opts: { source: string; cancelled: boolean; raw?: unknown; via?: ReconcileSource; collect?: DirtyBookings }): Promise<ImportResult> {
  const via: ReconcileSource = opts.via ?? "csv";
  const collect = opts.collect;
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
  // A product name nobody has mapped to a tour yet — usually the channel renamed a product.
  // Its bookings land on no board until someone maps it, so say so the same day, once per
  // name (notifyOps de-duplicates on the message). Not for a cancellation, and not for a
  // name that IS mapped but deliberately left without a tour (an evening channel-only slot).
  if (p.productName && !opts.cancelled && !(await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null))) {
    await notifyOps(
      `New product name "${p.productName}" is not mapped to a tour — its bookings are on no board. Map it on Product map.`,
      "Unmapped product", `"${p.productName}" — map it to a tour`,
      { date: p.date ?? undefined },
    );
  }
  // Correct the resolved tour by departure time: the 14:00 slot is the palace-only tour,
  // not the combined day tour a channel product maps to by name. (No-op for other slots.)
  tourId = slotAwareTourId(tourId, p.slotIdx);
  const { source, cancelled } = opts;
  const raw = (opts.raw ?? undefined) as object | undefined;
  // Recorded only with a cancellation, and only when the channel says when it happened.
  const cancelledAtSource = cancelled && p.cancelledAt ? new Date(p.cancelledAt) : undefined;

  // A booking whose date/slot an operator pinned by hand (a rebooking arranged outside
  // the OTA) must survive the sync: when pinned, an import updates everything EXCEPT the
  // date/slot/time, so the channel's original date can't drag it back. Non-pinned (the
  // default) behaves exactly as before.
  const slotFields = (pinned: boolean) =>
    pinned ? {} : { date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined };

  if (p.externalId) {
    const existing = await prisma.booking.findUnique({ where: { source_externalId: { source, externalId: p.externalId } }, select: { id: true, status: true, datePinned: true, date: true, slotIdx: true } });
    if (existing && (await ignoreStaleLive(existing, cancelled, via))) return "skipped";
    // The SAME OTA booking can re-arrive under a different Bokun externalId (a
    // re-issue / channel remap). If we already hold this externalRef, update THAT
    // record in place instead of creating a duplicate — but only a record nothing marks
    // as a different booking. An OTA amendment keeps the OTA ref and gets a new Bokun
    // booking and code; merging the two would let the old booking's cancellation cancel
    // the confirmed new one (or leave the new one cancelled), whichever event came first.
    if (!existing && p.externalRef) {
      const sameRef = await prisma.booking.findMany({ where: { externalRef: p.externalRef }, select: { id: true, status: true, datePinned: true, externalId: true, confirmationCode: true, date: true, slotIdx: true } });
      const byRef = sameRef.find((b) => (!b.externalId || b.externalId === p.externalId) && (!b.confirmationCode || b.confirmationCode === p.confirmationCode));
      if (byRef) {
        if (await ignoreStaleLive(byRef, cancelled, via)) return "skipped";
        const updated = await prisma.booking.update({ where: { id: byRef.id }, data: { confirmationCode: p.confirmationCode ?? undefined, productName: p.productName ?? undefined, rateTitle: p.rateTitle ?? undefined, tourId: tourId ?? undefined, ...slotFields(byRef.datePinned), pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, phone: p.phoneHidden ? null : (p.phone ?? undefined), status: cancelled ? "CANCELLED" : undefined, cancelledAtSource, raw } });
        if (cancelled && byRef.status !== "CANCELLED") await onBookingCancelled(updated);
        await reconcileAfterImport(updated.id, via, byRef, collect);
        return "updated";
      }
    }
    // A cancellation for a booking this path has never stored: the booking may already be in
    // FolkOPS under another identity (the search's "GET-…" copy). Cancel THAT record now,
    // rather than store a second, cancelled copy that dedupe would hide while the visible
    // one stayed live until the next autosync. Nothing new is created when it resolves.
    if (!existing && cancelled) {
      const resolved = await cancelOtherCopies(p, "", cancelledAtSource, via);
      if (resolved.matched > 0) {
        await announceCancelled(resolved.cancelledNow);
        for (const c of resolved.cancelledNow) await reconcileAfterImport(c.id, via, c, collect);
        return "updated";
      }
    }
    const rec = await prisma.booking.upsert({
      where: { source_externalId: { source, externalId: p.externalId } },
      create: {
        source, externalId: p.externalId, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null,
        productName: p.productName ?? null, rateTitle: p.rateTitle ?? null, tourId, date: p.date ?? null, startTime: p.startTime ?? null,
        slotIdx: p.slotIdx ?? null, pax: p.pax ?? null, customerName: p.customerName ?? null, phone: p.phone ?? null,
        status: cancelled ? "CANCELLED" : "PENDING", cancelledAtSource, raw,
      },
      update: {
        confirmationCode: p.confirmationCode ?? undefined, externalRef: p.externalRef ?? undefined, productName: p.productName ?? undefined, rateTitle: p.rateTitle ?? undefined,
        tourId: tourId ?? undefined, ...slotFields(existing?.datePinned ?? false),
        pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, phone: p.phoneHidden ? null : (p.phone ?? undefined), status: cancelled ? "CANCELLED" : undefined, cancelledAtSource, raw,
      },
    });
    // A cancelled record is never hidden as a duplicate of a live one: hiding it is how a
    // cancellation used to vanish. It cannot double-count a guest — it is not live.
    const keep = existing || cancelled || (!(await autoRemoveExactDuplicate(rec, p.phoneHidden === true, via)) && !(await flagCrossChannelDuplicate(rec)));
    // Other copies of the same Bokun booking (e.g. the visible "GET-…" copy while this one
    // was a hidden webhook copy) are cancelled too — exact identity only, see cancelOtherCopies.
    const others = cancelled ? await cancelOtherCopies(p, rec.id, cancelledAtSource, via) : { cancelledNow: [] as CopyRow[] };
    // Announce only what went from live to cancelled here — never a record FolkOPS never had
    // live, never one already cancelled — once per departure.
    const wasLive = !!existing && LIVE_STATUSES.includes(existing.status);
    if (cancelled) await announceCancelled([...(wasLive ? [rec] : []), ...others.cancelledNow]);
    if (keep) await reconcileAfterImport(rec.id, via, existing, collect);
    for (const c of others.cancelledNow) await reconcileAfterImport(c.id, via, c, collect);
    return existing ? "updated" : "created";
  }

  // No externalId: dedupe on confirmationCode / externalRef so re-import is safe.
  const ref = p.confirmationCode || p.externalRef;
  if (ref) {
    const select = { id: true, status: true, datePinned: true, confirmationCode: true, date: true, slotIdx: true } as const;
    const byCode = await prisma.booking.findFirst({ where: { confirmationCode: ref }, select });
    const dup = byCode ?? await prisma.booking.findFirst({ where: { externalRef: ref }, select });
    // A match on the ref alone does not prove it is the same booking: an OTA ref is shared by
    // every version of an amended booking, so a cancelled old version could otherwise cancel
    // the confirmed rebooking. Apply a cancellation only to a record with this exact code, or
    // to the single record holding the ref with no code of its own.
    if (dup && cancelled && !byCode && (dup.confirmationCode || (await prisma.booking.count({ where: { externalRef: ref } })) > 1)) {
      await audit({ action: "booking.cancel_not_applied", entityType: "Booking", entityId: dup.id, detail: { ref, reason: "cancellation matched only by a shared booking ref, not by this record's own code — left unchanged" } });
      return "skipped";
    }
    if (dup && (await ignoreStaleLive(dup, cancelled, via))) return "skipped";
    if (dup) {
      const updated = await prisma.booking.update({ where: { id: dup.id }, data: { tourId: tourId ?? undefined, ...slotFields(dup.datePinned), pax: p.pax ?? undefined, customerName: p.customerName ?? undefined, phone: p.phoneHidden ? null : (p.phone ?? undefined), productName: p.productName ?? undefined, rateTitle: p.rateTitle ?? undefined, status: cancelled ? "CANCELLED" : undefined, cancelledAtSource } });
      const copies = cancelled ? (await cancelOtherCopies(p, dup.id, cancelledAtSource, via)).cancelledNow : [];
      // Tell the guide/ops once per slot, after every copy is cancelled, so the recount is right.
      await announceCancelled([...(dup.status !== "CANCELLED" && cancelled ? [updated] : []), ...copies]);
      await reconcileAfterImport(dup.id, via, dup, collect);
      return "updated";
    }
  }
  const rec = await prisma.booking.create({
    data: {
      source, confirmationCode: p.confirmationCode ?? null, externalRef: p.externalRef ?? null, productName: p.productName ?? null, rateTitle: p.rateTitle ?? null, tourId,
      date: p.date ?? null, startTime: p.startTime ?? null, slotIdx: p.slotIdx ?? null,
      pax: p.pax ?? null, customerName: p.customerName ?? null, phone: p.phone ?? null, status: cancelled ? "CANCELLED" : "PENDING", cancelledAtSource,
    },
  });
  const keepNew = !(await autoRemoveExactDuplicate(rec, p.phoneHidden === true, via)) && !(await flagCrossChannelDuplicate(rec));
  if (cancelled) await announceCancelled((await cancelOtherCopies(p, rec.id, cancelledAtSource, via)).cancelledNow);
  if (keepNew) await reconcileAfterImport(rec.id, via, null, collect);
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
export async function importRawBooking(raw: unknown, opts?: { otaOnly?: boolean; via?: ReconcileSource; collect?: DirtyBookings }): Promise<ImportResult> {
  const parsed = parseBokun(raw);
  const source = detectChannel(raw);
  if (opts?.otaOnly && !isOtaBooking(parsed, source)) return "skipped";
  return importParsed(parsed, { source, cancelled: isCancellation(raw), raw, via: opts?.via ?? (opts?.otaOnly ? "autosync" : "webhook"), collect: opts?.collect });
}


// Background safety net: pull recent Bokun bookings (incl. CANCELLED) so the board
// stays current even when the live webhook is down. Cached to once / 30 min via the
// audit log (works across instances) plus a per-instance in-flight guard.
// Best-effort and meant to be fire-and-forget — never throws into the caller.
let autoSyncInFlight = false;
const AUTO_SYNC_PAGES = 10;
// Tour dates the auto-sync reads: the last 14 days through a year ahead — the manual Sync's
// horizon. It used to stop 120 days out, so a cancellation for a tour further ahead stayed
// live until someone pressed Sync or the date drifted into range.
export function autoSyncWindow(nowMs: number): { from: string; to: string } {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: fmt(nowMs - 14 * 86400_000), to: fmt(nowMs + 365 * 86400_000) };
}
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
    const { from, to } = autoSyncWindow(Date.now());
    let synced = 0;
    // Every departure the sync touched is reconciled ONCE at the end, not once per booking.
    const dirty: DirtyBookings = new Map();
    let firstPageFailed: { status: number; error?: string } | null = null;
    for (let page = 1; page <= AUTO_SYNC_PAGES; page++) {
      const res = await searchBookings({ from, to, page, pageSize: 100 });
      if (!res.ok) { if (page === 1) firstPageFailed = { status: res.status, error: res.error }; break; }
      if (res.items.length === 0) break;
      for (const item of res.items) { try { await importRawBooking(item, { otaOnly: true, via: "autosync", collect: dirty }); synced++; } catch { /* skip a bad item */ } }
      if (res.items.length < 100) break;
      // The last allowed page was full: there may be more bookings this run never read. Say so.
      if (page === AUTO_SYNC_PAGES) await prisma.auditLog.create({ data: { action: "bokun.autosync.truncated", entityType: "Booking", detail: { from, to, pagesRead: page, itemsRead: synced } } });
    }
    await reconcileCollected(dirty, "autosync");
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
