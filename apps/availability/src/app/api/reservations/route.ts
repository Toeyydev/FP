import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { onBookingCancelled } from "@/lib/booking-import";
import { canBook, quote, partyPax, seatsFor, voucherCode, commissionFor } from "@/lib/reservations";
import { sendBookingConfirmation } from "@/lib/send-confirmation";

export const dynamic = "force-dynamic";

// The reservation desk's write path: take a booking, amend one, cancel one.
//
// A reservation is stored as a Booking — the same row Dispatch, the Job Sheet and
// Payments already read. That is the whole reason this lives inside FolkOPS: a
// direct sale reaches the guide through machinery that already works, instead of
// through a second system that has to be reconciled with this one.

const createZ = z.object({
  action: z.literal("create"),
  departureId: z.string().min(1),
  customerName: z.string().min(1).max(160),
  email: z.string().email().max(200).nullish(),
  phone: z.string().max(60).nullish(),
  nationality: z.string().max(80).nullish(),
  adults: z.number().int().min(0).max(200).default(0),
  children: z.number().int().min(0).max(200).default(0),
  channel: z.string().min(1).max(40).default("direct"),
  specialRequests: z.string().max(1000).nullish(),
  notes: z.string().max(1000).nullish(),
  // Lets the desk honour a quoted price. Null means "use the standard price".
  overrideGross: z.number().min(0).max(10_000_000).nullish(),
  paymentStatus: z.enum(["unpaid", "paid", "deposit"]).default("unpaid"),
});

const cancelZ = z.object({ action: z.literal("cancel"), id: z.string().min(1), reason: z.string().max(300).nullish() });

const amendZ = z.object({
  action: z.literal("amend"),
  id: z.string().min(1),
  customerName: z.string().min(1).max(160).optional(),
  email: z.string().email().max(200).nullish(),
  phone: z.string().max(60).nullish(),
  adults: z.number().int().min(0).max(200).optional(),
  children: z.number().int().min(0).max(200).optional(),
  specialRequests: z.string().max(1000).nullish(),
  notes: z.string().max(1000).nullish(),
  paymentStatus: z.enum(["unpaid", "paid", "deposit"]).optional(),
});

const bodyZ = z.discriminatedUnion("action", [createZ, cancelZ, amendZ]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", detail: parsed.error.issues[0]?.message }, { status: 400 });
  const body = parsed.data;
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };

  if (body.action === "create") return createReservation(body, actor);
  if (body.action === "amend") return amendReservation(body, actor);
  return cancelReservation(body, actor);
}

type Actor = { actorId: string | null; actorRole: string | null };

async function createReservation(b: z.infer<typeof createZ>, actor: Actor) {
  const pax = partyPax(b);
  if (pax <= 0) return NextResponse.json({ error: "no-guests", detail: "Add at least one guest." }, { status: 400 });

  const channel = await prisma.salesChannel.findUnique({ where: { id: b.channel } });
  if (!channel || !channel.active) return NextResponse.json({ error: "unknown-channel" }, { status: 400 });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the departure row for the life of the transaction. Without this, two
      // operators booking the last seats at the same moment would both read
      // "2 left" under Postgres' default READ COMMITTED and both succeed. The
      // lock makes the check-then-write actually atomic.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Departure" WHERE id = ${b.departureId} FOR UPDATE`;
      if (!locked.length) return { error: "not-found" as const, status: 404 };

      const dep = await tx.departure.findUniqueOrThrow({ where: { id: b.departureId } });
      const tour = await tx.tour.findUnique({ where: { id: dep.tourId } });

      // Count seats INSIDE the lock, and count unlinked OTA bookings too — a
      // departure GetYourGuide already filled is not empty just because those
      // bookings have no departureId.
      const held = await tx.booking.findMany({
        where: {
          status: { notIn: ["CANCELLED", "IGNORED"] },
          OR: [
            { departureId: dep.id },
            { departureId: null, tourId: dep.tourId, date: dep.date, startTime: dep.time },
            ...(dep.slotIdx != null ? [{ departureId: null, tourId: dep.tourId, date: dep.date, slotIdx: dep.slotIdx }] : []),
          ],
        },
        select: { pax: true, status: true },
      });

      const seats = seatsFor(dep.capacity, held);
      const gate = canBook(dep, seats, pax);
      if (!gate.ok) return { error: "cannot-book" as const, status: 409, detail: gate.reason, remaining: gate.remaining };

      const num = (v: unknown) => (v == null ? null : Number(v.toString()));
      const q = quote(
        { priceAdult: num(tour?.priceAdult), priceChild: num(tour?.priceChild), currency: tour?.currency },
        { priceAdult: num(dep.priceAdult), priceChild: num(dep.priceChild) },
        b,
      );
      // An override is honoured, but a tour with no price and no override cannot
      // be sold — the desk is told to set a price rather than booking at ฿0.
      const gross = b.overrideGross ?? (q.ok ? q.gross : null);
      if (gross == null) return { error: "no-price" as const, status: 400, detail: q.ok ? undefined : q.reason };

      const comm = commissionFor(gross, { commissionPct: num(channel.commissionPct), isDirect: channel.isDirect });

      // Retry on the astronomically unlikely voucher-code collision rather than
      // failing a sale in front of a customer.
      let created = null as Awaited<ReturnType<typeof tx.booking.create>> | null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          created = await tx.booking.create({
            data: {
              source: channel.id,
              departureId: dep.id,
              tourId: dep.tourId, date: dep.date, startTime: dep.time, slotIdx: dep.slotIdx,
              pax, adults: b.adults, children: b.children,
              customerName: b.customerName, email: b.email ?? null, phone: b.phone ?? null,
              nationality: b.nationality ?? null,
              specialRequests: b.specialRequests ?? null, notes: b.notes ?? null,
              bookingDate: new Date().toISOString().slice(0, 10),
              paymentStatus: b.paymentStatus,
              status: "PENDING",
              // A desk booking is a deliberate placement. Pin it so the 30-minute
              // OTA sync never drags its date or slot somewhere else.
              datePinned: true,
              grossAmount: gross,
              commissionPct: comm.pct,
              commissionAmount: comm.amount,
              netAmount: comm.net,
              currency: q.currency,
              voucherCode: voucherCode(),
            },
          });
        } catch (e) {
          if (attempt === 4) throw e;
        }
      }
      return { booking: created!, seatsAfter: seats.remaining - pax, tourName: tour?.name ?? dep.tourId, meetingPoint: tour?.meetingPoint ?? null, durationMin: tour?.durationMin ?? null };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error, detail: result.detail, remaining: result.remaining }, { status: result.status });
    }

    // A desk booking gets the same confirmation as a web one — a guest who booked
    // by phone still wants the code in writing.
    const emailed = await sendBookingConfirmation({
      voucherCode: result.booking.voucherCode!, tourName: result.tourName,
      date: result.booking.date!, time: result.booking.startTime!,
      pax, adults: b.adults, children: b.children, customerName: b.customerName,
      meetingPoint: result.meetingPoint, total: Number(result.booking.grossAmount),
      currency: result.booking.currency, durationMin: result.durationMin,
      paymentNote: b.paymentStatus === "paid" ? "Paid in full — thank you." : null,
    }, b.email);

    await audit({
      ...actor, action: "reservation.created", entityType: "Booking", entityId: result.booking.id,
      detail: {
        voucher: result.booking.voucherCode, departureId: b.departureId, channel: b.channel,
        pax, gross: result.booking.grossAmount?.toString() ?? null,
        commission: result.booking.commissionAmount?.toString() ?? null,
      },
    });
    return NextResponse.json({ ok: true, booking: result.booking, seatsLeft: result.seatsAfter, emailed });
  } catch (e) {
    return NextResponse.json({ error: "create-failed", detail: (e as Error).message.slice(0, 200) }, { status: 500 });
  }
}

