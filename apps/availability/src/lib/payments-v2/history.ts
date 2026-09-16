// Financial history protection. A job that has ever been paid, slipped, batched, booked
// in PEAK, advanced or matched to a bank slip keeps that evidence: deleting the job would
// delete its TourPayment row (paid date, slips, EXP refs) and its job sheet (the figures
// and the Job No.). Such a job is not hard-deleted — reverse the payment or void the
// document instead, and keep the record.
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
export type JobKey = { guideId: string; date: string; slotIdx: number };

/** Every reason these jobs may not be deleted — one line each, naming the evidence. Empty when none. */
export async function financialHistoryBlockers(db: Db, jobs: JobKey[]): Promise<string[]> {
  if (!jobs.length) return [];
  const or = jobs.map((j) => ({ guideId: j.guideId, date: j.date, slotIdx: j.slotIdx }));
  const [payJobs, pays, sheets, batchItems, advances, returns] = await Promise.all([
    db.guidePaymentJob.findMany({ where: { OR: or }, select: { guideId: true, date: true, slotIdx: true, jobNo: true, active: true, paymentId: true } }),
    db.tourPayment.findMany({ where: { OR: or }, select: { guideId: true, date: true, slotIdx: true, status: true, eslipUrl: true, slips: true, peakRef: true, peakPaymentRef: true, paidBatchNo: true } }),
    db.jobSheet.findMany({ where: { OR: or }, select: { id: true, guideId: true, date: true, slotIdx: true, ref: true, peakDocumentNo: true, peakDocumentId: true, peakSyncStatus: true } }),
    db.paymentBatchItem.findMany({ where: { OR: or }, select: { guideId: true, date: true, slotIdx: true, batchId: true } }),
    db.guideAdvance.findMany({ where: { OR: or }, select: { guideId: true, date: true, slotIdx: true } }),
    db.guideAdvanceReturn.findMany({ where: { OR: or }, select: { guideId: true, date: true, slotIdx: true } }),
  ]);
  const [payments, batches] = await Promise.all([
    payJobs.length ? db.guidePayment.findMany({ where: { id: { in: [...new Set(payJobs.map((j) => j.paymentId))] } }, select: { id: true, paymentNo: true, status: true } }) : [],
    batchItems.length ? db.paymentBatch.findMany({ where: { id: { in: [...new Set(batchItems.map((b) => b.batchId))] } }, select: { id: true, batchNo: true } }) : [],
  ]);
  const sheetIds = sheets.map((s) => s.id);
  const [matched, docs] = await Promise.all([
    sheetIds.length ? db.paymentTransaction.findMany({ where: { matchedJobSheetId: { in: sheetIds } }, select: { matchedJobSheetId: true } }) : [],
    Promise.all(jobs.map((j) => db.guidePaymentDocument.findMany({ where: { guideId: j.guideId, jobs: { array_contains: [{ date: j.date, slotIdx: j.slotIdx }] } }, select: { paymentRef: true, peakDocumentNo: true } }))),
  ]);
  const same = (a: JobKey, b: JobKey) => a.guideId === b.guideId && a.date === b.date && a.slotIdx === b.slotIdx;
  const out: string[] = [];
  jobs.forEach((j, i) => {
    const sheet = sheets.find((s) => same(s, j));
    const label = sheet?.ref || `${j.guideId} ${j.date} slot ${j.slotIdx}`;
    const why: string[] = [];
    const pj = payJobs.filter((x) => same(x, j));
    if (pj.length) why.push(`payment ${[...new Set(pj.map((x) => { const p = payments.find((y) => y.id === x.paymentId); return `${p?.paymentNo ?? "recorded"}${p?.status === "REVERSED" ? " (reversed)" : ""}`; }))].join(", ")}`);
    const p = pays.find((x) => same(x, j));
    if (p?.status === "PAID") why.push("marked paid");
    if (p?.eslipUrl || (Array.isArray(p?.slips) && (p!.slips as unknown[]).length)) why.push("a payment slip");
    if (p?.peakRef) why.push(`PEAK ref ${p.peakRef}`);
    if (p?.peakPaymentRef) why.push(`combined PEAK document ${p.peakPaymentRef}`);
    if (p?.paidBatchNo) why.push(`batch ${p.paidBatchNo}`);
    if (sheet?.peakDocumentNo || sheet?.peakDocumentId || sheet?.peakSyncStatus) why.push(`PEAK sync history${sheet.peakDocumentNo ? ` (${sheet.peakDocumentNo})` : ""}`);
    const docsHit = docs[i];
    if (docsHit.length) why.push(`PEAK document ${docsHit.map((d) => d.peakDocumentNo ?? d.paymentRef).join(", ")}`);
    const bi = batchItems.find((x) => same(x, j));
    if (bi) why.push(`payment batch ${batches.find((b) => b.id === bi.batchId)?.batchNo ?? "recorded"}`);
    if (advances.some((x) => same(x, j)) || returns.some((x) => same(x, j))) why.push("advance records");
    if (sheet && matched.some((m) => m.matchedJobSheetId === sheet.id)) why.push("a matched bank slip");
    if (why.length) out.push(`${label} has financial history (${[...new Set(why)].join(", ")}) — it cannot be deleted. Reverse its payment or void its document instead; the record stays.`);
  });
  return out;
}
