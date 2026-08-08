import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { DEFAULT_GUIDE_FEE, defaultExpensesForTour, type Expense, type GuideFee } from "@/lib/jobsheet";
import { nextJobRef } from "@/lib/jobref";
import { canViewFinance } from "@/lib/roles";
import { bookingRef } from "@/lib/booking-ref";
import { sendJobSheetsForDate } from "@/lib/jobsheet-send";
import { removeTourEvents } from "@/lib/tour-calendar-sync";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// Header fields auto-pulled from the guide's profile (operator is authorized to see PII).
async function guideHeader(guideId: string) {
  const u = await prisma.user.findUnique({ where: { guideId } });
  if (!u) return null;
  return {
    guideId: u.guideId, name: u.fullName || u.displayName, email: u.email,
    tel: u.phone || "", taxId: decrypt(u.taxId), address: decrypt(u.currentAddress) || decrypt(u.idCardAddress),
  };
}

// GET ?guideId&date&slotIdx — operator only. Returns the saved sheet, or a
// default scaffold (preset expenses + standard guide fee) if none exists yet.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  // Operators/admin edit any sheet; a guide may only VIEW their own.
  const isOps = ops(session.user.role);
  if (!canViewFinance(session.user.role) && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [header, existing, assignment] = await Promise.all([
    guideHeader(guideId),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
  ]);
  const tourId = existing?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  // Give every saved sheet a job number. Sheets auto-created from a late-booking
  // combine never got one (ref stayed null → "auto on save"); assign the next ref
  // for the date the first time it's opened so the "No." always shows.
  if (existing && !existing.ref) {
    try {
      const newRef = await nextJobRef(date);
      await prisma.jobSheet.update({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, data: { ref: newRef } });
      existing.ref = newRef;
    } catch { /* ref is best-effort; never block opening the sheet */ }
  }

  // Whether this guide has checked in for the tour — gates the guide's no-show boxes.
  const checkedIn = (await prisma.checkin.count({ where: { guideId, date, slotIdx } })) > 0;

  // Paid state for this slot. Once the operator has uploaded the slip / marked it paid
  // (per-tour TourPayment, or the guide's whole-month payroll), the guide's summary
  // shows the operator's FINAL official expenses (which equal the transfer) instead of
  // the report flow. Slip = per-tour e-slip, else the monthly batch slip.
  const period = date.slice(0, 7);
  const [tourPay, payroll] = await Promise.all([
    prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { status: true, paidAt: true, eslipUrl: true, peakRef: true } }),
    prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId, period } }, select: { status: true, paidAt: true, eslipUrl: true, peakRef: true } }),
  ]);
  const payment = {
    paid: tourPay?.status === "PAID" || payroll?.status === "paid",
    paidAt: tourPay?.paidAt ?? payroll?.paidAt ?? null,
    slip: tourPay?.eslipUrl ?? payroll?.eslipUrl ?? null,
    status: tourPay?.status ?? (payroll?.status === "paid" ? "PAID" : null), // per-tour state for the finance sidebar
    peakRef: tourPay?.peakRef ?? payroll?.peakRef ?? null, // accounting ref (recorded on Payments)
  };

  // Collapse repeated guests to a single row — the same booking must appear only once
  // (a re-import or combine can leave a guest listed twice). The SAME booking can
  // arrive under two name spellings ("Romel Sierra" vs "Sierra, Romel"), so dedupe by
  // booking ref (the stable identity) first, then fall back to name for manual rows
  // with no ref. Keeps the first; blank (manual) rows are never merged.
  const dedupeByName = <T extends { name?: string; bookingNo?: string }>(rows: T[]): T[] => {
    const seen = new Set<string>(); const out: T[] = [];
    for (const r of rows) {
      const ref = (r?.bookingNo || "").trim().toLowerCase();
      const nm = (r?.name || "").trim().toLowerCase();
      const key = ref ? `ref:${ref}` : nm ? `nm:${nm}` : "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(r);
    }
    return out;
  };

  // Current bookings at this date + slot. By default ALL combine into one job; if
  // the slot was SPLIT across guides, this guide sees only the bookings tagged to
  // them (plus any untagged).
  const allAtSlot = await prisma.booking.findMany({
    where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
    select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true, noShowPax: true },
    orderBy: { createdAt: "asc" },
  });
  // Actual Pax on a live-scaffolded row: derived from the guide's no-show report —
  // a full no-show → 0, a partial → who actually came, and blank (null) until any
  // no-show is reported. (A hand-saved sheet already carries this; this is for the
  // scaffold, which previously left it null even for a reported no-show.)
  const liveActualPax = (b: { pax: number | null; noShow: boolean; noShowPax: number | null }) => {
    const ns = b.noShowPax ?? (b.noShow ? (b.pax ?? 0) : 0);
    return ns > 0 ? Math.max(0, (b.pax ?? 0) - ns) : null;
  };
  // Split slot → this guide's sheet is only the guests tagged to them. Untagged
  // guests are NOT copied onto every guide's sheet (that duplicated one booking
  // across two guides); they stay unassigned for the operator to place.
  const splitHere = allAtSlot.some((b) => b.assignedGuideId);
  const linked = splitHere ? allAtSlot.filter((b) => b.assignedGuideId === guideId) : allAtSlot;
  type SheetBooking = { name: string; bookingNo: string; bookedPax: number | null; actualPax: number | null; tickets: string; status: string };
  // Actual Pax stays blank until the guide reports after the tour (a no-show → 0,
  // everyone else → their booked count). Booked Pax is always shown alongside.
  const liveBookings: SheetBooking[] = linked.map((b) => ({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: liveActualPax(b), tickets: "", status: b.noShow ? "no-show" : "" }));

  // Standard expense template (labels + prices) with pax left BLANK — the operator
  // fills the counts via "fill down" on the sheet, so nothing is silently auto-scaled
  // to a guest count that may be stale. Used for a fresh sheet AND to backfill a saved
  // sheet that has none (e.g. one auto-created from a late add, which writes only bookings).
  const catalogue = defaultExpensesForTour(tour?.name);
  const defaultExpenses = catalogue;
  // Never show an empty expense table / blank fee for a real tour — fall back to the
  // standard template + guide fee when the saved sheet has none.
  const fill = <T extends { expenses?: unknown; guideFee?: unknown }>(sheet: T) => ({
    ...sheet,
    expenses: Array.isArray(sheet.expenses) && sheet.expenses.length > 0 ? sheet.expenses : defaultExpenses,
    guideFee: sheet.guideFee && typeof sheet.guideFee === "object" && Object.keys(sheet.guideFee as object).length ? sheet.guideFee : DEFAULT_GUIDE_FEE,
  });

  // Saved sheet: keep it live. Surface any booking that arrived AFTER it was saved
  // (e.g. a late add), so the assigned job always reflects the real guest list —
  // while keeping the operator's edits to the rows already on the sheet.
  if (existing) {
    // A past tour is a finished record: never auto-add or drop its bookings, so the
    // operator's curated sheet stays exactly as saved. Only upcoming/today sheets get
    // reconciled against live bookings (to surface late adds / re-slots).
    const todayBKK = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    if (date < todayBKK) {
      return NextResponse.json({ header, tour, saved: true, canEdit: isOps, checkedIn, payment, sheet: fill({ ...existing, bookings: dedupeByName((Array.isArray(existing.bookings) ? existing.bookings : []) as SheetBooking[]) }), reconciledAdded: 0, reconciledRemoved: 0 });
    }
    const saved = (Array.isArray(existing.bookings) ? existing.bookings : []) as SheetBooking[];

    // Match a saved row to a live booking by BOOKING NUMBER only — the sole trustworthy
    // identity. A GYG ref and its GET- confirmation code both count as that booking's
    // number, so an old sheet that stored the GET- code still lines up with the same
    // guest's GYG ref (and we refresh the row to the GYG ref). We deliberately do NOT
    // bridge by name: two different guests can share a name under different booking
    // numbers (e.g. two "John Smith" on the 10 Jul tour), and those MUST stay two rows.
    // Name is a fallback only for a manual row that carries no booking number at all.
    const refKeys = (b: { externalRef?: string | null; confirmationCode?: string | null }) =>
      [b.externalRef, b.confirmationCode].map((x) => (x || "").trim().toLowerCase()).filter(Boolean);
    const canonRef = (b: { externalRef?: string | null; confirmationCode?: string | null }) => bookingRef(b.externalRef, b.confirmationCode);
    const rowRef = (r: SheetBooking) => (r.bookingNo || "").trim().toLowerCase();
    const matchLive = (r: SheetBooking) => {
      const rRef = rowRef(r);
      if (rRef) return linked.find((lb) => refKeys(lb).includes(rRef));  // numbered row: its number only
      const rName = (r.name || "").trim().toLowerCase();                 // manual row (no number): by name
      return rName ? linked.find((lb) => (lb.customerName || "").trim().toLowerCase() === rName) : undefined;
    };

    // A saved (numbered) row whose booking is now active at a DIFFERENT date OR slot was
    // re-slotted (incl. a Bokun date change, e.g. 26→27 Jun) — drop it. Matched strictly
    // by booking number so a same-name guest elsewhere never drags this row off the sheet.
    const savedRefs = [...new Set(saved.map((r) => (r.bookingNo || "").trim()).filter(Boolean))];
    const elsewhere = savedRefs.length ? await prisma.booking.findMany({
      where: {
        status: { in: ["PENDING", "OFFERED", "ASSIGNED"] },
        NOT: { date, slotIdx },
        OR: [{ externalRef: { in: savedRefs } }, { confirmationCode: { in: savedRefs } }],
      },
      select: { externalRef: true, confirmationCode: true },
    }) : [];
    const movedRefSet = new Set(elsewhere.flatMap(refKeys));
    // A guest re-tagged to ANOTHER guide at this same slot (a hybrid split) must drop
    // off this guide's saved sheet, so the two guides' sheets stay separated.
    const otherGuideRefSet = new Set(allAtSlot.filter((b) => b.assignedGuideId && b.assignedGuideId !== guideId).flatMap(refKeys));

    const matched = new Map<SheetBooking, (typeof linked)[number]>();
    for (const r of saved) { const lb = matchLive(r); if (lb) matched.set(r, lb); }
    const coveredLive = new Set(matched.values());
    const kept = saved
      .filter((r) => {
        if (matched.has(r)) return true;                    // still active at this slot
        const rRef = rowRef(r);
        if (!rRef) return true;                             // manual row — always keep
        return !movedRefSet.has(rRef) && !otherGuideRefSet.has(rRef); // drop if re-slotted elsewhere OR handed to another guide here
      })
      .map((r) => { const lb = matched.get(r); return lb ? { ...r, bookingNo: canonRef(lb) } : r; }); // refresh GET- → GYG
    const added = linked
      .filter((lb) => !coveredLive.has(lb))
      .map((b) => ({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: liveActualPax(b), tickets: "", status: b.noShow ? "no-show" : "" }));
    const reconciledRemoved = saved.length - kept.length;
    const sheet = fill({ ...existing, bookings: dedupeByName(kept.concat(added)) });
    return NextResponse.json({ header, tour, saved: true, canEdit: isOps, checkedIn, payment, sheet, reconciledAdded: added.length, reconciledRemoved });
  }

  // No saved sheet yet — scaffold from the current bookings.
  const bookings = liveBookings.length
    ? liveBookings
    : [{ name: "", bookingNo: "", bookedPax: assignment?.pax ?? null, actualPax: null, tickets: "", status: "" }];

  return NextResponse.json({
    header, tour, saved: false, canEdit: isOps, checkedIn, payment,
    sheet: { ref: null, guideId, date, slotIdx, tourId, status: "Confirmed", bookings: dedupeByName(bookings), expenses: defaultExpenses, guideFee: DEFAULT_GUIDE_FEE, operatorNote: null, approvalStatus: null, approvedBy: null, approvedAt: null, updatedAt: null },
  });
}

