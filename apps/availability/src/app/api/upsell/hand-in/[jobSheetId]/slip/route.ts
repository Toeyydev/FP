import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cashActor, only } from "@/lib/upsell/cash-access";
import { fileEvidence, type Upload } from "@/lib/evidence-file";
import { bangkokToday } from "@/lib/payments-v2/rules";

export const dynamic = "force-dynamic";

// POST (multipart: file) — the guide files the slip of one hand-in transfer for their own job;
// the transfer then cites the returned evidence id.
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const job = await prisma.jobSheet.findUnique({ where: { id: (await ctx.params).jobSheetId }, select: { guideId: true, ref: true } });
  if (!job || job.guideId !== a.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const r = await fileEvidence(form?.get("file") as unknown as Upload | null, { actorId: a.userId, date: bangkokToday(), label: `${job.ref ?? "job"} extras hand-in slip ${a.guideId}`, evidenceType: "K_BIZ_SLIP", guideId: a.guideId });
  return r.ok ? NextResponse.json({ ok: true, evidenceId: r.evidenceId }) : NextResponse.json({ error: "slip", reasons: [r.reason] }, { status: r.status });
}
