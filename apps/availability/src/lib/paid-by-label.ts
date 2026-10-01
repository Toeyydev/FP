// How a job-sheet document names who paid an expense row.
//
// The printed PDF and the Google Doc in Drive used their own lookups that fell back to
// "Company" / "Company Direct" for anything they did not recognise — including a row
// nobody had tagged. That asserted a payer no one recorded. Both now read the SAME
// canonical value the payout and PEAK rules use (canonicalPaidBy), and a row whose payer
// is unknown says so. Display only: no calculation and no stored value changes.
//
// A payer nobody has confirmed (lib/payer-rules payerStatement) is printed as the
// proposal it is — "Guide Personal … · Suggested / รอยืนยัน" — never as a definite payer.
import { canonicalPaidBy, type PaidBy } from "@/lib/peak-sync";
import { payerStatement, type PayerRow } from "@/lib/payer-rules";

/** Shown for a blank or unrecognised Paid By — never a guessed payer. */
export const PAID_BY_UNSPECIFIED = "ยังไม่ระบุผู้จ่าย";

const FULL: Record<PaidBy, string> = {
  COMPANY_DIRECT: "Company Direct / บริษัทชำระโดยตรง",
  GUIDE_PERSONAL: "Guide Personal / มัคคุเทศก์สำรองจ่าย",
  GUIDE_ADVANCE: "Guide Advance / ชำระจากเงินทดรองจ่าย",
  UNSPECIFIED: `Not specified / ${PAID_BY_UNSPECIFIED}`,
};

// The printed sheet's narrow column: the sanctioned short forms, unchanged.
const SHORT: Record<PaidBy, string> = {
  COMPANY_DIRECT: "Company",
  GUIDE_PERSONAL: "Guide",
  GUIDE_ADVANCE: "Advance",
  UNSPECIFIED: PAID_BY_UNSPECIFIED,
};

/** Appended to a payer nobody has confirmed yet. */
export const PAID_BY_SUGGESTED = "Suggested / รอยืนยัน";

type LabelInput = string | null | undefined | PayerRow;
const statement = (v: LabelInput): { payer: PaidBy; awaiting: boolean } =>
  v != null && typeof v === "object" ? payerStatement(v) : { payer: canonicalPaidBy({ paidBy: v ?? undefined }), awaiting: false };

/** The Google Doc label ("Guide Personal / มัคคุเทศก์สำรองจ่าย"). Pass the row so an unconfirmed payer reads as suggested. */
export const paidByDocLabel = (v: LabelInput): string => {
  const s = statement(v);
  return s.awaiting ? `${FULL[s.payer]} · ${PAID_BY_SUGGESTED}` : FULL[s.payer];
};

/** The printed PDF's short label ("Guide"). Pass the row so an unconfirmed payer reads as suggested. */
export const paidByShortLabel = (v: LabelInput): string => {
  const s = statement(v);
  return s.awaiting ? `${SHORT[s.payer]} · ${PAID_BY_SUGGESTED}` : SHORT[s.payer];
};
