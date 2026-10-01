import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { settleFromExpenses } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// The request names the job sheet, the version of it the operator was looking at, and the
// rows — each by its position AND what it says (lib/advances/settlement). It never carries
// an amount or a total: the server works those out from the rows. `requestKey` is optional;
// when sent it must be the one the server computes for this request (settle:{advance}:
// {sheet}:{version}:{hash of the rows}), so a retry replays instead of writing twice.
const body = z.object({
  jobSheetId: z.string().min(1),
  sheetVersion: z.string().datetime(),
  lines: z.array(z.object({ index: z.number().int().min(0).max(99), identity: z.string().min(1).max(1000) })).min(1).max(40),
  requestKey: z.string().min(8).max(200).optional(),
}).strict();

// POST — settle an advance with the job sheet rows it paid for.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const extra = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
    const reasons = extra ? ["Send only the job sheet, its version and the rows — the server works out the amount"] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "bad-body", reasons, detail: reasons.join("\n") }, { status: 400 });
  }

  const result = await settleFromExpenses(prisma, {
    advanceId: id, jobSheetId: parsed.data.jobSheetId, sheetVersion: parsed.data.sheetVersion,
    lines: parsed.data.lines, requestKey: parsed.data.requestKey ?? null,
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({
    ok: true, entryId: result.entryId, replayed: result.replayed, amount: result.amountSatang / 100,
    outstanding: result.outstandingSatang == null ? null : result.outstandingSatang / 100, status: result.status,
  });
}
