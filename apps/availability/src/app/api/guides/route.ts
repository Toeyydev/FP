import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }

// GET — operator guide directory: each active guide with languages, tour count,
// and current-week leave.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const [guides, assigns, leaves] = await Promise.all([
    prisma.user.findMany({ where: { role: "GUIDE", state: "ACTIVE", guideId: { not: null } }, select: { id: true, guideId: true, displayName: true, languages: true, lastSeenAt: true, offerBlocked: true, email: true, fullName: true, phone: true, taxId: true, currentAddress: true } }),
    prisma.assignment.groupBy({ by: ["guideId"], _count: { _all: true } }),
    prisma.leaveRequest.findMany({ where: { status: "APPROVED", toDate: { gte: today } }, select: { guideId: true, fromDate: true, toDate: true } }),
  ]);
  const tours = new Map(assigns.map((a) => [a.guideId, a._count._all]));
  const leaveOf = (gid: string) => leaves.find((l) => l.guideId === gid);

  const rows = guides.map((g) => {
    const l = leaveOf(g.guideId!);
    return { id: g.id, guideId: g.guideId, name: g.displayName, languages: g.languages ?? "", tours: tours.get(g.guideId!) ?? 0, leave: l ? `${l.fromDate}${l.toDate !== l.fromDate ? `–${l.toDate}` : ""}` : null, lastSeenAt: g.lastSeenAt ?? null, offerBlocked: g.offerBlocked, email: g.email, fullName: g.fullName ?? "", phone: g.phone ?? "", taxId: decrypt(g.taxId), address: decrypt(g.currentAddress) };
  }).sort((a, b) => b.tours - a.tours);
  return NextResponse.json({ rows });
}

// PATCH { id, offerBlocked } — operator blocks/unblocks a guide from job offers.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    id: z.string().min(1),
    offerBlocked: z.boolean().optional(),
    email: z.string().email().optional(), fullName: z.string().max(160).optional(),
    phone: z.string().max(40).optional(), taxId: z.string().max(60).optional(), address: z.string().max(300).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  const data: Record<string, unknown> = {};
  if (d.offerBlocked !== undefined) data.offerBlocked = d.offerBlocked;
  if (d.fullName !== undefined) data.fullName = d.fullName.trim() || null;
  if (d.phone !== undefined) data.phone = d.phone.trim() || null;
  if (d.taxId !== undefined) data.taxId = d.taxId.trim() ? encrypt(d.taxId.trim()) : null;
  if (d.address !== undefined) data.currentAddress = d.address.trim() ? encrypt(d.address.trim()) : null;
  if (d.email !== undefined) {
    const email = d.email.toLowerCase().trim();
    const clash = await prisma.user.findFirst({ where: { email, id: { not: d.id } }, select: { id: true } });
    if (clash) return NextResponse.json({ error: "email-in-use", hint: "That email is already used by another account." }, { status: 400 });
    data.email = email;
  }
  const u = await prisma.user.update({ where: { id: d.id }, data, select: { guideId: true } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: d.offerBlocked !== undefined ? (d.offerBlocked ? "guide.offerBlocked" : "guide.offerUnblocked") : "guide.profileEdited", entityType: "User", entityId: d.id, detail: { guideId: u.guideId } });
  return NextResponse.json({ ok: true });
}
