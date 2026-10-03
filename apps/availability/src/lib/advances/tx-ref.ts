// One bank transfer is one advance.
//
// The bank's transaction reference identifies a transfer. Typed by a person reading a
// slip, the same reference arrives in many shapes — "TRXX 9903-1012", "trxx99031012",
// with Thai digits, with full-width characters pasted from a chat — so it is compared by
// its KEY: Thai digits to ASCII, Unicode compatibility forms folded, everything that is
// not a letter or a digit dropped, upper case.
//
// The database derives the same key (folk_tx_ref_key, migration 20261004090000) on every
// insert and every change of txRef, and a partial unique index over LIVE advances makes a
// second advance for one transfer impossible — across jobs, sessions, days, and two
// requests arriving at the same moment. This file is how the app asks first, so it can
// say which advance already holds the transfer instead of failing on a constraint.
//
// A reversed advance leaves the index: a transfer recorded against the wrong guide is
// reversed, then recorded again correctly.
import type { Prisma, PrismaClient } from "@prisma/client";

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
// Kept free of server modules: the slip-check panel imports this file in the browser.
const fromSatang = (s: number) => Math.round(s) / 100;

/** The transfer's identity, or null when nothing identifying is left. Mirrors folk_tx_ref_key in SQL. */
export function txRefKey(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const ascii = [...ref].map((c) => { const i = THAI_DIGITS.indexOf(c); return i >= 0 ? String(i) : c; }).join("");
  const key = ascii.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return key || null;
}

/** The advance that already holds a transfer, as the 409 names it. */
export type ExistingAdvance = {
  id: string; advanceNo: string; guideId: string; jobNo: string | null;
  advanceDate: string; amount: number; txRef: string | null;
};

export const DUPLICATE_TRANSFER = "DUPLICATE_BANK_REFERENCE";

type Db = Pick<PrismaClient, "guideAdvance"> | Pick<Prisma.TransactionClient, "guideAdvance">;

/** The live advance recorded for this transfer, if any. */
export async function liveAdvanceForTransfer(db: Db, ref: string | null | undefined): Promise<ExistingAdvance | null> {
  const key = txRefKey(ref);
  if (!key) return null;
  const a = await db.guideAdvance.findFirst({
    where: { txRefKey: key, reversedAt: null },
    select: { id: true, advanceNo: true, guideId: true, jobNo: true, advanceDate: true, amountSatang: true, txRef: true },
  });
  return a ? { id: a.id, advanceNo: a.advanceNo, guideId: a.guideId, jobNo: a.jobNo, advanceDate: a.advanceDate, amount: fromSatang(a.amountSatang), txRef: a.txRef } : null;
}

const baht = (n: number) => `฿${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Why the new record is refused, in Thai and English. When the amount or date differ
 * from what is on record, it says so: that is a typo in one of the two, not a second
 * transfer.
 */
export function duplicateTransferReasons(existing: ExistingAdvance, attempted: { amount?: number | null; advanceDate?: string | null }): string[] {
  const where = `${existing.advanceNo} (${existing.guideId}${existing.jobNo ? ` · ${existing.jobNo}` : ""} · ${existing.advanceDate} · ${baht(existing.amount)})`;
  const reasons = [
    `รายการโอนนี้ถูกบันทึกเป็นเงินทดรองแล้ว: ${where} — หนึ่งการโอนบันทึกได้ครั้งเดียว`,
    `This bank transfer is already recorded as advance ${where}. One transfer can be recorded once.`,
  ];
  const differs: string[] = [];
  if (attempted.amount != null && Math.round(attempted.amount * 100) !== Math.round(existing.amount * 100)) differs.push(`amount ${baht(attempted.amount)} vs ${baht(existing.amount)}`);
  if (attempted.advanceDate && attempted.advanceDate !== existing.advanceDate) differs.push(`date ${attempted.advanceDate} vs ${existing.advanceDate}`);
  if (differs.length) reasons.push(`The same reference was entered with a different ${differs.join(" and ")} — check the slip: one of the two was typed wrong. ยอดหรือวันที่ไม่ตรงกับรายการเดิม ให้ตรวจ slip อีกครั้ง`);
  reasons.push("If the existing advance is wrong (for example, the wrong guide), reverse it with a reason on Payments → Advances, then record the transfer again. ถ้ารายการเดิมผิด ให้กลับรายการ (reverse) พร้อมเหตุผลก่อน แล้วจึงบันทึกใหม่");
  return reasons;
}

/** The body every endpoint answers a duplicate transfer with (HTTP 409). */
export function duplicateTransferBody(existing: ExistingAdvance, attempted: { amount?: number | null; advanceDate?: string | null }) {
  const reasons = duplicateTransferReasons(existing, attempted);
  return { error: "duplicate-transfer", code: DUPLICATE_TRANSFER, reasons, detail: reasons.join("\n"), hint: reasons[1], duplicateOf: existing };
}
