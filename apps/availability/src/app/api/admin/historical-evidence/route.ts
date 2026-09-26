import { NextResponse } from "next/server";
import { loadCampaign } from "@/lib/historical-evidence/service";
import { summarize, NOT_REQUIRED_REASON_TH, STATUS_LABEL_TH } from "@/lib/historical-evidence/classify";
import { CAMPAIGN_CUTOFF, CAMPAIGN_CUTOFF_TH } from "@/lib/historical-evidence/campaign";
import { requireAdmin } from "./access";

export const dynamic = "force-dynamic";

// The campaign, every job, classified. ADMIN only. Reads and nothing else: no review row,
// no audit row, no Drive, no PEAK.

export async function GET() {
  const who = await requireAdmin();
  if (!who.ok) return NextResponse.json({ error: "forbidden" }, { status: who.status });
  const jobs = await loadCampaign();
  const summary = summarize(jobs.map((j) => j.classification));
  return NextResponse.json({
    ok: true,
    cutoff: CAMPAIGN_CUTOFF,
    cutoffTh: CAMPAIGN_CUTOFF_TH,
    labels: STATUS_LABEL_TH,
    notRequiredReasons: NOT_REQUIRED_REASON_TH,
    summary,
    jobs: jobs.map((j) => {
      const c = j.classification;
      return {
        id: j.id, ref: j.ref, date: j.date, slotIdx: j.slotIdx, guideId: j.guideId, guideName: j.guideName,
        approved: j.approved, guideReported: j.guideReported, jobSheetUrl: j.jobSheetUrl,
        status: c.status, completed: c.completed, confirmed: c.confirmed, reopened: c.reopened,
        reviewed: Boolean(c.review?.current),
        firstReason: c.reasons[0] ?? null, reasonCount: c.reasons.length,
        certifiable: c.certifiable,
        certificate: c.activeCertificate,
        rowsNeedingPayer: c.rows.filter((r) => r.needsPayerConfirmation).length,
        optInCount: c.optInCount,
        firstStep: c.certificatePath[0] ?? null,
        // What any action on this job must quote back, so it is taken against the version
        // shown here and nothing newer.
        snapshotHash: c.snapshotHash,
        reviewVersion: c.review?.version ?? 0,
        reviewDecision: c.review?.decision ?? null,
        suggestedSource: c.source.suggested,
      };
    }),
  });
}