async function amendReservation(b: z.infer<typeof amendZ>, actor: Actor) {
  const before = await prisma.booking.findUnique({ where: { id: b.id } });
  if (!before) return NextResponse.json({ error: "not-found" }, { status: 404 });

  // A headcount change re-runs the capacity check — growing a party is a new sale
  // against the same finite departure and must not be allowed to oversell it.
  const changesParty = b.adults !== undefined || b.children !== undefined;
  const adults = b.adults ?? before.adults ?? 0;
  const children = b.children ?? before.children ?? 0;
  const newPax = changesParty ? adults + children : (before.pax ?? 0);

  if (changesParty && newPax > (before.pax ?? 0) && before.departureId) {
    const dep = await prisma.departure.findUnique({ where: { id: before.departureId } });
    if (dep) {
      const held = await prisma.booking.findMany({
        where: { departureId: dep.id, status: { notIn: ["CANCELLED", "IGNORED"] }, id: { not: before.id } },
        select: { pax: true, status: true },
      });
      const seats = seatsFor(dep.capacity, held);
      const gate = canBook(dep, seats, newPax);
      if (!gate.ok) return NextResponse.json({ error: "cannot-book", detail: gate.reason }, { status: 409 });
    }
  }

  const updated = await prisma.booking.update({
    where: { id: b.id },
    data: {
      ...(b.customerName !== undefined ? { customerName: b.customerName } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.phone !== undefined ? { phone: b.phone } : {}),
      ...(b.specialRequests !== undefined ? { specialRequests: b.specialRequests } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.paymentStatus !== undefined ? { paymentStatus: b.paymentStatus } : {}),
      ...(changesParty ? { adults, children, pax: newPax } : {}),
    },
  });

  await audit({ ...actor, action: "reservation.amended", entityType: "Booking", entityId: b.id, detail: { from: { pax: before.pax, paymentStatus: before.paymentStatus }, to: { pax: updated.pax, paymentStatus: updated.paymentStatus } } });
  return NextResponse.json({ ok: true, booking: updated });
}

async function cancelReservation(b: z.infer<typeof cancelZ>, actor: Actor) {
  const before = await prisma.booking.findUnique({ where: { id: b.id } });
  if (!before) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (before.status === "CANCELLED") return NextResponse.json({ ok: true, alreadyCancelled: true });

  const updated = await prisma.booking.update({
    where: { id: b.id },
    data: {
      status: "CANCELLED",
      notes: b.reason ? `${before.notes ? `${before.notes}\n` : ""}Cancelled: ${b.reason}` : before.notes,
    },
  });

  // Same side effects as an OTA cancellation: the rostered guide's assignment and
  // calendar are updated, so nobody turns up for guests who cancelled.
  await onBookingCancelled(updated).catch(() => {});

  await audit({ ...actor, action: "reservation.cancelled", entityType: "Booking", entityId: b.id, detail: { voucher: before.voucherCode, pax: before.pax, reason: b.reason ?? null } });
  return NextResponse.json({ ok: true, booking: updated });
}
