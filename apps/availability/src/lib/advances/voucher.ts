import type { PrismaClient } from "@prisma/client";
import { bahtText } from "@/lib/baht-text";
import { JOB_SHEET_COMPANY_INFO as CO } from "@/lib/company";
import { thb } from "@/lib/jobsheet";
import { fromSatang } from "./rules";

// The paper a guide gets when the company hands them money.
//
// Until now the guide received nothing: the transfer landed, and what it was for
// and when it had to be cleared lived only in someone's memory. That is how ฿400
// stayed with a guide for three weeks with nobody able to say whether it was owed.
//
// The document is deliberately NOT a receipt and NOT a tax invoice. An advance is
// the company's own money moved into someone's hands — an ASSET (เงินทดรองจ่าย),
// not an expense — so it carries no VAT, no withholding tax, and no expense
// account. It becomes an expense only later, when the tickets are settled against
// it. The voucher says all of that on its face, because the guide, the accountant
// and an auditor each read this page for a different reason.

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Bangkok-readable date: 2026-09-20 → 20 ก.ย. 2569 */
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
export function thaiDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${TH_MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[1]) + 543}`;
}

/** How long a guide has to clear an advance. Stated on the voucher so it is a rule, not a habit. */
export const CLEAR_WITHIN_DAYS = 3;

export type VoucherInput = {
  advanceNo: string;
  guideId: string;
  guideName?: string | null;
  jobNo?: string | null;
  tourName?: string | null;
  tourDate?: string | null;
  advanceDate: string;
  amountSatang: number;
  purpose?: string | null;
  method?: string | null;
  txRef?: string | null;
  bankName?: string | null;
  slipUrl?: string | null;
  peakDocumentNo?: string | null;
  issuedBy?: string | null;
  acknowledgedAt?: Date | null;
};

const PURPOSE_FALLBACK = "ค่าบัตรเข้าชมสถานที่สำหรับลูกค้า / Customer entrance tickets";

/** The voucher's file name in Drive, and the name an operator will search for. */
export const voucherDriveName = (v: Pick<VoucherInput, "advanceNo" | "jobNo">) =>
  `${v.advanceNo}${v.jobNo ? ` — ${v.jobNo}` : ""} — advance voucher`;

export const voucherDriveFolder = (advanceDate: string) => [
  "Folkpaths Job Sheets",
  `${advanceDate.slice(0, 7)} ${MONTHS[Number(advanceDate.slice(5, 7)) - 1] ?? ""}`.trim(),
  "Advances",
];

/**
 * The voucher, as HTML that Google Drive turns into a document. Pure: everything
 * it prints comes from the input, so the wording can be tested without a database.
 */
export function advanceVoucherHtml(v: VoucherInput): string {
  const amount = fromSatang(v.amountSatang);
  const row = (label: string, thaiLabel: string, value: string) =>
    `<tr><td style="color:#555;white-space:nowrap;vertical-align:top">${esc(label)} <small style="font-size:8px;color:#8a8f8b">${esc(thaiLabel)}</small></td><td><b>${value}</b></td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(v.advanceNo)}</title></head>
