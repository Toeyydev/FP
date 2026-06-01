// 10 one-hour blocks covering the working day 08:30–18:30 (08:30, 09:30 … 17:30).
export type Slot = { idx: number; start: string; end: string; label: string };

const p = (n: number) => String(n).padStart(2, "0");

export const SLOTS: Slot[] = Array.from({ length: 10 }, (_, i) => {
  const sH = 8 + i;
  return { idx: i, start: `${p(sH)}:30`, end: `${p(sH + 1)}:30`, label: `${p(sH)}:30–${p(sH + 1)}:30` };
});

export const SLOT_COUNT = SLOTS.length;
