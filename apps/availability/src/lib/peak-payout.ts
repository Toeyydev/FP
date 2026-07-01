import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { createExpenseAllInOne, peakEnabled } from "@/lib/peak-api";

// Account-chart values are business-specific — set in Railway, never hard-coded.
// Until they're set the payload is still built (for logging) but the codes are
// blank, so we'd never post a real expense with wrong accounts.
const ACC_FEE = process.env.PEAK_ACCT_GUIDE_FEE || "";      // expense account for guide fees
const ACC_EXP = process.env.PEAK_ACCT_EXPENSES || "";       // account for reimbursable expenses
const CONTACT_TYPE = process.env.PEAK_CONTACT_TYPE || "";   // individual-vendor contact type code
const PAY_METHOD = process.env.PEAK_PAYMENT_METHOD || "";   // bank-transfer payment method id
const VAT_TYPE = process.env.PEAK_VAT_TYPE || "";           // e.g. a "no VAT" code (tune on sandbox)

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: string) => d.replace(/-/g, ""); // 2026-06-28 -> 20260628

// Build the PEAK expense payload for a guide's transfer (1+ tours paid together).
// Pure/testable — no network. Returns the payload + the computed net paid amount.
export async function buildPayoutExpense(guideId: string, jobs: { date: string; slotIdx: number }[], paymentDate: string) {
  const u = await prisma.user.findFirst({ where: { guideId }, select: { displayName: true, fullName: true, taxId: true } });
  const name = u?.fullName || u?.displayName || guideId;
  const taxNumber = decrypt(u?.taxId) || "";
  const sheets = await prisma.jobSheet.findMany({
    where: { guideId, OR: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) },
    select: { ref: true, expenses: true, guideFee: true },
  });
  let gross = 0, wht = 0, totalExp = 0;
  const refs: string[] = [];
  for (const s of sheets) {
    const t = computeTotals((s.expenses as Expense[]) ?? [], (s.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE);
    gross += t.gross; wht += t.wht; totalExp += t.totalExpenses;
    if (s.ref) refs.push(s.ref);
  }
  const dt = ymd(paymentDate);
  const products: Record<string, unknown>[] = [
    { description: `Guide fee — ${sheets.length} tour${sheets.length === 1 ? "" : "s"}`, quantity: 1, price: r2(gross), accountCode: ACC_FEE, vatType: VAT_TYPE, withHoldingTaxAmount: r2(wht) },
  ];
  if (totalExp > 0) products.push({ description: "Reimbursable expenses", quantity: 1, price: r2(totalExp), accountCode: ACC_EXP, vatType: VAT_TYPE, withHoldingTaxAmount: 0 });
  const netPaid = r2((gross - wht) + totalExp);
  const expense: Record<string, unknown> = {
    issuedDate: dt,
    dueDate: dt,
    contact: { name, type: CONTACT_TYPE, taxNumber },
    products,
    reference: refs.join(", "),
    remark: `Folkpaths payout · ${guideId}`,
    paidPayments: { paymentDate: dt, payments: [{ paymentMethod: { id: PAY_METHOD }, amount: netPaid }] },
  };
  return { expense, netPaid, tours: sheets.length, refs };
}

// Whether the account-chart config is present (in addition to PEAK creds).
export const peakPayoutReady = !!(ACC_FEE && CONTACT_TYPE && PAY_METHOD);

// Post the payout to PEAK. Dormant until PEAK creds + account-chart config are set.
export async function postGuidePayout(guideId: string, jobs: { date: string; slotIdx: number }[], paymentDate: string): Promise<{ ok: boolean; code?: string; desc?: string }> {
  if (!peakEnabled) return { ok: false, desc: "PEAK not connected (env not set)" };
  if (!peakPayoutReady) return { ok: false, desc: "PEAK account-chart config not set (PEAK_ACCT_GUIDE_FEE / PEAK_CONTACT_TYPE / PEAK_PAYMENT_METHOD)" };
  const { expense } = await buildPayoutExpense(guideId, jobs, paymentDate);
  const r = await createExpenseAllInOne(expense);
  return { ok: r.ok, code: r.code, desc: r.desc };
}