<body style="font-family:Sarabun,Arial,sans-serif;color:#111;font-size:13px">
  <div style="font-size:12px;font-weight:600;letter-spacing:1px">${esc(CO.brandName)}</div>
  <div style="color:#666;font-size:9px">Operated by ${esc(CO.operatedBy)} / ${esc(CO.legalNameTh)}</div>
  <div style="color:#8a8f8b;font-size:8.5px;margin-bottom:14px">Tax ID ${esc(CO.taxId)} · Tour Operator ${esc(CO.tourOperatorNameTh)} · License ${esc(CO.tourismLicenseNo)}</div>

  <h2 style="margin:0 0 2px;font-size:17px">ใบสำคัญจ่ายเงินทดรอง</h2>
  <div style="color:#666;font-size:10.5px;margin-bottom:12px">Advance Voucher · ${esc(v.advanceNo)}</div>

  <table border="0" cellpadding="6" style="border-collapse:collapse;margin-bottom:12px;font-size:12.5px">
    ${row("Guide", "ไกด์", `${esc(v.guideId)}${v.guideName ? ` ${esc(v.guideName)}` : ""}`)}
    ${v.jobNo ? row("Job No.", "เลขที่งาน", esc(v.jobNo)) : ""}
    ${v.tourName ? row("Tour", "ทัวร์", esc(v.tourName)) : ""}
    ${v.tourDate ? row("Tour date", "วันที่ทัวร์", `${esc(thaiDate(v.tourDate))} <span style="color:#8a8f8b;font-weight:400">(${esc(v.tourDate)})</span>`) : ""}
    ${row("Transferred", "วันที่โอน", `${esc(thaiDate(v.advanceDate))} <span style="color:#8a8f8b;font-weight:400">(${esc(v.advanceDate)})</span>`)}
  </table>

  <table border="0" cellpadding="10" style="border-collapse:collapse;width:100%;background:#f6f3f0;margin-bottom:12px">
    <tr>
      <td style="font-size:11px;color:#555">จำนวนเงินทดรอง <small style="font-size:8px;color:#8a8f8b">Advance amount</small>
        <div style="font-size:24px;font-weight:700;margin-top:2px">${esc(thb(amount))}</div>
        <div style="font-size:11.5px;color:#444;margin-top:2px">( ${esc(bahtText(amount))} )</div>
      </td>
      <td style="font-size:11px;color:#555;text-align:right;vertical-align:top">วัตถุประสงค์ <small style="font-size:8px;color:#8a8f8b">Purpose</small>
        <div style="font-size:12.5px;font-weight:600;color:#111;margin-top:4px">${esc(v.purpose?.trim() || PURPOSE_FALLBACK)}</div>
      </td>
    </tr>
  </table>

  <table border="0" cellpadding="6" style="border-collapse:collapse;margin-bottom:12px;font-size:12.5px">
    ${row("Paid by", "ช่องทางจ่าย", v.method === "cash" ? "เงินสด / Cash" : `โอนเงิน / Bank transfer${v.bankName ? ` · ${esc(v.bankName)}` : ""}`)}
    ${v.txRef ? row("Bank reference", "เลขอ้างอิงธนาคาร", `<span style="font-family:'Courier New',monospace">${esc(v.txRef)}</span>`) : ""}
    ${v.slipUrl ? row("Transfer slip", "สลิปโอนเงิน", `<a href="${esc(v.slipUrl)}">เปิดสลิป / open slip</a>`) : ""}
    ${v.peakDocumentNo ? row("Accounting document", "เอกสารบัญชี", `<span style="font-family:'Courier New',monospace">${esc(v.peakDocumentNo)}</span>`) : ""}
  </table>

  <div style="border-left:3px solid #c2604a;padding:2px 0 2px 10px;font-size:11.5px;color:#444;line-height:1.7;margin-bottom:14px">
    เงินจำนวนนี้เป็น<b>เงินของบริษัท</b> มอบให้เพื่อใช้ตามวัตถุประสงค์ข้างต้นเท่านั้น ไม่ใช่ค่าจ้างหรือรายได้ของผู้รับ<br>
    ผู้รับต้อง<b>เก็บตั๋วหรือใบเสร็จทุกใบ</b> บันทึกค่าใช้จ่ายในใบงานภายในวันที่ทัวร์จบ
    และ<b>คืนเงินส่วนที่เหลือภายใน ${CLEAR_WITHIN_DAYS} วันทำการ</b> นับจากวันที่ทัวร์จบ<br>
    เงินทดรองที่ยังไม่ได้เคลียร์จะถูกหักจากค่าจ้างรอบถัดไป โดยจะแสดงเป็นรายการหักในใบสรุปการจ่ายเงิน
  </div>

  <div style="font-size:10px;color:#8a8f8b;line-height:1.6;margin-bottom:16px">
    <b>หมายเหตุทางบัญชี</b> · เอกสารนี้<b>ไม่ใช่ใบเสร็จรับเงินและไม่ใช่ใบกำกับภาษี</b>
    ไม่มีภาษีมูลค่าเพิ่มและไม่มีการหักภาษี ณ ที่จ่าย เนื่องจากเงินทดรองจ่ายไม่ใช่ค่าจ้างหรือค่าบริการ<br>
    บันทึกบัญชี: เดบิต เงินทดรองจ่าย - ไกด์ (สินทรัพย์) / เครดิต เงินฝากธนาคาร —
    ค่าใช้จ่ายจะรับรู้เมื่อมีการเคลียร์ด้วยใบเสร็จของจริงเท่านั้น
  </div>

  <table border="0" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:11.5px">
    <tr>
      <td style="width:50%;vertical-align:bottom">
        ${v.acknowledgedAt
          ? `<div style="border-bottom:1px solid #111;padding-bottom:4px">ยืนยันรับเงินในแอปเมื่อ ${esc(new Date(v.acknowledgedAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }))}</div>`
          : `<div style="border-bottom:1px solid #111;height:34px"></div>`}
        <small style="color:#666">ผู้รับเงิน / Received by — ${esc(v.guideId)}${v.guideName ? ` ${esc(v.guideName)}` : ""}</small>
      </td>
      <td style="width:50%;vertical-align:bottom">
        <div style="border-bottom:1px solid #111;height:34px"></div>
        <small style="color:#666">ผู้อนุมัติ / Approved by${v.issuedBy ? ` — ${esc(v.issuedBy)}` : ""}</small>
      </td>
    </tr>
  </table>
