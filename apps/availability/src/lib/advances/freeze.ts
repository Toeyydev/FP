// The cutover switch.
//
// Between the moment the ledger migration runs and the moment the ledger app is live,
// the advance tables must take no new writes from anywhere: the old app cannot fill the
// ledger's columns (it does not know about them), and a return it writes to the legacy
// table would never reach the ledger. Hiding the buttons is not enough — a retry, an open
// tab, or the mobile app would still post.
//
// Set ADVANCE_WRITES_FROZEN=1 on the service and every write path below refuses with 503
// and an explanation. Reads stay open, so nobody is blind while it is on.
export const advanceWritesFrozen = () => (process.env.ADVANCE_WRITES_FROZEN ?? "").trim() === "1";

export const ADVANCE_FROZEN_MESSAGE =
  "Advances and returns are being moved to the new ledger. Recording is paused for a few minutes — nothing is lost, please try again shortly.";

/** The body every frozen write path answers with. */
export const advanceFrozenBody = { error: "advance-writes-frozen", reasons: [ADVANCE_FROZEN_MESSAGE], detail: ADVANCE_FROZEN_MESSAGE };

// ── What this build does on a database the ledger migration has already run on ──────────
//
// This version cannot write the ledger. Once the ledger tables exist, anything it wrote to
// the advance tables would be wrong: a return lands where the ledger never looks, a delete
// takes an advance and its history with it. So on a migrated database it refuses every
// advance write whether or not the switch is set — a rollback that forgets the variable
// is still safe. Checked in the database, not assumed; if the check itself fails, it
// refuses.
type RawDb = { $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T> };
let ledgerSeen = false;

export async function ledgerMigrated(db: RawDb): Promise<boolean> {
  if (ledgerSeen) return true; // a migrated database does not become un-migrated
  try {
    const rows = await db.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('"GuideAdvanceEntry"') IS NOT NULL AS present`;
    ledgerSeen = rows?.[0]?.present === true;
    return ledgerSeen;
  } catch {
    return true;
  }
}

export async function advanceWritesBlocked(db: RawDb): Promise<boolean> {
  return advanceWritesFrozen() || (await ledgerMigrated(db));
}

/** Test seam: forget what was seen. */
export const resetLedgerSeen = () => { ledgerSeen = false; };

/**
 * What the ledger says is still owed on one job, in baht — the figure this build's own
 * formula cannot produce once the ledger has moved (settlements, confirmed returns and
 * payment deductions live only there). Null when the ledger is not there.
 */
export async function ledgerOutstanding(db: RawDb, key: { guideId: string; date: string; slotIdx: number }): Promise<number | null> {
  if (!(await ledgerMigrated(db))) return null;
  const rows = await db.$queryRaw<{ satang: bigint | number | null }[]>`
    SELECT COALESCE(SUM("amountSatang" - "settledSatang"), 0) AS satang FROM "GuideAdvance"
    WHERE "guideId" = ${key.guideId} AND "date" = ${key.date} AND "slotIdx" = ${key.slotIdx} AND "reversedAt" IS NULL`;
  return Number(rows?.[0]?.satang ?? 0) / 100;
}

/** Live ledger deductions a payment carries. Reversing the payment here would not undo them. */
export async function liveLedgerDeductions(db: RawDb, paymentId: string): Promise<number> {
  if (!(await ledgerMigrated(db))) return 0;
  const rows = await db.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(*) AS n FROM "GuideAdvanceEntry"
    WHERE "type" = 'PAYMENT_DEDUCTION' AND "sourceId" = ${paymentId} AND "reversedByEntryId" IS NULL`;
  return Number(rows?.[0]?.n ?? 0);
}

/** Printed under the balance whenever it was taken from the ledger. */
export const LEDGER_BALANCE_NOTE = "Outstanding is taken from the advance ledger. The lines above are the old record and may not show every settlement, confirmed return or payment deduction.";
export const LEDGER_BALANCE_NOTE_TH = "ยอดคงค้างมาจากสมุดเงินทดรอง รายการด้านบนเป็นบันทึกเดิมและอาจไม่ครบ";

/** This version's totals, with the balance replaced by the ledger's when there is one. */
export function withLedgerBalance<T extends { outstanding: number }>(totals: T, ledger: number | null): T {
  return ledger == null ? totals : { ...totals, outstanding: ledger };
}

/**
 * Money a guide has already sent back that the ledger has not counted against an advance
 * yet: returns still being checked, and confirmed returns not yet allocated. A guide must
 * never be told to transfer this again. In baht; null when the ledger is not there.
 */
export async function ledgerPendingReturns(db: RawDb, guideId: string): Promise<number | null> {
  if (!(await ledgerMigrated(db))) return null;
  const rows = await db.$queryRaw<{ satang: bigint | number | null }[]>`
    SELECT COALESCE(SUM(CASE WHEN "status" = 'CLAIMED' THEN "amountSatang" ELSE "amountSatang" - "allocatedSatang" END), 0) AS satang
    FROM "GuideAdvanceReceipt" WHERE "guideId" = ${guideId} AND "status" IN ('CLAIMED', 'VERIFIED')`;
  return Number(rows?.[0]?.satang ?? 0) / 100;
}

/** What a guide should still transfer: the ledger balance less what they already sent. */
export const stillToReturn = (ledgerBalance: number, pending: number | null) =>
  Math.max(0, Math.round((ledgerBalance - (pending ?? 0)) * 100) / 100);
