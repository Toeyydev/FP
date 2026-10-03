// The "Company advances" report: every advance, what it was for, what is settled and what
// guides still hold — as a PDF filed in the company Drive beside the other documents
// (Folkpaths Job Sheets / <month> / Advances), the way job sheets and slips are filed.
//
// Read-only on the ledger: it reads advances and their summaries (lib/advances/summaries,
// the one definition the Advances page uses) and writes nothing but the PDF and an audit
// row. Same-day reports replace each other (Drive replace mode on the same name), so a
// person pressing it twice gets one file.
import type { PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { fromSatang } from "@/lib/advances/rules";
import { summariesFor } from "@/lib/advances/summaries";
import { advanceSyncStates } from "@/lib/advances/peak-sync";
import { FONT_STACK } from "@/lib/certificates/document";

export type ReportRow = {
  advanceNo: string; peakDocumentNo: string | null; guideId: string; advanceDate: string; jobNo: string | null;
  amount: number; settled: number; outstanding: number; status: string | null; reversed: boolean;
};

const STATUS: Record<string, string> = { OPEN: "Open · ยังไม่ใช้", IN_USE: "In use · กำลังใช้", RETURN_DUE: "Return due · รอคืนเงิน", SETTLED: "Settled · เคลียร์แล้ว", VOID: "Reversed · กลับรายการ" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const baht = (n: number) => `฿${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pure: the report as HTML. `printedAt` is Bangkok "YYYY-MM-DD HH:mm". */
export function advancesReportHtml(rows: ReportRow[], printedAt: string): string {
  const live = rows.filter((r) => !r.reversed);
  const owed = live.filter((r) => r.outstanding > 0);
  const total = (k: "amount" | "settled" | "outstanding") => live.reduce((t, r) => t + r[k], 0);
  const tr = rows.map((r) => `<tr${r.reversed ? ' class="rev"' : ""}>
    <td>${esc(r.advanceNo)}${r.peakDocumentNo ? `<div class="sub">PEAK ${esc(r.peakDocumentNo)}</div>` : ""}</td>
    <td>${esc(r.guideId)}</td><td>${esc(r.advanceDate)}</td><td>${esc(r.jobNo ?? "—")}</td>
    <td class="r">${baht(r.amount)}</td><td class="r">${baht(r.settled)}</td><td class="r"><b>${baht(r.outstanding)}</b></td>
    <td>${esc(STATUS[r.status ?? ""] ?? "Needs review · ต้องตรวจ")}</td></tr>`).join("\n");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Company advances ${esc(printedAt.slice(0, 10))}</title><style>
 @page { size: A4 landscape; margin: 12mm 10mm; }
 body { font-family: ${FONT_STACK}; color: #1c1917; font-size: 10pt; margin: 0; }
 h1 { font-size: 15pt; margin: 0 0 2px; } .m { color: #57534e; font-size: 9pt; margin-bottom: 10px; }
 table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #d6d3d1; padding: 5px 7px; text-align: left; vertical-align: top; }
 th { background: #f5f5f4; font-size: 9pt; } td.r, th.r { text-align: right; white-space: nowrap; }
 .sub { color: #78716c; font-size: 8.5pt; } tr.rev td { color: #a8a29e; text-decoration: line-through; }
 tr.sum td { font-weight: 700; border-top: 2px solid #1c1917; background: #fafaf9; }
 .foot { margin-top: 8px; color: #78716c; font-size: 8pt; }
</style></head><body>
<h1>Company advances · เงินทดรองจ่ายไกด์</h1>
<div class="m">${owed.length} outstanding · ${baht(total("outstanding"))} with guides · พิมพ์เมื่อ ${esc(printedAt)} (เวลากรุงเทพฯ) · FolkOPS</div>
<table><thead><tr><th>Advance · เลขที่</th><th>Guide</th><th>Date · วันโอน</th><th>Job</th><th class="r">Amount</th><th class="r">Settled</th><th class="r">Outstanding</th><th>Status</th></tr></thead>
<tbody>
${tr || '<tr><td colspan="8">No advance has been recorded.</td></tr>'}
<tr class="sum"><td colspan="4">รวม (ไม่นับรายการที่กลับรายการ)</td><td class="r">${baht(total("amount"))}</td><td class="r">${baht(total("settled"))}</td><td class="r">${baht(total("outstanding"))}</td><td></td></tr>
</tbody></table>
<div class="foot">ตัวเลขจากบัญชีเงินทดรองใน FolkOPS ณ เวลาที่พิมพ์ · Settled = ตัดด้วยค่าใช้จ่ายที่อนุมัติ เงินคืน หรือการหักจากค่าจ้าง</div>
</body></html>`;
}

/** The ledger as the report shows it. */
export async function reportRows(db: PrismaClient): Promise<ReportRow[]> {
  const rows = await db.guideAdvance.findMany({ orderBy: [{ advanceDate: "desc" }, { advanceNo: "desc" }], take: 1000 });
  const summaries = await summariesFor(db, rows);
  const sync = await advanceSyncStates(db, rows.map((r) => `ADVANCE:${r.id}`));
  return rows.map((r) => {
    const s = summaries.get(r.id)!;
    return {
      advanceNo: r.advanceNo, peakDocumentNo: r.peakDocumentNo ?? sync.get(`ADVANCE:${r.id}`)?.documentNo ?? null,
      guideId: r.guideId, advanceDate: r.advanceDate, jobNo: r.jobNo,
      amount: fromSatang(s.issued), settled: fromSatang(s.ledgerSettled), outstanding: fromSatang(s.outstanding),
      status: s.status, reversed: !!r.reversedAt,
    };
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const bangkokNow = (d = new Date()) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
/** Where it is filed: the same Advances folder as the slips and vouchers of that month. */
export const reportFolder = (day: string) => ["Folkpaths Job Sheets", `${day.slice(0, 7)} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""}`.trim(), "Advances"];
export const reportFileName = (day: string) => `Company advances ${day}.pdf`;

export type FileDeps = {
  render: (html: string) => Promise<Buffer>;
  save: (o: { name: string; base64: string; mimeType: string; folderPath: string[] }) => Promise<{ id: string; link: string }>;
  now?: () => Date;
};

/** Render the report and file it in Drive. Returns the Drive link. */
export async function fileAdvancesReport(db: PrismaClient, deps: FileDeps, actor: { actorId: string | null; actorRole: string | null }) {
  const printedAt = bangkokNow(deps.now?.() ?? new Date());
  const day = printedAt.slice(0, 10);
  const rows = await reportRows(db);
  const pdf = await deps.render(advancesReportHtml(rows, printedAt));
  const up = await deps.save({ name: reportFileName(day), base64: pdf.toString("base64"), mimeType: "application/pdf", folderPath: reportFolder(day) });
  const live = rows.filter((r) => !r.reversed);
  await audit({ ...actor, action: "advances.report_filed", entityType: "GuideAdvance", detail: {
    fileId: up.id, name: reportFileName(day), folder: reportFolder(day).join(" / "), advances: live.length,
    outstanding: live.reduce((t, r) => t + r.outstanding, 0), printedAt,
  } });
  return { link: up.link, name: reportFileName(day), folder: reportFolder(day).join(" / "), advances: live.length };
}
