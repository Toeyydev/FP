import { JOB_SHEET_COMPANY_INFO as CO } from "@/lib/company";
import { bahtText } from "@/lib/baht-text";
import { APPROVAL_TERM_TH } from "@/lib/certificates/state";
import { shortHash, type CertificatePayload } from "@/lib/certificates/payload";

// The certificate itself, as one deterministic HTML page.
//
// Deterministic matters: the same certificate rendered twice has to come out byte for
// byte the same, or the file hash means nothing. So there is no `new Date()` in here, no
// locale that depends on where this runs, and no randomness — every value on the page
// comes from the payload or from what the caller passes in.
//
// The page says what it is and does not overstate it. It is the company's own record,
// approved by a named person who was signed in at the time; it is not a tax invoice, and
// the guide is not asked to sign it again. What the guide did is on the page as the fact
// it is: they filed their expense report from their own account, at a time that is
// printed. They did not certify anything, and the page does not say they did.

const TH_MONTH = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

/** "2026-09-02" → "2 กันยายน 2569". Buddhist era, no timezone maths on a plain date. */
export function thaiDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${TH_MONTH[Number(m[2]) - 1] ?? ""} ${Number(m[1]) + 543}`;
}

/** An instant, in Bangkok, to the minute. Fixed offset — the country has no DST. */
export function thaiDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t + 7 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${TH_MONTH[d.getUTCMonth()]} ${d.getUTCFullYear() + 543} เวลา ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} น.`;
}

