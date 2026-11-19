import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";

// The central bank-transaction registry (PR4-0): one row per real bank movement, linked from
// every record that names it. Rules are enforced by triggers, so these tests write the source
// rows the way the app does and read the registry back.
//
// Every guide, reference and amount below is invented.

beforeAll(requireTestDatabase);
beforeEach(resetDatabase);

let seq = 0;
const n = () => String(++seq).padStart(3, "0");

async function payment(over: { bankRef?: string | null; amount?: number; transferGroup?: string | null; reversedAt?: Date | null; date?: string } = {}) {
  const amount = over.amount ?? 1000;
  return prisma.guidePayment.create({ data: {
    paymentNo: `FOLK-PMT-209901-${n()}`, guideId: "G-901", accountingPeriod: "2099-01", paymentDate: over.date ?? "2099-01-10",
    jobTotal: amount, adjustmentTotal: 0, amountTransferred: amount,
    bankRef: over.bankRef === undefined ? "KB-2099-0001" : over.bankRef, transferGroup: over.transferGroup ?? null, reversedAt: over.reversedAt ?? null,
  } });
}

async function document(bankRef: string, bankAccountKey: string | null = "ACC:1234567890") {
  return prisma.guidePaymentDocument.create({ data: {
    paymentRef: `FOLK-PAY-209901-${n()}`, guideId: "G-901", jobs: [], lines: [], total: 1000, status: "PAID",
    bankRef, bankAccountKey, paymentDate: "2099-01-10",
  } });
}

async function receipt(bankRef: string, amountSatang = 50000, status = "CLAIMED") {
  return prisma.guideAdvanceReceipt.create({ data: { receiptNo: `FOLK-ADR-209901-${n()}`, guideId: "G-901", receivedDate: "2099-01-11", amountSatang, bankRef, status } });
}

const txs = () => prisma.bankTransaction.findMany({ include: { uses: true }, orderBy: { createdAt: "asc" } });
const useOf = (sourceTable: string, sourceId: string) => prisma.bankTransactionUse.findUnique({ where: { sourceTable_sourceId: { sourceTable, sourceId } }, include: { transaction: true } });

async function fails(p: Promise<unknown>, re: RegExp) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(String((err as Error | undefined)?.message ?? "did not fail")).toMatch(re);
}

describe("one transfer, recorded once", () => {
  it("a payment with a reference creates the transfer and one live USE", async () => {
    const p = await payment({ bankRef: "kb 2099-0001", amount: 1250 });
    const [t] = await txs();
    expect(t).toMatchObject({ direction: "OUT", refStatus: "BANK_REF", refKey: "KB20990001", refRaw: "kb 2099-0001", amountSatang: 125000, reviewStatus: "OK", transferDate: "2099-01-10" });
    expect(t.uses).toEqual([expect.objectContaining({ sourceTable: "GuidePayment", sourceId: p.id, role: "USE", amountSatang: 125000, live: true })]);
  });

  it("the PEAK document of the same transfer links as DOC: same transaction, no money applied, account filled in", async () => {
    await payment({ bankRef: "KB-2099-0001" });
    const d = await document("kb 2099 0001");
    const all = await txs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ amountSatang: 100000, accountKey: "ACC:1234567890" });
    expect(await useOf("GuidePaymentDocument", d.id)).toMatchObject({ role: "DOC", amountSatang: null, live: true });
  });

  it("Thai digits and punctuation do not make a second transfer", async () => {
    await payment({ bankRef: "KB-๒๐๙๙-๐๐๐๑" });
    await document("KB 2099/0001");
    expect(await txs()).toHaveLength(1);
  });

  it("a second payment on the same transfer is refused and nothing of it is saved", async () => {
    await payment({ bankRef: "KB-2099-0001" });
    await fails(payment({ bankRef: "KB20990001" }), /BANK_TX_OVERUSED/);
    expect(await prisma.guidePayment.count()).toBe(1);
    expect(await prisma.bankTransactionUse.count()).toBe(1);
  });

  it("the same reference on another system is refused too (an ADV refund cannot reuse a guide-payment transfer)", async () => {
    const r = await receipt("KB-IN-7001");
    await payment({ bankRef: "KB-2099-0001" });
    await fails(prisma.guideAdvanceRefund.create({ data: { refundNo: `FOLK-ADF-209901-${n()}`, receiptId: r.id, guideId: "G-901", amountSatang: 50000, reason: "test", recordedById: "u-admin", bankRef: "KB-2099-0001" } }), /BANK_TX_OVERUSED/);
  });

  it("money in and money out are different transfers even with the same reference", async () => {
    await payment({ bankRef: "REF-5550001" });
    await receipt("REF-5550001");
    const all = await txs();
    expect(all.map((t) => t.direction).sort()).toEqual(["IN", "OUT"]);
  });
});

