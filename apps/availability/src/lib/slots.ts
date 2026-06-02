// Availability slots = the actual tour departure times. Each slot is a real tour
// a guide can be assigned to.
export type Slot = { idx: number; start: string; end: string; label: string };

export const SLOT_TIMES = ["08:30", "10:00", "13:30", "14:00", "15:00", "16:30", "17:30", "18:30"];

export const SLOTS: Slot[] = SLOT_TIMES.map((t, idx) => ({ idx, start: t, end: t, label: t }));

export const SLOT_COUNT = SLOTS.length;
