import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { recordReceipt } from "@/lib/advances/service";
import { notifyGuide, notifyOps } from "@/lib/booking-import";
import { advanceTotals, advanceStatus, type AdvanceStatus } from "@/lib/advance";
import { uploadSlip, type SlipFile } from "@/lib/advance-slip";
import { thb } from "@/lib/jobsheet";
import { bangkokToday } from "@/lib/guide-schedule";
import type { Expense } from "@/lib/jobsheet";

/**
 * What a guide still owes on money the company advanced them for one job.
 *
 * The company pays entrance tickets and transport by handing the guide cash up
 * front; afterwards the guide reports what they spent and returns the rest. Until
 * now only an operator could see that balance — the guide could record a return
 * (POST /api/jobsheet/advance) without being able to find out how much was left.
 *
 * The arithmetic is not repeated here: `advanceTotals` and `advanceStatus` from
 * lib/advance are the same functions the operator's job sheet and the printed PDF
 * use, so the app can never quietly disagree with them about money.
 */

/** One cash movement, trimmed to what a guide needs to recognise it. */
export type AdvanceMovement = {
  id: string;
  amount: number;
  at: Date;
  method: string;
  txRef: string | null;
  note: string | null;
  /** Drive link to the transfer slip, when one was attached. */
  slip: string | null;
};

export type GuideAdvanceSummary = {
  date: string;
  slotIdx: number;
  totalAdvancePaid: number;
  /** Spent out of the advance: the sheet's expense rows tagged paidBy "advance". */
  usedFromAdvance: number;
  /** Money the guide sent back: returns the ledger has counted, plus money still being checked (up to what is owed). */
  totalReturned: number;
  /** Returns the ledger has counted against this job's advances. */
  totalReturnedConfirmed: number;
  /** Settled by deductions from the guide's payments. */
  deductedFromPayments: number;
  /**
   * What the guide should STILL transfer. The phone app shows this field as "To return" and
   * offers it as "Send back", so it is net of money they already sent that is being checked:
   * a guide is never asked for the same money twice. Equals stillToReturn.
   */
  outstanding: number;
  /** The ledger balance on this job: advanced less everything the ledger has settled. */
  ledgerOutstanding: number;
  /**
   * Money the guide already sent back that is not counted yet (claims being checked, and
   * confirmed money not yet allocated). A receipt is a transfer, not a job, so this is the
   * guide's whole pending amount.
   */
  pendingReturns: number;
  /** ledgerOutstanding less pendingReturns, never below 0. */
  stillToReturn: number;
  status: AdvanceStatus;
  advances: AdvanceMovement[];
  returns: AdvanceMovement[];
};

