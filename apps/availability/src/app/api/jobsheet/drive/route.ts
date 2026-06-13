import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { googleDriveEnabled, saveHtmlToDrive } from "@/lib/google-drive";
import { computeTotals, expenseAmount, thb, DEFAULT_GUIDE_FEE, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// GET — is Drive saving configured? (drives the button's visibility)
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ enabled: googleDriveEnabled });
}

// POST { guideId, date, slotIdx } — render the job sheet and save it as a Google
// Doc in admin@folkpaths.com's Drive under "Folkpaths Job Sheets / YYYY-MM".
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", hint: "Set GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY and GOOGLE_DRIVE_SUBJECT on Railway." }, { status: 400 });

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
  const ref = sheet.ref || `FOLK-BKK-${date.replace(/-/g, "")}`;
  const guideName = u?.fullName || u?.displayName || guideId;
  const time = SLOT_TIMES[slotIdx] ?? tour?.time ?? "";

  const bookingRows = bookings.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.bookingNo)}</td><td style="text-align:center">${b.bookedPax ?? ""}</td><td style="text-align:center">${b.actualPax ?? ""}</td><td>${esc(b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : "")}</td></tr>`).join("") || `<tr><td colspan="5" style="color:#888">No bookings recorded.</td></tr>`;
  const expenseRows = expenses.filter((e) => (e.description || "").trim() || expenseAmount(e) > 0).map((e) => `<tr><td>${esc(e.description)}</td><td style="text-align:center">${e.pax ?? ""}</td><td style="text-align:right">${esc(thb(expenseAmount(e)))}</td></tr>`).join("") || `<tr><td colspan="3" style="color:#888">No expenses.</td></tr>`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(ref)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:13px">
    <h2 style="margin:0">Folkpaths — Job Sheet</h2>
    <p style="margin:2px 0 10px;color:#555">${esc(ref)} · ${esc(sheet.status)}</p>
    <table style="border-collapse:collapse;margin-bottom:6px"><tbody>
      <tr><td style="padding:2px 12px 2px 0;color:#555">Date</td><td><b>${esc(date)}</b> · ${esc(time)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#555">Tour</td><td><b>${esc(tour?.name ?? tourId)}</b></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#555">Guide</td><td><b>${esc(guideId)} ${esc(guideName)}</b></td></tr>
    </tbody></table>
    <h3 style="margin:14px 0 4px">Bookings</h3>
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

  try {
    const { link } = await saveHtmlToDrive({ name: `${ref} — ${guideName} — ${date}`, html, folderPath: ["Folkpaths Job Sheets", date.slice(0, 7)] });
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "jobsheet.drive_saved", entityType: "JobSheet", detail: { guideId, date, slotIdx, ref } });
    return NextResponse.json({ ok: true, link });
  } catch (e) {
    return NextResponse.json({ error: "drive-failed", detail: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
