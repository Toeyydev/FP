// Did a payment actually cover this job?
//
// A guide's month-level payroll (PayrollStatus) settles the jobs that existed
// when the transfer was made. A per-tour payment (TourPayment) settles exactly
// one job. The job sheet falls back from the second to the first — and that
// fallback used to ignore dates entirely, so a payroll run on 19 August marked a
// tour on 30 August as already paid, eleven days before it happened.
//
// That is the expensive direction to get wrong: a guide shown as paid for work
// they have not been paid for is a guide nobody follows up on. When coverage
// cannot be proven, this reports UNPAID so somebody checks.

/** Thailand is UTC+7 year-round, so an instant maps to a Bangkok calendar date by
 *  shifting seven hours before taking the date part. Comparing raw UTC dates would
 *  put a 00:30 Bangkok transfer on the previous day. */
const BANGKOK_OFFSET_MIN = 7 * 60;

export function bangkokDate(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + BANGKOK_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export type PayRecord = { status?: string | null; paidAt?: Date | string | null } | null | undefined;

export type Coverage = {
  paid: boolean;
  paidAt: Date | string | null;
  /** Which record settled it — the UI says "paid with the August payroll" rather
   *  than showing a bare date that looks wrong next to the tour date. */
  source: "tour" | "payroll" | null;
};

/**
 * @param tourDate  the job's date, "YYYY-MM-DD"
 * @param tourPay   the per-tour payment, if any
 * @param payroll   the guide's payroll status for the job's month, if any
 */
export function paymentCoverage(tourDate: string, tourPay: PayRecord, payroll: PayRecord): Coverage {
  // A per-tour payment names this job explicitly, so it always counts — an
  // operator settling one tour early is a deliberate act, not an inference.
  if (tourPay?.status === "PAID") {
    return { paid: true, paidAt: tourPay.paidAt ?? null, source: "tour" };
  }

  if (payroll?.status === "paid") {
    // Without a date there is nothing to check the tour against, so coverage is
    // unproven. Every code path that marks payroll paid also stamps paidAt, so
    // this is a corrupt row rather than a normal state.
    if (!payroll.paidAt) return { paid: false, paidAt: null, source: null };
    const paidOn = bangkokDate(payroll.paidAt);
    // Paid ON the tour date still counts: a same-day transfer after the tour is
    // ordinary, and the date is all the precision a payroll run carries.
    if (paidOn && paidOn >= tourDate) {
      return { paid: true, paidAt: payroll.paidAt, source: "payroll" };
    }
    return { paid: false, paidAt: null, source: null };
  }

  return { paid: false, paidAt: null, source: null };
}
