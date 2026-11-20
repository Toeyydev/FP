import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { mayReconcile, retrySync } from "@/lib/advances/peak-reconcile";

export const dynamic = "force-dynamic";

// POST — "Retry now" on a FAILED Company ADV → PEAK item (lib/advances/peak-reconcile).
// ADMIN / ACCOUNTANT only. It only brings the sender's next attempt forward; it sends nothing itself.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!mayReconcile(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin or the accountant can retry a PEAK sync"] }, { status: 403 });
  const { id } = await ctx.params;
  const r = await retrySync(prisma, decodeURIComponent(id), { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null });
  if (!r.ok) return NextResponse.json({ error: "not-allowed", reasons: r.reasons, detail: r.reasons.join("\n") }, { status: r.status });
  return NextResponse.json(r);
}