// Numeric fields are .nullish() (null OR undefined -> null): imported/edge sheets can
// store gaps, and JSON.stringify drops undefined keys on re-save, so requiring a
// present number would reject an otherwise-valid save. Strings/extra keys are lenient.
const num = z.number().nullish().transform((v) => v ?? null);
const numOpt = z.number().nullable().optional(); // present → number|null; absent → omitted (not stored)
const bookingZ = z.object({ name: z.string().max(200).optional().default(""), bookingNo: z.string().max(120).optional().default(""), bookedPax: num, actualPax: num, tickets: z.string().max(20).optional().default(""), status: z.string().max(40).optional().default("") });
// Expense rows: description/price/pax are the billed reimbursement; the rest are
// OPTIONAL finance metadata kept verbatim in the JSON. zod strips unknown keys, so a
// field MUST be listed here to survive a save — this is why `unit` used to vanish.
const expenseZ = z.object({
  description: z.string().max(160).optional().default(""), price: num, pax: num,
  unit: z.string().max(24).optional(),
  expenseType: z.string().max(40).optional(),
  paidBy: z.string().max(24).optional(),
  reimbursementRequired: z.boolean().optional(),
  estimatedAmount: numOpt,
  actualAmount: numOpt,
  receiptUrl: z.string().max(2000).optional(),
  receiptFileId: z.string().max(200).optional(),
  receiptName: z.string().max(200).optional(),
  receiptAt: z.string().max(40).optional(),
  receiptBy: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
});
const guideFeeZ = z.object({ price: num, time: num, whtPct: num }).nullish().transform((v) => v ?? { price: null, time: null, whtPct: null });

