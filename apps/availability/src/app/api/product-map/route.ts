import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { productKey } from "@/lib/bookings";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET — operator: existing product→tour maps, all tours, and the distinct
// product names of bookings that arrived with NO tour (need mapping).
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const [maps, tours, unmappedBookings] = await Promise.all([
    prisma.productMap.findMany({ orderBy: { productName: "asc" } }),
    prisma.tour.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.booking.findMany({ where: { tourId: null, productName: { not: null }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { productName: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const counts: Record<string, { name: string; count: number }> = {};
  for (const b of unmappedBookings) {
    const name = b.productName!; const k = productKey(name);
    counts[k] = counts[k] || { name, count: 0 }; counts[k].count++;
  }
  return NextResponse.json({
    maps: maps.map((m) => ({ ...m, tourName: tourName.get(m.tourId) ?? m.tourId })),
    tours,
    unmapped: Object.values(counts).sort((a, b) => b.count - a.count),
  });
}

// POST { productName, tourId } — map a product to a tour, and BACKFILL existing
// tour-less bookings of that product so they group into one job immediately.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ productName: z.string().min(1), tourId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { productName, tourId } = parsed.data;
  const key = productKey(productName);
  await prisma.productMap.upsert({ where: { productKey: key }, create: { productKey: key, productName, tourId }, update: { tourId, productName } });

  const candidates = await prisma.booking.findMany({ where: { tourId: null, productName: { not: null } }, select: { id: true, productName: true } });
  const ids = candidates.filter((b) => productKey(b.productName!) === key).map((b) => b.id);
  let backfilled = 0;
  if (ids.length) backfilled = (await prisma.booking.updateMany({ where: { id: { in: ids } }, data: { tourId } })).count;
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "productmap.set", entityType: "ProductMap", detail: { productName, tourId, backfilled } });
  return NextResponse.json({ ok: true, backfilled });
}

// DELETE ?key= — remove a mapping.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "no-key" }, { status: 400 });
  await prisma.productMap.delete({ where: { productKey: key } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
