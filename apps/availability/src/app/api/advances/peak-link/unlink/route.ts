import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { unlinkPeakDocument } from "@/lib/advances/peak-link";

export const dynamic = "force-dynamic";

// POST — remove a manual PEAK link that named the wrong document (lib/advances/peak-link
// unlinkPeakDocument). Admin only, like recording one; a reason is required and audited.
// It never touches PEAK and never re-queues the movement for sending.
const body = z.object({ kind: z.enum(["ADVANCE", "RETURN", "EXPENSE"]), sourceId: z.string().min(1), reason: z.string().max(500) });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can remove a PEAK document link"] }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const result = await unlinkPeakDocument(prisma, { ...parsed.data, actor });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
