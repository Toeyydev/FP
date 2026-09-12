import { prisma } from "@/lib/db";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { createExpenseAllInOne, peakEnabled } from "@/lib/peak-api";

/** Thrown rather than returned, so a caller cannot ignore it by reading `.ok`. */
export class HistoricalSheetNotPostable extends Error {
  readonly code = "historical-sheet-not-postable";
  constructor(message: string) { super(message); this.name = "HistoricalSheetNotPostable"; }
}

// Account-chart values are business-specific — set in Railway, never hard-coded.
// Until they're set the payload is still built (for logging) but the codes are
// blank, so we'd never post a real expense with wrong accounts.
const ACC_FEE = process.env.PEAK_ACCT_GUIDE_FEE || "";      // expense account for guide fees
const ACC_EXP = process.env.PEAK_ACCT_EXPENSES || "";       // account for reimbursable expenses
const PAY_METHOD = process.env.PEAK_PAYMENT_METHOD || "";   // bank-transfer payment method id
const VAT_TYPE = process.env.PEAK_VAT_TYPE || "";           // e.g. a "no VAT" code (tune on sandbox)

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: string) => d.replace(/-/g, ""); // 2026-06-28 -> 20260628

// Build the PEAK expense payload for a guide's transfer (1+ tours paid together).
// Pure/testable — no network. Returns the payload + the computed net paid amount.
export async function buildPayoutExpense(guideId: string, jobs: { date: string; slotIdx: number }[], paymentDate: string) {
  // Only the contact id is read. The guide's name and tax id used to be fetched
  // for the name fallback; with that gone, decrypting a tax number on every payout
  // would be handling sensitive data for no purpose.
  const u = await prisma.user.findFirst({ where: { guideId }, select: { peakContactId: true } });
  const sheets = await prisma.jobSheet.findMany({
    where: { guideId, OR: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) },
    select: { ref: true, expenses: true, guideFee: true, origin: true },
  });
  // The guard that actually blocks posting. peakSyncEligibility is only consulted
  // by the job-sheet screen for display — postGuidePayout never calls it — so a
  // reason added there would change a label and nothing else. Every posting path
  // (single e-slip, batch e-slip, the manual test route) reaches PEAK through
  // this function, so refusing here refuses everywhere.
  //
  // A reconstructed sheet has no guide-submitted expenses and no verified figures;
  // posting one would book invented numbers into the ledger.
  const historical = sheets.filter((x) => x.origin === "HISTORICAL_BACKFILL");
  if (historical.length) {
    throw new HistoricalSheetNotPostable(
      `${historical.length} job sheet(s) in this payout were reconstructed from historical records and cannot be posted to PEAK`,
    );
  }
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
    // ONLY the stored PEAK Contact id. There is no name fallback, by design.
    //
    // Sending a name asks PEAK to match-or-create a contact, and the names cannot
    // match: FolkOPS holds the guide's legal name in English while the PEAK
    // contact is in Thai. So the fallback would never find the existing supplier —
    // it would create a NEW one on every payout and split the guide's ledger
    // across duplicates that then have to be merged by hand in PEAK.
    //
    // An unmapped guide is refused in postGuidePayout instead. Mapping is a
    // deliberate one-time act by an operator; it is not something to infer.
    contact: u?.peakContactId ? { id: u.peakContactId } : undefined,
    products,
    reference: refs.join(", "),
    remark: `Folkpaths payout · ${guideId}`,
    paidPayments: { paymentDate: dt, payments: [{ paymentMethod: { id: PAY_METHOD }, amount: netPaid }] },
  };
  return { expense, netPaid, tours: sheets.length, refs };
}

// Whether the posting config is present (in addition to PEAK creds). No contact
// type is needed: every payout goes to a mapped contact id, and an unmapped guide
// is refused rather than posted under a name.
export const peakPayoutReady = !!(ACC_FEE && PAY_METHOD);

/**
 * What a posting attempt must leave behind — separated from the network call so the
 * decision is testable on its own.
 *
 * The bug this exists to prevent: a refusal that produces no ref, no log and no
 * message, leaving a PAID tour with no accounting document and nobody able to say
 * why. `ok` without a code counts as a failure, because there is still nothing to
 * record against the payment.
 */
export type PeakPostOutcome = { code: string; failure: null } | { code: null; failure: string };

export function peakPostOutcome(r: { ok: boolean; code?: string; desc?: string }): PeakPostOutcome {
  if (r.ok && (r.code ?? "").trim()) return { code: r.code!.trim(), failure: null };
  return { code: null, failure: (r.desc ?? "").trim() || "PEAK returned no document number and no reason" };
}

// Post the payout to PEAK. Dormant until PEAK creds + account-chart config are set.
export async function postGuidePayout(guideId: string, jobs: { date: string; slotIdx: number }[], paymentDate: string): Promise<{ ok: boolean; code?: string; desc?: string }> {
  if (!peakEnabled) return { ok: false, desc: "PEAK not connected (env not set)" };
  if (!peakPayoutReady) return { ok: false, desc: "PEAK posting config not set (PEAK_ACCT_GUIDE_FEE / PEAK_PAYMENT_METHOD)" };
  let expense: Record<string, unknown>;
  try {
    ({ expense } = await buildPayoutExpense(guideId, jobs, paymentDate));
  } catch (e) {
    if (e instanceof HistoricalSheetNotPostable) return { ok: false, code: e.code, desc: e.message };
    throw e;
  }
  // Refuse an unmapped guide outright. Posting without a contact id would make
  // PEAK match or create one from whatever we sent — and with English names here
  // against Thai names there, that means a duplicate supplier every time.
  const contact = expense.contact as { id?: string } | undefined;
  if (!contact?.id) {
    return { ok: false, desc: `Guide ${guideId} is not mapped to a PEAK Contact. Map them on the job sheet first — payouts are never posted by name.` };
  }
  const r = await createExpenseAllInOne(expense);
  return { ok: r.ok, code: r.code, desc: r.desc };
}
