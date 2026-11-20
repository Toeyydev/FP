import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { markTransferReviewed } from "@/lib/bank-transactions";
import { forbidden, refusalResponse, sessionAdmin } from "@/lib/bank-transactions-route";

export const dynamic = "force-dynamic";

const body = z.object({
  outcome: z.enum(["NO_REFERENCE_ON_SLIP", "CONFIRMED_ON_SLIP"]),
  note: z.string().max(500),
  evidenceId: z.string().min(1).max(64),
  expectedVersion: z.string().min(1).max(64),
}).strict();

// POST { outcome, note, evidenceId, expectedVersion } — ADMIN: checked against the slip; clears
// NEEDS_REVIEW. Never changes a reference or invents one: a slip showing a real reference for a
// "no digits" record is corrected on that record (lib/bank-transactions markTransferReviewed).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await sessionAdmin(await auth());
  if (!admin) return forbidden();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  try {
    await markTransferReviewed(prisma, { transactionId: (await ctx.params).id, outcome: parsed.data.outcome, note: parsed.data.note, evidence: { evidenceId: parsed.data.evidenceId }, expectedVersion: parsed.data.expectedVersion, admin });
    return NextResponse.json({ ok: true });
  } catch (e) { return refusalResponse(e); }
}
