import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { guideId, licenseNo } — remember a guide's tour-guide licence number so the
// next job order pre-fills it. Operator/admin, or the guide for their own licence.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = z.object({ guideId: z.string().min(1), licenseNo: z.string().max(60) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, licenseNo } = parsed.data;
  if (!isOps(session.user.role) && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await prisma.user.updateMany({ where: { guideId }, data: { licenseNo: licenseNo.trim() || null } });
  return NextResponse.json({ ok: true });
}
