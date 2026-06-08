import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { SLOT_TIMES } from "@/lib/slots";
import { DEFAULT_EXPENSES, DEFAULT_GUIDE_FEE, computeTotals, expenseAmount, thb, type Expense, type GuideFee, type Booking } from "@/lib/jobsheet";

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
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  if (!ops(session.user.role) && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [u, existing, assignment] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
  ]);
  const tourId = existing?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  const sheet = existing ?? { ref: null as string | null, status: "Confirmed", bookings: [] as Booking[], expenses: DEFAULT_EXPENSES, guideFee: DEFAULT_GUIDE_FEE, updatedAt: null as Date | null };
  const bookings = (sheet.bookings as Booking[]) ?? [];
  const expenses = (sheet.expenses as Expense[]) ?? [];
  const guideFee = (sheet.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE;
  const t = computeTotals(expenses, guideFee);

  const time = SLOT_TIMES[slotIdx] || tour?.time || "";
  const guideName = u?.fullName || u?.displayName || "";
  const taxId = decrypt(u?.taxId);
  const address = decrypt(u?.currentAddress) || decrypt(u?.idCardAddress);
  const updated = (sheet as { updatedAt?: Date | null }).updatedAt;
  const ref = sheet.ref || `job-sheet-${guideId}-${date}`;

  let bookedSum = 0, actualSum = 0;
  const bookingRows = bookings.map((b, i) => {
    bookedSum += b.bookedPax ?? 0; actualSum += b.actualPax ?? 0;
    const tickets = b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : "";
    return `<tr><td>${i + 1}</td><td>${esc(b.name)}</td><td>${esc(b.bookingNo)}</td><td class="n">${b.bookedPax ?? ""}</td><td class="n">${b.actualPax ?? ""}</td><td>${tickets}</td></tr>`;
  }).join("");

  const expenseRows = expenses.map((e) =>
    `<tr><td>${esc(e.description)}</td><td class="n">${e.price != null ? thb(e.price) : ""}</td><td class="c">×</td><td class="n">${e.pax ?? ""}</td><td class="n">${thb(expenseAmount(e))}</td></tr>`
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(ref)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Inter","Noto Sans Thai",-apple-system,sans-serif; color: #16201c; font-size: 12px; margin: 0; }
  .toolbar { background:#0e3b2e; color:#fff; padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }
  .toolbar button { background:#fff; color:#0e3b2e; border:none; border-radius:7px; padding:7px 14px; font-weight:600; cursor:pointer; font-size:13px; }
  .page { max-width: 800px; margin: 16px auto; padding: 0 16px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #0e3b2e; padding-bottom:10px; }
  .brand { font-size:22px; font-weight:600; color:#0e3b2e; }
  .brand small { display:block; font-size:12px; color:#6b746f; font-weight:400; }
  .meta { font-size:11px; }
  .meta div { margin-bottom:2px; } .meta b { display:inline-block; min-width:66px; color:#6b746f; font-weight:400; }
  .guide { display:grid; grid-template-columns:1fr 1fr; gap:2px 18px; margin:12px 0; }
  .guide div { display:flex; gap:8px; padding:3px 0; border-bottom:0.5px solid #eee; }
  .guide span { min-width:78px; color:#6b746f; }
  h3 { font-size:13px; margin:16px 0 4px; padding:5px 8px; background:#bfe3bf; border-radius:4px; }
  h3.exp { background:#fff8c4; } h3.fee { background:#f4d9c4; }
  table { width:100%; border-collapse:collapse; font-size:11.5px; }
  th, td { border:0.5px solid #cfd3cf; padding:5px 7px; text-align:left; }
  th { background:#f4f4f4; font-weight:600; }
  td.n, th.n { text-align:right; } td.c { text-align:center; }
  .tot td { font-weight:600; background:#fafafa; }
  .summary { margin-top:16px; margin-left:auto; width:280px; }
  .summary div { display:flex; justify-content:space-between; padding:5px 8px; }
  .summary .grand { background:#bfe3bf; font-weight:600; border-radius:4px; font-size:14px; }
  @media print { .toolbar { display:none; } .page { margin:0; } body { font-size:11px; } }
</style></head>
<body>
  <div class="toolbar"><span>Job sheet · ${esc(ref)}</span><button onclick="window.print()">Save as PDF / Print</button></div>
  <div class="page">
    <div class="head">
      <div class="brand">FOLKPATHS<small>บริษัท โฟล์คพาธส์ จำกัด</small></div>
      <div class="meta">
        <div><b>No.</b> ${esc(sheet.ref || "")}</div>
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
      <div><span>Guide name</span>${esc(guideName)}</div>
      <div><span>Tax ID</span>${esc(taxId || "—")}</div>
      <div><span>Address</span>${esc(address || "—")}</div>
      <div><span>E-mail</span>${esc(u?.email || "")}</div>
      <div><span>Tel no.</span>${esc(u?.phone || "—")}</div>
    </div>

    <h3>Job Details</h3>
    <table>
      <thead><tr><th>No.</th><th>Name lists</th><th>Booking No.</th><th class="n">Booked Pax</th><th class="n">Actual Pax</th><th>Tickets</th></tr></thead>
      <tbody>${bookingRows || '<tr><td colspan="6" style="color:#aaa">No bookings listed.</td></tr>'}
        <tr class="tot"><td></td><td colspan="2" style="text-align:right">Total</td><td class="n">${bookedSum}</td><td class="n">${actualSum}</td><td></td></tr>
      </tbody>
    </table>

    <h3 class="exp">Expense</h3>
    <table>
      <thead><tr><th>Description</th><th class="n">Price</th><th class="c"></th><th class="n">Pax</th><th class="n">Amount</th></tr></thead>
      <tbody>${expenseRows}
        <tr class="tot"><td colspan="4" style="text-align:right">Total Expenses</td><td class="n">${thb(t.totalExpenses)}</td></tr>
      </tbody>
    </table>

    <h3 class="fee">Guide</h3>
    <table>
      <thead><tr><th>Description</th><th class="n">Price</th><th class="c"></th><th class="n">Time</th><th class="n">WHT %</th><th class="n">WHT</th><th class="n">Net</th></tr></thead>
      <tbody>
        <tr><td>Guide Fee</td><td class="n">${guideFee.price != null ? thb(guideFee.price) : ""}</td><td class="c">×</td><td class="n">${guideFee.time ?? ""}</td><td class="n">${guideFee.whtPct ?? 0}%</td><td class="n">${thb(t.wht)}</td><td class="n">${thb(t.netGuideFee)}</td></tr>
      </tbody>
    </table>

    <div class="summary">
      <div><span>Total Expenses</span><b>${thb(t.totalExpenses)}</b></div>
      <div><span>Net Guide Fee</span><b>${thb(t.netGuideFee)}</b></div>
      <div class="grand"><span>Total</span><b>${thb(t.grandTotal)}</b></div>
    </div>
  </div>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 350); });</script>
</body></html>`;

  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
