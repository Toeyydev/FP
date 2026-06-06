import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const TYPES = ["ARRIVE", "START", "COMPLETE"] as const;

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

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type, lat: lat ?? null, lng: lng ?? null, accuracyM: accuracyM ?? null } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: `checkin.${type.toLowerCase()}`, entityType: "Assignment", detail: { date, slotIdx, tourId: assignment.tourId, lat, lng } });
  return NextResponse.json({ ok: true, type });
}
