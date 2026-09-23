import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { googleDriveEnabled, folkpathsDriveToken, saveHtmlToDrive, saveBufferToDrive } from "@/lib/google-drive";
import { computeTotals, expenseAmount, jobSheetDriveName, thb, DEFAULT_GUIDE_FEE, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";
import { tourCostBreakdown } from "@/lib/peak-sync";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// GET — is Drive saving configured? "connected" reflects the shared Folkpaths
// Drive (not the current operator's own account), since that's where saves go.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const connected = googleDriveEnabled ? !!(await folkpathsDriveToken(session?.user?.id)) : false;
  return NextResponse.json({ enabled: googleDriveEnabled, connected });
}

// POST { guideId, date, slotIdx } — render the job sheet and save it as a Google
// Doc in admin@folkpaths.com's Drive under "Folkpaths Job Sheets / YYYY-MM".
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Drive is optional here: marking the tour PAID from its e-slip must succeed even
  // if Drive isn't configured/connected. We attempt the Drive copy only when we can.
  // The copy always goes to the shared Folkpaths Drive, whoever the operator is.
  const refreshToken = googleDriveEnabled ? await folkpathsDriveToken(session?.user?.id) : null;

  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const [sheet, assignment, u] = await Promise.all([
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.user.findUnique({ where: { guideId } }),
  ]);
  if (!sheet) return NextResponse.json({ error: "no-sheet", hint: "Create/save the job sheet before exporting." }, { status: 404 });
  const tourId = sheet.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  const bookings = (sheet.bookings as Booking[]) ?? [];
  const expenses = (sheet.expenses as Expense[]) ?? [];
  const guideFee = (sheet.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE;
  const t = computeTotals(expenses, guideFee);
  // The payer split: what the job cost, and — separately — what to transfer.
  const b = tourCostBreakdown(expenses, guideFee);
  const ref = sheet.ref || `FOLK-BKK-${date.replace(/-/g, "")}`;
  const guideName = u?.fullName || u?.displayName || guideId;
  const time = SLOT_TIMES[slotIdx] ?? tour?.time ?? "";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthFolder = `${date.slice(0, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""}`.trim(); // e.g. "2026-06 June"

  // If the client sent a browser-rendered PDF (from the print page's "Share to
  // Drive"), store it verbatim — a pixel-perfect copy of the printed job sheet.
  const pdfBase64 = typeof body?.pdfBase64 === "string" ? body.pdfBase64 : "";
  const eslipBase64 = typeof body?.eslipBase64 === "string" ? body.eslipBase64 : "";
  if (pdfBase64 || eslipBase64) {
    const eslipMime = typeof body?.eslipMime === "string" ? body.eslipMime : "image/jpeg";
    const eslipExt = eslipMime.includes("png") ? "png" : eslipMime.includes("pdf") ? "pdf" : eslipMime.includes("webp") ? "webp" : "jpg";
    // Payments v2: saving a slip here does NOT pay the tour. A transfer is recorded on
    // Payments (date, amount, jobs, reconciliation, this slip) — that is what pays a job.
    // The copy still goes to Drive, so the evidence is filed either way.
    const paid = false;

    // Save the job-sheet PDF + e-slip to Drive (best effort).
    let link: string | undefined;
    let eslipLink: string | undefined;
    let driveError: string | undefined;
    if (!refreshToken && (pdfBase64 || eslipBase64)) driveError = "Google Drive isn't connected, so the copy wasn't saved.";
    if (pdfBase64 && refreshToken) {
      try {
        const r = await saveBufferToDrive({ refreshToken, name: jobSheetDriveName({ ref, guideName, date, guideId, slotIdx }, ".pdf"), base64: pdfBase64, mimeType: "application/pdf", folderPath: ["Folkpaths Job Sheets", monthFolder] });
        link = r.link;
      } catch (e) { driveError = (e as Error).message.slice(0, 200); }
    }
    if (eslipBase64 && refreshToken) {
      try {
        // Slip evidence leads with the PEAK expense ref (EXP-xxxxx) when this
        // tour's payment has one, matching the saved PEAK entry name.
        const tpRef = (await prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { peakRef: true } }))?.peakRef;
        const e = await saveBufferToDrive({ refreshToken, name: `${tpRef ? `${tpRef} — ` : ""}${jobSheetDriveName({ ref, guideName, date, guideId, slotIdx }, ` — e-slip.${eslipExt}`)}`, base64: eslipBase64, mimeType: eslipMime, folderPath: ["Folkpaths Job Sheets", monthFolder] });
        eslipLink = e.link;
      } catch (e) { driveError = driveError || (e as Error).message.slice(0, 200); }
    }
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.drive_saved_pdf", entityType: "JobSheet", detail: { guideId, date, slotIdx, ref, eslip: !!eslipBase64, paid, drive: !!link } });
    // Only a hard failure (nothing saved AND payment didn't land) is an error.
    if (!link && !eslipLink) return NextResponse.json({ error: "drive-failed", detail: driveError ?? "Drive save failed." }, { status: 502 });
    // The slip is filed, not paid: Payments records the transfer that pays this job.
    return NextResponse.json({ ok: true, link, eslipLink, paid, driveError, recordPayment: !!eslipBase64 });
  }
  if (!refreshToken) return NextResponse.json({ error: "not-connected", hint: "Connect Google Drive first." }, { status: 400 });
  const updated = sheet.updatedAt ? new Date(sheet.updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "";

  const bookingRows = bookings.map((b) => {
    const ns = (b as { status?: string }).status === "no-show";
    const actual = ns ? `<span style="color:#c0392b;font-weight:700">NO-SHOW</span>` : `${b.actualPax ?? ""}`;
    return `<tr${ns ? ' style="background:#fdecec"' : ""}><td>${esc(b.name)}</td><td>${esc(b.bookingNo)}</td><td style="text-align:center">${b.bookedPax ?? ""}</td><td style="text-align:center">${actual}</td><td>${b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : '<span style="display:inline-block;width:60%;height:0;border-top:1.4px solid #333;vertical-align:middle"></span>'}</td></tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#888">No bookings recorded.</td></tr>`;
  const expenseRows = expenses.filter((e) => (e.description || "").trim() || expenseAmount(e) > 0).map((e) => `<tr><td>${esc(e.description)}</td><td style="text-align:center">${e.pax ?? ""}${e.unit ? " " + esc(e.unit) : ""}</td><td style="text-align:right">${esc(thb(expenseAmount(e)))}</td></tr>`).join("") || `<tr><td colspan="3" style="color:#888">No expenses.</td></tr>`;

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
      <thead><tr style="background:#f2f2f2"><th align="left">Description</th><th>จำนวน</th><th align="right">Amount</th></tr></thead>
      <tbody>${expenseRows}</tbody>
    </table>
    <table style="margin-top:12px;border-collapse:collapse"><tbody>
      <tr><td style="padding:2px 16px 2px 0;color:#555">ต้นทุนทัวร์ทั้งหมด<br><span style="font-size:11px">Total tour cost</span></td><td align="right">${esc(thb(b.tourCost))}</td></tr>
      ${b.fundedByAdvance > 0 ? `<tr><td style="padding:2px 16px 2px 0;color:#555">จ่ายจากเงินทดรองบริษัท<br><span style="font-size:11px">Funded by a company advance — not transferred</span></td><td align="right">${esc(thb(b.fundedByAdvance))}</td></tr>` : ""}
      ${b.fundedByCompany > 0 ? `<tr><td style="padding:2px 16px 2px 0;color:#555">บริษัทจ่ายตรง<br><span style="font-size:11px">Paid direct by the company — not transferred</span></td><td align="right">${esc(thb(b.fundedByCompany))}</td></tr>` : ""}
      ${b.unresolved > 0 ? `<tr><td style="padding:2px 16px 2px 0;color:#b91c1c"><b>ยังไม่ระบุผู้จ่าย — ต้องแก้ก่อนจ่ายเงิน</b><br><span style="font-size:11px">ยังไม่รวมในยอดโอน — กรุณาระบุว่าใครเป็นผู้จ่าย · Paid By not set, so this job cannot be paid yet</span></td><td align="right" style="color:#b91c1c"><b>${esc(thb(b.unresolved))}</b></td></tr>` : ""}
      <tr><td colspan="2" style="padding:2px 0 8px;color:#777;font-size:11px">ยอดนี้ใช้วัดต้นทุนของงาน ไม่ใช่ยอดที่ต้องโอนให้ไกด์</td></tr>
      <tr><td style="padding:2px 16px 2px 0;color:#555">ค่าจ้างไกด์<br><span style="font-size:11px">Guide fee</span></td><td align="right">${esc(thb(b.feeGross))}</td></tr>
      ${b.reviewReward > 0 ? `<tr><td style="padding:2px 16px 2px 0;color:#555">ค่าตอบแทนรีวิวไกด์<br><span style="font-size:11px">Review incentive</span></td><td align="right">${esc(thb(b.reviewReward))}</td></tr>` : ""}
      <tr><td style="padding:2px 16px 2px 0;color:#555">ค่าใช้จ่ายที่ไกด์ออกเอง ต้องคืนให้ไกด์<br><span style="font-size:11px">Reimbursable to the guide</span></td><td align="right">${esc(thb(b.reimbursableToGuide))}</td></tr>
      <tr><td style="padding:2px 16px 2px 0;color:#555">หัก ภาษี ณ ที่จ่าย<br><span style="font-size:11px">Withholding tax</span></td><td align="right">−${esc(thb(b.withholding))}</td></tr>
      <tr><td style="padding:4px 16px 2px 0;border-top:1px solid #999"><b>ยอดโอนสุทธิให้ไกด์</b><br><span style="font-size:11px">Net transfer to the guide</span></td><td align="right" style="border-top:1px solid #999"><b>${esc(thb(b.netTransfer))}</b></td></tr>
      ${b.unresolved > 0 ? `<tr><td colspan="2" style="padding:4px 0 0;color:#b91c1c;font-size:11px">ยอดโอนนี้ยังไม่รวม ${esc(thb(b.unresolved))} ที่ยังไม่ระบุผู้จ่าย — ระบุ Paid By บนใบงานก่อน จึงจะจ่ายได้</td></tr>` : ""}
    </tbody></table>
  </body></html>`;

  try {
    const { link } = await saveHtmlToDrive({ refreshToken, name: jobSheetDriveName({ ref, guideName, date, guideId, slotIdx }), html, folderPath: ["Folkpaths Job Sheets", monthFolder] });
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.drive_saved", entityType: "JobSheet", detail: { guideId, date, slotIdx, ref } });
    return NextResponse.json({ ok: true, link });
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
