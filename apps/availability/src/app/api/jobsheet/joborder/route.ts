import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { DEFAULT_GUIDE_FEE, type GuideFee, type Booking } from "@/lib/jobsheet";
import { decrypt } from "@/lib/crypto";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Folkpaths company constants for the legal job order (edit here if they change).
const OPERATOR_NAME = "โฟลค์พาธส์ ทราเวล";
const OPERATOR_LICENSE = "11/12700";
const SIGNATORY = "นางสาว หทัยวรรณ ใจปลอด";
const BLANK = "______________________";

// GET ?guideId&date&slotIdx — print-ready Thai "ใบสั่งงานมัคคุเทศก์ / Guide Job Order"
// populated from the assignment + job sheet. Per-passenger / travel blanks are
// left as fill-in lines, as the official form intends. Auto-opens the print dialog.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  if (!ops(session.user.role) && session.user.guideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [u, sheet, assignment] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
  ]);
  const tourId = sheet?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  const bookings = ((sheet?.bookings as Booking[]) ?? []);
  const guideFee = ((sheet?.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE);
  const guideName = u?.fullName || u?.displayName || "";
  const ref = sheet?.ref || `FOLK-BKK-${date.replace(/-/g, "")}`;
  const [yy, mm, dd] = date.split("-");
  const dateTH = `${dd}/${mm}/${yy}`;
  const adults = bookings.reduce((s, b) => s + (b.actualPax ?? b.bookedPax ?? 0), 0) || (assignment?.pax ?? 0);
  const rate = guideFee.price != null ? guideFee.price.toLocaleString("en-US") : "............";
  const licenseNo = u?.licenseNo?.trim() || "";
  const signatureImg = u?.signature ? decrypt(u.signature) : "";

  // Tourist rows: list known names; passport + nationality stay blank to fill in.
  let n = 0;
  const touristRows = bookings.flatMap((b) => {
    const count = Math.max(1, b.bookedPax ?? 1);
    return Array.from({ length: count }, (_, i) => {
      n++;
      const name = i === 0 ? esc(b.name) : "";
      const note = i === 0 ? esc(b.bookingNo) : "";
      return `<tr><td class="c">${n}</td><td>${name}</td><td></td><td></td><td>${note}</td></tr>`;
    });
  }).join("") || `<tr><td class="c">1</td><td></td><td></td><td></td><td></td></tr><tr><td class="c">2</td><td></td><td></td><td></td><td></td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8"><title>${esc(ref)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600&family=Noto+Sans+Thai:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "Sarabun","Noto Sans Thai",sans-serif; color:#000; font-size:13px; line-height:1.55; margin:0; }
  .toolbar { background:#7e3a2c; color:#fff; padding:9px 16px; display:flex; justify-content:space-between; align-items:center; }
  .toolbar button { background:#fff; color:#7e3a2c; border:none; border-radius:7px; padding:7px 14px; font-weight:600; cursor:pointer; }
  .page { max-width:820px; margin:14px auto; padding:0 18px; }
  h1 { text-align:center; font-size:18px; margin:0; }
  h1 small { display:block; font-size:13px; font-weight:400; letter-spacing:2px; }
  .sec { background:#eef3ef; border:1px solid #cfd9d3; padding:5px 9px; font-weight:600; margin:14px 0 8px; }
  .row { margin:4px 0; }
  .meta { display:flex; justify-content:space-between; border:1px solid #cfd9d3; padding:6px 10px; }
  .indent { margin-left:22px; }
  .chk { margin-right:14px; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; margin-top:6px; font-size:12px; }
  th,td { border:1px solid #999; padding:4px 6px; vertical-align:top; }
  th { background:#f2f2f2; font-weight:600; text-align:center; }
  td.c { text-align:center; width:34px; }
  .counts { display:flex; gap:22px; margin-top:6px; }
  .sign { margin-top:34px; text-align:right; }
  @media print { .toolbar { display:none; } .page { margin:0; } }
</style></head>
<body>
  <div class="toolbar"><span>ใบสั่งงานมัคคุเทศก์ · ${esc(ref)} · แตะช่องว่างเพื่อกรอกข้อมูล (tap any blank to fill it in)</span><button onclick="window.print()">Save as PDF / Print</button></div>
  <div class="page" contenteditable="true" spellcheck="false">
    <h1>ใบสั่งงานมัคคุเทศก์<small>GUIDE JOB ORDER</small></h1>

    <div class="sec">ส่วนที่ ๑ ข้อมูลใบสั่งงานและผู้ประกอบการ</div>
    <div class="meta"><span>ใบสั่งงานเลขที่ <b>${esc(ref)}</b></span><span>วันที่ <b>${esc(dateTH)}</b></span></div>
    <div class="row">๑. ชื่อผู้ประกอบธุรกิจนำเที่ยว: <b>${esc(OPERATOR_NAME)}</b></div>
    <div class="row indent">ใบอนุญาตประกอบธุรกิจนำเที่ยวเลขที่ <b>${esc(OPERATOR_LICENSE)}</b></div>
    <div class="row">๒. ขอมอบหมายให้</div>
    <div class="row indent">๒.๑ <b>${esc(guideName)}</b> ใบอนุญาตเป็นมัคคุเทศก์เลขที่ ${licenseNo ? `<b>${esc(licenseNo)}</b>` : BLANK}</div>
    <div class="row indent">ปฏิบัติหน้าที่เป็นมัคคุเทศก์เพื่อให้บริการแก่นักท่องเที่ยวคณะนี้ ในอัตราค่าตอบแทนวันละ <b>${esc(rate)}</b> บาท</div>
    <div class="row indent">ทัวร์: <b>${esc(tour?.name ?? tourId)}</b> · เวลา ${esc(SLOT_TIMES[slotIdx] ?? tour?.time ?? "")}</div>

    <div class="sec">ส่วนที่ ๒ ข้อมูลคณะนักท่องเที่ยวและการเดินทาง</div>
    <div class="row">๓. ชื่อบริษัทนำเที่ยวจากต่างประเทศ ${BLANK}${BLANK}</div>
    <div class="row">๔. เดินทางจากประเทศ ${BLANK}${BLANK}</div>
    <div class="row">ช่องทางที่คณะนักท่องเที่ยวเดินทางมาถึง เดินทางโดย</div>
    <div class="row indent"><span class="chk">☐ เครื่องบิน เที่ยวบินที่ ........</span><span class="chk">☐ รถ ทะเบียน ........</span><span class="chk">☐ เรือ ชื่อเรือ ........</span><span class="chk">☐ อื่น ๆ ........</span></div>
    <div class="row indent">วันที่เดินทางมาถึง วันที่ ...... เดือน .......... ปี ..........</div>
    <div class="row">ช่องทางที่คณะนักท่องเที่ยวเดินทางกลับ เดินทางโดย</div>
    <div class="row indent"><span class="chk">☐ เครื่องบิน เที่ยวบินที่ ........</span><span class="chk">☐ รถ ทะเบียน ........</span><span class="chk">☐ เรือ ชื่อเรือ ........</span><span class="chk">☐ อื่น ๆ ........</span></div>
    <div class="row indent">วันที่เดินทางกลับ วันที่ ...... เดือน .......... ปี ..........</div>

    <div class="row" style="margin-top:10px;font-weight:600;">รายชื่อนักท่องเที่ยว</div>
    <table>
      <thead><tr><th>ลำดับ</th><th>ชื่อ - สกุล</th><th>บัตรประชาชน / หนังสือเดินทาง</th><th>สัญชาติ</th><th>หมายเหตุ</th></tr></thead>
      <tbody>${touristRows}</tbody>
    </table>
    <div class="counts">
      <span>ผู้ใหญ่ <b>${adults || "……"}</b></span>
      <span>เด็ก ……</span>
      <span>ผู้ติดตาม ……</span>
      <span>รวม <b>${adults || "……"}</b></span>
    </div>

    <div class="sign">
      ${signatureImg ? `<img src="${signatureImg}" alt="signature" style="height:52px;display:block;margin:0 0 -8px auto" />` : ""}
      ลงชื่อ .............................................<br>
      ( ${esc(SIGNATORY)} )<br>
      ผู้ประกอบธุรกิจนำเที่ยว / ผู้ได้รับมอบอำนาจ
    </div>
  </div>
  <!-- No auto-print: fill in the blanks first, then use the Print button. -->
</body></html>`;

  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
