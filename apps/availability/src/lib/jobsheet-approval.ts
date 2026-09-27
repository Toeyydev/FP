// What a job sheet says about its approval — on screen, in the PDF, and in the Drive copy.
//
// A job sheet is the operating record of a tour and the approval of its expenses. It is NOT
// a certificate in lieu of receipt: that is a separate accounting document with its own
// number, PDF and Drive file (lib/certificates). So the sheet carries no certification
// statement and no signature — only who approved the expenses, and when, from
// JobSheet.approvalStatus / approvedBy / approvedAt. Nothing here writes anything.

export const JOB_SHEET_ROLE_NOTE_TH =
  "Job Sheet เป็นเอกสารปฏิบัติงานและการอนุมัติค่าใช้จ่าย ไม่ใช่ใบรับรองแทนใบเสร็จรับเงิน — ใบรับรองแทนใบเสร็จรับเงิน (ถ้ามี) เป็นหลักฐานประกอบบัญชีแยกต่างหาก";

export type ApprovalView = { approved: boolean; statusTh: string; statusEn: string; approverName: string | null; approvedAt: string | null };

/** "13 Aug 2026 14:07" in Thailand time — the full timestamp stays in the database. */
export function fmtApprovedAt(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" });
  return `${day} ${time}`;
}

export function approvalView(sheet: { approvalStatus?: string | null; approvedAt?: string | Date | null }, approverName: string | null | undefined): ApprovalView {
  const approved = (sheet.approvalStatus ?? "") === "APPROVED";
  return {
    approved,
    statusTh: approved ? "อนุมัติแล้ว" : "ยังไม่อนุมัติ",
    statusEn: approved ? "Approved" : "Not approved",
    approverName: approved ? (approverName ?? "").trim() || null : null,
    approvedAt: approved ? fmtApprovedAt(sheet.approvedAt) : null,
  };
}

/** The approver's display name, from User — never from the sheet's own fields. */
export async function approverNameOf(
  db: { user: { findUnique(a: { where: { id: string }; select: { fullName: true; displayName: true; email: true } }): Promise<{ fullName: string | null; displayName: string | null; email: string | null } | null> } },
  approvedBy: string | null | undefined,
): Promise<string | null> {
  if (!approvedBy) return null;
  const u = await db.user.findUnique({ where: { id: approvedBy }, select: { fullName: true, displayName: true, email: true } }).catch(() => null);
  return (u?.fullName || u?.displayName || u?.email || "").trim() || null;
}

/** The approval block as HTML, for the PDF and the Drive copy. `esc` is the caller's escaper. */
export function approvalHtml(v: ApprovalView, esc: (s: string) => string): string {
  const row = (k: string, val: string) => `<tr><td style="color:#555;padding:2px 12px 2px 0;white-space:nowrap">${k}</td><td>${val}</td></tr>`;
  return `
      <div class="js-approval" style="margin-top:22px;border-top:1px dashed #cdd3cf;padding-top:10px;page-break-inside:avoid;break-inside:avoid">
        <div style="font-size:12px;font-weight:700;margin-bottom:4px">Approval <span style="font-size:10px;color:#8a8f8b;font-weight:400">การอนุมัติค่าใช้จ่าย</span></div>
        <table style="border-collapse:collapse;font-size:12px"><tbody>
          ${row("Status <small style=\"color:#8a8f8b\">สถานะ</small>", `<b>${esc(v.statusTh)}</b> · ${esc(v.statusEn)}`)}
          ${v.approved ? row("Approved by <small style=\"color:#8a8f8b\">ผู้อนุมัติ</small>", esc(v.approverName ?? "—")) : ""}
          ${v.approved ? row("Approved at <small style=\"color:#8a8f8b\">วันเวลาที่อนุมัติ</small>", esc(v.approvedAt ?? "—")) : ""}
        </tbody></table>
        <div style="font-size:9.5px;color:#6b746f;margin-top:6px;line-height:1.5">${esc(JOB_SHEET_ROLE_NOTE_TH)}</div>
      </div>`;
}