describe("one transfer split into several records (transferGroup)", () => {
  it("parts of one transfer in one group add up to the transfer", async () => {
    await payment({ bankRef: "KB-2099-0002", amount: 600, transferGroup: "grp-1" });
    await payment({ bankRef: "KB-2099-0002", amount: 400, transferGroup: "grp-1" });
    const [t] = await txs();
    expect(t.amountSatang).toBe(100000);
    expect(t.uses.filter((u) => u.live)).toHaveLength(2);
  });

  it("a record outside the group still cannot spend the transfer again", async () => {
    await payment({ bankRef: "KB-2099-0002", amount: 600, transferGroup: "grp-1" });
    await payment({ bankRef: "KB-2099-0002", amount: 400, transferGroup: "grp-1" });
    await fails(payment({ bankRef: "KB-2099-0002", amount: 1 }), /BANK_TX_OVERUSED/);
  });
});

describe("reversal keeps the transfer", () => {
  it("a reversed payment stops counting; the transfer and its link stay; it can be applied again within its amount", async () => {
    const p = await payment({ bankRef: "KB-2099-0003", amount: 1000 });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { reversedAt: new Date(), status: "REVERSED" } });
    expect(await useOf("GuidePayment", p.id)).toMatchObject({ live: false });
    expect(await prisma.bankTransaction.count()).toBe(1);

    await payment({ bankRef: "KB-2099-0003", amount: 1000 });
    const [t] = await txs();
    expect(t.uses).toHaveLength(2);
    expect(t.amountSatang).toBe(100000);
  });

  it("re-applying more than the transfer after a reversal is refused", async () => {
    const p = await payment({ bankRef: "KB-2099-0003", amount: 1000 });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { reversedAt: new Date(), status: "REVERSED" } });
    await fails(payment({ bankRef: "KB-2099-0003", amount: 1000.01 }), /BANK_TX_OVERUSED/);
  });

  it("un-reversing a payment whose transfer was re-used is refused", async () => {
    const p = await payment({ bankRef: "KB-2099-0003" });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { reversedAt: new Date() } });
    await payment({ bankRef: "KB-2099-0003" });
    await fails(prisma.guidePayment.update({ where: { id: p.id }, data: { reversedAt: null } }), /BANK_TX_OVERUSED/);
  });

  it("a reversed multi-transfer payment releases its transfers' uses, not the transfers", async () => {
    const p = await payment({ bankRef: null, amount: 1000 });
    const t1 = await prisma.guidePaymentTransfer.create({ data: { paymentId: p.id, seq: 1, amount: 100, transferDate: "2099-01-10", bankRef: "KB-2099-0101" } });
    await prisma.guidePaymentTransfer.create({ data: { paymentId: p.id, seq: 2, amount: 900, transferDate: "2099-01-11", bankRef: "KB-2099-0102" } });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { reversedAt: new Date() } });
    expect(await useOf("GuidePaymentTransfer", t1.id)).toMatchObject({ live: false });
    expect(await prisma.bankTransaction.count()).toBe(2);
  });

  it("a rejected ADV receipt applies nothing; the transfer stays", async () => {
    const r = await receipt("KB-IN-7002");
    await prisma.guideAdvanceReceipt.update({ where: { id: r.id }, data: { status: "REJECTED", rejectedReason: "not on the statement" } });
    expect(await useOf("GuideAdvanceReceipt", r.id)).toMatchObject({ live: false });
    expect(await prisma.bankTransaction.count()).toBe(1);
  });
});

