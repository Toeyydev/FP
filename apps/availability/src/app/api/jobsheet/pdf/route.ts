import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { SLOT_TIMES } from "@/lib/slots";
import { DEFAULT_GUIDE_FEE, defaultExpensesForTour, computeTotals, expenseAmount, thb, type Expense, type GuideFee, type Booking } from "@/lib/jobsheet";
import { canViewFinance } from "@/lib/roles";
import { bookingRef } from "@/lib/booking-ref";

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

  let bookedSum = 0, actualSum = 0, noShowSum = 0;
  let bookingRows = bookings.map((b, i) => {
    bookedSum += b.bookedPax ?? 0; actualSum += b.actualPax ?? 0;
    noShowSum += b.noShowPax ?? (b.status === "no-show" ? (b.bookedPax ?? 0) : 0);
    const tickets = b.tickets === "included" ? "Included" : b.tickets === "not" ? "Not incl." : "";
    return `<tr><td>${i + 1}</td><td${ce}>${esc(b.name)}</td><td${ce}>${esc(b.bookingNo)}</td><td class="n" data-bpax>${b.bookedPax ?? ""}</td><td class="n"${ce} data-apax>${b.actualPax ?? ""}</td><td${ce}>${tickets}</td></tr>`;
  }).join("");
  if (editable) for (let k = 0; k < 4; k++) bookingRows += `<tr><td>${bookings.length + k + 1}</td><td contenteditable="true"></td><td contenteditable="true"></td><td class="n" contenteditable="true" data-bpax></td><td class="n" contenteditable="true" data-apax></td><td contenteditable="true"></td></tr>`;

  const expRow = (desc: string, price: string, pax: string, amt: string) => editable
    ? `<tr data-exp><td contenteditable="true">${desc}</td><td class="n" contenteditable="true" data-eprice>${price}</td><td class="c">×</td><td class="n" contenteditable="true" data-epax>${pax}</td><td class="n" data-eamt>${amt}</td></tr>`
    : `<tr><td>${desc}</td><td class="n">${price}</td><td class="c">×</td><td class="n">${pax}</td><td class="n">${amt}</td></tr>`;
  let expenseRows = expenses.map((e) => expRow(esc(e.description), e.price != null ? thb(e.price) : "", e.pax != null ? String(e.pax) : "", thb(expenseAmount(e)))).join("");
  if (editable) for (let k = 0; k < 3; k++) expenseRows += expRow("", "", "", "");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(ref)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Inter","Noto Sans Thai",-apple-system,sans-serif; color: #16201c; font-size: 12px; margin: 0; }
  .toolbar { background:#7e3a2c; color:#fff; padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }
  .toolbar button { background:#fff; color:#7e3a2c; border:none; border-radius:7px; padding:7px 14px; font-weight:600; cursor:pointer; font-size:13px; }
  .page { max-width: 800px; margin: 16px auto; padding: 0 16px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #7e3a2c; padding-bottom:10px; }
  .brand { font-size:22px; font-weight:600; color:#7e3a2c; }
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
  .prepnote { background:#fbf4e8; border:1px solid #ecd9bf; color:#7e3a2c; border-radius:8px; padding:8px 12px; font-size:11.5px; margin:14px 0 2px; }
  [contenteditable="true"] { background:#fff7e8; outline:none; border-radius:3px; min-width:18px; }
  [contenteditable="true"]:focus { background:#fff2cf; box-shadow:0 0 0 2px #e9c98a inset; }
  .guide [contenteditable="true"] { display:inline-block; min-width:120px; }
  @media print { .toolbar { display:none; } .page { margin:0; } body { font-size:11px; } .prepnote { display:none; } [contenteditable="true"] { background:transparent; box-shadow:none; } }
</style></head>
<body>
  <div class="toolbar"><span>Job sheet · ${esc(ref)}</span><span style="display:flex;gap:8px;align-items:center">${isOps ? `<span style="font-size:12px;opacity:.9">\ud83d\udcce e-slip:</span><input type="file" id="eslipInput" accept="image/*,application/pdf" onchange="eslipChosen(this)" style="background:#fff;color:#7e3a2c;border-radius:7px;padding:6px 8px;font-size:12px;max-width:210px"><span id="eslipName" style="font-size:12px;opacity:.9"></span>` : ""}<button onclick="window.print()">Save as PDF / Print</button></span></div>
  <div class="page">
    ${editable ? `<div class="prepnote">📝 Prep sheet — no guide assigned yet. Fill in the highlighted fields, then <b>Save as PDF / Print</b>. Totals update as you type.</div>` : ""}
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
      <div><span>Guide name</span><b${ce}>${esc(guideName)}</b></div>
      <div><span>Tax ID</span><span${ce}>${esc(taxId || (editable ? "" : "—"))}</span></div>
      <div><span>Address</span><span${ce}>${esc(address || (editable ? "" : "—"))}</span></div>
      <div><span>E-mail</span><span${ce}>${esc(u?.email || "")}</span></div>
      <div><span>Tel no.</span><span${ce}>${esc(u?.phone || (editable ? "" : "—"))}</span></div>
    </div>

    <h3>Job Details</h3>
    <table>
      <thead><tr><th>No.</th><th>Name lists</th><th>Booking No.</th><th class="n">Booked Pax</th><th class="n">Actual Pax</th><th>Tickets</th></tr></thead>
      <tbody>${bookingRows || '<tr><td colspan="6" style="color:#aaa">No bookings listed.</td></tr>'}
        <tr class="tot"><td></td><td colspan="2" style="text-align:right">Total</td><td class="n" id="bookedTot">${bookedSum}</td><td class="n" id="actualTot">${actualSum}</td><td></td></tr>
        ${noShowSum > 0 ? `<tr class="tot"><td></td><td colspan="2" style="text-align:right;color:#c2604a">No-shows</td><td class="n" colspan="2" style="color:#c2604a">${noShowSum} pax</td><td></td></tr>` : ""}
      </tbody>
    </table>

    <h3 class="exp">Expense</h3>
    <table>
      <thead><tr><th>Description</th><th class="n">Price</th><th class="c"></th><th class="n">Pax</th><th class="n">Amount</th></tr></thead>
      <tbody>${expenseRows}
        <tr class="tot"><td colspan="4" style="text-align:right">Total Expenses</td><td class="n" id="expTot">${thb(t.totalExpenses)}</td></tr>
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
      <div><span>Total Expenses</span><b id="sumExp">${thb(t.totalExpenses)}</b></div>
      <div><span>Net Guide Fee</span><b>${thb(t.netGuideFee)}</b></div>
      <div class="grand"><span>Total</span><b id="grandTot">${thb(t.grandTotal)}</b></div>
    </div>
  </div>
  <script>
    var GID=${JSON.stringify(guideId)}, DATE=${JSON.stringify(date)}, SLOT=${slotIdx}, NETFEE=${Number(t.netGuideFee) || 0};
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
      var ge=document.getElementById("grandTot"); if(ge) ge.textContent=baht(et+NETFEE);
    }
    document.addEventListener("input",recompute);
    var eslipFile=null;
    async function eslipChosen(inp){ eslipFile=(inp.files&&inp.files[0])||null; var el=document.getElementById("eslipName"); if(!eslipFile){ if(el) el.textContent=""; return; } if(el) el.textContent="\ud83d\udcce Uploading\u2026"; try{ var b64=await readB64(eslipFile); var r=await fetch("/api/jobsheet/eslip",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({guideId:GID,date:DATE,slotIdx:SLOT,eslipBase64:b64,eslipMime:eslipFile.type||"image/jpeg"})}); var d=await r.json().catch(function(){return {};}); if(!r.ok){ if(el) el.textContent=""; alert(d.hint||d.detail||("Upload failed ("+r.status+")")); return; } if(el) el.textContent="Marked paid \u2713"; setTimeout(function(){ location.reload(); }, 1200); }catch(e){ if(el) el.textContent=""; alert("Upload failed: "+((e&&e.message)||e)); } }
    function readB64(file){ return new Promise(function(res,rej){ var fr=new FileReader(); fr.onload=function(){ var u=String(fr.result); res(u.substring(u.indexOf(",")+1)); }; fr.onerror=rej; fr.readAsDataURL(file); }); }
  </script>
</body></html>`;

  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
