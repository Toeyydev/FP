import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps, canViewFinance } from "@/lib/roles";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Sales channels and what each one costs in commission.
//
// The rate is entered by an operator from the actual contract, never defaulted.
// Every OTA publishes a range and negotiates within it, so a plausible-looking
// default here would produce a confident, wrong answer to "what are the OTAs
// costing us" — the one question this whole module exists to answer.

export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const channels = await prisma.salesChannel.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  // Which channels are actually in use, so the list can lead with those rather
  // than with whatever was seeded.
  const used = await prisma.booking.groupBy({
    by: ["source"],
    where: { status: { notIn: ["CANCELLED", "IGNORED"] } },
    _count: true,
  });
  const countOf = new Map(used.map((u) => [u.source, u._count]));

  return NextResponse.json({
    channels: channels.map((c) => ({
      ...c,
      commissionPct: c.commissionPct == null ? null : Number(c.commissionPct.toString()),
      bookings: countOf.get(c.id) ?? 0,
    })),
    // Sources seen on bookings that have no SalesChannel row — otherwise their
    // revenue would silently vanish from the commission report.
    unmapped: used.filter((u) => !channels.some((c) => c.id === u.source)).map((u) => ({ source: u.source, bookings: u._count })),
  });
}

const bodyZ = z.object({
  channels: z.array(z.object({
    id: z.string().min(1).max(40),
    // null clears the rate back to "not set" — the honest state when a contract
    // is under renegotiation, and not the same as 0%.
    commissionPct: z.number().min(0).max(100).nullable(),
  })).min(1).max(50),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const before = await prisma.salesChannel.findMany();
  const beforeBy = new Map(before.map((c) => [c.id, c.commissionPct == null ? null : Number(c.commissionPct.toString())]));
  const changed: { id: string; from: number | null; to: number | null }[] = [];

  for (const c of parsed.data.channels) {
    if (!beforeBy.has(c.id)) continue; // never create a channel via a rate save
    if (beforeBy.get(c.id) !== c.commissionPct) changed.push({ id: c.id, from: beforeBy.get(c.id) ?? null, to: c.commissionPct });
    await prisma.salesChannel.update({ where: { id: c.id }, data: { commissionPct: c.commissionPct } });
  }

  if (changed.length) {
    // A commission rate is an input to money owed. Who changed it, and from what,
    // is exactly what an accountant asks three months later.
    await audit({
      actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
      action: "channel.commission_saved", entityType: "SalesChannel", detail: { changed },
    });
  }
  return NextResponse.json({ ok: true, changed: changed.length });
}
