import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { confirmTaxProfile, FIXED_TREATMENT, type WhtAnswer } from "@/lib/upsell/tax-profile";

export const dynamic = "force-dynamic";

const SELECT = {
  code: true, name: true, status: true, vatRegistration: true, vatMode: true, peakDocumentKind: true, revenueRecognition: true,
  breakageOnExpiry: true, incentiveWhtMode: true, incentiveWhtPct: true, incentiveWhtBearer: true,
  fixedCostWhtMode: true, fixedCostWhtPct: true, fixedCostWhtBearer: true, confirmedAt: true,
} as const;

// GET — the upsell tax profile as the accountant answered it (or not yet), and what the system
// books regardless (finance reads).
export async function GET() {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  const t = await prisma.taxProfile.findUnique({ where: { code: "UPSELL-STD" }, select: SELECT });
  return NextResponse.json({ profile: t ? { ...t, incentiveWhtPct: t.incentiveWhtPct?.toString() ?? null, fixedCostWhtPct: t.fixedCostWhtPct?.toString() ?? null } : null, fixed: FIXED_TREATMENT });
}

// POST { code, agreeFixedTreatment, breakageOnExpiry, incentiveWht, fixedCostWht, source } — ADMIN
// records the accountant's answers and confirms the profile. Audited; frozen once confirmed.
export async function POST(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const t = await confirmTaxProfile(prisma, { userId: a.userId }, {
      code: String(b?.code ?? ""),
      agreeFixedTreatment: b?.agreeFixedTreatment === true,
      breakageOnExpiry: typeof b?.breakageOnExpiry === "boolean" ? b.breakageOnExpiry : null,
      incentiveWht: (b?.incentiveWht ?? undefined) as WhtAnswer | undefined,
      fixedCostWht: (b?.fixedCostWht ?? undefined) as WhtAnswer | undefined,
      source: String(b?.source ?? ""),
    });
    return { ok: true, code: t.code, status: t.status };
  });
}
