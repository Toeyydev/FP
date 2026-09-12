import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
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
  totalReturned: number;
  /** What is still to be settled: paid − used − returned. */
  outstanding: number;
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
  const [advances, returns, sheet, checkins] = await Promise.all([
    prisma.guideAdvance.findMany({ where, orderBy: { paidAt: "asc" }, select: { id: true, amount: true, paidAt: true, method: true, txRef: true, note: true, slipUrl: true } }),
    prisma.guideAdvanceReturn.findMany({ where, orderBy: { returnedAt: "asc" }, select: { id: true, amount: true, returnedAt: true, method: true, txRef: true, note: true, slipUrl: true } }),
    // The OPERATOR's official expense set is what settles an advance — not the
    // guide's own report, which is a claim the operator still cross-checks.
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: where }, select: { expenses: true } }),
    prisma.checkin.count({ where }),
  ]);

  const expenses = (sheet?.expenses as Expense[] | null) ?? [];
  const totals = advanceTotals(advances, returns, expenses);
  // "Completed" exactly as the job sheet decides it: the day has passed in Bangkok,
  // or the guide has checked in.
  const tourCompleted = date < bangkokToday(nowMs) || checkins > 0;

  return {
    date,
    slotIdx,
    ...totals,
    status: advanceStatus(totals, tourCompleted),
    advances: advances.map((a) => ({ id: a.id, amount: a.amount, at: a.paidAt, method: a.method, txRef: a.txRef, note: a.note, slip: a.slipUrl })),
    returns: returns.map((r) => ({ id: r.id, amount: r.amount, at: r.returnedAt, method: r.method, txRef: r.txRef, note: r.note, slip: r.slipUrl })),
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
}): Promise<ReturnResult> {
  const { guideId, date, slotIdx, amount } = o;
  const where = { guideId, date, slotIdx };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, status: 400, error: "bad-amount", hint: "Enter a positive amount in baht." };

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: where }, select: { id: true, ref: true } });
  if (!sheet) return { ok: false, status: 404, error: "no-sheet", hint: "The operator has not saved this job sheet yet." };

  // Accidental double-submit guard: the same amount on this job within the last
  // minute is almost certainly the same press twice.
  const dup = await prisma.guideAdvanceReturn.findFirst({ where: { ...where, amount, createdAt: { gte: new Date(Date.now() - 60_000) } } });
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

  const row = await prisma.guideAdvanceReturn.create({
    data: { ...where, advanceId: o.advanceId ?? null, amount, returnedAt: o.at ?? new Date(), method: o.method || "bank", txRef: o.txRef ?? null, note: o.note ?? null, slipUrl: slip?.url ?? null, slipFileId: slip?.fileId ?? null, createdById: o.actorId },
  });
  await audit({ actorId: o.actorId, actorRole: o.actorRole, action: "advance.return_recorded", entityType: "GuideAdvanceReturn", entityId: row.id, detail: { ref: sheet.ref, guideId, date, slotIdx, amount, method: o.method || "bank", txRef: o.txRef ?? null, slip: !!slip, byGuide: o.byGuide } });

  // Close the loop: a guide-recorded return asks an operator to verify the transfer
  // arrived; an operator-recorded one tells the guide it was received.
  if (o.byGuide) {
    await notifyOps(`${guideId} recorded returning ${thb(amount)} of the ${date} tour advance${slip ? " (slip attached)" : ""}. Check the transfer arrived, then review the settlement on the job sheet.`, "Guide returned advance money", `${guideId} · ${date} · ${thb(amount)}`, { date });
  } else {
    await notifyGuide(guideId, `Your advance return of ${thb(amount)} for the ${date} tour was recorded. Thank you!`, "Advance return recorded", `${date} · ${thb(amount)} returned`);
  }

  return { ok: true, id: row.id, slip: slip?.url ?? null };
}
