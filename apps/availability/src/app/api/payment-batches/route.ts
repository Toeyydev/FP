import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canViewFinance, isOps } from "@/lib/roles";
import { nextBatchNo, payoutSnapshot, money2, isBatchStatus, batchPaidAction } from "@/lib/payment-batch";

export const dynamic = "force-dynamic";

const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// GET               → list batches (summary), newest first.
// GET ?id=<batchId> → one batch with its items (+ guide display names).
// Finance roles (operator/admin/accountant) may view.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const batch = await prisma.paymentBatch.findUnique({ where: { id }, include: { items: { orderBy: [{ guideId: "asc" }, { date: "asc" }, { slotIdx: "asc" }] } } });
    if (!batch) return NextResponse.json({ error: "not-found" }, { status: 404 });
    const guideIds = [...new Set(batch.items.map((it) => it.guideId))];
    const tourIds = [...new Set(batch.items.map((it) => it.tourId).filter(Boolean))];
    const [guides, tours] = await Promise.all([
      prisma.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true } }),
      prisma.tour.findMany({ where: { id: { in: tourIds } }, select: { id: true, name: true } }),
    ]);
    const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
    const tName = (tid: string) => tours.find((t) => t.id === tid)?.name ?? tid;
    return NextResponse.json({ batch: { ...batch, items: batch.items.map((it) => ({ ...it, guide: gName(it.guideId), tour: it.tourId ? tName(it.tourId) : "—" })) } });
  }

  const batches = await prisma.paymentBatch.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { items: true } } } });
  const rows = batches.map((b) => ({
    id: b.id, batchNo: b.batchNo, status: b.status, paymentDate: b.paymentDate,
    totalAmount: b.totalAmount, note: b.note, createdAt: b.createdAt, paidAt: b.paidAt, items: b._count.items,
  }));
  return NextResponse.json({ rows });
}

