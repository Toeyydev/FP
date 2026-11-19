import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import { productsListingTour } from "@/lib/upsell/products";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// Tables that carry a tourId — kept in sync when two tours are merged. Run inside the merge's
// own transaction, so a merge the database refuses (the tour is an upsell product's eligible
// tour — trigger tour_upsell_eligibility_guard) moves nothing.
async function remapTour(tx: Prisma.TransactionClient, fromId: string, toId: string) {
  await tx.assignment.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.jobOffer.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.booking.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.jobSheet.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.checkin.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.tourReport.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.guideRating.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
  await tx.productMap.updateMany({ where: { tourId: fromId }, data: { tourId: toId } });
}

/** The database's refusal to remove a tour an upsell product lists (it may land between our own
 *  check and the delete, when an Admin ticks the tour at the same moment). */
const tourInUse = (e: unknown) => {
  const m = /UPSELL_TOUR_IN_USE: ([^\n"]+)/.exec(e instanceof Error ? e.message : String(e));
  return m ? NextResponse.json({ error: "upsell-eligible", message: m[1].trim() }, { status: 409 }) : null;
};

export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tours = await prisma.tour.findMany({ orderBy: { id: "asc" } });
  const [bk, asg] = await Promise.all([
    prisma.booking.groupBy({ by: ["tourId"], where: { status: { notIn: ["CANCELLED", "IGNORED"] }, tourId: { not: null } }, _count: true }),
    prisma.assignment.groupBy({ by: ["tourId"], _count: true }),
  ]);
  const bkOf = new Map(bk.map((r) => [r.tourId, r._count]));
  const asgOf = new Map(asg.map((r) => [r.tourId, r._count]));
  return NextResponse.json({ tours: tours.map((t) => ({ ...t, bookings: bkOf.get(t.id) ?? 0, assignments: asgOf.get(t.id) ?? 0 })) });
}

// POST { action: "create"|"update"|"delete"|"merge", ... } — operator only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const action = body?.action;

  if (action === "create") {
    const p = z.object({ name: z.string().min(1).max(160), time: z.string().max(20).optional(), durationMin: z.number().int().min(15).max(720).optional() }).safeParse(body);
    if (!p.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const all = await prisma.tour.findMany({ select: { id: true } });
    const max = all.reduce((m, t) => { const n = parseInt(t.id.replace(/\D/g, ""), 10); return Number.isFinite(n) && n > m ? n : m; }, 0);
    const id = `T-${String(max + 1).padStart(3, "0")}`;
    const tour = await prisma.tour.create({ data: { id, name: p.data.name.trim(), time: p.data.time?.trim() || "", durationMin: p.data.durationMin ?? null } });
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "tour.created", entityType: "Tour", entityId: id });
    return NextResponse.json({ ok: true, tour });
  }

  if (action === "update") {
    const p = z.object({ id: z.string().min(1), name: z.string().max(160).optional(), time: z.string().max(20).optional(), durationMin: z.number().int().min(15).max(720).nullable().optional(), meetingPoint: z.string().max(200).nullable().optional(), itinerary: z.string().max(4000).nullable().optional(), included: z.string().max(2000).nullable().optional(), bring: z.string().max(2000).nullable().optional() }).safeParse(body);
    if (!p.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const { id, ...rest } = p.data;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) data[k] = typeof v === "string" ? (v.trim() || (k === "name" || k === "time" ? v.trim() : null)) : v;
    const tour = await prisma.tour.update({ where: { id }, data });
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "tour.updated", entityType: "Tour", entityId: id });
    return NextResponse.json({ ok: true, tour });
  }

  if (action === "merge") {
    const p = z.object({ fromId: z.string().min(1), toId: z.string().min(1) }).safeParse(body);
    if (!p.success || p.data.fromId === p.data.toId) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const [from, to] = await Promise.all([prisma.tour.findUnique({ where: { id: p.data.fromId } }), prisma.tour.findUnique({ where: { id: p.data.toId } })]);
    if (!from || !to) return NextResponse.json({ error: "no-tour" }, { status: 404 });
    const upsell = await productsListingTour(prisma, p.data.fromId);
    if (upsell.length) return NextResponse.json({ error: "upsell-eligible", message: `${p.data.fromId} is an eligible tour of ${upsell.join(", ")} — remove it in Upsell settings first.` }, { status: 409 });
    try {
      await prisma.$transaction(async (tx) => {
        await remapTour(tx, p.data.fromId, p.data.toId);
        await tx.tour.delete({ where: { id: p.data.fromId } });
      }, { timeout: 20_000, maxWait: 5_000 });
    } catch (e) {
      const r = tourInUse(e); if (r) return r;
      throw e;
    }
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "tour.merged", entityType: "Tour", entityId: p.data.fromId, detail: { into: p.data.toId } });
    return NextResponse.json({ ok: true });
  }

  if (action === "delete") {
    const p = z.object({ id: z.string().min(1) }).safeParse(body);
    if (!p.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const [bk, asg] = await Promise.all([
      prisma.booking.count({ where: { tourId: p.data.id, status: { notIn: ["CANCELLED", "IGNORED"] } } }),
      prisma.assignment.count({ where: { tourId: p.data.id } }),
    ]);
    if (bk > 0 || asg > 0) return NextResponse.json({ error: "in-use", message: "This tour still has bookings or assignments — merge it into another tour instead." }, { status: 409 });
    const upsell = await productsListingTour(prisma, p.data.id);
    if (upsell.length) return NextResponse.json({ error: "upsell-eligible", message: `${p.data.id} is an eligible tour of ${upsell.join(", ")} — remove it in Upsell settings first.` }, { status: 409 });
    try { await prisma.tour.delete({ where: { id: p.data.id } }); } catch (e) {
      const r = tourInUse(e); if (r) return r;
      throw e;
    }
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "tour.deleted", entityType: "Tour", entityId: p.data.id });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad-action" }, { status: 400 });
}
