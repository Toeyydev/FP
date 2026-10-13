import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { PROCESS_STAGES, STAGE_INFO } from "@/lib/job-process";
import { loadJobProcess } from "@/lib/job-process-server";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

// GET ?from=&to= — every job of the range with the stage it has reached in the process and
// who it is waiting for (lib/job-process). With ?guideId=&date=&slotIdx= — that one job.
// Read-only. Operators, admins and the accountant.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const q = req.nextUrl.searchParams;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  const guideId = (q.get("guideId") ?? "").trim();
  const one = (q.get("date") ?? "").trim();
  if (guideId && DATE.test(one)) {
    const slotIdx = Number(q.get("slotIdx") ?? "0");
    const jobs = await loadJobProcess(prisma, { from: one, to: one, guideId });
    return NextResponse.json({ job: jobs.find((j) => j.slotIdx === slotIdx) ?? null, stages: PROCESS_STAGES.map((s) => ({ stage: s, ...STAGE_INFO[s] })) });
  }

  const from = DATE.test(q.get("from") ?? "") ? q.get("from")! : shift(today, -30);
  const to = DATE.test(q.get("to") ?? "") ? q.get("to")! : shift(today, 14);
  if (from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 190 * 86400_000) {
    return NextResponse.json({ error: "bad-range", reasons: ["Choose a range of up to about six months, ending after it starts"] }, { status: 400 });
  }
  const jobs = await loadJobProcess(prisma, { from, to });
  const counts = Object.fromEntries(PROCESS_STAGES.map((s) => [s, jobs.filter((j) => j.stage === s).length]));
  return NextResponse.json({ from, to, today, jobs, counts, stages: PROCESS_STAGES.map((s) => ({ stage: s, ...STAGE_INFO[s] })) });
}
