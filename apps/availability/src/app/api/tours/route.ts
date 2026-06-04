import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// GET — all tours with their info (operator).
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tours = await prisma.tour.findMany({ orderBy: { id: "asc" } });
  return NextResponse.json({ tours });
}

// POST { id, meetingPoint?, itinerary?, included?, bring?, durationMin? } — operator edits tour info.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    id: z.string().min(1),
    name: z.string().max(160).optional(),
    meetingPoint: z.string().max(500).optional(),
    itinerary: z.string().max(4000).optional(),
    included: z.string().max(1000).optional(),
    bring: z.string().max(1000).optional(),
    durationMin: z.number().int().min(0).max(720).nullable().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id, ...rest } = parsed.data;
  const tour = await prisma.tour.update({ where: { id }, data: rest });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "tour.updated", entityType: "Tour", entityId: id });
  return NextResponse.json({ ok: true, tour });
}
