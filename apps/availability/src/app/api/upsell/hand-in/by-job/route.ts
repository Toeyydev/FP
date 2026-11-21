import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, cashActor, only } from "@/lib/upsell/cash-access";
import { handInView } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// GET ?guideId&date&slotIdx — the Extras cash of one job as staff see it on the Job Sheet: the sales
// (Sale Ref), the Job Ref, the Hand-in Ref, where the cash is, the dates and the slips. Finance
// roles read only (Admin, operator, accountant); 404 while Extras is off. Acting on it stays on
// Finance › Extras cash.
export async function GET(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  const q = req.nextUrl.searchParams;
  const guideId = q.get("guideId") ?? "", date = q.get("date") ?? "", slotIdx = Number(q.get("slotIdx"));
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0) {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  const job = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true, guideId: true } });
  if (!job) return NextResponse.json({ jobSheetId: null, view: null }, { headers: { "cache-control": "no-store" } });
  return answer(async () => ({ jobSheetId: job.id, view: await handInView(prisma, job.guideId, job.id) }));
}
