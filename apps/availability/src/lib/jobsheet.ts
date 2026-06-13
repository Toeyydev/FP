// Job-sheet types, the default Folkpaths expense catalogue, and the totals math.

export type Booking = {
  name: string;
  bookingNo: string;
  bookedPax: number | null;
  actualPax: number | null;
  tickets: "included" | "not" | ""; // hybrid: some bookings include tickets, some don't
  status: string;
};
export type Expense = { description: string; price: number | null; pax: number | null };
export type GuideFee = { price: number | null; time: number | null; whtPct: number | null };

// The standard items that appear on every new sheet (prices editable per job).
export const DEFAULT_EXPENSES: Expense[] = [
  { description: "Water (Inc. Guide)", price: 10, pax: null },
  { description: "Ferry (Inc. Guide)", price: 12, pax: null },
  { description: "Grand Palace", price: 500, pax: null },
  { description: "Wat Pho", price: 300, pax: null },
  { description: "Wat Arun", price: 200, pax: null },
  { description: "Lotus (Inc. Guide)", price: 10, pax: null },
  { description: "Bus (Inc. Guide)", price: 15, pax: null },
];
export const DEFAULT_GUIDE_FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };

const n = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? v : 0);

export function expenseAmount(e: Expense): number {
  return n(e.price) * n(e.pax);
}

export function computeTotals(expenses: Expense[], guideFee: GuideFee) {
  const totalExpenses = (expenses ?? []).reduce((s, e) => s + expenseAmount(e), 0);
  const gross = n(guideFee?.price) * n(guideFee?.time);
  const wht = gross * (n(guideFee?.whtPct) / 100);
  const netGuideFee = gross - wht;
  const grandTotal = totalExpenses + netGuideFee;
  return { totalExpenses, gross, wht, netGuideFee, grandTotal };
}

export const thb = (v: number) =>
  `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// FOLK-BKK-YYYYMMDD-NN  (NN = nth sheet for that tour date)
export function makeRef(date: string, seq: number) {
  return `FOLK-BKK-${date.replace(/-/g, "")}-${String(seq).padStart(2, "0")}`;
}

// Apply a guide's reported attendance to a job sheet: remove `absent` guests
// (no-show + left-early) from the booking rows — taking them from the largest
// groups first — then re-sync the attraction (Grand Palace / Wat Pho / Wat Arun)
// ticket expenses to who actually showed up. The fixed guide fee is untouched.
const ATTRACTION_PREFIXES = ["grand palace", "wat pho", "wat arun"];
export function applyReportedAttendance(bookings: Booking[], expenses: Expense[], absent: number): { bookings: Booking[]; expenses: Expense[] } {
  const rows = bookings.map((b) => ({ ...b, actualPax: b.actualPax ?? b.bookedPax ?? 0 }));
  let remaining = Math.max(0, Math.floor(absent));
  while (remaining > 0) {
    let idx = -1, max = 0;
    rows.forEach((b, i) => { const p = b.actualPax ?? 0; if (p > max) { max = p; idx = i; } });
    if (idx < 0) break; // nobody left to remove
    rows[idx].actualPax = (rows[idx].actualPax ?? 0) - 1;
    remaining--;
  }
  const inclPax = rows.reduce((s, b) => s + (b.tickets === "included" ? (b.actualPax ?? 0) : 0), 0);
  const newExpenses = expenses.map((e) =>
    ATTRACTION_PREFIXES.some((a) => (e.description ?? "").trim().toLowerCase().startsWith(a)) ? { ...e, pax: inclPax } : e,
  );
  return { bookings: rows, expenses: newExpenses };
}
