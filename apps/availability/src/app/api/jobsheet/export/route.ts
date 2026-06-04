import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { SLOT_TIMES } from "@/lib/slots";
import { DEFAULT_EXPENSES, DEFAULT_GUIDE_FEE, computeTotals, expenseAmount, type Expense, type GuideFee, type Booking } from "@/lib/jobsheet";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}
const BAHT = '"฿"#,##0.00';

// GET ?guideId&date&slotIdx — download the job sheet as a styled .xlsx.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  if (!ops(session.user.role) && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [u, existing, assignment] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
  ]);
  const tourId = existing?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  const sheet = existing ?? { ref: null as string | null, status: "Confirmed", bookings: [] as Booking[], expenses: DEFAULT_EXPENSES, guideFee: DEFAULT_GUIDE_FEE };
  const bookings = (sheet.bookings as Booking[]) ?? [];
  const expenses = (sheet.expenses as Expense[]) ?? [];
  const guideFee = (sheet.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE;
  const t = computeTotals(expenses, guideFee);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Job Sheet", { properties: { defaultColWidth: 16 } });
  ws.columns = [{ width: 22 }, { width: 26 }, { width: 6 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }];
  const bold = { bold: true } as const;
  const border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } } as const;
  const fill = (argb: string) => ({ type: "pattern", pattern: "solid", fgColor: { argb } } as const);
  let r = 1;
  const set = (cell: string, val: unknown, opts?: { bold?: boolean; numFmt?: string }) => {
    const c = ws.getCell(cell); c.value = val as ExcelJS.CellValue;
    if (opts?.bold) c.font = bold; if (opts?.numFmt) c.numFmt = opts.numFmt;
    return c;
  };

  // Header
  set("A1", "FOLKPATHS", { bold: true }); ws.getCell("A1").font = { bold: true, size: 16 };
  set("A2", "บริษัท โฟล์คพาธส์ จำกัด");
  set("E1", "No."); set("F1", sheet.ref ?? "");
  set("E2", "Tour ID"); set("F2", tourId, { bold: true });
  set("E3", "Guide ID"); set("F3", guideId);
  set("E4", "Status"); set("F4", sheet.status);
  ["E1", "E2", "E3", "E4"].forEach((c) => ws.getCell(c).font = bold);

  // Guide block
  r = 4;
  const guideRows: [string, string][] = [
    ["Tour Date", date], ["Time", tour?.time ?? ""], ["Tour Name", tour?.name ?? ""],
    ["Guide name", u?.fullName || u?.displayName || ""], ["Tax ID", decrypt(u?.taxId)],
    ["Address", decrypt(u?.currentAddress) || decrypt(u?.idCardAddress)], ["E-mail", u?.email ?? ""], ["Tel no.", u?.phone ?? ""],
  ];
  for (const [k, v] of guideRows) { r++; set(`A${r}`, k, { bold: true }); set(`B${r}`, v); }

  // Job Details
  r += 2;
  const jdHead = r; ws.getCell(`A${jdHead}`).value = "Job Details"; ws.mergeCells(`A${jdHead}:G${jdHead}`);
  ws.getCell(`A${jdHead}`).font = bold; ws.getCell(`A${jdHead}`).alignment = { horizontal: "center" }; ws.getCell(`A${jdHead}`).fill = fill("FFBFE3BF");
  r++;
  const jdCols = ["No.", "Name lists", "Booking No.", "Booked Pax", "Actual Pax", "Tickets", "Status"];
  jdCols.forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; c.font = bold; c.border = border; c.fill = fill("FFF4F4F4"); });
  let bookedSum = 0, actualSum = 0;
  bookings.forEach((b, i) => {
    r++; bookedSum += b.bookedPax ?? 0; actualSum += b.actualPax ?? 0;
    const vals = [i + 1, b.name, b.bookingNo, b.bookedPax, b.actualPax, b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : "", b.status];
    vals.forEach((v, ci) => { const c = ws.getCell(r, ci + 1); c.value = v as ExcelJS.CellValue; c.border = border; });
  });
  r++; set(`C${r}`, "Total", { bold: true }); set(`D${r}`, bookedSum, { bold: true }); set(`E${r}`, actualSum, { bold: true });

  // Expense
  r += 2;
  const exHead = r; ws.getCell(`A${exHead}`).value = "Expense"; ws.mergeCells(`A${exHead}:E${exHead}`);
  ws.getCell(`A${exHead}`).font = bold; ws.getCell(`A${exHead}`).alignment = { horizontal: "center" }; ws.getCell(`A${exHead}`).fill = fill("FFFFF8C4");
  r++;
  ["Description", "Price", "", "Pax", "Amount"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; c.font = bold; c.border = border; c.fill = fill("FFF4F4F4"); });
  for (const e of expenses) {
    r++;
    set(`A${r}`, e.description).border = border;
    set(`B${r}`, e.price ?? 0, { numFmt: BAHT }).border = border;
    const x = ws.getCell(`C${r}`); x.value = "×"; x.alignment = { horizontal: "center" }; x.border = border;
    set(`D${r}`, e.pax ?? null).border = border;
    set(`E${r}`, expenseAmount(e), { numFmt: BAHT }).border = border;
  }
  r++; set(`D${r}`, "Total Expenses", { bold: true }); set(`E${r}`, t.totalExpenses, { bold: true, numFmt: BAHT });

  // Guide fee
  r += 2;
  const gfHead = r; ws.getCell(`A${gfHead}`).value = "Guide"; ws.mergeCells(`A${gfHead}:G${gfHead}`);
  ws.getCell(`A${gfHead}`).font = bold; ws.getCell(`A${gfHead}`).alignment = { horizontal: "center" }; ws.getCell(`A${gfHead}`).fill = fill("FFF4D9C4");
  r++;
  ["Description", "Price", "", "Time", "WHT %", "WHT", "Net"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; c.font = bold; c.border = border; c.fill = fill("FFF4F4F4"); });
  r++;
  set(`A${r}`, "Guide Fee");
  set(`B${r}`, guideFee.price ?? 0, { numFmt: BAHT });
  ws.getCell(`C${r}`).value = "×"; ws.getCell(`C${r}`).alignment = { horizontal: "center" };
  set(`D${r}`, guideFee.time ?? 0);
  set(`E${r}`, guideFee.whtPct ?? 0);
  set(`F${r}`, t.wht, { numFmt: BAHT });
  set(`G${r}`, t.netGuideFee, { bold: true, numFmt: BAHT });

  // Summary
  r += 2;
  set(`E${r}`, "Total Expenses", { bold: true }); set(`F${r}`, t.totalExpenses, { numFmt: BAHT }); r++;
  set(`E${r}`, "Net Guide Fee", { bold: true }); set(`F${r}`, t.netGuideFee, { numFmt: BAHT }); r++;
  set(`E${r}`, "Total", { bold: true }); const tot = set(`F${r}`, t.grandTotal, { bold: true, numFmt: BAHT }); tot.fill = fill("FFBFE3BF");

  const buf = await wb.xlsx.writeBuffer();
  const fname = `${sheet.ref || `job-sheet-${guideId}-${date}`}.xlsx`;
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${fname}"`,
    },
  });
}
