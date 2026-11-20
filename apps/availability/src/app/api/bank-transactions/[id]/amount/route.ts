import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { correctTransferAmount } from "@/lib/bank-transactions";
import { forbidden, refusalResponse, sessionAdmin } from "@/lib/bank-transactions-route";

export const dynamic = "force-dynamic";

const body = z.object({
  amount: z.number().positive(),
  reason: z.string().max(500),
  evidence: z.object({ url: z.string().url().max(500).nullish(), evidenceId: z.string().max(64).nullish() }),
}).strict();

// POST { amount (baht), reason, evidence } — ADMIN: the transfer's real amount from the slip or
// statement. Old and new values, the evidence and the Admin are kept in the audit.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await sessionAdmin(await auth());
  if (!admin) return forbidden();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const amountSatang = Math.round(parsed.data.amount * 100);
  if (Math.abs(parsed.data.amount * 100 - amountSatang) > 1e-6) return NextResponse.json({ error: "bad-body", reasons: ["At most two decimals"] }, { status: 400 });
  try {
    const t = await correctTransferAmount(prisma, { transactionId: (await ctx.params).id, amountSatang, reason: parsed.data.reason, evidence: parsed.data.evidence, admin });
    return NextResponse.json({ ok: true, amountSatang: t.amountSatang, amountSource: t.amountSource });
  } catch (e) { return refusalResponse(e); }
}