export async function guideAdvanceSummary(
  guideId: string,
  date: string,
  slotIdx: number,
  nowMs: number = Date.now(),
): Promise<GuideAdvanceSummary> {
  const where = { guideId, date, slotIdx };
  // Phase 3: the balance comes from the LEDGER, not from adding rows up again. An
  // expense tagged "from the advance" is a proposal until an operator settles it, and
  // money the guide sent back settles nothing until it is confirmed and allocated — so
  // the old formula (advances − tagged expenses − returns) would now overstate what has
  // been cleared. lib/advances is the single source for both numbers.
  const [advances, checkins] = await Promise.all([
    prisma.guideAdvance.findMany({
      where, orderBy: { advanceDate: "asc" },
      select: { id: true, advanceNo: true, amountSatang: true, settledSatang: true, advanceDate: true, paidAt: true, method: true, txRef: true, note: true, slipUrl: true, reversedAt: true },
    }),
    prisma.checkin.count({ where }),
  ]);
  const live = advances.filter((a) => !a.reversedAt);
  const [entries, receipts] = await Promise.all([
    live.length ? prisma.guideAdvanceEntry.findMany({ where: { advanceId: { in: live.map((a) => a.id) }, reversedByEntryId: null, type: { not: "REVERSAL" } }, select: { type: true, amountSatang: true } }) : Promise.resolve([]),
    prisma.guideAdvanceReceipt.findMany({
      where: { guideId, status: { in: ["CLAIMED", "VERIFIED"] } },
      orderBy: { receivedDate: "asc" },
      select: { id: true, receiptNo: true, amountSatang: true, allocatedSatang: true, status: true, receivedDate: true, createdAt: true, method: true, bankRef: true, note: true, slipUrl: true },
    }),
  ]);

  const sum = (f: (t: string) => boolean) => entries.filter((e) => f(e.type)).reduce((s, e) => s + e.amountSatang, 0) / 100;
  const totals = {
    totalAdvancePaid: live.reduce((s, a) => s + a.amountSatang, 0) / 100,
    usedFromAdvance: sum((t) => t === "EXPENSE_SETTLEMENT"),
    totalReturned: sum((t) => t === "RETURN_ALLOCATION"),
    outstanding: live.reduce((s, a) => s + (a.amountSatang - a.settledSatang), 0) / 100,
  };
  const tourCompleted = date < bangkokToday(nowMs) || checkins > 0;
  const pendingSatang = receipts.reduce((s, r) => s + (r.status === "CLAIMED" ? r.amountSatang : r.amountSatang - r.allocatedSatang), 0);
  const outstandingSatang = live.reduce((s, a) => s + (a.amountSatang - a.settledSatang), 0);
  const stillSatang = Math.max(0, outstandingSatang - pendingSatang);
  const returnedSatang = entries.filter((e) => e.type === "RETURN_ALLOCATION").reduce((s, e) => s + e.amountSatang, 0);

  return {
    date,
    slotIdx,
    totalAdvancePaid: totals.totalAdvancePaid,
    usedFromAdvance: totals.usedFromAdvance,
    totalReturned: (returnedSatang + Math.min(pendingSatang, outstandingSatang)) / 100,
    totalReturnedConfirmed: returnedSatang / 100,
    deductedFromPayments: sum((t) => t === "PAYMENT_DEDUCTION"),
    outstanding: stillSatang / 100,
    ledgerOutstanding: outstandingSatang / 100,
    pendingReturns: pendingSatang / 100,
    stillToReturn: stillSatang / 100,
    // The status follows the LEDGER: a balance covered only by money still being checked is
    // not settled yet.
    status: advanceStatus(totals, tourCompleted),
    advances: live.map((a) => ({ id: a.id, amount: a.amountSatang / 100, at: a.paidAt, method: a.method, txRef: a.txRef, note: [a.advanceNo, a.note].filter(Boolean).join(" · ") || null, slip: a.slipUrl })),
    // Money the guide has sent back, whatever it has been put against yet. A CLAIMED one
    // is shown as waiting on purpose: it is a claim until someone checks the bank.
    returns: receipts.map((r) => ({
      id: r.id, amount: r.amountSatang / 100, at: r.createdAt, method: r.method, txRef: r.bankRef,
      note: [r.receiptNo, r.status === "CLAIMED" ? "waiting to be checked" : `allocated ${(r.allocatedSatang / 100).toFixed(2)} of ${(r.amountSatang / 100).toFixed(2)}`, r.note].filter(Boolean).join(" · "),
      slip: r.slipUrl,
    })),
  };
}

export type ReturnResult =
  | { ok: true; id: string; slip: string | null }
  | { ok: false; status: number; error: string; hint?: string };

/**
 * The guide sends back what they didn't spend.
 *
 * A return is a cash movement, never a negative expense: it lands in its own table
 * and settles against the advance (see lib/advance). Both the web job sheet and
 * FolkOPS Mobile record one through here, so a return filed from a phone is the
 * same row, with its slip in the same Drive folder, as one typed by an operator.
 */
/** The Bangkok calendar date of a moment — when the money actually reached the bank. */
const bangkokDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

