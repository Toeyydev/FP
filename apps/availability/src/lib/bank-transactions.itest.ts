import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { addMissingTransfers } from "@/lib/payments-v2/service";
import { BankTxRefused, correctTransferAmount, markTransferReviewed, reallocateTransfer } from "./bank-transactions";

// The central bank-transaction registry (PR4-0): one row per real bank movement, linked from
// every record that names it. Rules and guards are database triggers, so these tests write the
// source rows the way the app does — and write the registry directly, the way a stray script
// would — and read the registry back.
//
// Every guide, reference and amount below is invented.

beforeAll(requireTestDatabase);
beforeEach(resetDatabase);

let seq = 0;
const n = () => String(++seq).padStart(3, "0");
const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 12)}`;

type PayOver = { id?: string; bankRef?: string | null; amount?: number; transferGroup?: string | null; transferTotal?: number | null; reversedAt?: Date | null; date?: string; status?: string };
const paymentData = (over: PayOver = {}) => {
  const amount = over.amount ?? 1000;
  return {
    ...(over.id ? { id: over.id } : {}),
    paymentNo: `FOLK-PMT-209901-${n()}`, guideId: "G-901", accountingPeriod: "2099-01", paymentDate: over.date ?? "2099-01-10",
    jobTotal: amount, adjustmentTotal: 0, amountTransferred: amount, status: over.status ?? "RECORDED",
    bankRef: over.bankRef === undefined ? "KB-2099-0001" : over.bankRef,
    transferGroup: over.transferGroup ?? null, transferTotal: over.transferTotal ?? null, reversedAt: over.reversedAt ?? null,
  };
};
const payment = (over: PayOver = {}) => prisma.guidePayment.create({ data: paymentData(over) });
const reverse = (paymentId: string) => prisma.guidePayment.update({ where: { id: paymentId }, data: { reversedAt: new Date(), status: "REVERSED" } });

async function document(bankRef: string, bankAccountKey: string | null = "ACC:1234567890") {
  return prisma.guidePaymentDocument.create({ data: {
    paymentRef: `FOLK-PAY-209901-${n()}`, guideId: "G-901", jobs: [], lines: [], total: 1000, status: "PAID",
    bankRef, bankAccountKey, paymentDate: "2099-01-10",
  } });
}

async function receipt(bankRef: string, amountSatang = 50000, status = "CLAIMED", guideId = "G-901") {
  return prisma.guideAdvanceReceipt.create({ data: {
    receiptNo: `FOLK-ADR-209901-${n()}`, guideId, receivedDate: "2099-01-11", amountSatang, bankRef, status,
    ...(status === "VERIFIED" ? { verifiedAt: new Date() } : {}),
  } });
}

async function user(role: "ADMIN" | "OPERATOR" | "GUIDE", state: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const u = await prisma.user.create({ data: { email: `${id(role.toLowerCase())}@example.test`, displayName: `${role} Example`, role, state } });
  return { actorId: u.id, actorRole: role as string };
}

const txs = () => prisma.bankTransaction.findMany({ include: { uses: true, releases: true }, orderBy: { createdAt: "asc" } });
const tx1 = async () => { const all = await txs(); expect(all).toHaveLength(1); return all[0]; };
/** The source's live link, or (when none) its latest one. */
const useOf = async (sourceTable: string, sourceId: string) =>
  (await prisma.bankTransactionUse.findFirst({ where: { sourceTable, sourceId }, orderBy: [{ live: "desc" }, { createdAt: "desc" }], include: { transaction: true } }))!;

async function fails(p: Promise<unknown>, re: RegExp) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(String((err as Error | undefined)?.message ?? "did not fail")).toMatch(re);
}

describe("one transfer, recorded once", () => {
  it("a payment with a reference creates the transfer, amount fixed from that first record", async () => {
    const p = await payment({ bankRef: "kb 2099-0001", amount: 1250 });
    const t = await tx1();
    expect(t).toMatchObject({ direction: "OUT", refStatus: "BANK_REF", refKey: "KB20990001", refRaw: "kb 2099-0001", amountSatang: 125000, amountSource: "FIRST_USE", reviewStatus: "OK", transferDate: "2099-01-10" });
    expect(t.uses).toEqual([expect.objectContaining({ sourceTable: "GuidePayment", sourceId: p.id, role: "USE", amountSatang: 125000, live: true, verified: true })]);
  });

  it("the PEAK document of the same transfer links as DOC: no money applied, account filled in", async () => {
    await payment({ bankRef: "KB-2099-0001" });
    const d = await document("kb 2099 0001");
    expect(await tx1()).toMatchObject({ amountSatang: 100000, accountKey: "ACC:1234567890" });
    expect(await useOf("GuidePaymentDocument", d.id)).toMatchObject({ role: "DOC", amountSatang: null, live: true });
  });

  it("Thai digits and punctuation do not make a second transfer", async () => {
    await payment({ bankRef: "KB-๒๐๙๙-๐๐๐๑" });
    await document("KB 2099/0001");
    await tx1();
  });

  it("a second payment on the same transfer is refused and nothing of it is saved", async () => {
    await payment({ bankRef: "KB-2099-0001" });
    await fails(payment({ bankRef: "KB20990001" }), /BANK_TX_OVERUSED/);
    expect(await prisma.guidePayment.count()).toBe(1);
    expect(await prisma.bankTransactionUse.count()).toBe(1);
  });

  it("the same reference in another system is refused too (an ADV refund cannot reuse a guide-payment transfer)", async () => {
    const r = await receipt("KB-IN-7001");
    await payment({ bankRef: "KB-2099-0001" });
    await fails(prisma.guideAdvanceRefund.create({ data: { refundNo: `FOLK-ADF-209901-${n()}`, receiptId: r.id, guideId: "G-901", amountSatang: 50000, reason: "test", recordedById: "u-admin", status: "PAID", approvedById: "u-a", approvedAt: new Date(), paidAt: new Date(), paidById: "u-b", bankRef: "KB-2099-0001" } }), /BANK_TX_OVERUSED/);
  });

  it("money in and money out are different transfers even with the same reference", async () => {
    await payment({ bankRef: "REF-5550001" });
    await receipt("REF-5550001");
    expect((await txs()).map((t) => t.direction).sort()).toEqual(["IN", "OUT"]);
  });

  it("raising a payment's amount above its transfer is refused — the transfer's amount is not re-derived", async () => {
    const p = await payment({ bankRef: "KB-2099-0001", amount: 1000 });
    await fails(prisma.guidePayment.update({ where: { id: p.id }, data: { amountTransferred: 1000.01 } }), /BANK_TX_OVERUSED/);
    expect((await tx1()).amountSatang).toBe(100000);
  });
});

describe("one transfer split into a jobs payment and a reviews payment (transferGroup)", () => {
  const G = { transferGroup: "tg-1", transferTotal: 1000 };

  it("the amount is the recorded total of the ONE transfer, not the sum of its parts", async () => {
    await payment({ bankRef: "KB-2099-0002", amount: 600, ...G });
    expect(await tx1()).toMatchObject({ amountSatang: 100000, amountSource: "GROUP_TOTAL", amountGroup: "tg-1" });
    await payment({ bankRef: "KB-2099-0002", amount: 400, ...G });
    const t = await tx1();
    expect(t.amountSatang).toBe(100000);
    expect(t.uses.filter((u) => u.live)).toHaveLength(2);
  });

  it("a third member added LATER cannot enlarge the completed group", async () => {
    await payment({ bankRef: "KB-2099-0002", amount: 600, ...G });
    await payment({ bankRef: "KB-2099-0002", amount: 400, ...G });
    await fails(payment({ bankRef: "KB-2099-0002", amount: 1, ...G }), /BANK_TX_OVERUSED/);
    await fails(payment({ bankRef: "KB-2099-0002", amount: 1 }), /BANK_TX_OVERUSED/);
  });

  it("a fake member in the SAME database transaction as the real ones is refused too", async () => {
    await fails(prisma.$transaction(async (db) => {
      await db.guidePayment.create({ data: paymentData({ bankRef: "KB-2099-0002", amount: 600, ...G }) });
      await db.guidePayment.create({ data: paymentData({ bankRef: "KB-2099-0002", amount: 400, ...G }) });
      await db.guidePayment.create({ data: paymentData({ bankRef: "KB-2099-0002", amount: 50, ...G }) });
    }), /BANK_TX_OVERUSED/);
    expect(await prisma.bankTransaction.count()).toBe(0);
  });

  it("a member that claims a different total, or none, is refused", async () => {
    await payment({ bankRef: "KB-2099-0002", amount: 600, ...G });
    await fails(payment({ bankRef: "KB-2099-0002", amount: 400, transferGroup: "tg-1", transferTotal: 2000 }), /BANK_TX_GROUP_TOTAL_MISMATCH/);
    await fails(payment({ bankRef: "KB-2099-0002", amount: 400, transferGroup: "tg-1" }), /BANK_TX_GROUP_TOTAL_MISSING/);
  });
});

describe("raw SQL cannot rewrite the registry (an application-role script)", () => {
  it("cannot change a transfer's amount, provenance or identity — a forged session flag changes nothing", async () => {
    await payment({ bankRef: "KB-2099-0003" });
    const t = await tx1();
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET "amountSatang" = 999999`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET "amountSatang" = 999999, "amountSource" = 'CORRECTED'`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET "refKey" = 'KB20990004'`), /BANK_TX_GUARD/);
    await fails(prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe(`SELECT set_config('folk.bank_tx_writer', 'attach', true)`);
      await db.$executeRawUnsafe(`UPDATE "BankTransaction" SET "amountSatang" = 999999 WHERE "id" = '${t.id}'`);
    }), /BANK_TX_GUARD/);
    expect((await tx1()).amountSatang).toBe(100000);
  });

  it("cannot insert a transaction with an amount, or a link that its source row does not say", async () => {
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus","refRaw","refKey","amountSatang","amountSource") VALUES ('x1','OUT','BANK_REF','KB1','KB1',100,'FIRST_USE')`), /BANK_TX_GUARD/);
    const p = await payment({ bankRef: "KB-2099-0003" });
    const other = await payment({ bankRef: "KB-2099-0004" });
    const t = (await useOf("GuidePayment", p.id)).transactionId;
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransactionUse" ("id","transactionId","sourceTable","sourceId","role","amountSatang","live","verified") VALUES ('u1','${t}','GuidePayment','${other.id}','USE',100000,true,true)`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransactionUse" ("id","transactionId","sourceTable","sourceId","role","amountSatang","live","verified") VALUES ('u2','${t}','GuidePayment','no-such-row','USE',1,true,true)`), /BANK_TX_GUARD/);
  });

  it("cannot move a link, shrink or grow it, or bring a reversed one back", async () => {
    const a = await payment({ bankRef: "KB-2099-0003" });
    const b = await payment({ bankRef: "KB-2099-0004" });
    const tb = (await useOf("GuidePayment", b.id)).transactionId;
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransactionUse" SET "transactionId" = '${tb}' WHERE "sourceId" = '${a.id}'`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransactionUse" SET "amountSatang" = 1 WHERE "sourceId" = '${a.id}'`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransactionUse" SET "verified" = false WHERE "sourceId" = '${a.id}'`), /BANK_TX_GUARD/);
    await reverse(a.id);
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransactionUse" SET "live" = true WHERE "sourceId" = '${a.id}'`), /BANK_TX_GUARD/);
  });

  it("cannot invent, change or remove a release, or clear a review flag without an Admin's audit", async () => {
    const p = await payment({ bankRef: "KB-2099-0003" });
    await reverse(p.id);
    const u = await useOf("GuidePayment", p.id);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransactionRelease" ("id","transactionId","fromUseId","kind","targetTable","targetId","reason") VALUES ('r1','${u.transactionId}','${u.id}','HISTORICAL_REUSE','GuidePayment','someone-else','made up history')`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransactionRelease" ("id","transactionId","fromUseId","kind","targetTable","targetId","auditLogId","reason") VALUES ('r2','${u.transactionId}','${u.id}','REALLOCATION','GuidePayment','someone-else','no-audit','made up reallocation')`), /BANK_TX_GUARD/);
    const pending = await payment({ bankRef: "BANK" });
    const pt = (await useOf("GuidePayment", pending.id)).transactionId;
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransaction" SET "reviewStatus" = 'OK' WHERE "id" = '${pt}'`), /BANK_TX_GUARD/);
  });

  it("transactions, uses and releases refuse DELETE; a release refuses UPDATE", async () => {
    const admin = await user("ADMIN");
    const p = await payment({ bankRef: "KB-2099-0003" });
    await reverse(p.id);
    await reallocateTransfer(prisma, { fromUseId: (await useOf("GuidePayment", p.id)).id, targetTable: "GuidePayment", targetId: "pay-next", reason: "re-recorded with the right jobs (example)", admin });
    await fails(prisma.$executeRawUnsafe(`DELETE FROM "BankTransactionRelease"`), /BANK_TX_KEPT/);
    await fails(prisma.$executeRawUnsafe(`UPDATE "BankTransactionRelease" SET "targetId" = 'someone-else'`), /BANK_TX_GUARD/);
    await fails(prisma.$executeRawUnsafe(`DELETE FROM "BankTransactionUse"`), /BANK_TX_KEPT/);
    await fails(prisma.$executeRawUnsafe(`DELETE FROM "BankTransaction"`), /BANK_TX_KEPT/);
  });

  it("the shape checks hold in raw SQL", async () => {
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus","refRaw") VALUES ('x1','OUT','BANK_REF','KB1')`), /check|GUARD/i);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus","refRaw","refKey") VALUES ('x2','SIDEWAYS','BANK_REF','KB1','KB1')`), /check/i);
    await fails(prisma.$executeRawUnsafe(`INSERT INTO "BankTransaction" ("id","direction","refStatus") VALUES ('x3','OUT','INTERNAL')`), /check|GUARD/i);
  });
});

describe("a reversed payment is not a new bank transfer", () => {
  it("its link stays and still counts: an UNRELATED new payment on that reference is refused", async () => {
    const p = await payment({ bankRef: "KB-2099-0005", amount: 1000 });
    await reverse(p.id);
    expect(await useOf("GuidePayment", p.id)).toMatchObject({ live: false, verified: true });
    await fails(payment({ bankRef: "KB-2099-0005", amount: 1000 }), /BANK_TX_OVERUSED/);
    await fails(payment({ bankRef: "KB-2099-0005", amount: 1 }), /BANK_TX_OVERUSED/);
  });

  it("an Admin can hand its share to the ONE corrected payment named, with lineage and audit", async () => {
    const admin = await user("ADMIN");
    const p = await payment({ bankRef: "KB-2099-0005", amount: 1000 });
    await reverse(p.id);
    const corrected = id("pay");
    await prisma.$transaction(async (db) => {
      await reallocateTransfer(db, { fromUseId: (await useOf("GuidePayment", p.id)).id, targetTable: "GuidePayment", targetId: corrected, reason: "recorded against the wrong job; re-recorded (example)", admin });
      await db.guidePayment.create({ data: paymentData({ id: corrected, bankRef: "KB-2099-0005", amount: 1000 }) });
    });
    const t = await tx1();
    expect(t.releases).toEqual([expect.objectContaining({ kind: "REALLOCATION", targetTable: "GuidePayment", targetId: corrected, auditLogId: expect.any(String) })]);
    const a = await prisma.auditLog.findUniqueOrThrow({ where: { id: t.releases[0].auditLogId! } });
    expect(a).toMatchObject({ action: "bank_tx.reallocated", actorId: admin.actorId, actorRole: "ADMIN", entityId: t.id });
    // Only the named record could take it; an unrelated payment still cannot.
    await fails(payment({ bankRef: "KB-2099-0005", amount: 1 }), /BANK_TX_OVERUSED/);
    // Nor can the reversed one come back while its share is in use.
    await fails(prisma.guidePayment.update({ where: { id: p.id }, data: { reversedAt: null, status: "RECORDED" } }), /BANK_TX_OVERUSED/);
  });

  it("a release names its target: another payment cannot use it", async () => {
    const admin = await user("ADMIN");
    const p = await payment({ bankRef: "KB-2099-0005", amount: 1000 });
    await reverse(p.id);
    await reallocateTransfer(prisma, { fromUseId: (await useOf("GuidePayment", p.id)).id, targetTable: "GuidePayment", targetId: "the-named-one", reason: "re-recorded (example)", admin });
    await fails(payment({ bankRef: "KB-2099-0005", amount: 1000 }), /BANK_TX_OVERUSED/);
  });

  it("the release hands on only what the target applies: the rest stays spent", async () => {
    const admin = await user("ADMIN");
    const p = await payment({ bankRef: "KB-2099-0005", amount: 1000 });
    await reverse(p.id);
    const corrected = id("pay");
    await prisma.$transaction(async (db) => {
      await reallocateTransfer(db, { fromUseId: (await useOf("GuidePayment", p.id)).id, targetTable: "GuidePayment", targetId: corrected, reason: "re-recorded for less (example)", admin });
      await db.guidePayment.create({ data: paymentData({ id: corrected, bankRef: "KB-2099-0005", amount: 600 }) });
    });
    await fails(payment({ bankRef: "KB-2099-0005", amount: 400 }), /BANK_TX_OVERUSED/);
  });

  it("the Admin path checks the actor in the database: a guide, a disabled admin or a forged role cannot", async () => {
    const p = await payment({ bankRef: "KB-2099-0005" });
    await reverse(p.id);
    const fromUseId = (await useOf("GuidePayment", p.id)).id;
    const input = { fromUseId, targetTable: "GuidePayment", targetId: "x", reason: "trying (example)" };
    const guide = await user("GUIDE");
    await expect(reallocateTransfer(prisma, { ...input, admin: guide })).rejects.toThrow(BankTxRefused);
    await expect(reallocateTransfer(prisma, { ...input, admin: { ...guide, actorRole: "ADMIN" } })).rejects.toThrow(BankTxRefused);
    await expect(reallocateTransfer(prisma, { ...input, admin: await user("ADMIN", "SUSPENDED") })).rejects.toThrow(BankTxRefused);
    // Writing the audit row by hand as that guide does not satisfy the database either.
    await fails(prisma.$transaction(async (db) => {
      const a = await db.auditLog.create({ data: { actorId: guide.actorId, actorRole: "ADMIN", action: "bank_tx.reallocated", entityType: "BankTransaction", entityId: (await useOf("GuidePayment", p.id)).transactionId, detail: { fromUseId, targetTable: "GuidePayment", targetId: "x" } } });
      await db.bankTransactionRelease.create({ data: { transactionId: a.entityId!, fromUseId, kind: "REALLOCATION", targetTable: "GuidePayment", targetId: "x", auditLogId: a.id, reason: "forged (example)" } });
    }), /BANK_TX_GUARD/);
    // An Admin's audit row from an EARLIER transaction does not count either.
    const admin = await user("ADMIN");
    const old = await prisma.auditLog.create({ data: { actorId: admin.actorId, actorRole: "ADMIN", action: "bank_tx.reallocated", entityType: "BankTransaction", entityId: (await useOf("GuidePayment", p.id)).transactionId, detail: { fromUseId, targetTable: "GuidePayment", targetId: "x" } } });
    await fails(prisma.bankTransactionRelease.create({ data: { transactionId: old.entityId!, fromUseId, kind: "REALLOCATION", targetTable: "GuidePayment", targetId: "x", auditLogId: old.id, reason: "replayed (example)" } }), /BANK_TX_GUARD/);
  });

  it("an Admin can correct a transfer's amount from the slip; the old amount stays in the audit", async () => {
    const admin = await user("ADMIN");
    const p = await payment({ bankRef: "KB-2099-0006", amount: 1000 });
    const t = (await useOf("GuidePayment", p.id)).transactionId;
    await expect(correctTransferAmount(prisma, { transactionId: t, amountSatang: 120000, reason: "statement shows 1,200 (example)", admin: await user("OPERATOR") })).rejects.toThrow(BankTxRefused);
    await correctTransferAmount(prisma, { transactionId: t, amountSatang: 120000, reason: "statement shows 1,200 (example)", admin });
    expect(await tx1()).toMatchObject({ amountSatang: 120000, amountSource: "CORRECTED" });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "bank_tx.amount_corrected" } })).detail).toMatchObject({ before: { amountSatang: 100000 }, after: { amountSatang: 120000 } });
    // Never below what is applied.
    await expect(correctTransferAmount(prisma, { transactionId: t, amountSatang: 50000, reason: "typo (example)", admin })).rejects.toThrow(/BANK_TX_OVERUSED/);
  });

  it("editing a payment's reference leaves the old link dead and still counted; editing back revives it", async () => {
    const p = await payment({ bankRef: "KB-2099-0007" });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { bankRef: "KB-2099-0008" } });
    const links = await prisma.bankTransactionUse.findMany({ where: { sourceId: p.id }, include: { transaction: true } });
    expect(links.map((l) => [l.transaction.refKey, l.live]).sort()).toEqual([["KB20990007", false], ["KB20990008", true]]);
    await fails(payment({ bankRef: "KB-2099-0007" }), /BANK_TX_OVERUSED/);
    await prisma.guidePayment.update({ where: { id: p.id }, data: { bankRef: "KB-2099-0007" } });
    expect((await useOf("GuidePayment", p.id)).transaction.refKey).toBe("KB20990007");
  });

  it("a reversed multi-transfer payment: its transfers' links die with it and still count", async () => {
    const p = await payment({ bankRef: null, amount: 1000 });
    const t1 = await prisma.guidePaymentTransfer.create({ data: { paymentId: p.id, seq: 1, amount: 100, transferDate: "2099-01-10", bankRef: "KB-2099-0101" } });
    await prisma.guidePaymentTransfer.create({ data: { paymentId: p.id, seq: 2, amount: 900, transferDate: "2099-01-11", bankRef: "KB-2099-0102" } });
    await reverse(p.id);
    expect(await useOf("GuidePaymentTransfer", t1.id)).toMatchObject({ live: false, verified: true });
    await fails(payment({ bankRef: "KB-2099-0101", amount: 100 }), /BANK_TX_OVERUSED/);
  });
});

describe("advance receipts: a claim is not money until verified", () => {
  it("a rejected, never-verified claim releases its reservation; a new claim on the reference is allowed", async () => {
    const r = await receipt("KB-IN-7002", 50000);
    expect(await tx1()).toMatchObject({ amountSatang: 50000, amountSource: "CLAIM" });
    await fails(receipt("KB-IN-7002", 50000, "CLAIMED", "G-902"), /BANK_TX_OVERUSED/); // reserved while claimed
    await prisma.guideAdvanceReceipt.update({ where: { id: r.id }, data: { status: "REJECTED", rejectedReason: "not on the statement" } });
    expect(await useOf("GuideAdvanceReceipt", r.id)).toMatchObject({ live: false, verified: false });
    const again = await receipt("KB-IN-7002", 30000, "CLAIMED", "G-902");
    expect(await tx1()).toMatchObject({ amountSatang: 30000, amountSource: "CLAIM" });
    expect(await useOf("GuideAdvanceReceipt", again.id)).toMatchObject({ live: true });
  });

  it("verifying the claim fixes the amount as verified money", async () => {
    const r = await receipt("KB-IN-7003", 50000);
    await prisma.guideAdvanceReceipt.update({ where: { id: r.id }, data: { status: "VERIFIED", verifiedAt: new Date() } });
    expect(await tx1()).toMatchObject({ amountSatang: 50000, amountSource: "FIRST_USE" });
  });

  it("verified then voided still counts: the money arrived, so the reference cannot be claimed again", async () => {
    const r = await receipt("KB-IN-7004", 50000, "VERIFIED");
    await prisma.guideAdvanceReceipt.update({ where: { id: r.id }, data: { status: "VOIDED", voidedAt: new Date(), voidedById: "u-admin", voidReason: "recorded on the wrong job" } });
    expect(await useOf("GuideAdvanceReceipt", r.id)).toMatchObject({ live: false, verified: true });
    await fails(receipt("KB-IN-7004", 50000, "CLAIMED", "G-902"), /BANK_TX_OVERUSED/);
    await fails(receipt("KB-IN-7004", 1, "CLAIMED", "G-903"), /BANK_TX_OVERUSED/);
  });
});

describe("Add the missing transfer… (#323), through the real service", () => {
  it("the payment's share moves to transfer 1; the amount narrows to its slip; nobody else can use the rest", async () => {
    const admin = await user("ADMIN");
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const p = await payment({ bankRef: "KB-2099-0201", amount: 1000, date: today });
    await document("KB-2099-0201"); // the PEAK document made before the correction
    const r = await addMissingTransfers(prisma, {
      paymentId: p.id, recordedAmount: 100, reason: "the recorded slip shows 100; 900 went separately (example)",
      added: [{ amount: 900, date: today, bankRef: "KB-2099-0202", slip: { url: "https://example.test/slip-2" } }], actor: admin,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const all = await txs();
    expect(all).toHaveLength(2);
    const a = all.find((t) => t.refKey === "KB20990201")!;
    expect(a).toMatchObject({ amountSatang: 10000, amountSource: "TRANSFER_ROW" });
    expect(a.releases).toEqual([expect.objectContaining({ kind: "MOVED_TO_TRANSFERS", targetTable: "GuidePaymentTransfer" })]);
    expect(all.find((t) => t.refKey === "KB20990202")).toMatchObject({ amountSatang: 90000, amountSource: "FIRST_USE" });
    await fails(payment({ bankRef: "KB-2099-0201", amount: 900 }), /BANK_TX_OVERUSED/);
    await fails(payment({ bankRef: "KB-2099-0202", amount: 1 }), /BANK_TX_OVERUSED/);
  });
});

describe("references that are not checkable (Q-T2)", () => {
  it("a reference with no digits is kept as typed, marked pending verification, and never matched", async () => {
    const a = await payment({ bankRef: "BANK", amount: 1000 });
    const b = await payment({ bankRef: "bank", amount: 1000 });
    const all = await txs();
    expect(all).toHaveLength(2);
    for (const t of all) expect(t).toMatchObject({ refStatus: "PENDING_VERIFICATION", refKey: null, reviewStatus: "NEEDS_REVIEW" });
    expect((await useOf("GuidePayment", a.id)).transaction.refRaw).toBe("BANK");
    expect((await useOf("GuidePayment", b.id)).transaction.refRaw).toBe("bank");
  });

  it("an Admin's audited review clears the flag; nothing else does", async () => {
    const admin = await user("ADMIN");
    const p = await payment({ bankRef: "BANK" });
    const t = (await useOf("GuidePayment", p.id)).transactionId;
    await expect(markTransferReviewed(prisma, { transactionId: t, note: "x", admin })).rejects.toThrow(BankTxRefused);
    await markTransferReviewed(prisma, { transactionId: t, note: "slip checked: no reference printed (example)", admin });
    expect(await tx1()).toMatchObject({ reviewStatus: "OK" });
  });

  it("correcting it to a real number links a real transfer; the pending one stays on record", async () => {
    const p = await payment({ bankRef: "BANK" });
    await prisma.guidePayment.update({ where: { id: p.id }, data: { bankRef: "KB-2099-9001" } });
    expect((await useOf("GuidePayment", p.id)).transaction).toMatchObject({ refStatus: "BANK_REF", refKey: "KB20999001" });
    expect(await prisma.bankTransaction.count()).toBe(2);
  });

  it("no digit-count rule: a short numeric reference is an ordinary bank reference", async () => {
    await payment({ bankRef: "57" });
    expect(await tx1()).toMatchObject({ refStatus: "BANK_REF", refKey: "57" });
  });
});

describe("accounts", () => {
  it("the same reference on two accounts is two transfers; a record with no account is refused, not guessed", async () => {
    await document("REF-777001", "ACC:1111111111");
    await document("REF-777001", "ACC:2222222222");
    expect(await prisma.bankTransaction.count()).toBe(2);
    await fails(payment({ bankRef: "REF-777001" }), /BANK_TX_AMBIGUOUS/);
  });
});

describe("two writers at once", () => {
  it("two payments on the same transfer at the same moment: exactly one is saved", async () => {
    const other = new PrismaClient();
    try {
      const write = (db: PrismaClient) => db.$transaction(async (tx) => {
        await tx.guidePayment.create({ data: paymentData({ bankRef: "KB-RACE-1" }) });
        await tx.$executeRawUnsafe("SELECT pg_sleep(0.3)");
      });
      const results = await Promise.allSettled([write(prisma), write(other)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/BANK_TX_OVERUSED/);
      expect(await prisma.guidePayment.count()).toBe(1);
      expect((await tx1()).uses).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  });
});

describe("the backfill in the migration", () => {
  const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261121090000_bank_transaction_registry/migration.sql"), "utf8");
  const start = sql.indexOf("-- ─── Backfill");
  const backfill = sql.slice(sql.indexOf("DO $$", start), sql.indexOf("-- From here on, HISTORICAL_"));
  const SOURCES = ["GuidePayment", "GuidePaymentDocument", "GuideAdvanceReceipt", "GuidePaymentTransfer"];

  /** Write rows as they stood before the migration (no registry triggers), then run the backfill
   *  as the migration does: with bank_tx_installed_at() still NULL. */
  async function history(fn: () => Promise<void>) {
    for (const t of SOURCES) await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    try { await fn(); } finally {
      for (const t of SOURCES) await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
  }
  async function runBackfill() {
    const installed = await prisma.$queryRawUnsafe<{ src: string }[]>(`SELECT pg_get_functiondef('bank_tx_installed_at()'::regprocedure) src`);
    await prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION bank_tx_installed_at() RETURNS timestamptz LANGUAGE sql STABLE AS $f$ SELECT NULL::timestamptz $f$`);
      await db.$executeRawUnsafe(backfill); // on failure the rollback restores the function too
      await db.$executeRawUnsafe(installed[0].src);
    });
  }

  it("links history oldest first, sums an old group, leaves the source rows untouched", async () => {
    await history(async () => {
      await payment({ bankRef: "KB-2099-0001", amount: 600, transferGroup: "g" });
      await payment({ bankRef: "KB-2099-0001", amount: 400, transferGroup: "g" });
      await document("KB-2099-0001");
      await payment({ bankRef: "BANK" });
      await receipt("KB-IN-7004");
    });
    const before = await prisma.guidePayment.findMany({ orderBy: { id: "asc" } });
    expect(await prisma.bankTransaction.count()).toBe(0);
    await runBackfill();
    expect(await prisma.guidePayment.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const all = await txs();
    expect(all).toHaveLength(3);
    expect(all.find((t) => t.refKey === "KB20990001")).toMatchObject({ amountSatang: 100000, amountSource: "HISTORICAL_GROUP_SUM", reviewStatus: "OK", accountKey: "ACC:1234567890" });
    expect(all.find((t) => t.refStatus === "PENDING_VERIFICATION")).toMatchObject({ refRaw: "BANK", reviewStatus: "NEEDS_REVIEW" });
    expect(await prisma.bankTransactionUse.count()).toBe(5);
  });

  it("a payment reversed and recorded again before the registry: linked, lineage kept, flagged for review", async () => {
    await history(async () => {
      await payment({ bankRef: "KB-2099-0001", reversedAt: new Date(Date.now() - 60_000), status: "REVERSED" });
      await payment({ bankRef: "KB-2099-0001" });
    });
    await runBackfill();
    const t = await tx1();
    expect(t).toMatchObject({ amountSatang: 100000, reviewStatus: "NEEDS_REVIEW" });
    expect(t.releases).toEqual([expect.objectContaining({ kind: "HISTORICAL_REUSE" })]);
    // …and after the migration nobody else can use it.
    await fails(payment({ bankRef: "KB-2099-0001", amount: 1 }), /BANK_TX_OVERUSED/);
  });

  it("HISTORICAL provenance is refused outside the migration", async () => {
    await history(async () => { await payment({ bankRef: "KB-2099-0001", amount: 600, transferGroup: "g" }); });
    await fails(prisma.$executeRawUnsafe(backfill), /BANK_TX_GROUP_TOTAL_MISSING|BANK_TX_GUARD/);
  });

  it("stops on a transfer whose LIVE records pay it twice, and writes nothing", async () => {
    await history(async () => {
      await payment({ bankRef: "KB-2099-0001" });
      await payment({ bankRef: "KB-2099-0001" });
      await receipt("KB-IN-7005");
    });
    await fails(runBackfill(), /BANK_TX_OVERUSED/);
    expect(await prisma.bankTransaction.count()).toBe(0);
    expect(await prisma.bankTransactionUse.count()).toBe(0);
  });
});
