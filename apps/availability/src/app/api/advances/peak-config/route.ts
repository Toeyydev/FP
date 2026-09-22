import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import { advancePeakConfig } from "@/lib/advances/peak-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const c = advancePeakConfig();
    const ready = !!(c.advanceAccountCode && c.bankAccountCode && c.bankAccountSubId && c.bankName && c.journalTypeIds?.ADVANCE && c.journalTypeIds?.RETURN && c.journalTypeIds?.EXPENSE);
    return NextResponse.json({
      enabled: ready && process.env.PEAK_ADVANCE_AUTO_SYNC === "1",
      bank: ready ? { id: c.bankAccountSubId, name: c.bankName } : null,
      ready,
    });
  } catch {
    return NextResponse.json({ enabled: false, ready: false, bank: null });
  }
}
