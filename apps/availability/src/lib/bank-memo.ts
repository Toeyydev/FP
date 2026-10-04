// The note to type into the bank app's memo (บันทึกช่วยจำ) when money moves, so a line on
// the bank statement can be matched to FolkOPS without opening the slip.
//
// The memo is written BEFORE the transfer, when FolkOPS has not yet numbered the payment
// (FOLK-PMT-… and FOLK-ADV-… are given when it is recorded, with its slip). So it carries
// what exists already: the Job No., the guide, the month — plus a short word for the kind of
// money. K BIZ / K PLUS keep about 30 characters; a memo that would be longer drops the
// "FOLK-" prefix first. A short job number ("0920-01") is never used: it repeats every year.
export const MEMO_MAX = 30;
export type MemoKind = "ADV" | "PAY" | "PAY+REV" | "REV" | "RFD" | "RTN";

const short = (ref: string) => ref.replace(/^FOLK-/, "");
const fit = (prefix: string, ref: string) => {
  const full = `${prefix} ${ref}`;
  return full.length <= MEMO_MAX ? full : `${prefix} ${short(ref)}`;
};
const mmdd = (date: string) => date.slice(5, 7) + date.slice(8, 10);

/** Advance to a guide for a job (one job, or several sharing one transfer). */
export function advanceMemo(jobNos: string[], guideId?: string | null): string {
  const jobs = [...new Set(jobNos.map((j) => j.trim()).filter(Boolean))].sort();
  if (jobs.length === 1) return fit("ADV", jobs[0]);
  if (jobs.length > 1 && guideId) return `ADV ${guideId} ${dateRange(jobs.map(jobDate).filter(Boolean) as string[])}`.trim();
  return fit("ADV", jobs[0] ?? "");
}

/** A guide's pay: one job by its number; several by the guide and the tour dates. */
export function payMemo(input: { guideId: string; jobs: { jobNo?: string | null; date: string }[]; withReview?: boolean }): string {
  const prefix = input.withReview ? "PAY+REV" : "PAY";
  const jobs = input.jobs.filter((j) => j.date);
  if (jobs.length === 1 && (jobs[0].jobNo ?? "").trim()) return fit(prefix, jobs[0].jobNo!.trim());
  return `${prefix} ${input.guideId} ${dateRange(jobs.map((j) => j.date))}`.trim();
}

/** A review incentive paid on its own: the guide and the month they worked. */
export const reviewMemo = (guideId: string, workMonth: string) => `REV ${guideId} ${workMonth}`;
/** Money the company pays back to a guide against an advance. */
export const refundMemo = (advanceNo: string) => fit("RFD", advanceNo);
/** For the guide: what to write when they send unused advance money back. */
export const returnMemo = (jobNo: string) => fit("RTN", jobNo);

function jobDate(jobNo: string): string | null {
  const m = /-(\d{4})(\d{2})(\d{2})-\d+$/.exec(jobNo);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function dateRange(dates: string[]): string {
  const d = [...new Set(dates)].sort();
  if (!d.length) return "";
  return d.length === 1 ? mmdd(d[0]) : `${mmdd(d[0])}-${mmdd(d[d.length - 1])}`;
}
