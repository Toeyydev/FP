import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { readPeakSafety } from "@/lib/peak-switches";
import { advancePeakConfig } from "@/lib/advances/peak-sync";
import { advanceAutoSyncEnabled, advanceReconciliationMode, advanceWritesFrozen, existingPeakLinksEnabled } from "@/lib/advances/freeze";

export const dynamic = "force-dynamic";

// What the advance screens are allowed to do right now. Status only — which switches
// are on, never what the configuration holds.
export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Across both services (lib/peak-switches): what the screen may OFFER. The routes check
  // again on every write; hiding a button is never the guard.
  const safety = await readPeakSafety(prisma);
  const mode = {
    reconciliation: advanceReconciliationMode(),
    existingLinks: existingPeakLinksEnabled(),
    writesFrozen: advanceWritesFrozen(),
    autoSync: advanceAutoSyncEnabled(),
    peakState: safety.state,
    linkingAllowed: safety.linkingAllowed,
    accountingWritesAllowed: safety.accountingWritesAllowed,
  };
  try {
    const c = advancePeakConfig();
    const ready = !!(c.advanceAccountCode && c.bankAccountCode && c.bankAccountSubId && c.bankName && c.journalTypeIds?.ADVANCE && c.journalTypeIds?.RETURN && c.journalTypeIds?.EXPENSE);
    return NextResponse.json({
      enabled: ready && mode.autoSync,
      bank: ready ? { id: c.bankAccountSubId, name: c.bankName } : null,
      ready,
      ...mode,
    });
  } catch {
    return NextResponse.json({ enabled: false, ready: false, bank: null, ...mode });
  }
}
