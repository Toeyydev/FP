import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { encrypt } from "@/lib/crypto";
import { ensureJobRef } from "@/lib/jobref";
import { DEFAULT_GUIDE_FEE, type GuideFee } from "@/lib/jobsheet";
import { paymentCoverage } from "@/lib/payment-coverage";
import { paymentDocumentLocks } from "@/lib/peak-payment-server";
import { guideSlotBookings, SHEET_BOOKING_STATUSES, toSheetBooking } from "@/lib/sheet-bookings";
import {
  externalGuideEmail, handoverBlockers, handoverFees, nextGuideId, undoBlockers, HANDOVER_REASONS, HANDOVER_TIME,
} from "@/lib/tour-handover";

export const dynamic = "force-dynamic";

// POST   — hand a tour from one guide to another part-way through (lib/tour-handover).
// DELETE — undo it, while nobody has been paid or booked for it.
//
// Operators only. Nobody is notified: the operator has already spoken to both guides
// by the time this is recorded (owner decision 2026-09-15).

const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const json = (v: unknown) => v as Prisma.InputJsonValue;

const postSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotIdx: z.number().int().min(0),
  fromGuideId: z.string().min(1),
  time: z.string().regex(HANDOVER_TIME),
  reason: z.enum(HANDOVER_REASONS),
  note: z.string().max(1000).optional(),
  toGuideId: z.string().min(1).optional(),
  external: z.object({
    fullName: z.string().trim().min(2).max(160),
    phone: z.string().trim().max(40).optional(),
    taxId: z.string().trim().max(60).optional(),
    bankName: z.string().trim().max(80).optional(),
    bankAccountNo: z.string().trim().max(40).optional(),
    bankAccountName: z.string().trim().max(160).optional(),
  }).optional(),
}).refine((b) => !!b.toGuideId !== !!b.external, { message: "Choose an existing guide or enter a one-off guide — one of the two" });