const money = (satang: number) => (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type CertificateView = {
  certificateNo: string;
  payload: CertificatePayload;
  payloadHash: string;
  signerName: string;
  signerRole: string;
  /** ISO. The moment the approval was recorded. */
  signedAt: string;
  auditRef: string;
};

export function renderCertificateHtml(v: CertificateView): string {
  const p = v.payload;
  const rows = p.rows.map((r, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(r.description)}</td>
      <td class="c">${esc(r.category)}</td>
      <td class="c">${r.pax}</td>
      <td class="r">${money(Math.round(r.price * 100))}</td>
      <td class="r">${money(r.amountSatang)}</td>
    </tr>`).join("\n");

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>${esc(v.certificateNo)}</title>
<style>
 @page { size: A4; margin: 16mm 15mm; }
 * { box-sizing: border-box; }
 body { font-family: "Sarabun", "Noto Sans Thai", "Leelawadee UI", sans-serif; color: #1c1917; font-size: 11pt; line-height: 1.6; margin: 0; }
 .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #b45309; padding-bottom: 9px; margin-bottom: 16px; }
 .org { font-size: 14pt; font-weight: 700; color: #b45309; }
 .org small { display: block; font-size: 8.5pt; color: #57534e; font-weight: 400; }
 .no { text-align: right; font-size: 9pt; color: #57534e; }
 .no b { display: block; font-size: 11pt; color: #1c1917; }
 h1 { font-size: 14pt; text-align: center; margin: 0 0 3px; }
 .kind { text-align: center; font-size: 9pt; color: #78716c; margin-bottom: 16px; }
 .notice { border: 1px solid #fcd34d; background: #fffbeb; padding: 7px 10px; font-size: 9.5pt; margin-bottom: 14px; }
 .notice b { color: #92400e; }
 table.facts { width: 100%; border-collapse: collapse; font-size: 10pt; margin-bottom: 14px; }
 table.facts th { text-align: left; width: 30%; font-weight: 600; color: #57534e; padding: 2px 0; vertical-align: top; }
 table.facts td { padding: 2px 0; }
 p { margin: 0 0 9px; text-indent: 2em; text-align: justify; }
 table.items { width: 100%; border-collapse: collapse; margin: 4px 0 12px; font-size: 10pt; }
 table.items th { background: #fef3c7; border: 1px solid #d6d3d1; padding: 5px 7px; font-weight: 600; text-align: left; }
 table.items td { border: 1px solid #e7e5e4; padding: 5px 7px; }
 .c { text-align: center; } .r { text-align: right; }
 tr.sum td { background: #fafaf9; font-weight: 700; border-top: 2px solid #b45309; }
 .words { font-size: 9.5pt; color: #57534e; font-style: italic; margin-bottom: 14px; }
 .approve { border: 1px solid #d6d3d1; padding: 10px 12px; margin-top: 6px; }
 .approve h2 { font-size: 10.5pt; margin: 0 0 6px; color: #b45309; }
 .approve table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
 .approve th { text-align: left; width: 32%; font-weight: 600; color: #57534e; padding: 2px 0; vertical-align: top; }
 .hash { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 8.5pt; }
 .foot { margin-top: 14px; border-top: 1px solid #e7e5e4; padding-top: 7px; font-size: 8pt; color: #78716c; line-height: 1.5; }
</style></head>
<body>
<div class="head">
  <div class="org">${esc(CO.brandName)}<small>${esc(CO.legalNameTh)} · เลขประจำตัวผู้เสียภาษี ${esc(CO.taxId)}</small></div>
  <div class="no">เลขที่<b>${esc(v.certificateNo)}</b>${esc(thaiDate(p.tourDate))}</div>
</div>

<h1>ใบรับรองแทนใบเสร็จรับเงิน</h1>
<div class="kind">Certificate in lieu of receipt · ใบงานเลขที่ ${esc(p.jobRef)}</div>

<div class="notice">
  <b>ใช้เป็นหลักฐานประกอบการบันทึกบัญชีภายใน · ไม่ใช่ใบกำกับภาษี</b><br>
  เอกสารนี้ออกโดยบริษัทเพื่อบันทึกค่าใช้จ่ายที่ไม่มีใบเสร็จรับเงินจากผู้ให้บริการ ไม่ใช่เอกสารทางภาษีและใช้เครดิตภาษีซื้อไม่ได้
</div>

<table class="facts">
  <tr><th>ใบงานเลขที่</th><td>${esc(p.jobRef)}</td></tr>
  <tr><th>วันที่ปฏิบัติงาน</th><td>${esc(thaiDate(p.tourDate))} (รอบที่ ${p.slotIdx})</td></tr>
  <tr><th>ไกด์ผู้สำรองจ่าย</th><td>${esc(p.guideName)} (รหัส ${esc(p.guideId)})</td></tr>
  <tr><th>ไกด์ส่งรายงานค่าใช้จ่าย</th><td>${p.guideReportedAt ? `ไกด์ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนเมื่อ ${esc(thaiDateTime(p.guideReportedAt))}` : "ไม่มีบันทึกการส่งรายงานจากบัญชีของไกด์"}</td></tr>
  <tr><th>จำนวนรายการ</th><td>${p.rows.length} รายการ รวม ${money(p.totalSatang)} บาท</td></tr>
</table>

<p>บริษัทขอรับรองว่า ค่าใช้จ่ายตามรายการข้างล่างนี้เกิดขึ้นจริงในการปฏิบัติงานนำเที่ยวตามใบงานที่อ้างถึง โดยไกด์เป็นผู้สำรองจ่ายไปก่อนและบริษัทมีหน้าที่ต้องจ่ายคืน</p>
<p>เหตุที่ไม่มีใบเสร็จรับเงินประกอบ: ${esc(p.reason)} อัตราที่เบิกเป็นราคาคงที่ที่บริษัทใช้เป็นมาตรฐานเดียวกันทุกงาน และจำนวนคนตรงกับจำนวนผู้เดินทางจริงรวมไกด์</p>

<table class="items">
  <thead><tr><th style="width:5%" class="c">ที่</th><th>รายการ</th><th style="width:13%" class="c">ประเภท</th><th style="width:9%" class="c">จำนวน</th><th style="width:15%" class="r">ราคา/หน่วย</th><th style="width:17%" class="r">จำนวนเงิน</th></tr></thead>
  <tbody>
${rows}
    <tr class="sum"><td colspan="5" class="r">รวมเป็นเงินที่ต้องจ่ายคืนไกด์</td><td class="r">${money(p.totalSatang)}</td></tr>
  </tbody>
</table>
<div class="words">จำนวนเงิน (ตัวอักษร) ${esc(bahtText(p.totalSatang / 100))}</div>

<p>รายการข้างต้นเป็นการจ่ายคืนเงินที่ไกด์สำรองจ่าย ไม่ถือเป็นค่าตอบแทนของไกด์ จึงไม่อยู่ในฐานคำนวณภาษีเงินได้หัก ณ ที่จ่าย</p>

<div class="approve">
  <h2>${esc(APPROVAL_TERM_TH)}</h2>
  <table>
    <tr><th>ผู้รับรอง</th><td>${esc(v.signerName)}</td></tr>
    <tr><th>ตำแหน่ง/สิทธิ์</th><td>${esc(v.signerRole)}</td></tr>
    <tr><th>รับรองเมื่อ</th><td>${esc(thaiDateTime(v.signedAt))}</td></tr>
    <tr><th>อ้างอิง audit</th><td class="hash">${esc(v.auditRef)}</td></tr>
    <tr><th>ลายนิ้วมือข้อมูลต้นทาง</th><td class="hash">${esc(shortHash(v.payloadHash))}…</td></tr>
  </table>
</div>

<div class="foot">
  ผู้รับรองยืนยันตัวตนผ่านการเข้าสู่ระบบของ FolkOPS และระบบบันทึกชื่อ สิทธิ์ และเวลาไว้ใน audit log — เอกสารนี้ไม่ได้ลงลายมือชื่ออิเล็กทรอนิกส์แบบเข้ารหัส (ไม่มีใบรับรองอิเล็กทรอนิกส์หรือกุญแจส่วนตัว)<br>
  ลายนิ้วมือข้อมูลต้นทางใช้ตรวจว่าใบงานถูกแก้ไขหลังการรับรองหรือไม่ และไม่ได้ใช้พิสูจน์ตัวบุคคลผู้รับรอง<br>
  ไกด์ไม่ต้องลงนามในเอกสารนี้ เนื่องจากไกด์ได้ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนไว้แล้วตามเวลาที่ระบุข้างต้น
</div>
</body></html>`;
}
