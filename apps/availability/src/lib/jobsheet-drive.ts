import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { googleDriveEnabled, folkpathsDriveToken, saveHtmlToDrive } from "@/lib/google-drive";
import { computeTotals, expenseAmount, guidePersonalTotal, isReviewExpense, noShowStats, reviewRewardTotal, thb, totalJobExpenses, tourOperatingExpenses, DEFAULT_GUIDE_FEE, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";
import { advanceTotals, advanceStatus, ADVANCE_STATUS_LABEL } from "@/lib/advance";
import { JOB_SHEET_CERTIFIER, CERT_STATEMENT_TH, certificationDate, fmtCertDate } from "@/lib/certifier";
import { JOB_SHEET_COMPANY_INFO as CO } from "@/lib/company";
import { readFile } from "node:fs/promises";
import path from "node:path";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Render the saved job sheet and store it in the shared Folkpaths Drive under
// "Folkpaths Job Sheets / YYYY-MM". Uses the company Drive account (no operator
// session needed — resolved via FOLKPATHS_DRIVE_EMAIL). Best-effort: returns the
// link or null, never throws — a Drive hiccup must not break the caller.
export async function saveJobSheetToDrive(guideId: string, date: string, slotIdx: number): Promise<string | null> {
  try {
    if (!googleDriveEnabled) return null;
    const refreshToken = await folkpathsDriveToken();
    if (!refreshToken) return null;

    const [sheet, assignment, u] = await Promise.all([
      prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
      prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
      prisma.user.findUnique({ where: { guideId } }),
    ]);
    if (!sheet) return null;
    const tourId = sheet.tourId || assignment?.tourId || "";
    const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

    const bookings = (sheet.bookings as Booking[]) ?? [];
    const expenses = (sheet.expenses as Expense[]) ?? [];
    const guideFee = (sheet.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE;
    const t = computeTotals(expenses, guideFee);
    const ref = sheet.ref || `FOLK-BKK-${date.replace(/-/g, "")}`;
    const guideName = u?.fullName || u?.displayName || guideId;
    const time = SLOT_TIMES[slotIdx] ?? tour?.time ?? "";
    const monthFolder = `${date.slice(0, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""}`.trim();
    const updated = sheet.updatedAt ? new Date(sheet.updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "";

    const bookingRows = bookings.map((b) => {
      const ns = (b as { status?: string }).status === "no-show";
      const actual = ns ? `<span style="color:#c0392b;font-weight:700">NO-SHOW</span>` : `${b.actualPax ?? ""}`;
      return `<tr${ns ? ' style="background:#fdecec"' : ""}><td>${esc(b.name)}</td><td>${esc(b.bookingNo)}</td><td style="text-align:center">${b.bookedPax ?? ""}</td><td style="text-align:center">${actual}</td><td>${esc(b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : "")}</td></tr>`;
    }).join("") || `<tr><td colspan="5" style="color:#888">No bookings recorded.</td></tr>`;
    const SRC: Record<string, string> = { advance: "Guide Advance / ชำระจากเงินทดรองจ่าย", guide: "Guide Personal / มัคคุเทศก์สำรองจ่าย" };
    const nsStats = noShowStats(bookings);
    const expenseRows = expenses.filter((e) => !isReviewExpense(e)).filter((e) => (e.description || "").trim() || expenseAmount(e) > 0).map((e) => `<tr><td>${esc(e.description)}</td><td style="text-align:center">${e.pax ?? ""}</td><td>${esc(SRC[e.paidBy ?? ""] ?? "Company Direct / บริษัทชำระโดยตรง")}</td><td style="text-align:right">${esc(thb(expenseAmount(e)))}</td></tr>`).join("") || `<tr><td colspan="4" style="color:#888">No expenses.</td></tr>`;

    // Advance / settlement ledger — the accountant's cash story (never in expense totals).
    const [advRows, retRows] = await Promise.all([
      prisma.guideAdvance.findMany({ where: { guideId, date, slotIdx }, orderBy: { paidAt: "asc" } }),
      prisma.guideAdvanceReturn.findMany({ where: { guideId, date, slotIdx }, orderBy: { returnedAt: "asc" } }),
    ]);
    const at = advanceTotals(advRows, retRows, expenses);
    const dtBKK = (x: Date) => new Date(x).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
    const advanceHtml = advRows.length || retRows.length ? `
      <h3 style="margin:14px 0 4px">Advance / Settlement <span style="font-size:10px;color:#8a8f8b;font-weight:400">การเคลียร์เงินทดรองจ่าย</span></h3>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4">
        <tbody>
          ${advRows.map((a) => `<tr><td>Advance Paid <span style="font-size:10px;color:#8a8f8b">เงินทดรองจ่ายให้มัคคุเทศก์</span> · ${esc(dtBKK(a.paidAt))} · ${esc(a.method)}${a.txRef ? ` · ${esc(a.txRef)}` : ""}${a.slipUrl ? ` · <a href="${esc(a.slipUrl)}">slip</a>` : ""}</td><td align="right">${esc(thb(a.amount))}</td></tr>`).join("")}
          <tr><td style="padding-left:18px">Expenses Paid from Advance <span style="font-size:10px;color:#8a8f8b">ค่าใช้จ่ายที่ชำระจากเงินทดรอง</span></td><td align="right">− ${esc(thb(at.usedFromAdvance))}</td></tr>
          ${retRows.map((a) => `<tr><td style="padding-left:18px">Advance Returned <span style="font-size:10px;color:#8a8f8b">เงินทดรองคงเหลือส่งคืน</span> · ${esc(dtBKK(a.returnedAt))} · ${esc(a.method)}${a.txRef ? ` · ${esc(a.txRef)}` : ""}${a.slipUrl ? ` · <a href="${esc(a.slipUrl)}">slip</a>` : ""}</td><td align="right">− ${esc(thb(a.amount))}</td></tr>`).join("")}
          <tr style="background:#f7f7f7"><td align="right"><b>Outstanding Advance <span style="font-size:10px;color:#8a8f8b;font-weight:400">เงินทดรองจ่ายคงค้าง</span></b></td><td align="right"><b>${esc(thb(at.outstanding))}</b></td></tr>
          <tr><td colspan="2"><b>Settlement Status <span style="font-size:10px;color:#8a8f8b;font-weight:400">สถานะการเคลียร์เงินทดรอง</span>:</b> ${esc(ADVANCE_STATUS_LABEL[advanceStatus(at, true)])}</td></tr>
        </tbody>
      </table>` : "";

    // Certification footer — same certifier + first-save date as the app/PDF; the
    // PNG is inlined base64 so the Doc conversion never depends on a live fetch.
    const certDate = certificationDate(sheet);
    let sigSrc = `https://guide.folkpaths.com${JOB_SHEET_CERTIFIER.signatureUrl}`;
    try { sigSrc = `data:image/png;base64,${(await readFile(path.join(process.cwd(), "public", JOB_SHEET_CERTIFIER.signatureFile))).toString("base64")}`; } catch { /* fall back to the public URL */ }
    const certHtml = `
      <div style="margin-top:26px;border-top:1px dashed #cdd3cf;padding-top:12px">
        <div style="font-size:10px;color:#5c655f;line-height:1.5;max-width:540px;margin-bottom:8px">${esc(CERT_STATEMENT_TH)}</div>
        <table style="margin-left:auto;border-collapse:collapse"><tbody>
          <tr><td align="center" style="color:#777;font-size:11px;letter-spacing:1px">CERTIFIED BY</td></tr>
          <tr><td align="center"><img src="${sigSrc}" alt="Signature of ${esc(JOB_SHEET_CERTIFIER.nameTh)}" width="170" /></td></tr>
          <tr><td align="center" style="font-weight:700">(${esc(JOB_SHEET_CERTIFIER.nameFullTh)})</td></tr>
          <tr><td align="center" style="color:#6b746f;font-size:11px">${esc(JOB_SHEET_CERTIFIER.roleLabelTh)}</td></tr>
          <tr><td align="center" style="color:#666;font-size:12px">${certDate ? `วันที่ ${esc(fmtCertDate(certDate))}` : "—"}</td></tr>
        </tbody></table>
      </div>`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(ref)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:13px">
      <div style="font-size:12px;font-weight:600;letter-spacing:1px">${esc(CO.brandName)}</div>
      <div style="color:#666;font-size:9px">Operated by ${esc(CO.operatedBy)} / ${esc(CO.legalNameTh)}</div>
      <div style="color:#8a8f8b;font-size:8.5px">Tax ID ${esc(CO.taxId)} · Tour Operator ${esc(CO.tourOperatorNameTh)} · License ${esc(CO.tourismLicenseNo)}</div>
      <div style="font-size:20px;font-weight:800;margin-top:10px">JOB SHEET</div>
      <div style="font-size:13px;font-weight:600;color:#7e3a2c;margin-bottom:12px">${esc(ref)}</div>
      <table border="1" cellpadding="6" style="border-collapse:collapse;margin-bottom:10px;font-size:12.5px">
        <tr><td style="color:#555">No.</td><td><b>${esc(ref)}</b></td></tr>
        <tr><td style="color:#555">Updated</td><td>${esc(updated)}</td></tr>
        <tr><td style="color:#555">Tour ID</td><td><b>${esc(tourId)}</b></td></tr>
        <tr><td style="color:#555">Guide ID</td><td>${esc(guideId)}</td></tr>
        <tr><td style="color:#555">Status</td><td>${esc(sheet.status)}</td></tr>
      </table>
      <table border="1" cellpadding="6" style="border-collapse:collapse;margin-bottom:14px;font-size:12.5px">
        <tr><td style="color:#555">Tour Date</td><td><b>${esc(date)}</b> · ${esc(time)}</td></tr>
        <tr><td style="color:#555">Tour Name</td><td><b>${esc(tour?.name ?? tourId)}</b></td></tr>
        <tr><td style="color:#555">Guide name</td><td>${esc(guideId)} ${esc(guideName)}</td></tr>
        ${u?.email ? `<tr><td style="color:#555">E-mail</td><td>${esc(u.email)}</td></tr>` : ""}
        ${u?.phone ? `<tr><td style="color:#555">Tel no.</td><td>${esc(u.phone)}</td></tr>` : ""}
      </table>
      <h3 style="margin:16px 0 4px">Job Details</h3>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4">
        <thead><tr style="background:#f2f2f2"><th align="left">Name</th><th align="left">Booking no.</th><th>Booked</th><th>Actual</th><th align="left">Tickets</th></tr></thead>
        <tbody>${bookingRows}</tbody>
      </table>
      ${nsStats.pax > 0 ? `<div style="font-size:11px;color:#c2604a;margin:4px 0 0"><b>No-show</b> <span style="font-size:9px;color:#8a8f8b">ไม่มาใช้บริการ</span>: ${nsStats.pax} pax · ${nsStats.bookings} booking${nsStats.bookings === 1 ? "" : "s"}</div>` : ""}
      <h3 style="margin:14px 0 4px">Tour Expenses <span style="font-size:10px;color:#8a8f8b;font-weight:400">ค่าใช้จ่ายในการนำเที่ยว</span></h3>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4">
        <thead><tr style="background:#f2f2f2"><th align="left">Description <span style="font-size:10px;color:#8a8f8b;font-weight:400">รายการ</span></th><th>Pax <span style="font-size:10px;color:#8a8f8b;font-weight:400">จำนวน</span></th><th align="left">Paid by <span style="font-size:10px;color:#8a8f8b;font-weight:400">แหล่งเงินที่ใช้ชำระ</span></th><th align="right">Amount <span style="font-size:10px;color:#8a8f8b;font-weight:400">จำนวนเงิน</span></th></tr></thead>
        <tbody>${expenseRows}</tbody>
      </table>
      <table style="margin-top:12px;border-collapse:collapse"><tbody>
        <tr><td colspan="2" style="font-weight:700;padding:2px 0">Financial Summary <span style="font-size:10px;color:#8a8f8b;font-weight:400">สรุปรายการทางการเงิน</span></td></tr>
        <tr><td style="padding:2px 16px 2px 0;color:#555">Tour Expenses <span style="font-size:10px;color:#8a8f8b">ค่าใช้จ่ายในการนำเที่ยว</span></td><td align="right"><b>${esc(thb(tourOperatingExpenses(expenses)))}</b></td></tr>
        ${reviewRewardTotal(expenses) > 0 ? `<tr><td style="padding:2px 16px 2px 0;color:#555">Review Reward <span style="font-size:10px;color:#8a8f8b">ค่าตอบแทนรีวิว</span></td><td align="right"><b>${esc(thb(reviewRewardTotal(expenses)))}</b></td></tr>` : ""}
        <tr><td style="padding:2px 16px 2px 0;color:#555">Guide Fee <span style="font-size:10px;color:#8a8f8b">ค่าจ้างมัคคุเทศก์</span></td><td align="right"><b>${esc(thb(t.gross))}</b></td></tr>
        <tr><td style="padding:2px 16px 2px 0"><b>Total Job Expenses <span style="font-size:10px;color:#8a8f8b;font-weight:400">รวมค่าใช้จ่ายของงาน</span></b></td><td align="right"><b>${esc(thb(totalJobExpenses(t)))}</b></td></tr>
        <tr><td style="padding:2px 16px 2px 0;color:#555">Withholding Tax <span style="font-size:10px;color:#8a8f8b">ภาษีหัก ณ ที่จ่าย</span></td><td align="right">${esc(thb(t.wht))}</td></tr>
        <tr><td style="padding:2px 16px 2px 0;color:#555">Net Payable to Guide <span style="font-size:10px;color:#8a8f8b">ยอดจ่ายสุทธิให้มัคคุเทศก์</span></td><td align="right"><b>${esc(thb(t.netGuideFee))}</b></td></tr>
        ${guidePersonalTotal(expenses) > 0 ? `<tr><td style="padding:2px 16px 2px 0;color:#b45309">Reimbursement Due <span style="font-size:10px;color:#8a8f8b">ยอดที่ต้องคืนให้มัคคุเทศก์ (สำรองจ่าย)</span></td><td align="right" style="color:#b45309"><b>${esc(thb(guidePersonalTotal(expenses)))}</b></td></tr>` : ""}
      </tbody></table>
      ${advanceHtml}
      ${certHtml}
    </body></html>`;

    const { link } = await saveHtmlToDrive({ refreshToken, name: `${ref} — ${guideName} — ${date}`, html, folderPath: ["Folkpaths Job Sheets", monthFolder] });
    return link;
  } catch {
    return null;
  }
}