describe("the missing-transfer correction (#323 shape)", () => {
  it("one ref on the payment, then split into ฿100 on that ref + ฿900 on a new ref: allowed, two transfers", async () => {
    const p = await payment({ bankRef: "KB-2099-0201", amount: 1000, date: "2099-01-03" });
    await document("KB-2099-0201"); // the PEAK document made before the correction
    await prisma.$transaction(async (tx) => {
      await tx.guidePayment.update({ where: { id: p.id }, data: { bankRef: null } });
      await tx.guidePaymentTransfer.create({ data: { paymentId: p.id, seq: 1, amount: 100, transferDate: "2099-01-04", bankRef: "KB-2099-0201" } });
      await tx.guidePaymentTransfer.create({ data: { paymentId: p.id, seq: 2, amount: 900, transferDate: "2099-01-05", bankRef: "KB-2099-0202" } });
    });
    const all = await txs();
    expect(all).toHaveLength(2);
    const a = all.find((t) => t.refKey === "KB20990201")!;
    expect(a.uses.filter((u) => u.live && u.role === "USE").map((u) => [u.sourceTable, u.amountSatang])).toEqual([["GuidePaymentTransfer", 10000]]);
    expect(await useOf("GuidePayment", p.id)).toMatchObject({ live: false });
  });
});

describe("accounts", () => {
  it("the same reference on two accounts is two transfers", async () => {
    await document("REF-777001", "ACC:1111111111");
    await document("REF-777001", "ACC:2222222222");
    expect(await prisma.bankTransaction.count()).toBe(2);
  });

  it("a record with no account cannot pick between them: refused, not guessed", async () => {
    await document("REF-777001", "ACC:1111111111");
    await document("REF-777001", "ACC:2222222222");
    await fails(payment({ bankRef: "REF-777001" }), /BANK_TX_AMBIGUOUS/);
  });
});

describe("references that are not checkable (Q-T2)", () => {
  it("a reference with no digits is kept as typed, marked pending verification, and never matched", async () => {
    const a = await payment({ bankRef: "BANK", amount: 1000 });
    const b = await payment({ bankRef: "bank", amount: 1000 });
    const all = await txs();
    expect(all).toHaveLength(2);
    for (const t of all) expect(t).toMatchObject({ refStatus: "PENDING_VERIFICATION", refKey: null, reviewStatus: "NEEDS_REVIEW" });
    expect((await useOf("GuidePayment", a.id))!.transaction.refRaw).toBe("BANK");
    expect((await useOf("GuidePayment", b.id))!.transaction.refRaw).toBe("bank");
  });

  it("editing the same row keeps its own pending transaction; correcting it to a real number links a real one", async () => {
    const p = await payment({ bankRef: "BANK" });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { amountTransferred: 999 } });
    expect(await prisma.bankTransaction.count()).toBe(1);
    await prisma.guidePayment.update({ where: { id: p.id }, data: { bankRef: "KB-2099-9001" } });
    const u = await useOf("GuidePayment", p.id);
    expect(u!.transaction).toMatchObject({ refStatus: "BANK_REF", refKey: "KB20999001" });
    // the pending one stays on record (nothing is deleted)
    expect(await prisma.bankTransaction.count()).toBe(2);
  });

  it("no digit-count rule: a short numeric reference is an ordinary bank reference", async () => {
    await payment({ bankRef: "57" });
    expect((await txs())[0]).toMatchObject({ refStatus: "BANK_REF", refKey: "57" });
  });
});

describe("nothing is deleted", () => {
  it("transactions and uses refuse DELETE, even in raw SQL", async () => {
    await payment();
    await fails(prisma.$executeRawUnsafe(`DELETE FROM "BankTransactionUse"`), /BANK_TX_KEPT/);
    await fails(prisma.$executeRawUnsafe(`DELETE FROM "BankTransaction"`), /BANK_TX_KEPT/);
  });

  it("deleting a source row marks its use not live; the transfer stays", async () => {
    const r = await receipt("KB-IN-7003");
    await prisma.guideAdvanceReceipt.delete({ where: { id: r.id } });
    expect(await useOf("GuideAdvanceReceipt", r.id)).toMatchObject({ live: false });
    expect(await prisma.bankTransaction.count()).toBe(1);
  });

  it("the shape checks hold in raw SQL", async () => {
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus","refRaw") VALUES ('x1','OUT','BANK_REF','KB1')`), /check/i);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus","refRaw","refKey") VALUES ('x2','SIDEWAYS','BANK_REF','KB1','KB1')`), /check/i);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus") VALUES ('x3','OUT','INTERNAL')`), /check/i);
  });
});

