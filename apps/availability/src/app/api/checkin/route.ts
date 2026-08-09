import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { guideExpensesComplete } from "@/lib/jobsheet";

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
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    type: z.enum(TYPES),
    lat: z.number().optional(), lng: z.number().optional(), accuracyM: z.number().int().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, type, lat, lng, accuracyM } = parsed.data;

  // Time-gate: a tour can't be checked in / started / completed more than 90 min
  // before it starts (prevents a guide running the lifecycle days early).
  const [sh, sm] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number);
  const [yy, mm, dd] = date.split("-").map(Number);
  const startMs = Date.UTC(yy, mm - 1, dd, sh, sm) - 7 * 3600 * 1000;
  if (Date.now() < startMs - 90 * 60 * 1000) return NextResponse.json({ error: "too-early" }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: { select: { meetingLat: true, meetingLng: true, meetingRadiusM: true } } } });
  if (!assignment) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  // Expenses before Done: COMPLETE is normally recorded via POST /api/report (which
  // gates on the expense report), but this route accepts a direct COMPLETE too —
  // enforce the same rule so the gate can't be sidestepped.
  if (type === "COMPLETE") {
    const sheetGate = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { guideExpensesAt: true, guideExpenses: true } });
    if (!guideExpensesComplete(sheetGate)) return NextResponse.json({ error: "expenses-required" }, { status: 409 });
  }

  // Geofence: distance from the meeting point, if it has coordinates + we have GPS.
  let distanceM: number | null = null, withinGeofence: boolean | null = null;
  const mp = assignment.tour;
  if (mp?.meetingLat != null && mp?.meetingLng != null && lat != null && lng != null) {
    distanceM = haversineM(lat, lng, mp.meetingLat, mp.meetingLng);
    withinGeofence = distanceM <= (mp.meetingRadiusM ?? 150);
  }

  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type, lat: lat ?? null, lng: lng ?? null, accuracyM: accuracyM ?? null, distanceM, withinGeofence } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: `checkin.${type.toLowerCase()}`, entityType: "Assignment", detail: { date, slotIdx, tourId: assignment.tourId, lat, lng } });
  return NextResponse.json({ ok: true, type });
}
