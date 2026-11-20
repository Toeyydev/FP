import type { Prisma, PrismaClient } from "@prisma/client";

// The cash a guide holds for Folkpaths on one job — read from the custody ledger
// (CashCustodyEntry), the single source of truth (owner, 19 Nov 2026). Never added up from
// payments or sales: the ledger is what the database keeps balanced (trigger
// cash_custody_insert_guard) and what settlement clears.
//
// Company cash is kept apart from everything the guide is paid or reimbursed: nothing here
// reads or writes JobSheet expenses, guide payments or the Company ADV ledger.

type Db = PrismaClient | Prisma.TransactionClient;

/** Not sent yet, or where the guide's hand-in for this job stands (CashSettlement, PR4). */
export type RemittanceStatus = "NOT_SENT" | "DRAFT" | "SUBMITTED" | "RETURNED" | "CONFIRMED" | "REVERSED";

export type JobCash = {
  heldSatang: number;     // Σ custody entries for (guide, job)
  toRemitSatang: number;  // what is still to be handed in: the ledger balance (deductions arrive in later PRs)
  remitBy: "BANK_TRANSFER";
  remitWhen: "END_TOUR_REPORT";
  status: RemittanceStatus;
};

export async function jobCash(db: Db, guideId: string, jobSheetId: string): Promise<JobCash> {
  const [sum, settlement] = await Promise.all([
    db.cashCustodyEntry.aggregate({ where: { custodianId: guideId, sourceJobSheetId: jobSheetId }, _sum: { amountSatang: true } }),
    db.cashSettlement.findUnique({ where: { guideId_sourceJobSheetId: { guideId, sourceJobSheetId: jobSheetId } }, select: { status: true } }),
  ]);
  const held = sum._sum.amountSatang ?? 0;
  return {
    heldSatang: held,
    toRemitSatang: held,
    remitBy: "BANK_TRANSFER",
    remitWhen: "END_TOUR_REPORT",
    status: (settlement?.status as RemittanceStatus | undefined) ?? "NOT_SENT",
  };
}
