// A company-borne review incentive, put into PEAK as its own document through the API.
//
// Owner policy 2026-10-06: the incentive is paid apart from the guide fee — its own payment,
// its own PEAK document, its own 50 ทวิ — because one 50 ทวิ carries one condition, and the
// fee's is "deducted" while the incentive's is "paid by the payer, once" (ผู้จ่ายออกให้ครั้งเดียว).
//
// In PEAK the incentive is one 510110 line of income = transfer + tax, with that tax as its
// withholding, so the document is payable for exactly what the guide received and the tax
// lands in ภ.ง.ด.3. PEAK's API has no field for the condition itself — the accountant marks
// "ออกให้ครั้งเดียว" on the 50 ทวิ in PEAK; FolkOPS's draft 50 ทวิ says it.
//
// Two steps, the same as a combined payment document (lib/peak-payment-document): create the
// expense, then record its payment on the date the money left the bank. Each write is
// claimed first; an answer that was lost is UNCERTAIN and locks the incentive until a person
// has looked in PEAK — pressing again could create a second document for the same money.
import type { PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { classifyExpenseWrite, type ExpenseWriteResult } from "@/lib/peak-payment-document";
import { createExpenseAllInOne, payExistingExpense, type PaidPaymentResult } from "@/lib/peak-api";
import { resolveBankAccount } from "@/lib/peak-payment-server";
import { REVIEW_RATE } from "@/lib/supplemental-payments/rules";
import { activePaymentNos } from "@/lib/supplemental-payments/service";

type Actor = { actorId: string | null; actorRole: string | null };
export type PeakDeps = {
  createExpense?: (expense: Record<string, unknown>) => Promise<ExpenseWriteResult>;
  payExpense?: (p: Parameters<typeof payExistingExpense>[0]) => Promise<PaidPaymentResult>;
  checkAccount?: (paymentMethodId: string) => Promise<{ ok: true } | { ok: false; reasons: string[] }>;
  today?: string;
};
export type PeakResult = { ok: true; peakStatus: string; documentNo: string | null } | { ok: false; status: number; reasons: string[] };

const compact = (d: string) => d.replace(/-/g, "");
const lastDayOf = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const bangkokToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const thb = (n: number) => `฿${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const refused = (status: number, ...reasons: string[]): PeakResult => ({ ok: false, status, reasons });

/**
 * The expense PEAK is sent. Dated the last day of the month the guide worked — the month
 * the cost belongs to — or the payment date if that is earlier; due no earlier than issued.
 */
export function reviewIncentiveExpense(input: {
  paymentNo: string; guideId: string; peakContactId: string; accountCode: string;
  reviewCount: number; workMonth: string; gross: number; wht: number; net: number; whtPct: number; paymentDate: string; today: string;
}) {
  const end = lastDayOf(input.workMonth);
  const issued = end < input.paymentDate ? end : input.paymentDate;
  const due = input.today > issued ? input.today : issued;
  return {
    issuedDate: compact(issued),
    dueDate: compact(due),
    contact: { id: input.peakContactId },
    products: [{
      description: `Review incentive ${input.workMonth} · ${input.reviewCount} × ฿${REVIEW_RATE} = ${thb(input.net)} to the guide · tax ${input.whtPct}% ${thb(input.wht)} borne by the company (ผู้จ่ายออกภาษีให้ครั้งเดียว)`,
      quantity: 1, price: input.gross, accountCode: input.accountCode, withHoldingTaxAmount: input.wht,
    }],
    reference: input.paymentNo,
    remark: `Folkpaths review incentive ${input.paymentNo} · ${input.guideId} · ${input.workMonth} · income ${thb(input.gross)} · tax ${thb(input.wht)} paid by Folkpaths once · transfer ${thb(input.net)}`,
  };
}

/** Create the document if it does not exist yet, then record its payment. */
export async function putReviewIncentiveInPeak(prisma: PrismaClient, input: { id: string; paymentMethodId: string; actor: Actor }, deps: PeakDeps = {}): Promise<PeakResult> {
  const row = await prisma.supplementalPayment.findUnique({ where: { id: input.id } });
  if (!row) return refused(404, "No such supplemental payment");
  if (row.whtBearer !== "COMPANY_ONCE" || !row.reviewCount || !row.workMonth) return refused(409, "Only a review incentive whose tax the company bears is put into PEAK from here");
  if (row.voidedAt) return refused(409, "It is void");
  if (row.peakStatus === "PAID") return { ok: true, peakStatus: "PAID", documentNo: row.peakRef };
  if (row.peakStatus === "CREATE_UNCERTAIN" || row.peakStatus === "PAYMENT_UNCERTAIN") return refused(409, `PEAK did not confirm the last attempt (${row.peakError ?? "no answer"}). Look in PEAK and record what is there before anything else.`);
  if (row.peakStatus === "CREATING" || row.peakStatus === "PAYING") return refused(409, "It is being put into PEAK right now — reload in a moment");
  if (row.peakRef && row.peakStatus !== "AWAITING_PAYMENT") return refused(409, `It is already booked in PEAK as ${row.peakRef}`);
  const paid = (await activePaymentNos(prisma, [row.id])).get(row.id);
  if (!paid) return refused(409, "Record the transfer first — PEAK is given the payment the guide actually received");
  const method = (input.paymentMethodId ?? "").trim();
  if (!method) return refused(400, "Choose the bank account the money left from");
  const acct = await (deps.checkAccount ?? resolveBankAccount)(method);
  if (!acct.ok) return refused(409, ...acct.reasons);
  const net = Number(row.netAmount), wht = Number(row.wht), gross = Number(row.grossAmount);

  // Step 1: the document — unless an earlier attempt already made it.
  let documentNo = row.peakStatus === "AWAITING_PAYMENT" ? row.peakRef : null;
  let documentId = row.peakStatus === "AWAITING_PAYMENT" ? row.peakDocumentId : null;
  if (!documentNo) {
    const [user, map] = await Promise.all([
      prisma.user.findFirst({ where: { guideId: row.guideId }, select: { peakContactId: true } }),
      prisma.peakAccountMapping.findUnique({ where: { folkopsCategory: row.accountingCategory }, select: { peakAccountCode: true, isActive: true } }),
    ]);
    if (!user?.peakContactId) return refused(409, `${row.guideId} is not mapped to a PEAK contact — map them on Guides first`);
    if (!map?.isActive || !(map.peakAccountCode ?? "").trim()) return refused(409, `${row.accountingCategory} has no PEAK account mapped`);
    const claimed = await prisma.supplementalPayment.updateMany({ where: { id: row.id, OR: [{ peakStatus: null }, { peakStatus: "FAILED" }], peakRef: null }, data: { peakStatus: "CREATING", peakError: null, peakPaymentMethodId: method } });
    if (claimed.count !== 1) return refused(409, "Someone else is putting it into PEAK — reload");
    const expense = reviewIncentiveExpense({ paymentNo: paid.paymentNo, guideId: row.guideId, peakContactId: user.peakContactId, accountCode: map.peakAccountCode!.trim(),
      reviewCount: row.reviewCount, workMonth: row.workMonth, gross, wht, net, whtPct: Number(row.whtPct), paymentDate: paid.paymentDate, today: deps.today ?? bangkokToday() });
    const out = classifyExpenseWrite(await (deps.createExpense ?? createExpenseAllInOne)(expense));
    if (out.status !== "POSTED") {
      const status = out.status === "UNCERTAIN" ? "CREATE_UNCERTAIN" : "FAILED";
      await prisma.supplementalPayment.update({ where: { id: row.id }, data: { peakStatus: status, peakError: out.reason.slice(0, 500) } });
      await audit({ ...input.actor, action: `supplemental.peak_${status.toLowerCase()}`, entityType: "SupplementalPayment", entityId: row.id, detail: { paymentNo: paid.paymentNo, reason: out.reason } });
      return refused(out.status === "UNCERTAIN" ? 502 : 409, out.status === "UNCERTAIN"
        ? `PEAK did not answer whether the document was created: ${out.reason}. Look in PEAK before anything else.`
        : `PEAK refused the document: ${out.reason}. Nothing was created.`);
    }
    documentNo = out.documentNo; documentId = out.documentId;
    await prisma.supplementalPayment.update({ where: { id: row.id }, data: { peakStatus: "AWAITING_PAYMENT", peakRef: documentNo, peakRefAt: new Date(), peakRefById: input.actor.actorId, peakDocumentId: documentId, peakDocumentLink: out.documentLink } });
    await audit({ ...input.actor, action: "supplemental.peak_document_created", entityType: "SupplementalPayment", entityId: row.id,
      detail: { paymentNo: paid.paymentNo, documentNo, documentId, income: gross, tax: wht, transfer: net, workMonth: row.workMonth, condition: "tax paid by the company once (ผู้จ่ายออกให้ครั้งเดียว)" } });
  }

  // Step 2: its payment, on the date the money left the bank, for what the guide received.
  const paying = await prisma.supplementalPayment.updateMany({ where: { id: row.id, peakStatus: "AWAITING_PAYMENT" }, data: { peakStatus: "PAYING", peakError: null, peakPaymentMethodId: method } });
  if (paying.count !== 1) return refused(409, "Someone else is recording its payment in PEAK — reload");
  const pay = await (deps.payExpense ?? payExistingExpense)({ documentNo: documentNo!, documentId, paymentDate: compact(paid.paymentDate), paymentMethodId: method, amount: net, withholdingTaxAmount: wht });
  if (!pay.ok) {
    const status = pay.uncertain ? "PAYMENT_UNCERTAIN" : "AWAITING_PAYMENT";
    await prisma.supplementalPayment.update({ where: { id: row.id }, data: { peakStatus: status, peakError: (pay.desc ?? "PEAK refused the payment").slice(0, 500) } });
    await audit({ ...input.actor, action: pay.uncertain ? "supplemental.peak_payment_uncertain" : "supplemental.peak_payment_refused", entityType: "SupplementalPayment", entityId: row.id, detail: { documentNo, reason: pay.desc ?? null } });
    return refused(pay.uncertain ? 502 : 409, pay.uncertain
      ? `PEAK did not answer whether the payment on ${documentNo} was recorded: ${pay.desc ?? ""}. Look at ${documentNo} in PEAK first.`
      : `${documentNo} was created, but PEAK refused its payment: ${pay.desc ?? ""}. Fix that and press again — the document is not created twice.`);
  }
  await prisma.supplementalPayment.update({ where: { id: row.id }, data: { peakStatus: "PAID", peakError: null } });
  await audit({ ...input.actor, action: "supplemental.peak_paid", entityType: "SupplementalPayment", entityId: row.id, detail: { documentNo, paymentDate: paid.paymentDate, amount: net, tax: wht, paymentNo: paid.paymentNo } });
  return { ok: true, peakStatus: "PAID", documentNo };
}

export type PeakResolution = { kind: "created"; documentNo: string } | { kind: "not-created" } | { kind: "payment-found" } | { kind: "payment-not-found" };

/** A person looked in PEAK after an answer was lost, and records what is there. */
export async function resolveReviewIncentivePeak(prisma: PrismaClient, input: { id: string; resolution: PeakResolution; actor: Actor }): Promise<PeakResult> {
  const row = await prisma.supplementalPayment.findUnique({ where: { id: input.id } });
  if (!row) return refused(404, "No such supplemental payment");
  const r = input.resolution;
  const next =
    row.peakStatus === "CREATE_UNCERTAIN" && r.kind === "created" ? { peakStatus: "AWAITING_PAYMENT", peakRef: r.documentNo.trim().toUpperCase(), peakRefAt: new Date(), peakRefById: input.actor.actorId, peakError: null } :
    row.peakStatus === "CREATE_UNCERTAIN" && r.kind === "not-created" ? { peakStatus: null, peakError: null } :
    row.peakStatus === "PAYMENT_UNCERTAIN" && r.kind === "payment-found" ? { peakStatus: "PAID", peakError: null } :
    row.peakStatus === "PAYMENT_UNCERTAIN" && r.kind === "payment-not-found" ? { peakStatus: "AWAITING_PAYMENT", peakError: null } : null;
  if (!next) return refused(409, `Nothing is waiting on that: it is ${row.peakStatus ?? "not in PEAK"}`);
  if (r.kind === "created" && !/^EXP-\d{6}-?\d{2,}$/.test(r.documentNo.trim().toUpperCase())) return refused(400, "Enter the EXP number exactly as PEAK shows it");
  const moved = await prisma.supplementalPayment.updateMany({ where: { id: row.id, peakStatus: row.peakStatus }, data: next });
  if (moved.count !== 1) return refused(409, "It changed while this was being saved — reload");
  await audit({ ...input.actor, action: "supplemental.peak_resolved", entityType: "SupplementalPayment", entityId: row.id, detail: { was: row.peakStatus, resolution: r, error: row.peakError } });
  return { ok: true, peakStatus: next.peakStatus ?? "NOT_IN_PEAK", documentNo: "peakRef" in next ? (next.peakRef as string) : row.peakRef };
}
