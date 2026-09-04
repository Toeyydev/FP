import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canBook, quote, partyPax, seatsFor, voucherCode, commissionFor } from "@/lib/reservations";
import { rateLimit, callerKey } from "@/lib/rate-limit";
import { sendBookingConfirmation } from "@/lib/send-confirmation";

export const dynamic = "force-dynamic";

// A guest booking themselves, with no account. The commission-free path, and the
// only unauthenticated endpoint in FolkOPS that writes a row.
//
// Because anyone can call it, the trust boundary is drawn tightly:
//   * the channel is FORCED to "website" — a caller cannot label their booking as
//     GetYourGuide and corrupt the commission report,
//   * the price is computed server-side from the tour and departure, never taken
//     from the request, so the total cannot be edited in the browser,
//   * capacity is re-checked under a row lock, exactly as at the operator desk,
//   * party size is capped, so one request cannot swallow a whole departure.

const PUBLIC_CHANNEL = "website";
const MAX_PARTY = 20;

const bodyZ = z.object({
  departureId: z.string().min(1).max(40),
  customerName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().max(40).optional().default(""),
  nationality: z.string().trim().max(60).optional().default(""),
  adults: z.number().int().min(1).max(MAX_PARTY),
  children: z.number().int().min(0).max(MAX_PARTY),
  specialRequests: z.string().trim().max(600).optional().default(""),
});

export async function POST(req: NextRequest) {
  // Tighter than the read endpoint: this one writes.
  const rl = rateLimit(callerKey(req.headers, "book"), 8, 10 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "slow-down", message: "Too many booking attempts. Please wait a few minutes or contact us directly." },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  }

  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad-request", message: firstMessage(parsed.error.issues) }, { status: 400 });
  }
  const b = parsed.data;
  const pax = partyPax(b);
  if (pax < 1 || pax > MAX_PARTY) {
    return NextResponse.json({ error: "party-size", message: `Please book between 1 and ${MAX_PARTY} guests, or contact us for a larger group.` }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Departure" WHERE id = ${b.departureId} FOR UPDATE`;
      if (!locked.length) return { err: "gone", status: 404, message: "That departure is no longer available." };

      const dep = await tx.departure.findUniqueOrThrow({ where: { id: b.departureId } });
      const tour = await tx.tour.findUnique({ where: { id: dep.tourId } });
      if (!tour || tour.priceAdult == null) {
        return { err: "not-for-sale", status: 409, message: "This tour is not available to book online right now." };
      }

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
      if (!gate.ok) return { err: "unavailable", status: 409, message: gate.reason, seatsLeft: gate.remaining };

      const n = (v: unknown) => (v == null ? null : Number(v.toString()));
      const q = quote(
        { priceAdult: n(tour.priceAdult), priceChild: n(tour.priceChild), currency: tour.currency },
        { priceAdult: n(dep.priceAdult), priceChild: n(dep.priceChild) },
        b,
      );
      if (!q.ok) return { err: "not-for-sale", status: 409, message: "This tour is not available to book online right now." };

      const channel = await tx.salesChannel.findUnique({ where: { id: PUBLIC_CHANNEL } });
      const comm = commissionFor(q.gross, { commissionPct: n(channel?.commissionPct), isDirect: channel?.isDirect ?? true });

      let created = null as Awaited<ReturnType<typeof tx.booking.create>> | null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          created = await tx.booking.create({
            data: {
              source: PUBLIC_CHANNEL,
              departureId: dep.id,
              tourId: dep.tourId, date: dep.date, startTime: dep.time, slotIdx: dep.slotIdx,
              pax, adults: b.adults, children: b.children,
              customerName: b.customerName,
              email: b.email, phone: b.phone || null, nationality: b.nationality || null,
              specialRequests: b.specialRequests || null,
              bookingDate: new Date().toISOString().slice(0, 10),
              paymentStatus: "unpaid",
              status: "PENDING",
              datePinned: true,
              grossAmount: q.gross,
              commissionPct: comm.pct, commissionAmount: comm.amount, netAmount: comm.net,
              currency: q.currency,
              voucherCode: voucherCode(),
            },
          });
        } catch (e) { if (attempt === 4) throw e; }
      }
      return { booking: created!, seatsLeft: seats.remaining - pax, tourName: tour.name, meetingPoint: tour.meetingPoint, durationMin: tour.durationMin };
    });

    if ("err" in result) {
      return NextResponse.json({ error: result.err, message: result.message, seatsLeft: result.seatsLeft }, { status: result.status });
    }

    // No actor: the guest is not a user. The audit trail still records the sale.
    await audit({
      actorId: null, actorRole: "GUEST",
      action: "reservation.public_booked", entityType: "Booking", entityId: result.booking.id,
      detail: { voucher: result.booking.voucherCode, departureId: b.departureId, pax, gross: result.booking.grossAmount?.toString() ?? null },
    });

    // Outside the transaction on purpose: an SMTP round trip inside a row lock
    // would hold the departure — and every other guest trying to book it — for as
    // long as the mail server takes to answer.
    const emailed = await sendBookingConfirmation({
      voucherCode: result.booking.voucherCode!, tourName: result.tourName,
      date: result.booking.date!, time: result.booking.startTime!,
      pax, adults: b.adults, children: b.children, customerName: b.customerName,
      meetingPoint: result.meetingPoint, total: Number(result.booking.grossAmount),
      currency: result.booking.currency, durationMin: result.durationMin,
    }, b.email);

    // Only what the guest needs to see their own booking back.
    return NextResponse.json({
      ok: true,
      voucherCode: result.booking.voucherCode,
      tourName: result.tourName,
      date: result.booking.date,
      time: result.booking.startTime,
      pax,
      total: result.booking.grossAmount?.toString() ?? null,
      currency: result.booking.currency,
      meetingPoint: result.meetingPoint,
      // The page says "check your email" only when one actually went out.
      emailed,
    });
  } catch {
    return NextResponse.json({ error: "failed", message: "We could not complete that booking. Please try again, or contact us directly." }, { status: 500 });
  }
}

function firstMessage(issues: { path: (string | number)[]; message: string }[]): string {
  const i = issues[0];
  if (!i) return "Please check the form and try again.";
  const field = String(i.path[0] ?? "");
  if (field === "email") return "Please enter a valid email address — it is where your confirmation goes.";
  if (field === "customerName") return "Please enter the name the booking is under.";
  return "Please check the form and try again.";
}