describe("two writers at once", () => {
  it("two payments on the same transfer at the same moment: exactly one is saved", async () => {
    const other = new PrismaClient();
    try {
      const results = await Promise.allSettled([
        prisma.$transaction(async (tx) => { await tx.guidePayment.create({ data: { paymentNo: "FOLK-PMT-209901-901", guideId: "G-901", accountingPeriod: "2099-01", paymentDate: "2099-01-10", jobTotal: 1000, adjustmentTotal: 0, amountTransferred: 1000, bankRef: "KB-RACE-1" } }); await tx.$executeRawUnsafe("SELECT pg_sleep(0.3)"); }),
        other.$transaction(async (tx) => { await tx.guidePayment.create({ data: { paymentNo: "FOLK-PMT-209901-902", guideId: "G-901", accountingPeriod: "2099-01", paymentDate: "2099-01-10", jobTotal: 1000, adjustmentTotal: 0, amountTransferred: 1000, bankRef: "KB-RACE-1" } }); await tx.$executeRawUnsafe("SELECT pg_sleep(0.3)"); }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/BANK_TX_OVERUSED/);
      expect(await prisma.guidePayment.count()).toBe(1);
      const [t] = await txs();
      expect(t.uses).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  });
});

describe("the backfill in the migration", () => {
  const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261121090000_bank_transaction_registry/migration.sql"), "utf8");
  const backfill = sql.slice(sql.lastIndexOf("DO $$"));
  const TRIGGERS: [string, string][] = [["GuidePayment", "bank_tx_guide_payment"], ["GuidePaymentDocument", "bank_tx_guide_payment_document"], ["GuideAdvanceReceipt", "bank_tx_guide_advance_receipt"]];

  /** Write rows as they stood before the migration: without the registry's triggers. */
  async function withoutTriggers(fn: () => Promise<void>) {
    for (const [t, g] of TRIGGERS) await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER ${g}`);
    try { await fn(); } finally {
      for (const [t, g] of TRIGGERS) await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER ${g}`);
    }
  }

  it("links history oldest first and leaves the source rows untouched", async () => {
    await withoutTriggers(async () => {
      await payment({ bankRef: "KB-2099-0001", amount: 600, transferGroup: "g" });
      await payment({ bankRef: "KB-2099-0001", amount: 400, transferGroup: "g" });
      await document("KB-2099-0001");
      await payment({ bankRef: "BANK" });
      await receipt("KB-IN-7004");
    });
    const before = await prisma.guidePayment.findMany({ orderBy: { id: "asc" } });
    expect(await prisma.bankTransaction.count()).toBe(0);
    await prisma.$executeRawUnsafe(backfill);
    expect(await prisma.guidePayment.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const all = await txs();
    expect(all).toHaveLength(3);
    expect(all.find((t) => t.refKey === "KB20990001")).toMatchObject({ amountSatang: 100000, accountKey: "ACC:1234567890" });
    expect(all.find((t) => t.refStatus === "PENDING_VERIFICATION")).toMatchObject({ refRaw: "BANK" });
    expect(await prisma.bankTransactionUse.count()).toBe(5);
  });

  it("stops on a transfer used twice and writes nothing", async () => {
    await withoutTriggers(async () => {
      await payment({ bankRef: "KB-2099-0001" });
      await payment({ bankRef: "KB-2099-0001" });
      await receipt("KB-IN-7005");
    });
    await fails(prisma.$executeRawUnsafe(backfill), /BANK_TX_OVERUSED/);
    expect(await prisma.bankTransaction.count()).toBe(0);
    expect(await prisma.bankTransactionUse.count()).toBe(0);
  });
});
