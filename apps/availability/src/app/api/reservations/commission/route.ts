import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { commissionFor, rollupCommission } from "@/lib/reservations";

export const dynamic = "force-dynamic";

// What the sales channels cost over a period.
//
// The point of the report: OTA commission is invisible day to day because it is
// deducted before the money ever arrives. Put next to direct revenue, it becomes
// a number worth acting on.
//
// Two honesty rules it will not break:
//   * A booking whose channel has no rate set is reported separately as
//     "rate not set" — never folded in at 0%, which would understate the cost.
//   * A booking with no gross amount is not counted at all. Most of the OTA
//     backlog has no price, because Bokun's sync never sent one; pretending
//     otherwise would invent revenue.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const to = DATE.test(sp.get("to") ?? "") ? sp.get("to")! : today;
  const from = DATE.test(sp.get("from") ?? "") ? sp.get("from")! : `${today.slice(0, 8)}01`;

  const [channels, bookings] = await Promise.all([
    prisma.salesChannel.findMany(),
    prisma.booking.findMany({
      where: { date: { gte: from, lte: to }, status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { id: true, source: true, pax: true, grossAmount: true, commissionAmount: true, netAmount: true, date: true },
    }),
  ]);

  const num = (v: unknown) => (v == null ? null : Number(v.toString()));
  const chBy = new Map(channels.map((c) => [c.id, { id: c.id, name: c.name, isDirect: c.isDirect, commissionPct: num(c.commissionPct) }]));

  const rows = bookings.map((b) => ({
    ...b,
    // A booking that stored its own commission keeps it: that snapshot is what
    // was true when the sale happened, and a later rate change must not rewrite
    // history. Only bookings without one are priced at the current rate.
    channel: chBy.get(b.source) ?? { id: b.source, name: b.source, isDirect: false, commissionPct: null },
    gross: num(b.grossAmount),
    storedCommission: num(b.commissionAmount),
  }));

  const byChannel = new Map<string, { id: string; name: string; isDirect: boolean; pct: number | null; bookings: number; pax: number; gross: number; commission: number; net: number; unknownRate: number; priced: number; unpriced: number }>();

  for (const r of rows) {
    const key = r.channel.id;
    if (!byChannel.has(key)) {
      byChannel.set(key, { id: key, name: r.channel.name, isDirect: r.channel.isDirect, pct: r.channel.commissionPct, bookings: 0, pax: 0, gross: 0, commission: 0, net: 0, unknownRate: 0, priced: 0, unpriced: 0 });
    }
    const agg = byChannel.get(key)!;
    agg.bookings += 1;
    agg.pax += r.pax ?? 0;
    if (r.gross == null) { agg.unpriced += 1; continue; }
    agg.priced += 1;
    agg.gross += r.gross;
    const c = r.storedCommission != null
      ? { known: true, amount: r.storedCommission, net: r.gross - r.storedCommission }
      : commissionFor(r.gross, r.channel);
    if (!c.known) { agg.unknownRate += 1; continue; }
    agg.commission += c.amount ?? 0;
    agg.net += c.net ?? 0;
  }

  const channelRows = [...byChannel.values()].sort((a, b) => b.gross - a.gross);
  const total = rollupCommission(rows.map((r) => ({ gross: r.gross, channel: r.channel })));

  // The headline: what the same revenue would have kept if it had been booked
  // direct. Only over bookings whose rate is actually known — an unknown rate
  // cannot contribute to a savings claim.
  const otaGrossKnown = channelRows.filter((c) => !c.isDirect).reduce((n, c) => n + c.gross, 0);
  const otaCommission = channelRows.filter((c) => !c.isDirect).reduce((n, c) => n + c.commission, 0);

  return NextResponse.json({
    from, to,
    channels: channelRows.map((c) => ({ ...c, gross: round2(c.gross), commission: round2(c.commission), net: round2(c.net) })),
    total: { ...total, gross: round2(total.gross), commission: round2(total.commission), net: round2(total.net) },
    ota: { gross: round2(otaGrossKnown), commission: round2(otaCommission) },
    direct: {
      gross: round2(channelRows.filter((c) => c.isDirect).reduce((n, c) => n + c.gross, 0)),
      bookings: channelRows.filter((c) => c.isDirect).reduce((n, c) => n + c.bookings, 0),
    },
    // Surfaced so the totals are never mistaken for the whole picture.
    coverage: {
      bookings: rows.length,
      priced: channelRows.reduce((n, c) => n + c.priced, 0),
      unpriced: channelRows.reduce((n, c) => n + c.unpriced, 0),
      unknownRate: channelRows.reduce((n, c) => n + c.unknownRate, 0),
    },
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
