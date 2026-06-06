import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }

// Pull lat,lng out of a pasted Google Maps URL (several shapes).
function parseLatLng(url: string): { lat: number; lng: number } | null {
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&]query=(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/];
  for (const p of pats) { const m = url.match(p); if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) }; }
  return null;
}

export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tours = await prisma.tour.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true, meetingPoint: true, meetingLat: true, meetingLng: true, meetingRadiusM: true } });
  return NextResponse.json({ tours });
}

// POST { tourId, meetingPoint?, mapsUrl?, radiusM? } — set a tour's meeting point
// and parse coordinates from a pasted Google Maps link (or "lat,lng").
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ tourId: z.string().min(1), meetingPoint: z.string().max(200).optional(), mapsUrl: z.string().max(2000).optional(), radiusM: z.number().int().min(20).max(2000).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { tourId, meetingPoint, mapsUrl, radiusM } = parsed.data;

  const data: Record<string, unknown> = {};
  if (meetingPoint !== undefined) data.meetingPoint = meetingPoint.trim() || null;
  if (radiusM !== undefined) data.meetingRadiusM = radiusM;
  let coords: { lat: number; lng: number } | null = null;
  if (mapsUrl !== undefined) {
    if (mapsUrl.trim() === "") { data.meetingLat = null; data.meetingLng = null; }
    else {
      coords = parseLatLng(mapsUrl.trim());
      if (!coords) return NextResponse.json({ error: "no-coords", message: "Couldn't find coordinates in that link — paste a Google Maps link or 'lat,lng'." }, { status: 400 });
      data.meetingLat = coords.lat; data.meetingLng = coords.lng;
      if (radiusM === undefined) data.meetingRadiusM = 150;
    }
  }
  const tour = await prisma.tour.update({ where: { id: tourId }, data });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "meetingpoint.set", entityType: "Tour", entityId: tourId, detail: { coords } });
  return NextResponse.json({ ok: true, tour: { id: tour.id, meetingLat: tour.meetingLat, meetingLng: tour.meetingLng, meetingRadiusM: tour.meetingRadiusM, meetingPoint: tour.meetingPoint } });
}
