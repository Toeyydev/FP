// Availability slots = the actual tour departure times. Each slot is a real tour
// a guide can be assigned to.
export type Slot = { idx: number; start: string; end: string; label: string };

export const SLOT_TIMES = ["08:30", "10:00", "13:30", "14:00", "15:00", "16:30", "17:30", "18:30"];

export const SLOTS: Slot[] = SLOT_TIMES.map((t, idx) => ({ idx, start: t, end: t, label: t }));

export const SLOT_COUNT = SLOTS.length;

// Evening departures (16:00+): the China Town food tours run here; the daytime
// Grand Palace / temple tours never do. Used to reject a daytime channel default
// (e.g. "GetYourGuide" → Grand Palace) for an evening booking.
export const isEveningSlot = (idx: number | null | undefined): boolean =>
  typeof idx === "number" && idx >= 0 && idx < SLOT_TIMES.length && parseInt(SLOT_TIMES[idx], 10) >= 16;

// Two tours the SAME guide runs on one day must start at least this many minutes
// apart — a guide can't be in two places at once. Tuned to the departure grid:
// 13:30 & 14:00 are exactly 30 min apart and must never both land on one guide.
// (Distinct guides on one slot is a hybrid split, not a clash — this is per-guide.)
export const SLOT_CLASH_GAP_MIN = 30;

// Minutes-into-the-day of a slot's departure time (NaN for an unknown index).
export function slotStartMin(idx: number): number {
  const t = SLOT_TIMES[idx];
  if (!t) return NaN;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Do two slots clash for one guide? Start times within the clash gap (a slot
// always clashes with itself). Unknown indexes only clash with themselves.
export function slotsClash(a: number, b: number, gapMin: number = SLOT_CLASH_GAP_MIN): boolean {
  const sa = slotStartMin(a), sb = slotStartMin(b);
  if (Number.isNaN(sa) || Number.isNaN(sb)) return a === b;
  return Math.abs(sa - sb) <= gapMin;
}

// Every slot index that clashes with `idx` (includes idx itself) — used to find a
// guide's conflicting assignments before offering or accepting a slot.
export function clashingSlotIdxs(idx: number, gapMin: number = SLOT_CLASH_GAP_MIN): number[] {
  const out: number[] = [];
  for (let i = 0; i < SLOT_TIMES.length; i++) if (slotsClash(idx, i, gapMin)) out.push(i);
  return out;
}