// PUT — operator only. Upserts the sheet; assigns a FOLK-BKK-… ref on first save.
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
    tourId: z.string().default(""), status: z.string().max(40).default("Confirmed"),
    bookings: z.array(bookingZ).max(20), expenses: z.array(expenseZ).max(40), guideFee: guideFeeZ,
    operatorNote: z.string().max(2000).optional().default(""),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", detail: parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` : undefined }, { status: 400 });
  const d = parsed.data;
  const key = { guideId_date_slotIdx: { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx } };

  const existing = await prisma.jobSheet.findUnique({ where: key });
  let ref = existing?.ref ?? null;
  if (!ref) ref = await nextJobRef(d.date);
  const operatorNote = d.operatorNote.trim() || null;

  const sheet = await prisma.jobSheet.upsert({
    where: key,
    create: { ref, guideId: d.guideId, date: d.date, slotIdx: d.slotIdx, tourId: d.tourId, status: d.status, bookings: d.bookings, expenses: d.expenses, guideFee: d.guideFee, operatorNote, createdById: session!.user!.id ?? null },
    update: { tourId: d.tourId, status: d.status, bookings: d.bookings, expenses: d.expenses, guideFee: d.guideFee, operatorNote },
  });
  // Keep the assignment's pax in sync with the job sheet's booking total, so the
  // dispatch board ("On-going tours") and the LINE job sheet match the Job Details.
  const paxTotal = d.bookings.reduce((s, b) => s + (b.bookedPax ?? 0), 0);
  if (paxTotal > 0) {
    await prisma.assignment.updateMany({ where: { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx }, data: { pax: paxTotal } });
  }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.saved", entityType: "JobSheet", entityId: sheet.id, detail: { ref } });
  return NextResponse.json({ ok: true, sheet });
}

