import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { markTransferReviewed } from "@/lib/bank-transactions";
import { forbidden, refusalResponse, sessionAdmin } from "@/lib/bank-transactions-route";

export const dynamic = "force-dynamic";

const body = z.object({
  note: z.string().max(500),
  evidence: z.object({ url: z.string().url().max(500).nullish(), evidenceId: z.string().max(64).nullish() }).nullish(),
}).strict();

// POST { note, evidence? } — ADMIN: the transfer has been checked against its slip; clears
// NEEDS_REVIEW. Never changes a reference or invents one.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await sessionAdmin(await auth());
  if (!admin) return forbidden();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  try {
    await markTransferReviewed(prisma, { transactionId: (await ctx.params).id, note: parsed.data.note, evidence: parsed.data.evidence ?? null, admin });
    return NextResponse.json({ ok: true });
  } catch (e) { return refusalResponse(e); }
}