export async function recordAdvanceReturn(o: {
  guideId: string;
  date: string;
  slotIdx: number;
  amount: number;
  at?: Date;
  method?: string;
  txRef?: string | null;
  note?: string | null;
  /** Settle against one particular advance, when the guide says which. */
  advanceId?: string | null;
  slipFile?: SlipFile | null;
  actorId: string | null;
  actorRole: string | null;
  /** False when an operator is recording it on the guide's behalf. */
  byGuide: boolean;
  /** The operator states they have seen the money in the company account. */
  confirmedArrived?: boolean;
}): Promise<ReturnResult> {
  const { guideId, date, slotIdx, amount } = o;
  const where = { guideId, date, slotIdx };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, status: 400, error: "bad-amount", hint: "Enter a positive amount in baht." };

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: where }, select: { id: true, ref: true } });
  if (!sheet) return { ok: false, status: 404, error: "no-sheet", hint: "The operator has not saved this job sheet yet." };

  // Accidental double-submit guard: the same amount on this job within the last
  // minute is almost certainly the same press twice.
  const dup = await prisma.guideAdvanceReceipt.findFirst({ where: { guideId, amountSatang: Math.round(amount * 100), createdAt: { gte: new Date(Date.now() - 60_000) } } });
  if (dup) return { ok: false, status: 409, error: "duplicate", hint: "That amount was just recorded — check before sending it again." };

  if (o.advanceId && !(await prisma.guideAdvance.findFirst({ where: { id: o.advanceId, ...where } }))) {
    return { ok: false, status: 400, error: "bad-advance" };
  }

  let slip: { url: string; fileId: string } | null = null;
  if (o.slipFile && typeof o.slipFile.arrayBuffer === "function" && (o.slipFile.size ?? 0) > 0) {
    const gUser = await prisma.user.findUnique({ where: { guideId }, select: { displayName: true, fullName: true } });
    const guideName = gUser?.fullName || gUser?.displayName || guideId;
    // The same naming as every other Drive file of this job, so its documents sort together.
    const base = `${sheet.ref || `${guideId}-${date}`} — ${guideName} — ${date}`;
    const up = await uploadSlip(o.actorId ?? undefined, o.slipFile, `${base} — advance return ฿${amount}`, date);
    if ("error" in up) return { ok: false, status: up.status, error: up.error };
    slip = up;
  }

  // Phase 3: money coming back is a receipt on the guide's ledger, not a row keyed to
  // one job. It settles nothing until an operator confirms it arrived and allocates it
  // to an advance — so a return typed here can no longer quietly change a balance.
  const at = o.at ?? new Date();
  const receipt = await recordReceipt(prisma, {
    guideId, receivedDate: bangkokDate(at), amount, byGuide: o.byGuide, confirmedArrived: !o.byGuide && !!o.confirmedArrived, today: bangkokToday(Date.now()),
    bankRef: o.txRef ?? null, method: o.method || "bank",
    note: [o.note, sheet.ref ? `Recorded on ${sheet.ref}` : null, o.advanceId ? `Guide says it is for advance ${o.advanceId}` : null].filter(Boolean).join(" · ") || null,
    slipUrl: slip?.url ?? null, slipFileId: slip?.fileId ?? null,
    actor: { actorId: o.actorId, actorRole: o.actorRole },
  });
  if (!receipt.ok) return { ok: false, status: receipt.status, error: "not-allowed", hint: receipt.reasons.join(" · ") };
  const row = { id: receipt.receipt.id };

  // Close the loop: a guide-recorded return asks an operator to verify the transfer
  // arrived; an operator-recorded one tells the guide it was received.
  if (o.byGuide) {
    await notifyOps(`${guideId} recorded returning ${thb(amount)} of the ${date} tour advance${slip ? " (slip attached)" : ""}. Check the transfer arrived, then review the settlement on the job sheet.`, "Guide returned advance money", `${guideId} · ${date} · ${thb(amount)}`, { date });
  } else {
    await notifyGuide(guideId, `Your advance return of ${thb(amount)} for the ${date} tour was recorded and is being checked against the company bank account. Thank you!`, "Advance return recorded", `${date} · ${thb(amount)} returned`);
  }

  return { ok: true, id: row.id, slip: slip?.url ?? null };
}
