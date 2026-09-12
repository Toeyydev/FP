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

  // A slot with a job on it is locked. The week grid renders it as a link to the
  // job sheet rather than a toggle — but that lock lived only in the browser, and
  // this endpoint overwrites the whole array, so anything calling the API directly
  // could drop a job the guide had already accepted without a trace.
  //
  // Only refuse when a locked slot would actually CHANGE: the client always sends
  // the full array, including the locked slots it is leaving exactly as they are.
  const assigned = await prisma.assignment.findMany({
    where: { guideId, date },
    select: { slotIdx: true },
  });
  // An out-of-range slotIdx is ignored rather than trusted: treating corrupt data
  // as a lock would refuse every future save for that day, with no way back.
  const locked = assigned.map((a) => a.slotIdx).filter((i) => i >= 0 && i < SLOT_COUNT);
  if (locked.length) {
    const current = await prisma.availability.findUnique({
      where: { guideId_date: { guideId, date } },
      select: { slots: true },
    });
    const stored = current?.slots ?? [];
    // No row yet means the guide has never marked this day: everything reads free.
    const changed = locked.filter((i) => slots[i] !== (stored[i] ?? false)).sort((a, b) => a - b);
    if (changed.length) {
      return NextResponse.json({ error: "slot-assigned", slots: changed }, { status: 409 });
    }
  }

  await prisma.availability.upsert({
    where: { guideId_date: { guideId, date } },
    create: { guideId, date, slots },
    update: { slots },
  });

  return NextResponse.json({ ok: true });
}
