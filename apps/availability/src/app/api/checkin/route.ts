import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";

const TYPES = ["ARRIVE", "START", "COMPLETE"] as const;

// Great-circle distance in metres.
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// POST { date, slotIdx, type, lat?, lng?, accuracyM? } — guide records a lifecycle
// event for their own assignment. Server stores the moment + captured GPS.
export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  const ops = role === "OPERATOR" || role === "ADMIN";
  const ownGuideId = session?.user?.guideId;

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    type: z.enum(TYPES),
    lat: z.number().optional(), lng: z.number().optional(), accuracyM: z.number().int().optional(),
    // Operators only: record this for a guide who cannot do it themselves. Some
    // guides never check in, and the job then sits at "Not checked in" for ever,
    // with no start or finish time on the Tour Log and nothing to chase but the
    // guide. An operator recording it is worth far more than a permanent blank.
    forGuideId: z.string().min(1).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const onBehalf = parsed.data.forGuideId && parsed.data.forGuideId !== ownGuideId;
  if (onBehalf && !ops) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = onBehalf ? parsed.data.forGuideId! : ownGuideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { date, slotIdx, type, lat, lng, accuracyM } = parsed.data;

  // Time-gate: a tour can't be checked in / started / completed more than 90 min
  // before it starts (prevents a guide running the lifecycle days early).
  const [sh, sm] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number);
  const [yy, mm, dd] = date.split("-").map(Number);
  const startMs = Date.UTC(yy, mm - 1, dd, sh, sm) - 7 * 3600 * 1000;
  if (Date.now() < startMs - 90 * 60 * 1000) return NextResponse.json({ error: "too-early" }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: { select: { meetingLat: true, meetingLng: true, meetingRadiusM: true } } } });
  if (!assignment) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  // Geofence: distance from the meeting point, if it has coordinates + we have GPS.
  let distanceM: number | null = null, withinGeofence: boolean | null = null;
  const mp = assignment.tour;
  if (mp?.meetingLat != null && mp?.meetingLng != null && lat != null && lng != null) {
    distanceM = haversineM(lat, lng, mp.meetingLat, mp.meetingLng);
    withinGeofence = distanceM <= (mp.meetingRadiusM ?? 150);
  }

  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type, lat: lat ?? null, lng: lng ?? null, accuracyM: accuracyM ?? null, distanceM, withinGeofence,
    // NULL for a guide's own check-in (the GPS-verified case); set only when
    // an operator recorded it for them, which carries no location proof.
    recordedById: onBehalf ? (session!.user!.id ?? null) : null,
    recordedByRole: onBehalf ? (role ?? null) : null,
  } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: `checkin.${type.toLowerCase()}`, entityType: "Assignment", detail: { date, slotIdx, tourId: assignment.tourId, lat, lng } });
  return NextResponse.json({ ok: true, type });
}
