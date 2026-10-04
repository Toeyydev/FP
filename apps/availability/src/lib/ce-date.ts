// Dates in FolkOPS are Gregorian (ค.ศ.). A Thai user may type the Buddhist-era year (พ.ศ.,
// +543) into a date field — "2569" for 2026 — which a Gregorian field accepts as the year
// 2569. Such a date is in the far future: a slip check reads it as "not the date on the
// slip" and the server refuses it. A year in the Buddhist-era range is turned back here.
const BE_MIN = 2400; // 1857 CE — no FolkOPS date is near it either way
const BE_MAX = 2700;

/** "2569-10-04" / "2569-10-04T22:42" → "2026-10-04…"; anything else unchanged. */
export function ceDate(value: string): string {
  const m = /^(\d{4})(-.*)?$/.exec(value ?? "");
  if (!m) return value;
  const year = Number(m[1]);
  return year >= BE_MIN && year <= BE_MAX ? `${year - 543}${m[2] ?? ""}` : value;
}

/** Whether two "YYYY-…" dates are the same day except that one was typed in พ.ศ. */
export function differsByBuddhistEra(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.slice(4, 10) !== b.slice(4, 10)) return false;
  return Math.abs(Number(a.slice(0, 4)) - Number(b.slice(0, 4))) === 543;
}
