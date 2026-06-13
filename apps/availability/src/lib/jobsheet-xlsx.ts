import ExcelJS from "exceljs";
import { timeToSlot } from "@/lib/bookings";

// Parse a filled FOLKPATHS job-sheet .xlsx into structured data. Label-based:
// finds known labels and reads the value beside / below them, so it tolerates
// small layout shifts. Returns null fields when something isn't found.
export type ParsedJobSheet = {
  ref: string; tourId: string; guideId: string; status: string;
  date: string | null; slotIdx: number | null;
  bookings: { name: string; bookingNo: string; bookedPax: number | null; actualPax: number | null; tickets: "included" | "not" | "" }[];
  expenses: { description: string; price: number | null; pax: number | null }[];
  guideFee: { price: number | null; time: number | null; whtPct: number };
  guideName: string; taxId: string; address: string; tel: string;
};

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; hyperlink?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    return "";
  }
  return String(v);
}
const num = (s: string): number | null => {
  const n = parseFloat(String(s).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

async function toGrid(buf: ArrayBuffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const grid: string[][] = [];
  if (!ws) return grid;
  ws.eachRow((row, r) => {
    const vals = row.values as unknown[]; // 1-indexed
    const out: string[] = [];
    for (let c = 1; c < vals.length; c++) out[c - 1] = cellStr(vals[c]).trim();
    grid[r - 1] = out;
  });
  return grid;
}

// First non-empty cell to the right of a cell whose text contains `label`.
function rightOf(grid: string[][], label: string): string {
  const L = norm(label);
  for (const row of grid) {
    for (let c = 0; c < (row?.length ?? 0); c++) {
      if (row[c] && norm(row[c]).includes(L)) {
        for (let cc = c + 1; cc < row.length; cc++) if (row[cc]) return row[cc];
      }
    }
  }
  return "";
}
// Row index + column map for a table whose header row contains all `headers`.
function findHeader(grid: string[][], headers: string[]): { row: number; cols: Record<string, number> } | null {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const cols: Record<string, number> = {};
    for (const h of headers) {
      const idx = row.findIndex((cell) => cell && norm(cell).includes(norm(h)));
      if (idx >= 0) cols[h] = idx;
    }
    if (Object.keys(cols).length === headers.length) return { row: r, cols };
  }
  return null;
}

// "13.30 PM" / "1.30 PM" / "13:30" -> "HH:MM"
function parseTime(s: string): string | undefined {
  const m = s.match(/(\d{1,2})[.:](\d{2})/);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = m[2];
  if (/pm/i.test(s) && h < 12) h += 12;
  if (/am/i.test(s) && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}
function parseDate(s: string): string | null {
  const dmy = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); // 13/06/2026
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const ymd = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
const ticketKind = (s: string): "included" | "not" | "" => {
  const v = norm(s);
  if (!v) return "";
  if (v.includes("incl") && !v.includes("not")) return "included";
  if (v.includes("not")) return "not";
  return "";
};

export async function parseJobSheetXlsx(buf: ArrayBuffer): Promise<ParsedJobSheet> {
  const grid = await toGrid(buf);

  const ref = rightOf(grid, "No.") || rightOf(grid, "ref");
  const tourId = rightOf(grid, "Tour ID");
  const guideId = rightOf(grid, "Guide ID");
  const status = rightOf(grid, "Status") || "Confirmed";
  const date = parseDate(rightOf(grid, "Tour Date"));
  const time = parseTime(rightOf(grid, "Time"));
  const slotIdx = timeToSlot(time) ?? null;
  const guideName = rightOf(grid, "Guide name");
  const taxId = rightOf(grid, "Tax ID");
  const address = rightOf(grid, "Address");
  const tel = rightOf(grid, "Tel");

  // Bookings (Job Details table)
  const bookings: ParsedJobSheet["bookings"] = [];
  const bh = findHeader(grid, ["Name", "Booking No"]);
  if (bh) {
    const c = bh.cols;
    const cName = c["Name"], cBk = c["Booking No"];
    const cBooked = (grid[bh.row] ?? []).findIndex((x) => norm(x).includes("booked"));
    const cActual = (grid[bh.row] ?? []).findIndex((x) => norm(x).includes("actual"));
    const cTick = (grid[bh.row] ?? []).findIndex((x) => norm(x).includes("ticket"));
    for (let r = bh.row + 1; r < grid.length; r++) {
      const row = grid[r] ?? [];
      const name = (row[cName] ?? "").trim();
      const bk = (row[cBk] ?? "").trim();
      if (!name && !bk) {
        // stop at the first fully-empty booking line after we've collected some
        if (bookings.length) break; else continue;
      }
      bookings.push({
        name, bookingNo: bk,
        bookedPax: cBooked >= 0 ? num(row[cBooked]) : null,
        actualPax: cActual >= 0 ? num(row[cActual]) : null,
        tickets: cTick >= 0 ? ticketKind(row[cTick]) : "",
      });
    }
  }

  // Expenses
  const expenses: ParsedJobSheet["expenses"] = [];
  const eh = findHeader(grid, ["Description", "Amount"]);
  if (eh) {
    const cDesc = eh.cols["Description"];
    const cPrice = (grid[eh.row] ?? []).findIndex((x) => norm(x) === "price" || norm(x).includes("price"));
    const cPax = (grid[eh.row] ?? []).findIndex((x) => norm(x).includes("pax"));
    for (let r = eh.row + 1; r < grid.length; r++) {
      const row = grid[r] ?? [];
      const desc = (row[cDesc] ?? "").trim();
      if (norm(desc).includes("total") ) break;
      if (!desc) { if (expenses.length) break; else continue; }
      expenses.push({ description: desc, price: cPrice >= 0 ? num(row[cPrice]) : null, pax: cPax >= 0 ? num(row[cPax]) : null });
    }
  }

  // Guide fee (the "Guide Fee" row): price, time, WHT%
  let guideFee: ParsedJobSheet["guideFee"] = { price: null, time: null, whtPct: 3 };
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const i = row.findIndex((x) => norm(x).includes("guide fee"));
    if (i >= 0) {
      const nums = row.slice(i + 1).map(num).filter((n): n is number => n != null);
      // layout: price, [time], [wht amount], [net] — first is price, the small one (<100) is the time multiplier
      const price = nums[0] ?? null;
      const time = nums.find((n, idx) => idx > 0 && n > 0 && n <= 24) ?? 1;
      const whtCell = row.find((x) => /wht/i.test(x));
      const whtPct = whtCell ? (num(whtCell) ?? 3) : 3;
      guideFee = { price, time, whtPct };
      break;
    }
  }

  return { ref, tourId, guideId, status, date, slotIdx, bookings, expenses, guideFee, guideName, taxId, address, tel };
}
