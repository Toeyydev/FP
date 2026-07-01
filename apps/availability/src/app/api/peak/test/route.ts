import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { peakConfigured, peakEnabled, peakBaseUrl, clientToken } from "@/lib/peak-api";
import { buildPayoutExpense, postGuidePayout, peakPayoutReady } from "@/lib/peak-payout";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
export const dynamic = "force-dynamic";

// GET — operator/admin only. Verify the PEAK connection: are the env creds present,
// and can we fetch a client token from PEAK right now? Surfaces PEAK's own
// resCode/resDesc so we can tune signing on first contact. Never leaks the creds.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!peakConfigured) return NextResponse.json({ configured: false, hint: "Set PEAK_CONNECT_ID and PEAK_CONNECT_KEY (and PEAK_USER_TOKEN) in Railway." });
  const t = await clientToken(true);
  return NextResponse.json({
    configured: true,
    baseUrl: peakBaseUrl,
    userTokenSet: peakEnabled,
    accountChartReady: peakPayoutReady,
    connected: t.ok,
    peakCode: t.code ?? null,
    detail: t.desc ?? null,
  });
}

// POST { guideId, jobs:[{date,slotIdx}], paymentDate, dryRun? } — build the payout
// expense payload and (unless dryRun) POST it to PEAK's sandbox to validate the
// mapping + read back the EXP- code. Operator/admin only; for Phase 2 testing.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    guideId: z.string().min(1),
    jobs: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dryRun: z.boolean().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, jobs, paymentDate, dryRun } = parsed.data;
  const preview = await buildPayoutExpense(guideId, jobs, paymentDate);
  if (dryRun) return NextResponse.json({ dryRun: true, payload: preview.expense, netPaid: preview.netPaid });
  const r = await postGuidePayout(guideId, jobs, paymentDate);
  return NextResponse.json({ posted: r.ok, code: r.code ?? null, detail: r.desc ?? null, netPaid: preview.netPaid, payload: preview.expense });
}
