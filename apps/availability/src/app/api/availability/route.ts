import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_COUNT } from "@/lib/slots";
import { guideProfileStatus, PROFILE_STATUS_SELECT } from "@/lib/profile";
import { dayOf } from "@/lib/dates";

const monthRe = /^\d{4}-\d{2}$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/availability?month=YYYY-MM
// Guides see only their own row; operators see all guides.
// Shape: { [guideId]: { [dayOfMonth]: boolean[10] } }
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!monthRe.test(month)) return NextResponse.json({ error: "bad month" }, { status: 400 });

  const isOperator = session.user.role === "OPERATOR" || session.user.role === "ADMIN";
  const rows = await prisma.availability.findMany({
    where: {
      date: { startsWith: month },
      ...(isOperator ? {} : { guideId: session.user.guideId ?? "__none__" }),
    },
    select: { guideId: true, date: true, slots: true },
  });

  const out: Record<string, Record<number, boolean[]>> = {};
  for (const r of rows) {
    (out[r.guideId] ??= {})[dayOf(r.date)] = r.slots;
  }
  return NextResponse.json(out);
}

// PUT /api/availability  { date: "YYYY-MM-DD", slots: boolean[10] }
// A guide sets the full slot array for one of their own days.
const putSchema = z.object({
  date: z.string().regex(dateRe),
  slots: z.array(z.boolean()).length(SLOT_COUNT),
});

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.user.role !== "GUIDE" || !session.user.guideId) {
    return NextResponse.json({ error: "guides only" }, { status: 403 });
  }

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });

  const guideId = session.user.guideId;
  const { date, slots } = parsed.data;

  // Must complete account details before setting availability.
  const me = await prisma.user.findUnique({
    where: { id: session.user.id! },
    select: PROFILE_STATUS_SELECT,
  });
  if (me && !guideProfileStatus(me).complete) {
    return NextResponse.json({ error: "profile-incomplete" }, { status: 403 });
  }

  if (await prisma.blockedDate.findUnique({ where: { date } })) {
    return NextResponse.json({ error: "date-blocked" }, { status: 409 });
  }

  await prisma.availability.upsert({
    where: { guideId_date: { guideId, date } },
    create: { guideId, date, slots },
    update: { slots },
  });

  return NextResponse.json({ ok: true });
}
