// Job-sheet types, the default Folkpath expense catalogue, and the totals math.

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
