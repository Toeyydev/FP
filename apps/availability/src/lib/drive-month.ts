// The month a document is filed under in Drive, by the date the caller files it on.
//
// Owner decision 2026-11-01: from November 2026, a year folder holding its months, so a
// new year starts a folder of its own. Earlier months stay as they were ("2026-10 October"):
// a closed month keeps the one folder its documents are already in.
export const YEAR_FOLDERS_FROM = "2026-11";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const name = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1] ?? "";

/** The folders for this date: ["2026", "11 November"], or ["2026-10 October"] before the change. */
export function driveMonth(date: string): string[] {
  if (date.slice(0, 7) >= YEAR_FOLDERS_FROM) return [date.slice(0, 4), `${date.slice(5, 7)} ${name(date)}`.trim()];
  return [`${date.slice(0, 7)} ${name(date)}`.trim()];
}
