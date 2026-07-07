import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { googleDriveEnabled, folkpathsDriveToken, saveHtmlToDrive } from "@/lib/google-drive";
import { computeTotals, expenseAmount, thb, DEFAULT_GUIDE_FEE, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";

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
    const expenseRows = expenses.filter((e) => (e.description || "").trim() || expenseAmount(e) > 0).map((e) => `<tr><td>${esc(e.description)}</td><td style="text-align:center">${e.pax ?? ""}</td><td style="text-align:right">${esc(thb(expenseAmount(e)))}</td></tr>`).join("") || `<tr><td colspan="3" style="color:#888">No expenses.</td></tr>`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(ref)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:13px">
      <div style="font-size:24px;font-weight:800;letter-spacing:1px">FOLKPATHS</div>
      <div style="color:#666;font-size:12px;margin-bottom:12px">บริษัท โฟล์คพาธส์ จำกัด · Job Sheet</div>
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
      <h3 style="margin:14px 0 4px">Expenses</h3>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4">
        <thead><tr style="background:#f2f2f2"><th align="left">Description</th><th>Pax</th><th align="right">Amount</th></tr></thead>
        <tbody>${expenseRows}</tbody>
      </table>
      <table style="margin-top:12px;border-collapse:collapse"><tbody>
        <tr><td style="padding:2px 16px 2px 0;color:#555">Guide fee (net)</td><td align="right"><b>${esc(thb(t.netGuideFee))}</b></td></tr>
        <tr><td style="padding:2px 16px 2px 0;color:#555">Expenses</td><td align="right"><b>${esc(thb(t.totalExpenses))}</b></td></tr>
        <tr><td style="padding:2px 16px 2px 0"><b>Total payout</b></td><td align="right"><b>${esc(thb(t.grandTotal))}</b></td></tr>
      </tbody></table>
    </body></html>`;

    const { link } = await saveHtmlToDrive({ refreshToken, name: `${ref} — ${guideName} — ${date}`, html, folderPath: ["Folkpaths Job Sheets", monthFolder] });
    return link;
  } catch {
    return null;
  }
}
