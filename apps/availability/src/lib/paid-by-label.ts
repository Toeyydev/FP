// How a job-sheet document names who paid an expense row.
//
// The printed PDF and the Google Doc in Drive used their own lookups that fell back to
// "Company" / "Company Direct" for anything they did not recognise — including a row
// nobody had tagged. That asserted a payer no one recorded. Both now read the SAME
// canonical value the payout and PEAK rules use (canonicalPaidBy), and a row whose payer
// is unknown says so. Display only: no calculation and no stored value changes.
import { canonicalPaidBy, type PaidBy } from "@/lib/peak-sync";

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

/** The Google Doc label ("Guide Personal / มัคคุเทศก์สำรองจ่าย"). */
export const paidByDocLabel = (paidBy?: string | null): string => FULL[canonicalPaidBy({ paidBy: paidBy ?? undefined })];

/** The printed PDF's short label ("Guide"). */
export const paidByShortLabel = (paidBy?: string | null): string => SHORT[canonicalPaidBy({ paidBy: paidBy ?? undefined })];
