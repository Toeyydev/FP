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
    select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true },
    orderBy: { createdAt: "asc" },
  });
  const splitHere = allAtSlot.some((b) => b.assignedGuideId);
  const linked = splitHere ? allAtSlot.filter((b) => !b.assignedGuideId || b.assignedGuideId === guideId) : allAtSlot;
  type SheetBooking = { name: string; bookingNo: string; bookedPax: number | null; actualPax: number | null; tickets: string; status: string };
  // Actual Pax stays blank until the guide reports after the tour (a no-show → 0,
  // everyone else → their booked count). Booked Pax is always shown alongside.
  const liveBookings: SheetBooking[] = linked.map((b) => ({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: null, tickets: "", status: b.noShow ? "no-show" : "" }));

  // Standard expense template scaled to the actual guests. Used for a fresh sheet,
  // AND to backfill a saved sheet that has none (e.g. one auto-created from a late
  // add, which writes only bookings). "(Inc. Guide)" items add +1 (the guide).
  const clientPax = linked.reduce((s, b) => s + (b.pax ?? 0), 0) || (assignment?.pax ?? 0);
  const catalogue = defaultExpensesForTour(tour?.name);
  const defaultExpenses = clientPax > 0
    ? catalogue.map((e) => ({ ...e, pax: /inc\.?\s*guide/i.test(e.description) ? clientPax + 1 : clientPax }))
    : catalogue;
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
      return NextResponse.json({ header, tour, saved: true, canEdit: isOps, checkedIn, sheet: fill({ ...existing, bookings: dedupeByName((Array.isArray(existing.bookings) ? existing.bookings : []) as SheetBooking[]) }), reconciledAdded: 0, reconciledRemoved: 0 });
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

    const matched = new Map<SheetBooking, (typeof linked)[number]>();
    for (const r of saved) { const lb = matchLive(r); if (lb) matched.set(r, lb); }
    const coveredLive = new Set(matched.values());
    const kept = saved
      .filter((r) => {
        if (matched.has(r)) return true;                    // still active at this slot
        const rRef = rowRef(r);
        if (!rRef) return true;                             // manual row — always keep
        return !movedRefSet.has(rRef);                      // drop only if THIS booking # re-slotted elsewhere
      })
      .map((r) => { const lb = matched.get(r); return lb ? { ...r, bookingNo: canonRef(lb) } : r; }); // refresh GET- → GYG
    const added = linked
      .filter((lb) => !coveredLive.has(lb))
      .map((b) => ({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: null, tickets: "", status: b.noShow ? "no-show" : "" }));
    const reconciledRemoved = saved.length - kept.length;
    const sheet = fill({ ...existing, bookings: dedupeByName(kept.concat(added)) });
    return NextResponse.json({ header, tour, saved: true, canEdit: isOps, checkedIn, sheet, reconciledAdded: added.length, reconciledRemoved });
  }

  // No saved sheet yet — scaffold from the current bookings.
  const bookings = liveBookings.length
    ? liveBookings
    : [{ name: "", bookingNo: "", bookedPax: assignment?.pax ?? null, actualPax: null, tickets: "", status: "" }];

  return NextResponse.json({
    header, tour, saved: false, canEdit: isOps, checkedIn,
    sheet: { ref: null, guideId, date, slotIdx, tourId, status: "Confirmed", bookings: dedupeByName(bookings), expenses: defaultExpenses, guideFee: DEFAULT_GUIDE_FEE, updatedAt: null },
  });
}

// Numeric fields are .nullish() (null OR undefined -> null): imported/edge sheets can
// store gaps, and JSON.stringify drops undefined keys on re-save, so requiring a
// present number would reject an otherwise-valid save. Strings/extra keys are lenient.
const num = z.number().nullish().transform((v) => v ?? null);
const bookingZ = z.object({ name: z.string().max(200).optional().default(""), bookingNo: z.string().max(120).optional().default(""), bookedPax: num, actualPax: num, tickets: z.string().max(20).optional().default(""), status: z.string().max(40).optional().default("") });
const expenseZ = z.object({ description: z.string().max(160).optional().default(""), price: num, pax: num });
const guideFeeZ = z.object({ price: num, time: num, whtPct: num }).nullish().transform((v) => v ?? { price: null, time: null, whtPct: null });

// PUT — operator only. Upserts the sheet; assigns a FOLK-BKK-… ref on first save.
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
    tourId: z.string().default(""), status: z.string().max(40).default("Confirmed"),
    bookings: z.array(bookingZ).max(20), expenses: z.array(expenseZ).max(40), guideFee: guideFeeZ,
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", detail: parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` : undefined }, { status: 400 });
  const d = parsed.data;
  const key = { guideId_date_slotIdx: { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx } };

  const existing = await prisma.jobSheet.findUnique({ where: key });
  let ref = existing?.ref ?? null;
  if (!ref) ref = await nextJobRef(d.date);

  const sheet = await prisma.jobSheet.upsert({
    where: key,
    create: { ref, guideId: d.guideId, date: d.date, slotIdx: d.slotIdx, tourId: d.tourId, status: d.status, bookings: d.bookings, expenses: d.expenses, guideFee: d.guideFee, createdById: session!.user!.id ?? null },
    update: { tourId: d.tourId, status: d.status, bookings: d.bookings, expenses: d.expenses, guideFee: d.guideFee },
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


// DELETE { guideId, date, slotIdx } — operator/admin only. Remove a single uploaded
// job sheet and the tour records tied to that slot (assignment, payment, check-ins,
// report, rating, and any manually-imported bookings for it). For undoing a bad
// import or a one-off tour from the Payments screen. Real (Bokun) bookings are kept.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const where = { guideId, date, slotIdx };
  await prisma.$transaction([
    prisma.checkin.deleteMany({ where }),
    prisma.tourReport.deleteMany({ where }),
    prisma.guideRating.deleteMany({ where }),
    prisma.tourPayment.deleteMany({ where }),
    prisma.assignment.deleteMany({ where }),
    prisma.jobSheet.deleteMany({ where }),
    prisma.booking.deleteMany({ where: { date, slotIdx, source: "manual" } }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.deleted", entityType: "JobSheet", detail: { guideId, date, slotIdx } });
  return NextResponse.json({ ok: true });
}