</body></html>`;
}

export type VoucherDeps = {
  enabled: boolean;
  token: () => Promise<string | null>;
  saveHtml: (o: { refreshToken: string; name: string; html: string; folderPath: string[] }) => Promise<{ id: string; link: string }>;
};

/**
 * Render the voucher and file it in Drive beside the transfer slip, then record
 * the link on the advance.
 *
 * Best-effort by design: a Drive outage must never stop money being recorded, so
 * this returns null instead of throwing. The link can be produced again at any
 * time — the voucher is derived from the ledger, not stored only in Drive.
 */
export async function saveAdvanceVoucher(
  db: Pick<PrismaClient, "guideAdvance" | "user" | "jobSheet" | "tour">,
  advanceId: string,
  deps: VoucherDeps,
): Promise<string | null> {
  try {
    if (!deps.enabled) return null;
    const advance = await db.guideAdvance.findUnique({ where: { id: advanceId } });
    if (!advance) return null;
    const refreshToken = await deps.token();
    if (!refreshToken) return null;

    const [guide, sheet] = await Promise.all([
      db.user.findUnique({ where: { guideId: advance.guideId }, select: { displayName: true } }),
      advance.jobNo
        ? db.jobSheet.findFirst({ where: { ref: advance.jobNo, guideId: advance.guideId }, select: { date: true, tourId: true } })
        : Promise.resolve(null),
    ]);
    const tour = sheet?.tourId ? await db.tour.findUnique({ where: { id: sheet.tourId }, select: { name: true } }) : null;

    const html = advanceVoucherHtml({
      advanceNo: advance.advanceNo, guideId: advance.guideId, guideName: guide?.displayName,
      jobNo: advance.jobNo, tourName: tour?.name, tourDate: sheet?.date,
      advanceDate: advance.advanceDate, amountSatang: advance.amountSatang,
      purpose: advance.purpose, method: advance.method, txRef: advance.txRef,
      slipUrl: advance.slipUrl, peakDocumentNo: advance.peakDocumentNo,
      acknowledgedAt: advance.acknowledgedAt,
    });

    const up = await deps.saveHtml({
      refreshToken,
      name: voucherDriveName({ advanceNo: advance.advanceNo, jobNo: advance.jobNo }),
      html,
      folderPath: voucherDriveFolder(advance.advanceDate),
    });
    await db.guideAdvance.update({
      where: { id: advanceId },
      data: { voucherUrl: up.link, voucherFileId: up.id, voucherIssuedAt: new Date() },
    });
    return up.link;
  } catch {
    return null;
  }
}
