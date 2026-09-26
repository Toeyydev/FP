// Which job sheets the historical evidence campaign covers.
//
// Every job whose TOUR took place before the cutoff, by the civil date the sheet itself
// carries ("YYYY-MM-DD", Asia/Bangkok — the operating timezone every sheet is dated in).
// Not createdAt, not the moment somebody opens the page: a sheet saved today for a tour
// last month is historical work, and one saved last month for a tour next week is not.
//
// The cutoff is the campaign's definition, not a business rule. Jobs from the cutoff on
// are the normal flow's responsibility and never appear here.

export const CAMPAIGN_CUTOFF = "2026-09-26";

/** Human form of the cutoff, for the page heading. */
export const CAMPAIGN_CUTOFF_TH = "26 กันยายน 2569";

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Is this tour date inside the campaign? A malformed date is not — it is not silently in. */
export function inCampaign(tourDate: string | null | undefined): boolean {
  const d = (tourDate ?? "").trim();
  return CIVIL_DATE.test(d) && d < CAMPAIGN_CUTOFF;
}

/** The Prisma filter for the same rule. String comparison is correct for YYYY-MM-DD. */
export const campaignWhere = { date: { lt: CAMPAIGN_CUTOFF } } as const;
