import { NextRequest, NextResponse } from "next/server";
import { paxIndex } from "@/lib/assigned-pax";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_COUNT, clashingSlotIdxs } from "@/lib/slots";
import { dayOf } from "@/lib/dates";
import { sweepExpiredOffers, createOffer } from "@/lib/offers";
import { audit } from "@/lib/audit";
import { DASHBOARD_CACHE_KEY, forgetCached } from "@/lib/api-cache";
import { manualAssignBlockers } from "@/lib/manual-assign";
import { notifyGuide } from "@/lib/booking-import";
import { directAssignmentNotice } from "@/lib/assignment-notice";
import { removeGuideFromDeparture } from "@/lib/assignment-removal";
import { ensureJobSheetForAssignment } from "@/lib/jobsheet-auto";

const monthRe = /^\d{4}-\d{2}$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export type Job = { tour: string; pax: number | null; note: string | null };

// GET /api/assignments?month=YYYY-MM
// Guides see only their own; operators see all.
// Shape: { [guideId]: { [dayOfMonth]: { [slotIdx]: Job } } }
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!monthRe.test(month)) return NextResponse.json({ error: "bad month" }, { status: 400 });

  const isOperator = session.user.role === "OPERATOR";
  // While an operator is using the board, expire any timed-out offers + alert.
  if (isOperator || session.user.role === "ADMIN") await sweepExpiredOffers();
  const rows = await prisma.assignment.findMany({
    where: {
      date: { startsWith: month },
      ...(isOperator ? {} : { guideId: session.user.guideId ?? "__none__" }),
    },
    select: { guideId: true, date: true, slotIdx: true, tourId: true, pax: true, note: true },
  });

  // The board shows the guide their own job card. Assignment.pax is frozen at the
  // offer, so recount the month's bookings — otherwise a guest moved onto the
  // departure afterwards is invisible right up until the guide opens the sheet.
  const livePax = paxIndex(await prisma.booking.findMany({
    where: { date: { startsWith: month }, tourId: { not: null }, slotIdx: { not: null }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
    select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true },
  }));

  const out: Record<string, Record<number, Record<number, Job>>> = {};
  for (const r of rows) {
    const byDay = (out[r.guideId] ??= {});
    const byIdx = (byDay[dayOf(r.date)] ??= {});
    byIdx[r.slotIdx] = { tour: r.tourId, pax: livePax.for(r.tourId, r.date, r.slotIdx, r.guideId) ?? r.pax, note: r.note };
  }
  return NextResponse.json(out);
}

// POST /api/assignments  { guideId, date, slotIdx, tourId, pax?, note? }  — operator only
const postSchema = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  tourId: z.string().min(1),
  pax: z.number().int().min(0).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  // Put the guide on a tour still to come WITHOUT an offer to accept (agreed by phone,
  // or the LINE accept not reaching us). See lib/manual-assign.
  direct: z.boolean().optional(),
});

