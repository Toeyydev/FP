// The two steps of an advance's life that need no judgement, done without a click.
//
// A person still decides everything that is a decision: that an advance was issued (with
// its slip), who paid for each row, that the job sheet is right (approval), and that money
// a guide says they returned really reached the bank. What follows from those decisions is
// arithmetic, and was a button only because someone had to press it:
//
//   * a job sheet is approved   → the rows a person confirmed as paid from one of the job's
//                                 advances, and linked to it, are settled against it
//   * a return is confirmed     → if the guide said which advance it repays, it is put
//                                 against that advance, up to what the advance still holds
//
// Both go through the ordinary services (lib/advances/service), with every check those
// make — nothing here writes to the ledger by itself, and nothing is forced: whatever the
// service refuses stays undone and is reported, exactly as the button would have reported
// it. Anything left over (an excess return, a row no advance covers) waits for a person.
import type { PrismaClient } from "@prisma/client";
import { expenseAmount, isApproved, isReviewExpense } from "@/lib/jobsheet";
import { effectivePayer } from "@/lib/payer-rules";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { categoryAllowed } from "./categories";
import { advanceWritesFrozen } from "./freeze";
import { fromSatang } from "./rules";
import { allocateReceipt, settleFromExpenses, type Actor } from "./service";
import type { SheetRow } from "./settlement";
import { summariesFor } from "./summaries";

export type AutoSettled = { advanceNo: string; ok: boolean; amount: number; rows: number; reasons: string[] };

/** The rows of a sheet that are ready to be settled against this advance — the ones the Settle button would offer. */
export function settleableRows(rows: readonly SheetRow[], advance: { id: string; allowedCategories?: readonly string[] | null }): { index: number; identity: string }[] {
  const counts = new Map<string, number>();
  for (const r of rows) { const id = financialIdentity(r); counts.set(id, (counts.get(id) ?? 0) + 1); }
  const out: { index: number; identity: string }[] = [];
  rows.forEach((row, index) => {
    if (isReviewExpense(row) || row.advanceSettlement) return;
    if ((row.advanceId ?? "") !== advance.id) return;
    if (!(expenseAmount(row) > 0)) return;
    const { payer, basis } = effectivePayer(row);
    if (payer !== "GUIDE_ADVANCE" || (basis !== "OPERATOR" && basis !== "GUIDE")) return;
    if (!categoryAllowed(advance, row)) return;
    const identity = financialIdentity(row);
    // Two rows that read the same cannot be told apart; the service refuses them, so a
    // person has to make them distinct. Left out here rather than failing the rest.
    if ((counts.get(identity) ?? 0) > 1) return;
    out.push({ index, identity });
  });
  return out;
}

/**
 * Settle an approved job sheet's advance rows. Called right after approval (and after a
 * save of a sheet that is already approved). Does nothing for a sheet that is not approved
 * or a job with no live advance. Never throws: a failure here must not undo the approval.
 */
export async function autoSettleSheet(prisma: PrismaClient, job: { guideId: string; date: string; slotIdx: number }, actor: Actor): Promise<AutoSettled[]> {
  if (advanceWritesFrozen()) return [];
  const out: AutoSettled[] = [];
  try {
    const advances = await prisma.guideAdvance.findMany({ where: { guideId: job.guideId, date: job.date, slotIdx: job.slotIdx, reversedAt: null }, orderBy: { advanceNo: "asc" } });
    for (const advance of advances) {
      // Re-read each time: settling one advance rewrites the sheet's rows and moves its version.
      const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: job }, select: { id: true, expenses: true, approvalStatus: true, updatedAt: true } });
      if (!sheet || !isApproved(sheet.approvalStatus)) return out;
      const lines = settleableRows((sheet.expenses as unknown as SheetRow[]) ?? [], advance);
      if (!lines.length) continue;
      const res = await settleFromExpenses(prisma, { advanceId: advance.id, jobSheetId: sheet.id, sheetVersion: sheet.updatedAt.toISOString(), lines, actor });
      out.push(res.ok
        ? { advanceNo: advance.advanceNo, ok: true, amount: fromSatang(res.amountSatang), rows: lines.length, reasons: [] }
        : { advanceNo: advance.advanceNo, ok: false, amount: 0, rows: lines.length, reasons: res.reasons });
    }
  } catch (e) {
    out.push({ advanceNo: "", ok: false, amount: 0, rows: 0, reasons: [`Settling the advance automatically failed: ${String((e as Error).message).slice(0, 200)}`] });
  }
  return out;
}

export type AutoAllocated = { advanceNo: string; ok: boolean; amount: number; left: number; reasons: string[] } | null;

/**
 * Put a confirmed return against the advance the guide said it repays. Only when the return
 * names one — a return with no advance on it is left for a person to allocate. Allocates up
 * to what the advance still holds; anything beyond that is an excess, which is refunded to
 * the guide through its own two-step process and is never allocated away.
 */
export async function autoAllocateReturn(prisma: PrismaClient, receiptId: string, actor: Actor): Promise<AutoAllocated> {
  if (advanceWritesFrozen()) return null;
  try {
    const receipt = await prisma.guideAdvanceReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.status !== "VERIFIED" || !receipt.advanceId) return null;
    const advance = await prisma.guideAdvance.findUnique({ where: { id: receipt.advanceId } });
    if (!advance || advance.reversedAt || advance.guideId !== receipt.guideId) return null;
    const free = receipt.amountSatang - receipt.allocatedSatang - (receipt.refundedSatang ?? 0);
    const summary = (await summariesFor(prisma, [advance])).get(advance.id);
    const outstanding = summary && summary.status !== null && summary.driftSatang === 0 ? summary.outstanding : 0;
    const amountSatang = Math.min(free, outstanding);
    if (!(amountSatang > 0)) return null;
    const res = await allocateReceipt(prisma, { receiptId, allocations: [{ advanceId: advance.id, amount: fromSatang(amountSatang) }], requestKey: `auto-allocate:${receiptId}`, actor });
    return res.ok
      ? { advanceNo: advance.advanceNo, ok: true, amount: fromSatang(amountSatang), left: fromSatang(free - amountSatang), reasons: [] }
      : { advanceNo: advance.advanceNo, ok: false, amount: 0, left: fromSatang(free), reasons: res.reasons };
  } catch (e) {
    return { advanceNo: "", ok: false, amount: 0, left: 0, reasons: [`Allocating the return automatically failed: ${String((e as Error).message).slice(0, 200)}`] };
  }
}
