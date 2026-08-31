import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { SLOT_TIMES } from "@/lib/slots";
import { DEFAULT_GUIDE_FEE, defaultExpensesForTour, computeTotals, expenseAmount, expenseCategory, expenseCategoryLabel, guidePersonalTotal, isReviewExpense, jobCostBreakdown, noShowStats, reviewBelongsToJob, thb, type Expense, type GuideFee, type Booking } from "@/lib/jobsheet";
import { canViewFinance } from "@/lib/roles";
import { jobSheetTotals } from "@/lib/peak-sync";
import { bookingRef } from "@/lib/booking-ref";
import { JOB_SHEET_CERTIFIER, CERT_STATEMENT_TH, certificationDate, fmtCertDate } from "@/lib/certifier";
import { JOB_SHEET_COMPANY_INFO as CO } from "@/lib/company";
import { advanceTotals, advanceStatus, ADVANCE_STATUS_LABEL } from "@/lib/advance";
import { readFile } from "node:fs/promises";
import path from "node:path";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// Escape user-supplied values before putting them in HTML (prevents injection
// into the generated document).
function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// GET ?guideId&date&slotIdx — return a print-ready A4 job sheet (HTML) that
// auto-opens the browser's print dialog, where the operator chooses "Save as
// PDF". No PDF dependency, and Thai text renders natively via the browser.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  const auto = req.nextUrl.searchParams.get("auto") === "1";
  const qTourId = req.nextUrl.searchParams.get("tourId") || "";
  // guideId is optional: the Incoming-bookings page exports a prep sheet for a
  // slot that isn't assigned yet (bookings come straight from the live table).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  if (!canViewFinance(session.user.role) && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const isOps = ops(session.user.role);

  const [u, existing, assignment] = await Promise.all([
    guideId ? prisma.user.findUnique({ where: { guideId } }) : Promise.resolve(null),
    guideId ? prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }) : Promise.resolve(null),
    guideId ? prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }) : Promise.resolve(null),
  ]);
  const tourId = existing?.tourId || assignment?.tourId || qTourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  const sheet = existing ?? { ref: null as string | null, status: "Confirmed", bookings: [] as Booking[], expenses: defaultExpensesForTour(tour?.name), guideFee: DEFAULT_GUIDE_FEE, updatedAt: null as Date | null };
  // Certification: date = the sheet's first successful save (fallback: approval
  // time for historical sheets; blank dots when neither exists — never tour date).
  // The signature PNG is inlined as base64 so print / html2pdf can never race an
  // async image load and silently drop it; if it can't be read, say so on the
  // document instead of quietly producing an uncertified-looking sheet.
  const certDate = existing ? certificationDate(existing) : null;
  // Advance / settlement ledger for the accountant: only rendered when an advance
  // exists. Cash movements — never added into the expense or payable totals.
  const [advRows, retRows] = guideId
    ? await Promise.all([
        prisma.guideAdvance.findMany({ where: { guideId, date, slotIdx }, orderBy: { paidAt: "asc" } }),
        prisma.guideAdvanceReturn.findMany({ where: { guideId, date, slotIdx }, orderBy: { returnedAt: "asc" } }),
      ])
    : [[], []];
  let sigSrc: string | null = null;
  try {
    sigSrc = `data:image/png;base64,${(await readFile(path.join(process.cwd(), "public", JOB_SHEET_CERTIFIER.signatureFile))).toString("base64")}`;
  } catch { /* fs layout differs on the deployed container — try HTTP next */ }
  // The app can always reach its own public URL even when the fs path can't be
  // found (e.g. a different working directory in production) — self-fetch and
  // inline. Base64 keeps print/html2pdf immune to image-load races.
  if (!sigSrc) {
    try {
      const res = await fetch(new URL("/approver-signature.png", req.nextUrl.origin), { cache: "no-store" });
      if (res.ok) sigSrc = `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
    } catch { /* fall back to the plain URL <img> + client-side warning */ }
  }
  let bookings = (sheet.bookings as Booking[]) ?? [];
  // No saved sheet yet → pull the slot's live bookings so the prep PDF still
  // lists every guest (name + OTA ref + pax) for the operator to work from.
  if (bookings.length === 0) {
    const live = await prisma.booking.findMany({
      where: { date, slotIdx, ...(tourId ? { tourId } : {}), status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true },
      orderBy: { customerName: "asc" },
    });
    // Split-aware: if this slot was split across guides, a named guide's prep sheet
    // shows only their guests (plus any not-yet-tagged), so the sheets stay separated.
    const splitHere = live.some((b) => b.assignedGuideId);
    const mine = splitHere && guideId ? live.filter((b) => !b.assignedGuideId || b.assignedGuideId === guideId) : live;
    bookings = mine.map((b) => ({ name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: b.pax ?? null, tickets: "" })) as Booking[];
  }
  const expenses = (sheet.expenses as Expense[]) ?? [];
  const guideFee = (sheet.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE;
  const t = computeTotals(expenses, guideFee);
  const cost = jobCostBreakdown(expenses, guideFee, sheet.ref, bookings);
  const money = jobSheetTotals(expenses, guideFee, sheet.ref, bookings);
  // No saved sheet (e.g. exported from Incoming bookings before assignment) →
  // make the guest list, expenses and guide details fillable on the page so the
  // operator can complete the sheet by hand, with live totals, before Save-as-PDF.
  const editable = !existing;
  const ce = editable ? ' contenteditable="true"' : '';

  const time = SLOT_TIMES[slotIdx] || tour?.time || "";
  const guideName = u?.fullName || u?.displayName || "";
  const taxId = decrypt(u?.taxId);
  const address = decrypt(u?.currentAddress) || decrypt(u?.idCardAddress);
  const updated = (sheet as { updatedAt?: Date | null }).updatedAt;
  const ref = sheet.ref || `job-sheet-${guideId || tourId || "slot"}-${date}`;

  const nsStats = noShowStats(bookings);
  let bookedSum = 0, actualSum = 0, noShowSum = 0;
  let bookingRows = bookings.map((b, i) => {
    bookedSum += b.bookedPax ?? 0; actualSum += b.actualPax ?? 0;
    noShowSum += b.noShowPax ?? (b.status === "no-show" ? (b.bookedPax ?? 0) : 0);
    const tickets = b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : `<span class="strike"></span>`;
    return `<tr><td>${i + 1}</td><td${ce}>${esc(b.name)}</td><td${ce}>${esc(b.bookingNo)}</td><td class="n" data-bpax>${b.bookedPax ?? ""}</td><td class="n"${ce} data-apax>${b.actualPax ?? ""}</td><td${ce}>${tickets}</td></tr>`;
  }).join("");
  if (editable) for (let k = 0; k < 4; k++) bookingRows += `<tr><td>${bookings.length + k + 1}</td><td contenteditable="true"></td><td contenteditable="true"></td><td class="n" contenteditable="true" data-bpax></td><td class="n" contenteditable="true" data-apax></td><td contenteditable="true"></td></tr>`;

  // Paid-by (แหล่งเงินที่ใช้ชำระ): compact read-only labels — Company / Advance /
  // Guide are the sanctioned short forms; never truncated composites.
  const paidByShort = (v?: string) => (v === "advance" ? "Advance" : v === "guide" ? "Guide" : "Company");
  const expRow = (cat: string, desc: string, price: string, pax: string, unit: string, amt: string, paidBy: string) => editable
    ? `<tr data-exp><td>${cat}</td><td contenteditable="true">${desc}</td><td class="n" contenteditable="true" data-eprice>${price}</td><td class="c">×</td><td class="n" contenteditable="true" data-epax>${pax}</td><td class="c" contenteditable="true">${unit}</td><td class="n" data-eamt>${amt}</td><td class="c" contenteditable="true">${paidBy}</td></tr>`
    : `<tr><td>${cat}</td><td>${desc}</td><td class="n">${price}</td><td class="c">×</td><td class="n">${pax}</td><td class="c">${unit}</td><td class="n">${amt}</td><td class="c">${paidBy}</td></tr>`;
  // Review-reward rows are guide compensation — rendered with the Guide Fee
  // section, never inside Tour Expenses (presentation only; data unchanged).
  // An uncategorised row prints "—", never a guessed category: the printed sheet
  // must show exactly what is stored (see expenseCategory in lib/jobsheet).
  const catShort = (e: Expense) => (expenseCategory(e) ? esc(expenseCategoryLabel(e)) : "—");
  let expenseRows = expenses.filter((e) => !isReviewExpense(e)).map((e) => expRow(catShort(e), esc(e.description), e.price != null ? thb(e.price) : "", e.pax != null ? String(e.pax) : "", esc(e.unit || "คน"), thb(expenseAmount(e)), paidByShort(e.paidBy))).join("");
  if (editable) for (let k = 0; k < 3; k++) expenseRows += expRow("", "", "", "", "", "", "");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(ref)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: "Sarabun","Noto Sans Thai",-apple-system,sans-serif; color: #16201c; font-size: 12px; margin: 0; }
  .toolbar { background:#7e3a2c; color:#fff; padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }
  .toolbar button { background:#fff; color:#7e3a2c; border:none; border-radius:7px; padding:7px 14px; font-weight:600; cursor:pointer; font-size:13px; }
  .page { max-width: 800px; margin: 16px auto; padding: 0 16px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #7e3a2c; padding-bottom:10px; }
  .brand { font-size:11px; font-weight:600; letter-spacing:0.06em; color:#333; break-inside:avoid; page-break-inside:avoid; }
  .brand .co2 { font-size:8.5px; color:#6b746f; font-weight:400; letter-spacing:0; }
  .brand .co3 { font-size:8px; color:#8a8f8b; font-weight:400; letter-spacing:0; }
  .brand .doctitle { font-size:19px; font-weight:700; color:#111; margin-top:9px; letter-spacing:0.02em; }
  .brand .docref { font-size:13px; font-weight:600; color:#7e3a2c; font-family:ui-monospace,Menlo,monospace; }
  .meta { font-size:11px; }
  .meta div { margin-bottom:2px; } .meta b { display:inline-block; min-width:66px; color:#6b746f; font-weight:400; }
  .guide { display:grid; grid-template-columns:1fr 1fr; gap:2px 18px; margin:12px 0; }
  .guide div { display:flex; gap:8px; padding:3px 0; border-bottom:0.5px solid #eee; }
  .guide span { min-width:78px; color:#6b746f; }
  h3 { font-size:13px; margin:16px 0 4px; padding:5px 8px; background:#bfe3bf; border:0; border-radius:4px; }
  h3.exp { background:#fff8c4; } h3.fee { background:#f4d9c4; }
  table { width:100%; border-collapse:collapse; font-size:11.5px; }
  th, td { border:0; border-right:0.5px solid #edefed; border-bottom:0.5px solid #dfe3df; padding:5px 7px; text-align:left; }
  th:last-child, td:last-child { border-right:0; }
  tbody tr:last-child td { border-bottom:0; }
  thead th { border-bottom:1px solid #b9beb9; }
  th { background:#f4f4f4; font-weight:400; }
  td.n, th.n { text-align:right; } td.c { text-align:center; }
  .tot td { font-weight:600; background:#fafafa; border-bottom:0; }
  tr:has(+ .tot) td { border-bottom:0; }
  /* Company cost beside the transfer. Previously one fit-content column pinned to
     the right, leaving the left half of an A4 page empty. */
  .money-row { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px;
               align-items:start; break-inside:avoid; page-break-inside:avoid; }
  .summary { margin:0; width:auto; min-width:0; max-width:100%; }
  .summary > div { gap:18px; }
  .summary div { display:flex; justify-content:space-between; padding:5px 8px; }
  .summary .grand { background:#bfe3bf; font-weight:600; border-radius:4px; font-size:14px; }
  .sum-head { font-weight:700; margin-bottom:2px; padding:0 8px;
              display:flex; justify-content:space-between; }
  .summary .sub { padding:1px 8px 1px 22px; font-size:10.5px; color:#6b746f; }
  .summary .sub b { font-weight:600; color:#6b746f; }
  .summary .handoff { justify-content:flex-end; font-size:10px; color:#8a8f8b; padding-top:4px; }
  .netpay { border:1px solid #cbe5d6; background:#eef7f0; border-radius:8px; padding:10px 12px; }
  .netpay div { display:flex; justify-content:space-between; gap:14px; padding:3px 0; }
  .netpay .netpay-top { align-items:baseline; padding:0 0 7px; margin-bottom:6px;
                        border-bottom:1px solid #cbe5d6; }
  .netpay .netpay-top span { font-weight:700; font-size:13px; }
  .netpay .netpay-top b { font-size:17px; font-weight:700; color:#14532d; }
  /* Thai gloss sits under its English label, as it does everywhere else on the
     sheet — .summary already does this and .netpay must match. */
  .netpay span small { display:block; margin-left:0; }
  .netpay .note { display:block; font-size:10px; color:#6b746f; line-height:1.5;
                  padding-top:7px; margin-top:5px; border-top:1px solid #cbe5d6; }
  @media (max-width:640px){ .money-row { grid-template-columns:1fr; } }
  .prepnote { background:#fbf4e8; border:1px solid #ecd9bf; color:#7e3a2c; border-radius:8px; padding:8px 12px; font-size:11.5px; margin:14px 0 2px; }
  [contenteditable="true"] { background:#fff7e8; outline:none; border-radius:3px; min-width:18px; }
  [contenteditable="true"]:focus { background:#fff2cf; box-shadow:0 0 0 2px #e9c98a inset; }
  .guide [contenteditable="true"] { display:inline-block; min-width:120px; }
  @media print { .toolbar { display:none; } .page { margin:0; max-width:none; padding:14mm; } body { font-size:11px; } .prepnote { display:none; } [contenteditable="true"] { background:transparent; box-shadow:none; } }
  th small, .thx { display:block; font-size:8px; color:#8a8f8b; font-weight:500; line-height:1.2; }
  h3 small, .summary small, .adv small { font-size:9px; color:#8a8f8b; font-weight:500; margin-left:5px; }
  .adv, .advance-settlement { margin-top:14px; break-inside:avoid; page-break-inside:avoid; }
  .adv table td { font-size:11.5px; }
  .adv .st { font-weight:700; }

  .summary span small { display:block; margin-left:0; }
  .keep { break-inside:avoid; page-break-inside:avoid; }
  h3 { break-after:avoid-page; page-break-after:avoid; }
  .approve { margin-top:26px; border-top:1px dashed #cdd3cf; padding-top:12px; break-inside:avoid; page-break-inside:avoid; }
  .approve .certnote { font-size:10.5px; color:#5c655f; line-height:1.6; max-width:none; text-align:left; }
  .approve .sigwrap { display:flex; justify-content:flex-end; margin-top:16px; }
  .approve .sigbox { text-align:center; width:290px; }
  .approve .sigimg { height:52px; display:block; margin:0 auto -8px; user-select:none; -webkit-user-select:none; pointer-events:none; }
  .approve .sigline { margin-top:2px; }
  .approve .signame { font-weight:600; margin-top:2px; }
  .approve .sigdate { color:#6b746f; margin-top:4px; font-size:11px; }
  @media print { .approve .sigimg { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
  .strike { display:inline-block; width:60%; height:0; border-top:1.4px solid #333; vertical-align:middle; }
</style></head>
<body>
  <div class="toolbar"><span>Job sheet · ${esc(ref)}</span><span style="display:flex;gap:8px;align-items:center">${isOps ? `<span style="font-size:12px;opacity:.9">\ud83d\udcce e-slip:</span><input type="file" id="eslipInput" accept="image/*,application/pdf" onchange="eslipChosen(this)" style="background:#fff;color:#7e3a2c;border-radius:7px;padding:6px 8px;font-size:12px;max-width:210px"><span id="eslipName" style="font-size:12px;opacity:.9"></span><button id="driveBtn" onclick="shareToDrive(this)">\u2601 Share to Drive</button>` : ""}<button onclick="window.print()">Save as PDF / Print</button></span></div>
  <div class="page">
    ${editable ? `<div class="prepnote">📝 Prep sheet — no guide assigned yet. Fill in the highlighted fields, then <b>Save as PDF / Print</b>. Totals update as you type.</div>` : ""}
    <div class="head">
      <div class="brand">${esc(CO.brandName)}
        <div class="co2">Operated by ${esc(CO.operatedBy)} / ${esc(CO.legalNameTh)}</div>
        <div class="co3">Tax ID ${esc(CO.taxId)} · Tour Operator ${esc(CO.tourOperatorNameTh)} · License ${esc(CO.tourismLicenseNo)}</div>
      </div>
      <div class="meta">
        <div><b>Job No.</b> <small style="font-size:8px;color:#8a8f8b">เลขที่งาน</small> ${esc(sheet.ref || "")}</div>
        <div><b>Tour ID</b> ${esc(tourId || "—")}</div>
        <div><b>Guide ID</b> ${esc(guideId)}</div>
        <div><b>Status</b> ${esc(sheet.status)}</div>
        <div><b>Updated</b> ${updated ? esc(new Date(updated).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })) : "—"}</div>
      </div>
    </div>

    <div class="guide">
      <div><span>Tour Date</span><b>${esc(date)}</b></div>
      <div><span>Time</span><b>${esc(time)}</b></div>
      <div><span>Tour Name</span><b>${esc(tour?.name || "")}</b></div>
      <div><span>Guide Name</span><b${ce}>${esc(guideName)}</b></div>
      <div><span>Tax ID</span><span${ce}>${esc(taxId || (editable ? "" : "—"))}</span></div>
      <div><span>Address</span><span${ce}>${esc(address || (editable ? "" : "—"))}</span></div>
      <div><span>E-mail</span><span${ce}>${esc(u?.email || "")}</span></div>
      <div><span>Tel.</span><span${ce}>${esc(u?.phone || (editable ? "" : "—"))}</span></div>
    </div>

    <h3>Job Details <small>รายละเอียดงาน</small></h3>
    <table>
      <thead><tr><th>No.<small>ลำดับ</small></th><th>Guest Name<small>ชื่อผู้เดินทาง</small></th><th>Booking No.<small>เลขที่การจอง</small></th><th class="n">Booked Pax<small>จำนวนที่จอง</small></th><th class="n">Actual Pax<small>จำนวนผู้เดินทางจริง</small></th><th>Tickets<small>บัตรเข้าชม</small></th></tr></thead>
      <tbody>${bookingRows || '<tr><td colspan="6" style="color:#aaa">No bookings listed.</td></tr>'}
        <tr class="tot"><td></td><td colspan="2" style="text-align:right">Total</td><td class="n" id="bookedTot">${bookedSum}</td><td class="n" id="actualTot">${actualSum}</td><td></td></tr>
        ${nsStats.pax > 0 || nsStats.bookings > 0 ? `<tr class="tot"><td></td><td colspan="2" style="text-align:right;color:#c2604a">No-show <small>ไม่มาใช้บริการ</small></td><td class="n" colspan="2" style="color:#c2604a;white-space:nowrap">${nsStats.pax} pax · ${nsStats.bookings} booking${nsStats.bookings === 1 ? "" : "s"}</td><td></td></tr>` : ""}
      </tbody>
    </table>

    ${nsStats.pax > 0 ? `<div style="font-size:9.5px;color:#8a8f8b;margin:4px 0 0">หมายเหตุ: งานนี้มีรายการผู้เดินทางไม่มาใช้บริการ (${nsStats.pax} pax · ${nsStats.bookings} booking${nsStats.bookings === 1 ? "" : "s"}) / Note: no-show recorded for this job.</div>` : ""}

    <h3 class="exp">Tour Expenses <small>ค่าใช้จ่ายในการนำเที่ยว</small></h3>
    <table>
      <thead><tr><th style="width:104px">Expense Category<small>ประเภทค่าใช้จ่าย</small></th><th>Description<small>รายการ</small></th><th class="n">Unit Price<small>ราคาต่อหน่วย</small></th><th class="c"></th><th class="n">Qty<small>จำนวน</small></th><th class="c">Unit<small>หน่วย</small></th><th class="n">Amount<small>จำนวนเงิน</small></th><th class="c">Paid by<small>แหล่งเงินที่ใช้ชำระ</small></th></tr></thead>
      <tbody>${expenseRows}
        <tr class="tot"><td colspan="6" style="text-align:right">Total Tour Expenses <small>รวมค่าใช้จ่ายในการนำเที่ยว</small></td><td class="n" id="expTot">${thb(cost.tourExpenses)}</td><td></td></tr>
      </tbody>
    </table>

    <div class="keep">
    <h3 class="fee">Guide Fee <small>ค่าจ้างมัคคุเทศก์</small></h3>
    <table>
      <thead><tr><th>Description<small>รายการ</small></th><th class="n">Rate<small>อัตราค่าจ้าง</small></th><th class="c"></th><th class="n">Qty<small>จำนวนครั้ง</small></th><th class="n">WHT %<small>อัตราภาษีหัก ณ ที่จ่าย</small></th><th class="n">WHT<small>ภาษีหัก ณ ที่จ่าย</small></th><th class="n">Net Guide Fee<small>ค่าจ้างมัคคุเทศก์สุทธิ</small></th></tr></thead>
      <tbody>
        <tr><td>Guide Fee <small style="display:block;font-size:8px;color:#8a8f8b">ค่าจ้างมัคคุเทศก์</small></td><td class="n">${guideFee.price != null ? thb(guideFee.price) : ""}</td><td class="c">×</td><td class="n">${guideFee.time ?? ""}</td><td class="n">${guideFee.whtPct ?? 0}%</td><td class="n">${thb(t.wht)}</td><td class="n">${thb(t.netGuideFee)}</td></tr>
      </tbody>
    </table>
    ${(() => {
      const rev = expenses.filter((e) => isReviewExpense(e) && expenseAmount(e) > 0);
      if (!rev.length) return "";
      return `<h3 style="background:#efe7f3">Additional Guide Payment <small>รายการจ่ายเพิ่มเติมให้มัคคุเทศก์</small></h3>
    <table>
      <thead><tr><th>Description<small>รายการ</small></th><th>Booking No.<small>เลขที่การจองที่รีวิว</small></th><th class="n">Amount<small>จำนวนเงิน</small></th></tr></thead>
      <tbody>
        ${rev.map((e) => `<tr><td>${esc(e.description || "Review Reward")} <small>ค่าตอบแทนรีวิว</small></td><td style="white-space:nowrap">${esc(e.relatedBookingNo || e.relatedJobRef || "—")}</td><td class="n">${thb(expenseAmount(e))}</td></tr>`).join("")}
        <tr class="tot"><td colspan="2" style="text-align:right">Total Additional Payment <small>รวมรายการจ่ายเพิ่มเติม</small></td><td class="n">${thb(cost.reviewOwn + cost.reviewOther)}</td></tr>
      </tbody>
    </table>`;
    })()}
    </div>


    ${advRows.length || retRows.length ? (() => {
      const at = advanceTotals(advRows, retRows, expenses);
      const st = ADVANCE_STATUS_LABEL[advanceStatus(at, true)];
      const dt = (x: Date) => new Date(x).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
      return `<div class="adv advance-settlement"><h3>Advance / Settlement <small>การเคลียร์เงินทดรองจ่าย</small></h3>
      <table>
        <thead><tr><th>Description<small>รายการ</small></th><th style="width:120px">Date · Time<small>วันเวลาทำรายการ</small></th><th class="n" style="width:100px">Amount<small>จำนวนเงิน</small></th></tr></thead>
        <tbody>
        ${advRows.map((a) => `<tr><td>Advance Paid <small>เงินทดรองจ่ายให้มัคคุเทศก์</small>${a.txRef ? ` · ${esc(a.txRef)}` : ""}</td><td style="white-space:nowrap;color:#6b746f">${esc(dt(a.paidAt))} · ${esc(a.method)}</td><td class="n">${thb(a.amount)}</td></tr>`).join("")}
        <tr><td style="padding-left:16px">Expenses Paid from Advance <small>ค่าใช้จ่ายที่ชำระจากเงินทดรอง</small></td><td></td><td class="n">− ${thb(at.usedFromAdvance)}</td></tr>
        ${expenses.filter((e) => e.paidBy === "advance" && expenseAmount(e) > 0).map((e) => `<tr style="color:#6b746f"><td style="padding-left:30px">${esc(e.description)}</td><td></td><td class="n">${thb(expenseAmount(e))}</td></tr>`).join("")}
        ${retRows.map((a) => `<tr><td style="padding-left:16px">Advance Returned <small>เงินทดรองคงเหลือส่งคืน</small>${a.txRef ? ` · ${esc(a.txRef)}` : ""}</td><td style="white-space:nowrap;color:#6b746f">${esc(dt(a.returnedAt))} · ${esc(a.method)}</td><td class="n">− ${thb(a.amount)}</td></tr>`).join("")}
        <tr class="tot"><td colspan="2" style="text-align:right">Outstanding Advance <small>เงินทดรองจ่ายคงค้าง</small></td><td class="n">${thb(at.outstanding)}</td></tr>
        <tr><td class="st" colspan="3">Settlement Status <small>สถานะการเคลียร์เงินทดรอง</small> : ${esc(st)}</td></tr>
      </tbody></table></div>`;
    })() : ""}
    <!-- Two blocks, side by side, matching the operator screen: what the job COST
         the company on the left, what gets TRANSFERRED to the guide on the right.
         They are different questions and were previously run together into one
         column ending at "Net Pay to Guide", which invited reading the cost as the
         payment. They differ by the withholding tax and by anything the company
         settled with the vendor directly. -->
    <div class="money-row">
      <div class="summary">
        <div class="sum-head">SUMMARY <small>สรุปรายการทางการเงิน</small></div>
        <div><span>Total Tour Expenses <small>ค่าใช้จ่ายในการนำเที่ยว (ต้นทุนบริษัท)</small></span><b id="sumExp">${thb(cost.tourExpenses)}</b></div>
        ${money.reimbursementDue > 0 ? `<div class="sub"><span>of which reimbursable to guide <small>ยอดที่ต้องคืนให้มัคคุเทศก์ (สำรองจ่าย)</small></span><b>${thb(money.reimbursementDue)}</b></div>` : ""}
        ${cost.reviewOwn > 0 ? `<div><span>Review Reward <small>ค่าตอบแทนรีวิว</small></span><b>${thb(cost.reviewOwn)}</b></div>` : ""}
        <div><span>Guide Fee <small>ค่าจ้างมัคคุเทศก์</small></span><b>${thb(t.gross)}</b></div>
        <div class="sub"><span>of which withheld as tax (WHT) <small>ภาษีหัก ณ ที่จ่าย — นำส่งสรรพากร</small></span><b>${thb(t.wht)}</b></div>
        <!-- id kept on the figure the fillable prep script actually recomputes
             (expenses + review + gross fee). It previously sat on "Net Pay to
             Guide", so typing into the prep sheet overwrote the payment figure
             with the company-cost one. -->
        <div class="grand"><span>Total Company Cost <small>รวมต้นทุน</small></span><b id="grandTot">${thb(money.totalCompanyCost)}</b></div>
        <div class="handoff">what the job cost — not the amount to transfer →</div>
      </div>

      <div class="netpay">
        <div class="netpay-top">
          <span>Transfer to guide <small>ยอดที่ต้องโอนให้มัคคุเทศก์</small></span>
          <b>${thb(money.netPayToGuide)}</b>
        </div>
        <div><span>Guide fee after WHT <small>ค่าจ้างหลังหักภาษี</small></span><b>${thb(t.netGuideFee)}</b></div>
        ${money.additionalGuidePayment > 0 ? `<div><span>Additional payment <small>รายการจ่ายเพิ่มเติม</small></span><b>${thb(money.additionalGuidePayment)}</b></div>` : ""}
        ${money.reimbursementDue > 0 ? `<div><span>Reimbursement for expenses <small>คืนเงินสำรองจ่าย</small></span><b>${thb(money.reimbursementDue)}</b></div>` : ""}
        ${money.settledByCompany > 0 ? `<div class="note">${thb(money.settledByCompany)} of tour expenses is not paid here — the company already settled it.<br><small>ค่าใช้จ่ายส่วนนี้บริษัทชำระให้ผู้ขายโดยตรงแล้ว</small></div>` : ""}
      </div>
    </div>
    <div class="approve">
      <div class="certnote">${esc(CERT_STATEMENT_TH)}</div>
      <div class="sigwrap">
        <div class="sigbox">
          <img class="sigimg" src="${sigSrc ?? JOB_SHEET_CERTIFIER.signatureUrl}" alt="Signature of ${esc(JOB_SHEET_CERTIFIER.nameTh)}" draggable="false" onerror="this.style.display='none';var w=document.getElementById('sigfail');if(w)w.style.display='block'" />
          <div id="sigfail" style="display:none;color:#b00020;font-size:11px;font-weight:600;padding:14px 0">⚠ ลายเซ็นผู้รับรองโหลดไม่สำเร็จ — เอกสารนี้ยังไม่สมบูรณ์ / certifier signature failed to load</div>
          <div class="signame">(${esc(JOB_SHEET_CERTIFIER.nameFullTh)})</div>
          <div class="sigline" style="color:#6b746f;font-size:11px">${esc(JOB_SHEET_CERTIFIER.roleLabelTh)}</div>
          <div class="sigdate">${certDate ? `วันที่ ${esc(fmtCertDate(certDate))}` : "วันที่ ......../......../........"}</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    var GID=${JSON.stringify(guideId)}, DATE=${JSON.stringify(date)}, SLOT=${slotIdx}, NETFEE=${Number(t.netGuideFee) || 0}, GROSSFEE=${Number(t.gross) || 0}, REVIEW=${Number(cost.reviewOwn) || 0};
    // Live totals for the fillable prep sheet — sum pax + expense lines as you type.
    function jnum(t){ var n=parseFloat(String(t==null?"":t).replace(/[^0-9.\\-]/g,"")); return isFinite(n)?n:0; }
    function baht(n){ return "฿"+Math.round(n).toLocaleString(); }
    function recompute(){
      var bt=0; document.querySelectorAll("[data-bpax]").forEach(function(c){bt+=jnum(c.textContent);});
      var at=0; document.querySelectorAll("[data-apax]").forEach(function(c){at+=jnum(c.textContent);});
      var be=document.getElementById("bookedTot"); if(be) be.textContent=bt;
      var ae=document.getElementById("actualTot"); if(ae) ae.textContent=at;
      var et=0; document.querySelectorAll("tr[data-exp]").forEach(function(r){ var p=jnum((r.querySelector("[data-eprice]")||{}).textContent); var px=jnum((r.querySelector("[data-epax]")||{}).textContent); var amt=p*px; var ac=r.querySelector("[data-eamt]"); if(ac) ac.textContent=amt?baht(amt):""; et+=amt; });
      var ete=document.getElementById("expTot"); if(ete) ete.textContent=baht(et);
      var se=document.getElementById("sumExp"); if(se) se.textContent=baht(et);
      var ge=document.getElementById("grandTot"); if(ge) ge.textContent=baht(et+REVIEW+GROSSFEE);
    }
    document.addEventListener("input",recompute);
    var eslipFile=null;
    async function eslipChosen(inp){ eslipFile=(inp.files&&inp.files[0])||null; var el=document.getElementById("eslipName"); if(el) el.textContent=eslipFile?("\ud83d\udcce "+eslipFile.name):""; if(!eslipFile) return; var btn=document.getElementById("driveBtn"); var old=btn?btn.textContent:""; if(btn){ btn.disabled=true; btn.textContent="Uploading\u2026"; } try{ var b64=await readB64(eslipFile); var r=await fetch("/api/jobsheet/drive",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({guideId:GID,date:DATE,slotIdx:SLOT,eslipBase64:b64,eslipMime:eslipFile.type||"image/jpeg"})}); var d=await r.json().catch(function(){return {};}); if(!r.ok){ alert(d.hint||d.detail||("Upload failed ("+r.status+")")); if(btn){btn.textContent=old;btn.disabled=false;} return; } if(btn){ btn.textContent=d.paid?"Marked paid \u2713":"Uploaded \u2713"; btn.disabled=false; } if(d.driveError){ alert((d.paid?"Tour marked paid. ":"")+"Note: "+d.driveError); } if(d.paid){ setTimeout(function(){ location.reload(); }, 1200); } }catch(e){ alert("Upload failed: "+((e&&e.message)||e)); if(btn){btn.textContent=old;btn.disabled=false;} } }
    function readB64(file){ return new Promise(function(res,rej){ var fr=new FileReader(); fr.onload=function(){ var u=String(fr.result); res(u.substring(u.indexOf(",")+1)); }; fr.onerror=rej; fr.readAsDataURL(file); }); }
    async function shareToDrive(btn){
      var old=btn.textContent; btn.disabled=true; btn.textContent="Saving\u2026";
      try{
        var payload={guideId:GID,date:DATE,slotIdx:SLOT};
        try{
          var opt={margin:8,image:{type:"jpeg",quality:0.98},html2canvas:{scale:2,useCORS:true,backgroundColor:"#ffffff"},jsPDF:{unit:"mm",format:"a4",orientation:"portrait"},pagebreak:{mode:["css","legacy"]}};
          var uri=await html2pdf().set(opt).from(document.querySelector(".page")).outputPdf("datauristring");
          payload.pdfBase64=uri.substring(uri.indexOf(",")+1);
        }catch(pe){ /* PDF render is best-effort; e-slip + paid still go through */ }
        if(eslipFile){ payload.eslipBase64=await readB64(eslipFile); payload.eslipMime=eslipFile.type||"image/jpeg"; }
        if(!payload.pdfBase64 && !payload.eslipBase64){ alert("Nothing to save."); btn.textContent=old; btn.disabled=false; return; }
        var r=await fetch("/api/jobsheet/drive",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
        var d=await r.json().catch(function(){return {};});
        if(!r.ok){ alert(d.hint||d.detail||"Drive save failed."); btn.textContent=old; btn.disabled=false; return; }
        btn.textContent=d.paid?"Saved + marked paid \u2713":(eslipFile?"Saved sheet + e-slip \u2713":"Saved \u2713");
        if(d.driveError){ alert((d.paid?"Payment marked paid. ":"")+"But the Drive copy failed: "+d.driveError+"\nTry Share to Drive again."); }
        else if(d.link) window.open(d.link,"_blank","noopener");
        if(d.paid){ setTimeout(function(){ location.reload(); }, 1500); }
      }catch(e){ alert("Could not save PDF: "+((e&&e.message)||e)); btn.textContent=old; btn.disabled=false; }
    }
  </script>
${auto ? '<script>window.addEventListener("load",function(){setTimeout(async function(){try{if(document.fonts&&document.fonts.ready){await document.fonts.ready;}var opt={margin:8,image:{type:"jpeg",quality:0.98},html2canvas:{scale:2,useCORS:true,backgroundColor:"#ffffff"},jsPDF:{unit:"mm",format:"a4",orientation:"portrait"},pagebreak:{mode:["css","legacy"]}};var uri=await html2pdf().set(opt).from(document.querySelector(".page")).outputPdf("datauristring");var b64=uri.substring(uri.indexOf(",")+1);var r=await fetch("/api/jobsheet/drive",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({guideId:GID,date:DATE,slotIdx:SLOT,pdfBase64:b64})});var d=await r.json().catch(function(){return {};});parent.postMessage({fpBackfill:true,ok:r.ok,drive:!!(d&&d.link),error:(d&&(d.driveError||d.detail))||(r.ok?null:"HTTP "+r.status)},"*");}catch(e){parent.postMessage({fpBackfill:true,ok:false,error:String((e&&e.message)||e)},"*");}},400);});</script>' : ""}</body></html>`;

  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