function isOps(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) {
    return NextResponse.json({ error: "operators only" }, { status: 403 });
  }
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const { guideId, date, slotIdx, tourId, pax, note, direct } = parsed.data;

  // RECORDING A TOUR THAT ALREADY RAN.
  //
  // Every other path here goes through a 2-hour offer the guide must accept. For
  // a date in the past there is nothing to accept: the tour happened. Offers also
  // require the guide to be free in the availability grid, which nobody fills in
  // retrospectively, so a past assignment always failed with guide-unavailable —
  // leaving no way to record who actually guided.
  //
  // That is not hypothetical. Gigi guided 4 pax on 31 August, agreed off-channel
  // because her acceptance kept expiring, and the system held no assignment, no
  // job sheet and no payment for it. Work done and unpaid, invisible.
  //
  // So a past-dated assignment is written DIRECTLY, operator-only, and audited as
  // its own action — it is a record of fact, not a dispatch decision.
  const todayBkk = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  if (date < todayBkk) {
    const [pastGuide, pastTour] = await Promise.all([
      prisma.user.findUnique({ where: { guideId }, select: { role: true } }),
      prisma.tour.findUnique({ where: { id: tourId }, select: { id: true } }),
    ]);
    if (!pastGuide || pastGuide.role !== "GUIDE") return NextResponse.json({ error: "unknown guide" }, { status: 400 });
    if (!pastTour) return NextResponse.json({ error: "unknown tour" }, { status: 400 });
    const a = await prisma.assignment.upsert({
      where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
      create: { guideId, date, slotIdx, tourId, pax: pax ?? null, note: note ?? null },
      update: { tourId, pax: pax ?? null, note: note ?? null },
    });
    // The only guide on the slot guided all of its guests: their bookings are no longer
    // waiting for anyone. With two guides on it the operator places guests with Split.
    const onSlot = await prisma.assignment.count({ where: { date, slotIdx } });
    const settled = onSlot === 1
      ? await prisma.booking.updateMany({ where: { date, slotIdx, status: { in: ["PENDING", "OFFERED"] }, assignedGuideId: null }, data: { status: "ASSIGNED" } })
      : { count: 0 };
    // The job has its sheet and FOLK-BKK number from the moment it exists (lib/jobsheet-auto).
    await ensureJobSheetForAssignment(guideId, date, slotIdx, "recorded-past");
    await audit({
      actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
      action: "assign.recorded_past", entityType: "Assignment", entityId: a.id,
      detail: { guideId, date, slotIdx, tourId, bookingsAssigned: settled.count, reason: "tour already ran — recorded by operator" },
    });
    forgetCached(DASHBOARD_CACHE_KEY);
    return NextResponse.json({ ok: true, recorded: true, past: true, bookingsAssigned: settled.count });
  }

  if (direct) {
    const [g, tour, blocked, leave, staffed, clash] = await Promise.all([
      prisma.user.findUnique({ where: { guideId }, select: { role: true, state: true, external: true, displayName: true, lineUserId: true } }),
      prisma.tour.findUnique({ where: { id: tourId }, select: { name: true, meetingPoint: true } }),
      prisma.blockedDate.findUnique({ where: { date } }),
      prisma.leaveRequest.findFirst({ where: { guideId, status: "APPROVED", fromDate: { lte: date }, toDate: { gte: date } }, select: { id: true } }),
      prisma.assignment.findMany({ where: { date, slotIdx }, select: { guideId: true } }),
      prisma.assignment.findFirst({ where: { guideId, date, slotIdx: { in: clashingSlotIdxs(slotIdx).filter((i) => i !== slotIdx) } }, select: { slotIdx: true } }),
    ]);
    const reasons = manualAssignBlockers({
      guideId, date, today: todayBkk, guide: g ? { role: g.role, state: g.state, external: !!g.external } : null, tourExists: !!tour,
      dateBlocked: !!blocked, onLeave: !!leave, staffedBy: staffed.map((a) => a.guideId), clashSlotIdx: clash?.slotIdx ?? null,
    });
    if (reasons.length) return NextResponse.json({ error: "not-assignable", reasons }, { status: 409 });

    const a = await prisma.assignment.upsert({
      where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
      create: { guideId, date, slotIdx, tourId, pax: pax ?? null, note: note ?? null },
      update: { tourId, pax: pax ?? null, note: note ?? null },
    });
    // The slot's guests are on this guide's job now — the same state an accepted offer
    // leaves them in — and any offer still asking other guides is over.
    const booked = await prisma.booking.updateMany({ where: { date, slotIdx, status: "PENDING", assignedGuideId: null }, data: { status: "OFFERED" } });
    const open = await prisma.jobOffer.findMany({ where: { date, slotIdx, status: "OPEN" }, select: { id: true } });
    if (open.length) {
      await prisma.jobOffer.updateMany({ where: { id: { in: open.map((o) => o.id) }, status: "OPEN" }, data: { status: "EXPIRED" } });
      await prisma.notification.deleteMany({ where: { offerId: { in: open.map((o) => o.id) } } });
    }
    await ensureJobSheetForAssignment(guideId, date, slotIdx, "direct-assign");
    await audit({
      actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
      action: "assign.manual", entityType: "Assignment", entityId: a.id,
      detail: { guideId, date, slotIdx, tourId, bookings: booked.count, offersClosed: open.length },
    });
    forgetCached(DASHBOARD_CACHE_KEY);
    // The company calendar event with this guide invited, as an accepted offer gets — the
    // departure's existing event when there is one (lib/tour-calendar-sync). Best-effort.
    try { await (await import("@/lib/tour-calendar-sync")).pushTourToCalendars(guideId, date, slotIdx); } catch { /* never block on calendar */ }
    // Every channel the guide can be reached on: in the app (the bell), a push to the
    // phone or browser where the app is installed, and LINE when linked. No email: the
    // calendar invitation comes from Google. (A slot the guide already holds is refused
    // above, so this is always news to them.)
    const n = directAssignmentNotice({ guideName: g?.displayName ?? null, tourName: tour?.name ?? tourId, meetingPoint: tour?.meetingPoint ?? null, date, slotIdx, pax: pax ?? null });
    try {
      await notifyGuide(guideId, n.message, n.title, n.body, undefined, { url: `/tour-details?date=${date}&slotIdx=${slotIdx}`, email: false });
    } catch { /* never block the assignment on a notice */ }
    return NextResponse.json({ ok: true, assigned: true, direct: true, bookings: booked.count, offersClosed: open.length });
  }

  if (await prisma.blockedDate.findUnique({ where: { date } })) {
    return NextResponse.json({ error: "date-blocked" }, { status: 409 });
  }

  // Validate FK targets exist for clean errors.
  const [guide, tour] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.tour.findUnique({ where: { id: tourId } }),
  ]);
  if (!guide) return NextResponse.json({ error: "unknown guide" }, { status: 400 });
  if (!tour) return NextResponse.json({ error: "unknown tour" }, { status: 400 });

  // Assigning a job no longer books the guide instantly: it sends them a job
  // offer with a 2-hour accept window. The confirmed Assignment is created only
  // when they accept (acceptOffer). If they don't, sweepExpiredOffers hands it
  // back to the operator to reassign.
  const r = await createOffer({
    tourId, date, slotIdx, pax: pax ?? null, note: note ?? null,
    ttlMinutes: 120, onlyGuideId: guideId, createdById: session!.user!.id ?? null,
  });
  // Already guided by someone: an offer from here never doubles a job (lib/offers createOffer).
  if (r.staffed) {
    const who = r.staffed.map((g) => `${g.guideId} ${g.name}`).join(", ");
    return NextResponse.json({ error: "slot-staffed", staffed: r.staffed, reasons: [`This tour already has a guide: ${who}. Replace them from the Bookings inbox, or add a second guide with Split on Jobs.`] }, { status: 409 });
  }
  // No candidate means this guide can't take the slot (already booked it, on
  // leave, inactive, or offers-blocked) — surface that instead of silently no-op.
  if (r.candidates === 0) return NextResponse.json({ error: "guide-unavailable" }, { status: 409 });
  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "assign.offered", entityType: "JobOffer", entityId: r.offerId ?? undefined,
    detail: { guideId, date, slotIdx, tourId, ttlMinutes: 120 },
  });
  return NextResponse.json({ ok: true, pending: true, offerId: r.offerId, lineSent: r.lineSent });
}

// DELETE /api/assignments  { guideId, date, slotIdx }  — operator only
const delSchema = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  release: z.boolean().optional(), // true (plain Remove) → return its bookings to the inbox
});

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) {
    return NextResponse.json({ error: "operators only" }, { status: 403 });
  }
  const parsed = delSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const { guideId, date, slotIdx, release } = parsed.data;

  // The guide comes off the departure (lib/assignment-removal): refused once the tour has
  // started, under a handover, or with financial history; otherwise their work on the slot is
  // undone, their tag comes off its bookings, and they are told.
  const r = await removeGuideFromDeparture({ guideId, date, slotIdx, release });
  if (!r.ok) return NextResponse.json(r.refusal.body, { status: r.refusal.status });
  return NextResponse.json({ ok: true });
}
