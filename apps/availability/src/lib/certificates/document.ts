import { JOB_SHEET_COMPANY_INFO as CO } from "@/lib/company";
import { bahtText } from "@/lib/baht-text";
import { sourceSentenceTh } from "@/lib/certificates/source";
import { APPROVAL_TERM_TH } from "@/lib/certificates/state";
import { shortHash, type CertificatePayload } from "@/lib/certificates/payload";
import { expenseCategoryLabelTh } from "@/lib/jobsheet";

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
// Everything that reaches the page goes through one of these two. The payload is read
// back out of a JSON column, so a value that was a number when it was written is only
// "a number" by convention by the time it is printed — `int` makes that true again
// rather than trusting it.
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]!);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);

/**
 * Which round of the day this was — the number the job reference already carries.
 *
 * FOLK-BKK-20990401-01 is the day's round 01, and the page should say the same thing
 * its own reference says: "รอบที่ 1". It used to print `slotIdx` raw, which is not a
 * round at all but a position in the departure grid counted from zero — "รอบที่ 0" on a
 * signed document, and "รอบที่ 2" for a 13:30 that was the day's first job. A reference
 * without a round number prints nothing rather than a guess. Wording only: the payload
 * and its hash are untouched, and nothing matches a job sheet by this.
 */
export function roundLabelTh(jobRef: unknown): string | null {
  // The round follows the eight-digit date (lib/jobref.ts). A reference that stops at
  // the date — jobsheet-drive.ts builds one when a sheet has no ref — has no round, and
  // its date must not be read as one.
  const m = /-\d{8}-(\d{2,})$/.exec(String(jobRef ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) && n > 0 ? `รอบที่ ${n}` : null;
}

/**
 * The expense type in Thai, from the one mapping FolkOPS keeps (EXPENSE_CATEGORIES).
 *
 * The payload stores the key ("meal", "transport") and hashes it; only the page
 * translates. A key that mapping does not know is printed as it came, escaped by the
 * caller — shown rather than hidden, because a row whose type nobody recognises is
 * something the reader should see.
 */
export function categoryLabelTh(raw: unknown): string {
  const key = String(raw ?? "").trim();
  if (!key) return "—";
  return expenseCategoryLabelTh({ expenseType: key }) ?? key;
}

export type CertificateView = {
  certificateNo: string;
  payload: CertificatePayload;
  payloadHash: string;
  attestedByName: string;
  attestedByRole: string;
  /** ISO. The moment the approval was recorded. */
  attestedAt: string;
  auditRef: string;
  /**
   * A draft: what this document WOULD say, shown before anything exists.
   *
   * It is not a lesser version of the certificate, it is a different document. There is
   * no attester, no audit reference and no signature, because none of those has happened
   * — and every page carries a watermark, because the failure this guards against is a
   * printed draft being filed as though it were the real thing.
   */
  draft?: boolean;
  /**
   * The attester's own signature image, already fetched, checked and inlined by
   * `lib/certificates/signature`. A `data:` URI, so the page fetches nothing while it
   * renders — the browser has the network switched off.
   *
   * Absent when that person has no signature registered, and the document is complete
   * without one: the name, the role, the time and the audit reference say who attested
   * it. What must never happen is somebody else's image appearing here, which is why it
   * arrives resolved rather than as a user id to look up.
   */
  signatureDataUri?: string | null;
  signatureVersion?: number | null;
};

/**
 * What this document does NOT cover.
 *
 * PEAK will print its own "ใบรับรองแทนใบเสร็จรับเงิน" from a whole EXP, and that page
 * adds up every line on it — the guide's fee, the review reward, the withholding and the
 * net transfer — because an EXP for a combined payment holds all of them. As evidence
 * for unreceipted expenses it is therefore useless: it certifies a number that is mostly
 * wages.
 *
 * This document is the opposite thing on purpose. It shows the covered reimbursement
 * rows and their total, and nothing else, so the sentence below is not a disclaimer
 * bolted onto a page that contradicts it — it is a description of what the page already
 * is. Anyone reconciling against PEAK needs both documents and should be told so here,
 * rather than discovering the totals differ and assuming one of them is wrong.
 */
export const SCOPE_NOTICE_TH =
  "เอกสารฉบับนี้ครอบคลุมเฉพาะรายการค่าใช้จ่ายที่ระบุด้านล่าง และไม่ครอบคลุมค่าจ้าง ค่าตอบแทน หรือรายการอื่นในเอกสาร PEAK ที่อ้างอิง";

/**
 * Loma first, and not for looks: for the text layer.
 *
 * Chromium writes each Thai cluster twice — the glyphs, each mapped back to a character,
 * and an /ActualText span with the real text. Noto Sans Thai (what production drew with
 * before) and Sarabun both lift a tone mark over an upper vowel by swapping in a glyph
 * that has no character of its own, so those glyphs map to U+0000. Readers that trust
 * /ActualText (poppler, Acrobat) cope; PDFium — Chrome's viewer, and so Drive's — prints
 * the span AND the glyphs ("บริษัริ ษัท"), and PDFKit drops the marks, so the document
 * could not be searched for its own company name.
 *
 * Every TLWG face maps every glyph it draws; Loma read back best of them. It comes from
 * `fonts-thai-tlwg`, which nixpacks.toml and CI already install. The renderer test holds
 * the rule itself — no glyph in the text layer may map to nothing — not the font name.
 */
const FONT_STACK = `"Loma", "Sarabun", "Noto Sans Thai", "Leelawadee UI", sans-serif`;

export function renderCertificateHtml(v: CertificateView): string {
  const p = v.payload;
  const rows = p.rows.map((r, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(r.description)}</td>
      <td class="c">${esc(categoryLabelTh(r.category))}</td>
      <td class="c">${int(r.pax)}</td>
      <td class="r">${money(Math.round(int(r.price * 100)))}</td>
      <td class="r">${money(r.amountSatang)}</td>
    </tr>`).join("\n");

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>${esc(v.certificateNo)}</title>
<style>
 @page { size: A4; margin: 16mm 15mm; }
 * { box-sizing: border-box; }
 body { font-family: ${FONT_STACK}; color: #1c1917; font-size: 11pt; line-height: 1.5; margin: 0; }
 .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #b45309; padding-bottom: 7px; margin-bottom: 12px; }
 .org { font-size: 14pt; font-weight: 700; color: #b45309; }
 .org small { display: block; font-size: 8.5pt; color: #57534e; font-weight: 400; }
 .no { text-align: right; font-size: 9pt; color: #57534e; }
 .no b { display: block; font-size: 11pt; color: #1c1917; }
 h1 { font-size: 14pt; text-align: center; margin: 0 0 3px; }
 .kind { text-align: center; font-size: 9pt; color: #78716c; margin-bottom: 10px; }
 .notice { border: 1px solid #fcd34d; background: #fffbeb; padding: 6px 10px; font-size: 9.5pt; margin-bottom: 10px; }
 .scope { display: block; margin-top: 3px; font-weight: 600; color: #92400e; }
 .notice b { color: #92400e; }
 table.facts { width: 100%; border-collapse: collapse; font-size: 10pt; margin-bottom: 10px; }
 table.facts th { text-align: left; width: 30%; font-weight: 600; color: #57534e; padding: 2px 0; vertical-align: top; }
 table.facts td { padding: 2px 0; }
 p { margin: 0 0 7px; text-indent: 2em; text-align: justify; }
 table.items { width: 100%; border-collapse: collapse; margin: 3px 0 6px; font-size: 10pt; }
 table.items th { background: #fef3c7; border: 1px solid #d6d3d1; padding: 5px 7px; font-weight: 600; text-align: left; }
 table.items td { border: 1px solid #e7e5e4; padding: 5px 7px; }
 .c { text-align: center; } .r { text-align: right; }
 tr.sum td { background: #fafaf9; font-weight: 700; border-top: 2px solid #b45309; }
 .words { font-size: 9.5pt; color: #57534e; font-style: italic; margin-bottom: 6px; }
 /* Never split across a page. An attestation broken in half — the name on one page and
    the signature on the next — is what a tampered document looks like, and a reader
    cannot tell the difference between that and a page that merely ran out of room. */
 .approve { border: 1px solid #d6d3d1; padding: 8px 11px; margin-top: 4px; break-inside: avoid; page-break-inside: avoid; }
 .approve h2 { font-size: 10.5pt; margin: 0 0 4px; color: #b45309; }
 .approve table { width: 100%; border-collapse: collapse; font-size: 9pt; }
 .approve th { text-align: left; width: 32%; font-weight: 600; color: #57534e; padding: 1px 0; vertical-align: top; }
 .hash { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 8.5pt; }
 /* A row in the attester's own table, rather than a panel underneath it. Two reasons,
    and they point the same way: it is bound to the name in the same table, so there is
    no arrangement of this page on which it reads as somebody else's — and it costs the
    height of the image alone, so adding a signature does not turn a one-page
    certificate into two. Capped in both directions, so an oddly proportioned scan
    cannot stretch the page either. */
 .sig td { padding-top: 2px; }
 .sig img { max-width: 150px; max-height: 34px; width: auto; height: auto; display: block; }
 .sig-ver { font-size: 8pt; color: #78716c; }
 /* Every page, not the first. A watermark that only marks page one is a watermark a
    two-page draft gets round by being stapled in a different order. A fixed position
    inside a paged medium repeats on each sheet, which is exactly what is wanted here. */
 .draft-mark { position: fixed; top: 44%; left: 0; right: 0; text-align: center; z-index: 9;
   font-size: 26pt; font-weight: 800; color: rgba(185, 28, 28, 0.16); letter-spacing: 0.04em;
   transform: rotate(-24deg); pointer-events: none; }
 .draft-banner { border: 1.5px solid #b91c1c; background: #fef2f2; color: #b91c1c;
   padding: 7px 10px; font-size: 10.5pt; font-weight: 700; text-align: center; margin-bottom: 10px; }
 .foot { margin-top: 6px; border-top: 1px solid #e7e5e4; padding-top: 5px; font-size: 8pt; color: #78716c; line-height: 1.35; }
</style></head>
<body>
${v.draft ? `<div class="draft-mark">ร่าง — ยังไม่รับรอง · ยังไม่ใช่หลักฐานบัญชี</div>` : ""}
<div class="head">
  <div class="org">${esc(CO.brandName)}<small>${esc(CO.legalNameTh)} · เลขประจำตัวผู้เสียภาษี ${esc(CO.taxId)}</small></div>
  <div class="no">เลขที่<b>${esc(v.certificateNo)}</b>${esc(thaiDate(p.tourDate))}</div>
</div>

<h1>ใบรับรองแทนใบเสร็จรับเงิน</h1>
<div class="kind">Certificate in lieu of receipt · ใบงานเลขที่ ${esc(p.jobRef)}</div>

${v.draft ? `<div class="draft-banner">ร่าง — ยังไม่รับรอง · ยังไม่ใช่หลักฐานบัญชี</div>` : ""}
<div class="notice">
  <b>ใช้เป็นหลักฐานประกอบการบันทึกบัญชีภายใน · ไม่ใช่ใบกำกับภาษี</b><br>
  เอกสารนี้ออกโดยบริษัทเพื่อบันทึกค่าใช้จ่ายที่ไม่มีใบเสร็จรับเงินจากผู้ให้บริการ ไม่ใช่เอกสารทางภาษีและใช้เครดิตภาษีซื้อไม่ได้<br>
  <span class="scope">${esc(SCOPE_NOTICE_TH)}</span>
</div>

<table class="facts">
  <tr><th>ใบงานเลขที่</th><td>${esc(p.jobRef)}</td></tr>
  <tr><th>วันที่ปฏิบัติงาน</th><td>${esc(thaiDate(p.tourDate))}${roundLabelTh(p.jobRef) ? ` (${esc(roundLabelTh(p.jobRef))})` : ""}</td></tr>
  <tr><th>ไกด์ผู้สำรองจ่าย</th><td>${esc(p.guideName)} (รหัส ${esc(p.guideId)})</td></tr>
  <tr><th>ที่มาของรายการ</th><td>${esc(sourceSentenceTh({
    source: p.source ?? "GUIDE_REPORTED",
    guideReportedAt: p.guideReportedAt,
    recordedByName: p.recordedBy?.name ?? null,
    recordedAt: p.recordedBy?.at ?? null,
    draft: v.draft,
  }, thaiDateTime))}</td></tr>
  <tr><th>จำนวนรายการ</th><td>${int(p.rows.length)} รายการ รวม ${money(p.totalSatang)} บาท</td></tr>
</table>

<p>บริษัทขอรับรองว่า ค่าใช้จ่ายตามรายการข้างล่างนี้เกิดขึ้นจริงในการปฏิบัติงานนำเที่ยวตามใบงานที่อ้างถึง โดยไกด์เป็นผู้สำรองจ่ายไปก่อนและบริษัทมีหน้าที่ต้องจ่ายคืน</p>
<p>เหตุที่ไม่มีใบเสร็จรับเงินประกอบ: ${esc(p.reason)} อัตราที่เบิกเป็นราคาคงที่ที่บริษัทใช้เป็นมาตรฐานเดียวกันทุกงาน และจำนวนคนตรงกับจำนวนผู้เดินทางจริงรวมไกด์</p>

<table class="items">
  <thead><tr><th style="width:5%" class="c">ที่</th><th>รายการ</th><th style="width:22%" class="c">ประเภท</th><th style="width:9%" class="c">จำนวน</th><th style="width:15%" class="r">ราคา/หน่วย</th><th style="width:17%" class="r">จำนวนเงิน</th></tr></thead>
  <tbody>
${rows}
    <tr class="sum"><td colspan="5" class="r">รวมเป็นเงินที่ต้องจ่ายคืนไกด์</td><td class="r">${money(p.totalSatang)}</td></tr>
  </tbody>
</table>
<div class="words">จำนวนเงิน (ตัวอักษร) ${esc(bahtText(p.totalSatang / 100))}</div>

<p>รายการข้างต้นเป็นการจ่ายคืนเงินที่ไกด์สำรองจ่าย ไม่ถือเป็นค่าตอบแทนของไกด์ จึงไม่อยู่ในฐานคำนวณภาษีเงินได้หัก ณ ที่จ่าย</p>

${v.draft ? `<div class="notice" style="border-color:#fca5a5;background:#fef2f2">
  เอกสารนี้เป็นเพียงตัวอย่างสำหรับตรวจทานก่อนออกใบรับรอง ยังไม่มีผู้รับรอง ยังไม่มีเลขอ้างอิง audit และยังใช้เป็นหลักฐานประกอบการบันทึกบัญชีไม่ได้
</div>` : `<div class="approve">
  <h2>${esc(APPROVAL_TERM_TH)}</h2>
  <table>
    <tr><th>ผู้รับรอง</th><td>${esc(v.attestedByName)}</td></tr>
    <tr><th>ตำแหน่ง/สิทธิ์</th><td>${esc(v.attestedByRole)}</td></tr>
    <tr><th>รับรองเมื่อ</th><td>${esc(thaiDateTime(v.attestedAt))}</td></tr>
    <tr><th>อ้างอิง audit</th><td class="hash">${esc(v.auditRef)}</td></tr>
    <tr><th>ลายนิ้วมือข้อมูลต้นทาง</th><td class="hash">${esc(shortHash(v.payloadHash))}…</td></tr>
${v.signatureDataUri ? `    <tr class="sig"><th>ภาพลายมือชื่อประกอบการรับรองทางอิเล็กทรอนิกส์</th><td>
      <img src="${esc(v.signatureDataUri)}" alt="ภาพลายมือชื่อของ ${esc(v.attestedByName)}">
      ${v.signatureVersion ? `<span class="sig-ver">(ฉบับที่ ${int(v.signatureVersion)})</span>` : ""}
    </td></tr>` : ""}
  </table>
</div>`}

<div class="foot">
  ผู้รับรองยืนยันตัวตนผ่านการเข้าสู่ระบบของ FolkOPS และระบบบันทึกชื่อ สิทธิ์ และเวลาไว้ใน audit log — เอกสารนี้ไม่ได้ลงลายมือชื่ออิเล็กทรอนิกส์แบบเข้ารหัส (ไม่มีใบรับรองอิเล็กทรอนิกส์หรือกุญแจส่วนตัว)<br>
  ลายนิ้วมือข้อมูลต้นทางใช้ตรวจว่าใบงานถูกแก้ไขหลังการรับรองหรือไม่ และไม่ได้ใช้พิสูจน์ตัวบุคคลผู้รับรอง<br>
  ไกด์ไม่ต้องลงนามในเอกสารนี้ เนื่องจากไกด์ได้ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนไว้แล้วตามเวลาที่ระบุข้างต้น
</div>
</body></html>`;
}
