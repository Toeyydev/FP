import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, cashActor, only } from "@/lib/upsell/cash-access";
import { fileEvidence, type Upload } from "@/lib/evidence-file";
import { bangkokToday } from "@/lib/payments-v2/rules";
import { uploadHandInSlip } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST (multipart: file) — the guide uploads a bank slip of their hand-in for their own job. The
// slip is filed and added to the hand-in as UNVERIFIED proof: no amount, time or reference is taken.
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const jobSheetId = (await ctx.params).jobSheetId;
  const job = await prisma.jobSheet.findUnique({ where: { id: jobSheetId }, select: { guideId: true, ref: true } });
  if (!job || job.guideId !== a.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const r = await fileEvidence(form?.get("file") as unknown as Upload | null, { actorId: a.userId, date: bangkokToday(), label: `${job.ref ?? "job"} extras hand-in slip ${a.guideId}`, evidenceType: "K_BIZ_SLIP", guideId: a.guideId });
  if (!r.ok) return NextResponse.json({ error: "slip", reasons: [r.reason] }, { status: r.status });
  return answer(async () => {
    const x = await uploadHandInSlip(prisma, { userId: a.userId, guideId: a.guideId! }, { jobSheetId, evidenceId: r.evidenceId });
    return { ok: true, slipId: x.slip.id, seq: x.slip.seq, replay: x.replay, settlementNo: x.settlementNo };
  });
}