// POST { items: [{guideId,date,slotIdx}], paymentDate?, note? } — operator/admin only.
// Create a batch from a set of tour payouts. Amounts are SNAPSHOTTED server-side from
// each job sheet (computeTotals) — never trusted from the client. Any requested payout
// already sitting in a batch is skipped (the unique guard) and reported back. Fails
// only when NONE are eligible.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    items: z.array(z.object({ guideId: z.string().min(1), date: z.string().regex(dateRe), slotIdx: z.number().int().min(0) })).min(1).max(200),
    paymentDate: z.string().regex(dateRe).optional(),
    note: z.string().max(500).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { items, paymentDate, note } = parsed.data;

  // De-dup within the request, then drop any payout already in a batch. The DB unique
  // on (guideId,date,slotIdx) is the backstop; this turns it into a clean skip+report.
  const uniq = new Map<string, { guideId: string; date: string; slotIdx: number }>();
  for (const it of items) uniq.set(`${it.guideId}|${it.date}|${it.slotIdx}`, it);
  const already = await prisma.paymentBatchItem.findMany({
    where: { OR: [...uniq.values()].map((it) => ({ guideId: it.guideId, date: it.date, slotIdx: it.slotIdx })) },
    select: { guideId: true, date: true, slotIdx: true, batch: { select: { batchNo: true } } },
  });
  const takenKeys = new Set(already.map((a) => `${a.guideId}|${a.date}|${a.slotIdx}`));
  const skipped = already.map((a) => ({ guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, batchNo: a.batch.batchNo }));

  // Snapshot each free payout from its job sheet (server-side truth).
  const rows: { guideId: string; date: string; slotIdx: number; tourId: string; ref: string | null; guideFee: number; reimbursement: number; totalPayable: number }[] = [];
  for (const it of uniq.values()) {
    if (takenKeys.has(`${it.guideId}|${it.date}|${it.slotIdx}`)) continue;
    const snap = await payoutSnapshot(it.guideId, it.date, it.slotIdx);
    if (!snap) continue; // nothing to pay at this slot
    rows.push({ guideId: it.guideId, date: it.date, slotIdx: it.slotIdx, tourId: snap.tourId, ref: snap.ref, guideFee: snap.guideFee, reimbursement: snap.reimbursement, totalPayable: snap.totalPayable });
  }
  if (!rows.length) return NextResponse.json({ error: "no-eligible-items", skipped }, { status: 400 });

  const total = money2(rows.reduce((s, r) => s + r.totalPayable, 0));
  const batchNo = await nextBatchNo(paymentDate ?? bkkToday());
  const batch = await prisma.paymentBatch.create({
    data: { batchNo, status: "DRAFT", paymentDate: paymentDate ?? null, totalAmount: total, note: note?.trim() || null, createdById: session!.user!.id ?? null, items: { create: rows } },
    include: { _count: { select: { items: true } } },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payment_batch.created", entityType: "PaymentBatch", entityId: batch.id, detail: { batchNo, items: rows.length, total, skipped: skipped.length } });
  return NextResponse.json({ ok: true, id: batch.id, batchNo, total, added: rows.length, skipped });
}

// PATCH { id, status?, paymentDate?, note?, removeItemId? } — operator/admin only.
// Update batch lifecycle/metadata, or remove one item. Marking PAID settles the
// member tours: each TourPayment flips to PAID stamped with this batch's number —
// UNLESS the tour was already paid by another route (slip / manual / another batch),
// which is skipped and reported, never re-settled. Un-marking reverts ONLY the tours
// carrying this batch's number. Totals recomputed server-side, never client-supplied.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    id: z.string().min(1),
    status: z.string().optional(),
    paymentDate: z.string().regex(dateRe).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    removeItemId: z.string().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id, status, paymentDate, note, removeItemId } = parsed.data;
  if (status && !isBatchStatus(status)) return NextResponse.json({ error: "bad-status" }, { status: 400 });

  const existing = await prisma.paymentBatch.findUnique({ where: { id }, select: { batchNo: true, status: true } });
  if (!existing) return NextResponse.json({ error: "not-found" }, { status: 404 });

  if (removeItemId) {
    if (existing.status === "PAID") return NextResponse.json({ error: "paid-locked", hint: "Can't edit a paid batch." }, { status: 409 });
    await prisma.paymentBatchItem.deleteMany({ where: { id: removeItemId, batchId: id } }); // frees that payout
  }

  const data: Record<string, unknown> = {};
  if (paymentDate !== undefined) data.paymentDate = paymentDate;
  if (note !== undefined) data.note = note?.trim() || null;
  let settled: { flipped: number; skippedPaid: { guideId: string; date: string; slotIdx: number }[] } | null = null;
  if (status) {
    data.status = status;
    const wasPaid = existing.status === "PAID";
    if (status === "PAID" && !wasPaid) {
      // Settle the member tours. Skip (and report) any tour already PAID by another
      // route so a batch can never silently re-settle someone else's payment.
      const items = await prisma.paymentBatchItem.findMany({ where: { batchId: id }, select: { guideId: true, date: true, slotIdx: true, tourId: true } });
      const pays = items.length ? await prisma.tourPayment.findMany({
        where: { OR: items.map((it) => ({ guideId: it.guideId, date: it.date, slotIdx: it.slotIdx })) },
        select: { guideId: true, date: true, slotIdx: true, status: true, paidBatchNo: true },
      }) : [];
      const now = new Date();
      settled = { flipped: 0, skippedPaid: [] };
      for (const it of items) {
        const ex = pays.find((p) => p.guideId === it.guideId && p.date === it.date && p.slotIdx === it.slotIdx) ?? null;
        if (batchPaidAction(ex, existing.batchNo) === "skip") { settled.skippedPaid.push({ guideId: it.guideId, date: it.date, slotIdx: it.slotIdx }); continue; }
        await prisma.tourPayment.upsert({
          where: { guideId_date_slotIdx: { guideId: it.guideId, date: it.date, slotIdx: it.slotIdx } },
          create: { guideId: it.guideId, date: it.date, slotIdx: it.slotIdx, tourId: it.tourId, status: "PAID", paidAt: now, paidBatchNo: existing.batchNo },
          update: { status: "PAID", paidAt: now, paidBatchNo: existing.batchNo },
        });
        settled.flipped += 1;
      }
      data.paidAt = now;
      await prisma.paymentBatchItem.updateMany({ where: { batchId: id }, data: { paymentStatus: "PAID" } });
    } else if (status !== "PAID" && wasPaid) {
      // Undo: revert ONLY the tours this batch settled (provenance = our batchNo).
      // A tour paid via a slip / manually / by another batch is never touched.
      await prisma.tourPayment.updateMany({ where: { paidBatchNo: existing.batchNo, status: "PAID" }, data: { status: "PENDING", paidAt: null, paidBatchNo: null } });
      data.paidAt = null;
      await prisma.paymentBatchItem.updateMany({ where: { batchId: id }, data: { paymentStatus: "PENDING" } });
    } else if (status !== "PAID") {
      // Non-paid → non-paid transition (e.g. DRAFT → READY): nothing to settle.
      data.paidAt = null;
      await prisma.paymentBatchItem.updateMany({ where: { batchId: id }, data: { paymentStatus: "PENDING" } });
    }
    // status === "PAID" && wasPaid: already settled — leave paidAt and the tours alone.
  }
  if (removeItemId) {
    const agg = await prisma.paymentBatchItem.aggregate({ where: { batchId: id }, _sum: { totalPayable: true } });
    data.totalAmount = money2(agg._sum.totalPayable ?? 0);
  }
  const batch = await prisma.paymentBatch.update({ where: { id }, data, include: { _count: { select: { items: true } } } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payment_batch.updated", entityType: "PaymentBatch", entityId: id, detail: { batchNo: existing.batchNo, status: batch.status, removedItem: removeItemId ?? null, settled: settled ? { flipped: settled.flipped, skippedPaid: settled.skippedPaid.length } : undefined } });
  return NextResponse.json({ ok: true, id, status: batch.status, totalAmount: batch.totalAmount, items: batch._count.items, settled });
}

// DELETE { id } — operator/admin only. Remove a batch; cascade-deletes its items,
// freeing those payouts to be re-batched. A PAID batch is a financial record and
// cannot be deleted (change its status first if it was raised in error).
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  if (!id) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const existing = await prisma.paymentBatch.findUnique({ where: { id }, select: { batchNo: true, status: true } });
  if (!existing) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (existing.status === "PAID") return NextResponse.json({ error: "paid-locked", hint: "A paid batch can't be deleted." }, { status: 409 });
  await prisma.paymentBatch.delete({ where: { id } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payment_batch.deleted", entityType: "PaymentBatch", detail: { batchNo: existing.batchNo } });
  return NextResponse.json({ ok: true });
}
