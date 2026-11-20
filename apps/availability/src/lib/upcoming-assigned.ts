// Upcoming assigned jobs (owner, 2026-11-10): who is booked on which departure beyond
// the Dashboard's Tomorrow / Next 7 days. One row per departure (date · slot · tour),
// every guide on it listed with their own job sheet. Thai time throughout.

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

const iso = /^\d{4}-\d{2}-\d{2}$/;
export const bkkToday = (now = Date.now()) => new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The range asked for, or the default (tomorrow + 30 days). Null when it cannot be read. */
export function readRange(from: string | null, to: string | null, now = Date.now()): { from: string; to: string } | null {
  const f = from && iso.test(from) ? from : addDays(bkkToday(now), 1);
  const t = to && iso.test(to) ? to : addDays(f, DEFAULT_DAYS - 1);
  if ((from && !iso.test(from)) || (to && !iso.test(to)) || t < f) return null;
  if (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`) > (MAX_DAYS - 1) * 86400000) return null;
  return { from: f, to: t };
}

export type AssignedRow = { date: string; slotIdx: number; tourId: string | null; guideId: string };
export type Departure = { date: string; slotIdx: number; time: string; tourId: string; tourName: string; guides: { guideId: string; name: string }[] };

/** Rows → departures, earliest first; guides on a departure by id. */
export function groupDepartures(rows: readonly AssignedRow[], names: ReadonlyMap<string, string>, tours: ReadonlyMap<string, string>, times: readonly string[]): Departure[] {
  const m = new Map<string, Departure>();
  for (const r of rows) {
    const k = `${r.date}|${r.slotIdx}|${r.tourId ?? ""}`;
    const d = m.get(k) ?? { date: r.date, slotIdx: r.slotIdx, time: times[r.slotIdx] ?? "", tourId: r.tourId ?? "", tourName: (r.tourId && tours.get(r.tourId)) || r.tourId || "Tour not set", guides: [] };
    if (!d.guides.some((g) => g.guideId === r.guideId)) d.guides.push({ guideId: r.guideId, name: names.get(r.guideId) ?? "" });
    m.set(k, d);
  }
  return [...m.values()]
    .map((d) => ({ ...d, guides: d.guides.sort((a, b) => a.guideId.localeCompare(b.guideId)) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx || a.tourName.localeCompare(b.tourName));
}
