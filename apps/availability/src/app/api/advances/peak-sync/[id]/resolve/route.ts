import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { mayReconcile, resolveUncertain } from "@/lib/advances/peak-reconcile";

export const dynamic = "force-dynamic";

// POST — resolve a Company ADV → PEAK item that needs reconciliation (UNCERTAIN), after a person
// has looked in PEAK (lib/advances/peak-reconcile). ADMIN / ACCOUNTANT only; reason required + audited.
//   { outcome: "FOUND", documentNo, reason }  — accepted only if PEAK's journal is exactly what was sent
//   { outcome: "NOT_IN_PEAK", reason }        — back to the sender
const body = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("FOUND"), documentNo: z.string().min(1).max(60), reason: z.string().max(500) }),
  z.object({ outcome: z.literal("NOT_IN_PEAK"), reason: z.string().max(500) }),
]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!mayReconcile(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin or the accountant can resolve a PEAK sync"] }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const { id } = await ctx.params;
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const r = await resolveUncertain(prisma, { ...parsed.data, id: decodeURIComponent(id), actor });
  if (!r.ok) return NextResponse.json({ error: "not-allowed", reasons: r.reasons, detail: r.reasons.join("\n") }, { status: r.status });
  return NextResponse.json(r);
}