// POST { date: "YYYY-MM-DD", guideId? }  — operator/admin only.
// Sends each assigned guide their personal job sheet for the day via LINE (if
// linked) and as an in-app notification (always, so nothing is missed).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    guideId: z.string().min(1).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, guideId } = parsed.data;

  const { count, lineSent, lineSkipped } = await sendJobSheetsForDate(date, guideId);
  if (count === 0) return NextResponse.json({ ok: true, count: 0, lineSent: 0, lineSkipped: [] });

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "jobsheet.sent", entityType: "Assignment",
    detail: { date, guides: count, lineSent, lineSkipped },
  });

  return NextResponse.json({ ok: true, count, lineSent, lineSkipped });
}


// DELETE { guideId, date, slotIdx, guardStarted? } — operator/admin only. Remove a single
// job sheet and the tour records tied to that slot (assignment, payment, check-ins, report,
// rating) AND hard-delete the slot's bookings — imported (bokun/gyg/viator) as well as
// manual — so a synced booking doesn't reappear as a job (see the block below). The operator
// must have already cancelled the booking on the OTA; this does NOT propagate to the channel.
// Used from Payments (undo a bad import / one-off tour) and from the Job Sheet page.
//   guardStarted: the Job Sheet page's Delete is a before-start-only action — pass this so
//   the delete is refused (409 tour-in-progress) once the guide has checked in, the same
//   guard Dispatch's Remove uses. Payments' undo path omits it, so it can still clear a
//   completed tour's bad import.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  const guardStarted = body?.guardStarted === true;
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const where = { guideId, date, slotIdx };

  // Before-start-only delete (from the Job Sheet page): once the guide has checked in the
  // tour is live or done — refuse it, so a running/finished tour isn't wiped by accident.
  if (guardStarted && (await prisma.checkin.count({ where })) > 0) {
    return NextResponse.json({ error: "tour-in-progress" }, { status: 409 });
  }

  // Clear the guide + operator Google Calendar events first so a deleted upcoming tour
  // doesn't linger as a ghost event. Best-effort; never blocks the delete.
  if (guardStarted) {
    const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
    if (assignment) { try { await removeTourEvents(assignment); } catch { /* calendar cleanup is best-effort */ } }
  }

  // Imported bookings (bokun/gyg/viator) for this slot must go too, not just
  // manual ones: otherwise the surviving Booking is re-turned into a job by the
  // Bookings Inbox on the next sync and the row reappears on Payments (the
  // "won't stay deleted" bug for imported bookings). Snapshot them into the audit
  // trail first — they feed PEAK accounting and this is a hard delete.
  // Split-aware: a slot split across guides (any booking tagged with
  // assignedGuideId) only loses THIS guide's tagged bookings, never the co-guide's,
  // mirroring the split rule in GET above; a normal slot combines into one job so
  // all its bookings are this guide's.
  // NB: the operator must have already cancelled the booking on the OTA
  // (GetYourGuide); deleting here does NOT propagate to the channel.
  const atSlot = await prisma.booking.findMany({
    where: { date, slotIdx },
    select: { id: true, source: true, externalRef: true, confirmationCode: true, customerName: true, pax: true, status: true, paymentStatus: true, assignedGuideId: true },
  });
  const splitHere = atSlot.some((b) => b.assignedGuideId);
  const deletedBookings = splitHere ? atSlot.filter((b) => b.assignedGuideId === guideId) : atSlot;
  const doomedIds = deletedBookings.map((b) => b.id);
  await prisma.$transaction([
    prisma.checkin.deleteMany({ where }),
    prisma.tourReport.deleteMany({ where }),
    prisma.guideRating.deleteMany({ where }),
    prisma.tourPayment.deleteMany({ where }),
    prisma.assignment.deleteMany({ where }),
    prisma.jobSheet.deleteMany({ where }),
    ...(doomedIds.length ? [prisma.booking.deleteMany({ where: { id: { in: doomedIds } } })] : []),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.deleted", entityType: "JobSheet", detail: { guideId, date, slotIdx, guardStarted, deletedBookings } });
  return NextResponse.json({ ok: true });
}