/** Everything that decides whether a guide's part of this tour may still change. */
async function jobFacts(guideId: string, date: string, slotIdx: number) {
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const [assignment, sheet, tourPay, payroll, locks, checkins] = await Promise.all([
    prisma.assignment.findUnique({ where: key, select: { tourId: true } }),
    prisma.jobSheet.findUnique({ where: key }),
    prisma.tourPayment.findUnique({ where: key, select: { status: true, paidAt: true } }),
    prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId, period: date.slice(0, 7) } }, select: { status: true, paidAt: true } }),
    paymentDocumentLocks([{ guideId, date, slotIdx }]),
    prisma.checkin.count({ where: { guideId, date, slotIdx } }),
  ]);
  return {
    assignment, sheet,
    facts: { assignment: !!assignment, sheet, paid: paymentCoverage(date, tourPay, payroll).paid, locked: locks, checkins },
  };
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const b = parsed.data;
  const { date, slotIdx, fromGuideId } = b;
  if (date > bkkToday()) {
    return NextResponse.json({ error: "not-started", reasons: ["This tour has not happened yet — re-offer it to another guide instead of handing it over"] }, { status: 409 });
  }

  const from = await jobFacts(fromGuideId, date, slotIdx);
  let toFacts: { assignment: boolean; sheet: boolean } | null = null;
  const reasons: string[] = [];
  if (b.toGuideId) {
    const [u, a, s] = await Promise.all([
      prisma.user.findUnique({ where: { guideId: b.toGuideId }, select: { role: true, external: true } }),
      prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId: b.toGuideId, date, slotIdx } }, select: { id: true } }),
      prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: b.toGuideId, date, slotIdx } }, select: { id: true } }),
    ]);
    if (!u || u.role !== "GUIDE") reasons.push(`${b.toGuideId} is not a guide`);
    // A one-off guide is never booked again (owner decision) — not even as a replacement.
    else if (u.external) reasons.push(`${b.toGuideId} is a one-off guide and is not booked again`);
    toFacts = { assignment: !!a, sheet: !!s };
  }
  const active = await prisma.tourHandover.count({ where: { date, slotIdx, fromGuideId, revokedAt: null } });
  reasons.push(...handoverBlockers({ fromGuideId, toGuideId: b.toGuideId ?? null, from: from.facts, to: toFacts, activeHandoverFromThisGuide: active > 0 }));
  if (reasons.length) return NextResponse.json({ error: "not-allowed", reasons }, { status: 409 });

  const tourId = from.assignment!.tourId;
  const originalFee = (from.sheet?.guideFee as GuideFee | null) ?? null;
  const fees = handoverFees(originalFee);

  let result: { handoverId: string; toGuideId: string; fromSheetId: string; toSheetId: string; externalUserId: string | null } | null = null;
  // A new one-off guide takes the next G-id; two operators doing this at once can pick
  // the same one, and the unique index refuses the second — so try the next number.
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    try {
      result = await prisma.$transaction(async (tx) => {
        let toGuideId = b.toGuideId ?? "";
        let externalUserId: string | null = null;
        if (b.external) {
          const last = await tx.user.findFirst({ where: { guideId: { startsWith: "G-" } }, orderBy: { guideId: "desc" }, select: { guideId: true } });
          toGuideId = nextGuideId(last?.guideId);
          const e = b.external;
          const u = await tx.user.create({
            data: {
              guideId: toGuideId, role: "GUIDE", state: "ACTIVE", external: true, offerBlocked: true,
              email: externalGuideEmail(toGuideId), displayName: e.fullName, fullName: e.fullName,
              phone: e.phone || null,
              taxId: e.taxId ? encrypt(e.taxId) : null,
              bankName: e.bankName ? encrypt(e.bankName) : null,
              bankAccountNo: e.bankAccountNo ? encrypt(e.bankAccountNo) : null,
              bankAccountName: e.bankAccountName ? encrypt(e.bankAccountName) : null,
            },
            select: { id: true },
          });
          externalUserId = u.id;
        }

        // The guests stay with the original guide. On a slot that was never split the
        // bookings carry no guide, and a sheet shows every untagged guest — so the
        // replacement's sheet would list them all. Tag them to the original guide.
        const tagged = await tx.booking.count({ where: { date, slotIdx, assignedGuideId: { not: null }, status: { in: [...SHEET_BOOKING_STATUSES] } } });
        if (!tagged) await tx.booking.updateMany({ where: { date, slotIdx, assignedGuideId: null, status: { in: [...SHEET_BOOKING_STATUSES] } }, data: { assignedGuideId: fromGuideId } });

        // Original guide: no fee from here on. Their expenses stay and are still reimbursed.
        let fromSheetId: string;
        if (from.sheet) {
          await tx.jobSheet.update({ where: { id: from.sheet.id }, data: { guideFee: json(fees.from) } });
          fromSheetId = from.sheet.id;
        } else {
          // No sheet yet: without one, Payments would pay the standard fee for this job.
          const atSlot = await tx.booking.findMany({
            where: { date, slotIdx, status: { in: [...SHEET_BOOKING_STATUSES] } },
            select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true, noShowPax: true, status: true },
            orderBy: { createdAt: "asc" },
          });
          const created = await tx.jobSheet.create({
            data: { guideId: fromGuideId, date, slotIdx, tourId, bookings: json(guideSlotBookings(atSlot, fromGuideId).map(toSheetBooking)), expenses: json([]), guideFee: json(fees.from), createdById: actor.actorId },
            select: { id: true },
          });
          fromSheetId = created.id;
        }

        // Replacement: their own assignment and sheet, the full fee, no guests.
        await tx.assignment.create({ data: { guideId: toGuideId, date, slotIdx, tourId, pax: null, note: `Replacement for ${fromGuideId} from ${b.time}` } });
        const toSheet = await tx.jobSheet.create({
          data: { guideId: toGuideId, date, slotIdx, tourId, bookings: json([]), expenses: json([]), guideFee: json(fees.to), createdById: actor.actorId },
          select: { id: true },
        });

        const h = await tx.tourHandover.create({
          data: {
            date, slotIdx, tourId, fromGuideId, toGuideId, handedOverAt: b.time, reason: b.reason,
            note: b.note?.trim() || null, fromFee: originalFee ? json(originalFee) : Prisma.JsonNull, createdById: actor.actorId,
          },
          select: { id: true },
        });
        return { handoverId: h.id, toGuideId, fromSheetId, toSheetId: toSheet.id, externalUserId };
      }, { timeout: 20_000 });
    } catch (e) {
      if (b.external && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
  if (!result) return NextResponse.json({ error: "busy", reasons: ["Could not assign a guide number — try again"] }, { status: 409 });

  const [fromRef, toRef] = await Promise.all([
    ensureJobRef(result.fromSheetId, date).catch(() => null),
    ensureJobRef(result.toSheetId, date).catch(() => null),
  ]);
  const detail = { date, slotIdx, fromGuideId, toGuideId: result.toGuideId, time: b.time, reason: b.reason, external: !!b.external, fromRef, toRef };
  await audit({ ...actor, action: "tour.handover", entityType: "TourHandover", entityId: result.handoverId, detail });
  await audit({ ...actor, action: "jobsheet.handed_over", entityType: "JobSheet", entityId: result.fromSheetId, detail });
  await audit({ ...actor, action: "jobsheet.handed_over", entityType: "JobSheet", entityId: result.toSheetId, detail });
  if (result.externalUserId) await audit({ ...actor, action: "guide.external_created", entityType: "User", entityId: result.externalUserId, detail: { guideId: result.toGuideId, date, slotIdx } });

  return NextResponse.json({ ok: true, id: result.handoverId, toGuideId: result.toGuideId, fromRef, toRef });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const parsed = z.object({ id: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const h = await prisma.tourHandover.findUnique({ where: { id: parsed.data.id } });
  if (!h || h.revokedAt) return NextResponse.json({ error: "not-found", reasons: ["There is no active handover to undo"] }, { status: 404 });
  const [from, to] = await Promise.all([jobFacts(h.fromGuideId, h.date, h.slotIdx), jobFacts(h.toGuideId, h.date, h.slotIdx)]);
  const reasons = undoBlockers({ fromGuideId: h.fromGuideId, toGuideId: h.toGuideId, from: from.facts, to: to.facts });
  if (reasons.length) return NextResponse.json({ error: "not-allowed", reasons }, { status: 409 });

  const where = { guideId: h.toGuideId, date: h.date, slotIdx: h.slotIdx };
  await prisma.$transaction(async (tx) => {
    const undone = await tx.tourHandover.updateMany({ where: { id: h.id, revokedAt: null }, data: { revokedAt: new Date(), revokedById: actor.actorId } });
    if (undone.count !== 1) throw new Error("handover already undone");
    await tx.jobSheet.deleteMany({ where });
    await tx.assignment.deleteMany({ where });
    // The original guide's fee as it was before the handover (the standard fee if they
    // had no sheet then — which is what Payments paid for the job without one).
    if (from.sheet) await tx.jobSheet.update({ where: { id: from.sheet.id }, data: { guideFee: json((h.fromFee as GuideFee | null) ?? DEFAULT_GUIDE_FEE) } });
  }, { timeout: 20_000 });

  const detail = { date: h.date, slotIdx: h.slotIdx, fromGuideId: h.fromGuideId, toGuideId: h.toGuideId };
  await audit({ ...actor, action: "tour.handover_undone", entityType: "TourHandover", entityId: h.id, detail });
  if (from.sheet) await audit({ ...actor, action: "jobsheet.handover_undone", entityType: "JobSheet", entityId: from.sheet.id, detail });
  return NextResponse.json({ ok: true });
}
