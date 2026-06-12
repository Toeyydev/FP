import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_COUNT } from "@/lib/slots";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// GET ?from&to — operator: the blocked time slots in a range (default next 120 days).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const from = dateRe.test(sp.get("from") || "") ? sp.get("from")! : today;
  const to = dateRe.test(sp.get("to") || "") ? sp.get("to")! : new Date(Date.now() + 7 * 3600 * 1000 + 120 * 86400_000).toISOString().slice(0, 10);
  const rows = await prisma.blockedSlot.findMany({ where: { date: { gte: from, lte: to } }, orderBy: [{ date: "asc" }, { slotIdx: "asc" }], select: { id: true, date: true, slotIdx: true, reason: true } });
  return NextResponse.json({ rows });
}

// POST { dates: [...], slotIdxs: [...], reason? } — operator blocks every (date × slot)
// combination. Idempotent: re-blocking an already-blocked slot is a no-op.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    dates: z.array(z.string().regex(dateRe)).min(1).max(400),
    slotIdxs: z.array(z.number().int().min(0).max(SLOT_COUNT - 1)).min(1).max(SLOT_COUNT),
    reason: z.string().max(200).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { dates, slotIdxs, reason } = parsed.data;

  const data = dates.flatMap((date) => [...new Set(slotIdxs)].map((slotIdx) => ({ date, slotIdx, reason: reason ?? null, createdById: session!.user!.id ?? null })));
  const res = await prisma.blockedSlot.createMany({ data, skipDuplicates: true });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "slots.blocked", entityType: "BlockedSlot", detail: { dates: dates.length, slots: slotIdxs.length, created: res.count } });
  return NextResponse.json({ ok: true, blocked: res.count });
}

// DELETE { id } OR { date, slotIdx } — unblock a slot.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (typeof body?.id === "string") {
    await prisma.blockedSlot.deleteMany({ where: { id: body.id } });
  } else if (dateRe.test(body?.date || "") && Number.isInteger(body?.slotIdx)) {
    await prisma.blockedSlot.deleteMany({ where: { date: body.date, slotIdx: body.slotIdx } });
  } else {
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
