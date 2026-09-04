import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { listDepartures } from "@/lib/departure-store";
import { SLOT_TIMES } from "@/lib/slots";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

// The ops board is indexed by slot, so a departure whose time IS one of the grid
// slots gets that index and appears there. An off-grid time still sells; it just
// has no column. Derived, never asked for — an operator typing a time should not
// also have to know the slot table.
const slotFor = (time: string): number | null => {
  const i = SLOT_TIMES.indexOf(time);
  return i >= 0 ? i : null;
};

// GET /api/departures?from=&to=&tourId= — inventory with live seat counts.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = DATE.test(sp.get("from") ?? "") ? sp.get("from")! : today;
  const to = DATE.test(sp.get("to") ?? "") ? sp.get("to")! : addDays(from, 30);
  const tourId = sp.get("tourId") || undefined;

  const departures = await listDepartures({ from, to, tourId });
  return NextResponse.json({ from, to, departures });
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const createZ = z.object({
  action: z.literal("create"),
  tourId: z.string().min(1),
  date: z.string().regex(DATE),
  time: z.string().regex(TIME),
  capacity: z.number().int().min(1).max(999),
  priceAdult: z.number().min(0).max(1_000_000).nullish(),
  priceChild: z.number().min(0).max(1_000_000).nullish(),
  note: z.string().max(300).nullish(),
});

// Bulk schedule: "this tour, at these times, on these weekdays, for this range".
// The equivalent of Bokun's availability calendar, which is the single most
// tedious thing to do one departure at a time.
const generateZ = z.object({
  action: z.literal("generate"),
  tourId: z.string().min(1),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
  times: z.array(z.string().regex(TIME)).min(1).max(12),
  // 0 = Sunday … 6 = Saturday. Empty means every day.
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  capacity: z.number().int().min(1).max(999),
  skipExisting: z.boolean().default(true),
});

const updateZ = z.object({
  action: z.literal("update"),
  id: z.string().min(1),
  capacity: z.number().int().min(1).max(999).optional(),
  status: z.enum(["OPEN", "CLOSED", "CANCELLED"]).optional(),
  priceAdult: z.number().min(0).max(1_000_000).nullish(),
  priceChild: z.number().min(0).max(1_000_000).nullish(),
  note: z.string().max(300).nullish(),
});

const deleteZ = z.object({ action: z.literal("delete"), id: z.string().min(1) });

const bodyZ = z.discriminatedUnion("action", [createZ, generateZ, updateZ, deleteZ]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", detail: parsed.error.issues[0]?.message }, { status: 400 });
  const body = parsed.data;
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };

  if (body.action === "create") {
    const tour = await prisma.tour.findUnique({ where: { id: body.tourId } });
    if (!tour) return NextResponse.json({ error: "unknown-tour" }, { status: 400 });
    try {
      const d = await prisma.departure.create({
        data: {
          tourId: body.tourId, date: body.date, time: body.time, slotIdx: slotFor(body.time),
          capacity: body.capacity, priceAdult: body.priceAdult ?? null,
          priceChild: body.priceChild ?? null, note: body.note ?? null,
        },
      });
      await audit({ ...actor, action: "departure.created", entityType: "Departure", entityId: d.id, detail: { tourId: d.tourId, date: d.date, time: d.time, capacity: d.capacity } });
      return NextResponse.json({ ok: true, departure: d });
    } catch {
      // The unique index is what stops two operators creating the same trip twice.
      return NextResponse.json({ error: "duplicate", detail: "A departure already exists for that tour, date and time." }, { status: 409 });
    }
  }

  if (body.action === "generate") {
    if (body.to < body.from) return NextResponse.json({ error: "bad-range" }, { status: 400 });
    const tour = await prisma.tour.findUnique({ where: { id: body.tourId } });
    if (!tour) return NextResponse.json({ error: "unknown-tour" }, { status: 400 });

    const days = eachDate(body.from, body.to, 366);
    if (!days.length) return NextResponse.json({ error: "bad-range", detail: "Range is empty or longer than a year." }, { status: 400 });
    const wanted = body.weekdays?.length ? new Set(body.weekdays) : null;

    const rows = days
      .filter((d) => !wanted || wanted.has(new Date(`${d}T00:00:00`).getDay()))
      .flatMap((date) => body.times.map((time) => ({
        tourId: body.tourId, date, time, slotIdx: slotFor(time), capacity: body.capacity,
      })));

    // skipDuplicates leaves an existing departure — and the bookings on it —
    // completely untouched. Regenerating a schedule must never reset capacity on
    // a departure that has already sold seats.
    const res = await prisma.departure.createMany({ data: rows, skipDuplicates: body.skipExisting });
    await audit({ ...actor, action: "departure.generated", entityType: "Departure", detail: { tourId: body.tourId, from: body.from, to: body.to, times: body.times, weekdays: body.weekdays ?? "all", capacity: body.capacity, attempted: rows.length, created: res.count } });
    return NextResponse.json({ ok: true, created: res.count, attempted: rows.length, skipped: rows.length - res.count });
  }

  if (body.action === "update") {
    const before = await prisma.departure.findUnique({ where: { id: body.id } });
    if (!before) return NextResponse.json({ error: "not-found" }, { status: 404 });
    const d = await prisma.departure.update({
      where: { id: body.id },
      data: {
        ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.priceAdult !== undefined ? { priceAdult: body.priceAdult } : {}),
        ...(body.priceChild !== undefined ? { priceChild: body.priceChild } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
    });
    await audit({ ...actor, action: "departure.updated", entityType: "Departure", entityId: d.id, detail: { from: { capacity: before.capacity, status: before.status }, to: { capacity: d.capacity, status: d.status } } });
    return NextResponse.json({ ok: true, departure: d });
  }

  // delete — refused while bookings are attached. Cancelling is the safe verb:
  // it keeps the record and the guests, deletion would orphan them.
  const held = await prisma.booking.count({ where: { departureId: body.id, status: { notIn: ["CANCELLED", "IGNORED"] } } });
  if (held > 0) {
    return NextResponse.json({ error: "has-bookings", detail: `${held} live booking${held === 1 ? "" : "s"} on this departure. Cancel the departure instead of deleting it.` }, { status: 409 });
  }
  await prisma.departure.delete({ where: { id: body.id } }).catch(() => null);
  await audit({ ...actor, action: "departure.deleted", entityType: "Departure", entityId: body.id });
  return NextResponse.json({ ok: true });
}

function eachDate(from: string, to: string, max: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (d <= end && out.length < max) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return d <= end ? [] : out; // range longer than `max` is rejected, not truncated
}
