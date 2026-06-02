import { SLOTS } from "./slots";

export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MON = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => String(n).padStart(2, "0");

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function mkey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function parseYMD(s: string): Date {
  const [y, m, da] = s.split("-").map(Number);
  return new Date(y, m - 1, da);
}
export function dayOf(s: string): number {
  return Number(s.slice(8, 10));
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
export function weekStart(d: Date): Date {
  const x = new Date(d);
  const wd = (x.getDay() + 6) % 7; // Monday-based
  x.setDate(x.getDate() - wd);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

// --- Asia/Bangkok awareness ---------------------------------------------
// The board operates on Bangkok civil dates. We derive "today" and the
// current slot from Bangkok wall-clock regardless of the device timezone.
function bangkokParts(): { y: number; m: number; d: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour === "24" ? "0" : parts.hour), min: Number(parts.minute),
  };
}

export function todayD(): Date {
  const { y, m, d } = bangkokParts();
  return new Date(y, m - 1, d); // local Date at the Bangkok civil date, midnight
}

// Highlight the most recent departure that has started (until the next one).
export function currentSlotIdx(): number {
  const { h, min } = bangkokParts();
  const mins = h * 60 + min;
  let idx = -1;
  for (let i = 0; i < SLOTS.length; i++) {
    const [hh, mm] = SLOTS[i].start.split(":").map(Number);
    if (mins >= hh * 60 + mm) idx = i; else break;
  }
  return idx;
}
