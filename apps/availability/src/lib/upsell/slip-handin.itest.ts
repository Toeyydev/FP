import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Slip-only hand-in against a real database (owner, 20 Nov 2026: "ให้อัพโหลดสลิปอย่างเดียวก็พอแล้ว").
// The guide uploads slips and sends — nothing typed; an Admin records what each slip shows, at the
// version on screen, into a known company account; only Confirm makes transfers, the remittance and
// the bank clearing, in one transaction. Every name, number and reference is invented.

import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { listCashSales, recordRouteExtensionSale } from "./sales";
import { chooseGuests } from "@/test/upsell-allocation";
import {
  SettlementError, confirmHandIn, handInView, listHandIns, prepareHandIn, removeHandInSlip, reportTransfer, returnHandIn, reviewHandInSlip,
  setReceivingAccount, submitHandIn, submitHandInSlips, uploadHandInSlip,
} from "./settlement";

const TODAY = bangkokToday();
const G = "G-971", G2 = "G-972", TOUR = "T-005";
let guide = { userId: "", guideId: G }, guide2 = { userId: "", guideId: G2 };
let admin = { userId: "" }, admin2 = { userId: "" };
let jobId = "", job2Id = "";
let n = 0;
const key = () => `slip-key-${String(++n).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof SettlementError ? e.code : `UNEXPECTED: ${String((e as Error).message).slice(0, 300)}`; }
}
async function job(guideId: string, slotIdx: number) {
  await prisma.assignment.create({ data: { guideId, date: TODAY, slotIdx, tourId: TOUR } });
  await prisma.booking.create({ data: { source: "manual", externalId: `bk-${guideId}-${slotIdx}-${Math.random()}`, tourId: TOUR, date: TODAY, slotIdx, pax: 6, status: "ASSIGNED", customerName: "Invented Guest" } });
  return (await prisma.jobSheet.create({ data: { guideId, date: TODAY, slotIdx, tourId: TOUR, bookings: [{ name: "Invented Guest", bookingNo: "INV-1", bookedPax: 6 }] } })).id;
}
async function sale(guests: number, g = guide, onJob = jobId) {
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } }, orderBy: { version: "desc" } });
  return (await recordRouteExtensionSale(prisma, { requestKey: key(), jobSheetId: onJob, productVersionId: v.id, guests, expectedUnitPriceSatang: v.unitPriceSatang, ...(await chooseGuests(prisma, onJob, v.id, guests)) }, g)).sale;
}
const endTour = (guideId: string, slotIdx: number) => prisma.tourReport.create({ data: { guideId, date: TODAY, slotIdx, tourId: TOUR } });
const account = (d: string) => setReceivingAccount(prisma, admin, { peakPaymentMethodId: `pm-${d}`, label: `Extras ${d} (example)`, confirmSuitable: true },
  async (id) => ({ id, name: `Invented Bank ${d}`, bankAccountKey: `ACC:99900${d}`, accountDisplay: `···${d}` }));
/** A slip file on record, as hand-in/[job]/slip files it (fake Drive). */
async function evidence(g: { userId: string; guideId: string }) {
  const r = Math.random().toString(36).slice(2, 12);
  return (await prisma.paymentEvidence.create({ data: { googleDriveFileId: `drive-${r}`, fileHash: `hash-${r}`, driveLink: `https://example.test/slip-${r}`, guideId: g.guideId, slipUploadedBy: g.userId } })).id;
}
const upload = async (g = guide, onJob = jobId) => (await uploadHandInSlip(prisma, g, { jobSheetId: onJob, evidenceId: await evidence(g) })).slip;
const held = async (g = G, onJob = jobId) => (await prisma.cashCustodyEntry.aggregate({ where: { custodianId: g, sourceJobSheetId: onJob }, _sum: { amountSatang: true } }))._sum.amountSatang ?? 0;
const acctNow = () => prisma.upsellReceivingAccount.findFirstOrThrow({ where: { retiredAt: null } });
/** What the Admin records from the slip, at the version on their screen. */
async function review(slipId: string, f: { amount: number; ref: string; at?: string; accountId?: string; verified?: boolean; who?: { userId: string } }, version?: number) {
  const sl = await prisma.cashSettlementSlip.findUniqueOrThrow({ where: { id: slipId } });
  const st = await prisma.cashSettlement.findUniqueOrThrow({ where: { id: sl.settlementId } });
  return reviewHandInSlip(prisma, f.who ?? admin, { slipId, submissionNo: st.submissionNo, reviewVersion: version ?? sl.reviewVersion, amountSatang: f.amount, transferredAt: f.at ?? ago(40),
    bankRef: f.ref, receivingAccountId: f.accountId ?? sl.shownAccountId, recipientVerified: f.verified ?? true });
}
const tokens = async (ids: string[]) => (await prisma.cashSettlementSlip.findMany({ where: { id: { in: ids } } })).map((x) => ({ id: x.id, reviewVersion: x.reviewVersion }));

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
  guide = { userId: (await seedGuide(G)).id, guideId: G };
  guide2 = { userId: (await seedGuide(G2, { email: "g972@example.test" })).id, guideId: G2 };
  for (const [id, name] of [[TOUR, "Invented Palace Tour"], ["T-001", "Invented Three Temples"], ["T-002", "Invented Three Temples PM"]]) {
    await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "14.00 PM" } });
  }
  admin = { userId: (await prisma.user.create({ data: { email: "admin-slip@example.test", displayName: "Admin A Example", role: "ADMIN", state: "ACTIVE" } })).id };
  admin2 = { userId: (await prisma.user.create({ data: { email: "admin-slip-b@example.test", displayName: "Admin B Example", role: "ADMIN", state: "ACTIVE" } })).id };
  await seedUpsellProducts(prisma, TODAY);
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR], activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  jobId = await job(G, 2);
  job2Id = await job(G2, 3);
});
afterEach(() => vi.unstubAllEnvs());

/** ฿600 + ฿200 sold, the report sent, the account set. */
async function ready() { await sale(3); await sale(1); await endTour(G, 2); await account("7890"); }

describe("the guide: upload slips and Send — nothing typed", () => {
  it("one slip, no amount/date/ref; Send freezes what is owed and claims nothing; cash held unchanged until Admin", async () => {
    await ready();
    const sl = await upload();
    expect(sl).toMatchObject({ amountSatang: null, transferredAt: null, bankRef: null, reviewedAt: null, shownAccountDisplay: "···7890", shownAccountVersion: 1 });
    const r = await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    expect(r.submission).toMatchObject({ kind: "SLIPS", expectedSatang: 80000, totalSatang: 0, transferIds: [], slipIds: [sl.id] });
    expect(r.settlement).toMatchObject({ status: "SUBMITTED", expectedSatang: 80000, remittedSatang: 0 });
    expect(await held()).toBe(80000);
    expect(await prisma.cashSettlementTransfer.count()).toBe(0);
    expect(await prisma.bankTransaction.count()).toBe(0);
    expect(await prisma.upsellPeakEvent.count({ where: { eventKind: "BANK_CLEARING" } })).toBe(0);
    // A retry of the same send is the same send.
    expect((await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] })).replay).toBe(true);
    const v = await handInView(prisma, G, jobId);
    expect(v).toMatchObject({ status: "SUBMITTED", memo: v.settlementNo, toRemitSatang: 80000, receivingAccount: { display: "···7890" } });
    expect(v.slips[0]).not.toHaveProperty("amountSatang");
  });

  it("several slips; the same file twice is one slip; a wrong one comes out with a reason, kept in the history", async () => {
    await ready();
    const ev = await evidence(guide);
    const a = await uploadHandInSlip(prisma, guide, { jobSheetId: jobId, evidenceId: ev });
    expect((await uploadHandInSlip(prisma, guide, { jobSheetId: jobId, evidenceId: ev })).replay).toBe(true);
    const b = await upload();
    expect(await code(removeHandInSlip(prisma, guide, { slipId: b.id, reason: "x" }))).toBe("REASON");
    await removeHandInSlip(prisma, guide, { slipId: b.id, reason: "a slip from another job" });
    // The slips on screen must be the slips there are.
    expect(await code(submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [a.slip.id, b.id] }))).toBe("STALE");
    expect((await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [a.slip.id] })).submission.slipIds).toEqual([a.slip.id]);
    expect(await prisma.cashSettlementSlip.count()).toBe(2);
  });

  it("someone else's slip, a slip used by another hand-in or a transfer, another guide's job, before the report: refused", async () => {
    await ready();
    expect(await code(uploadHandInSlip(prisma, guide, { jobSheetId: jobId, evidenceId: await evidence(guide2) }))).toBe("SLIP");
    expect(await code(uploadHandInSlip(prisma, guide2, { jobSheetId: jobId, evidenceId: await evidence(guide2) }))).toBe("NOT_YOUR_JOB");
    await sale(1, guide2, job2Id);
    expect(await code(uploadHandInSlip(prisma, guide2, { jobSheetId: job2Id, evidenceId: await evidence(guide2) }))).toBe("REPORT_NOT_SENT");
    await endTour(G2, 3);
    const ev = await evidence(guide);
    await uploadHandInSlip(prisma, guide, { jobSheetId: jobId, evidenceId: ev });
    // Evidence is per guide; even so, a slip id on record for one hand-in is never filed for another.
    await prisma.paymentEvidence.update({ where: { id: ev }, data: { guideId: G2, slipUploadedBy: guide2.userId } });
    expect(await code(uploadHandInSlip(prisma, guide2, { jobSheetId: job2Id, evidenceId: ev }))).toBe("SLIP_USED");
    // And never reported again the earlier way.
    expect(await code(reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 80000, transferredAt: ago(10), bankRef: "KB-0000-1111", slip: { evidenceId: await evidence(guide) }, requestKey: key() }))).toBe("SLIPS_IN_USE");
  });

  it("nothing owed, or the hand-in already with Admin: no slip", async () => {
    await sale(1); await endTour(G, 2); await endTour(G2, 3); await account("7890");
    expect(await code(upload(guide2, job2Id))).toBe("NOTHING_OWED");
    const s = await upload();
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [s.id] });
    expect(await code(upload())).toBe("HAND_IN_SENT");
    expect(await code(removeHandInSlip(prisma, guide, { slipId: s.id, reason: "changed my mind" }))).toBe("HAND_IN_SENT");
  });
});

describe("the Admin: records what each slip shows, then Confirm in one step", () => {
  async function sent(amounts = 1) {
    await ready();
    const slips = [];
    for (let i = 0; i < amounts; i++) slips.push(await upload());
    const r = await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: slips.map((x) => x.id) });
    return { s: r.settlement, slips };
  }

  it("facts are required, from the Admin: the memo is not a ref, a recipient must be verified, a known account chosen", async () => {
    const { s, slips: [a] } = await sent();
    expect(await code(review(a.id, { amount: 0, ref: "KB-1" }))).toBe("AMOUNT");
    expect(await code(review(a.id, { amount: 80000, ref: " " }))).toBe("BANK_REF");
    expect(await code(review(a.id, { amount: 80000, ref: s.settlementNo }))).toBe("MEMO_AS_REF");
    expect(await code(review(a.id, { amount: 80000, ref: "KB-7731-0001", verified: false }))).toBe("RECIPIENT");
    expect(await code(review(a.id, { amount: 80000, ref: "KB-7731-0001", accountId: "no-such-account" }))).toBe("RECIPIENT");
    expect(await code(review(a.id, { amount: 80000, ref: "KB-7731-0001", at: new Date(Date.now() + 3_600_000).toISOString() }))).toBe("TRANSFER_TIME");
    // Unreviewed: not confirmable.
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id]) }))).toBe("NOT_REVIEWED");
    const r = await review(a.id, { amount: 80000, ref: "KB-7731-0001" });
    expect(r).toMatchObject({ reviewVersion: 1, recipientVerified: true, receivingAccountDisplay: "···7890", receivingAccountVersion: 1, reviewedById: admin.userId });
  });

  it("two slips adding up exactly: Confirm makes the transfers, one remittance, one clearing with the actual facts", async () => {
    const { s, slips: [a, b] } = await sent(2);
    const t1 = ago(50), t2 = ago(45);
    await review(a.id, { amount: 50000, ref: "KB-7731-0101", at: t1 });
    await review(b.id, { amount: 30000, ref: "KB-7731-0102", at: t2 });
    const c = await confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id, b.id]) });
    expect(c).toMatchObject({ status: "CONFIRMED", remittedSatang: 80000 });
    const transfers = await prisma.cashSettlementTransfer.findMany({ orderBy: { seq: "asc" } });
    expect(transfers.map((t) => [t.amountSatang, t.bankRef, t.transferredAt.toISOString(), t.status, t.reportedById, t.slipId])).toEqual([
      [50000, "KB-7731-0101", t1, "CONFIRMED", admin.userId, a.id], [30000, "KB-7731-0102", t2, "CONFIRMED", admin.userId, b.id]]);
    expect(await held()).toBe(0);
    expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1);
    expect(await prisma.bankTransactionUse.count({ where: { sourceTable: "CashSettlementTransfer", live: true } })).toBe(2);
    const ev = await prisma.upsellPeakEvent.findMany({ where: { eventKind: "BANK_CLEARING" } });
    expect(ev).toHaveLength(1);
    const p = ev[0].payload as { totalSatang: number; lines: { amountSatang: number; bankRef: string; transferredAt: string }[]; memo: string };
    expect(p.totalSatang).toBe(80000);
    expect(p.memo).toBe(s.settlementNo);
    expect(p.lines.map((l) => [l.amountSatang, l.bankRef, l.transferredAt])).toEqual([[50000, "KB-7731-0101", t1], [30000, "KB-7731-0102", t2]]);
    // A retry, or a second Admin, gets the one result.
    expect((await confirmHandIn(prisma, admin2, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id, b.id]) })).status).toBe("CONFIRMED");
    expect(await prisma.cashSettlementTransfer.count()).toBe(2);
    expect(await prisma.upsellPeakEvent.count({ where: { eventKind: "BANK_CLEARING" } })).toBe(1);
  });

  it("short, over, a duplicate ref within the hand-in or already in the bank registry: not confirmable", async () => {
    const { s, slips: [a, b] } = await sent(2);
    await review(a.id, { amount: 50000, ref: "KB-7731-0201" });
    expect(await code(review(b.id, { amount: 30000, ref: "kb 7731 0201" }))).toBe("BANK_REF_TWICE");
    await review(b.id, { amount: 20000, ref: "KB-7731-0202" });
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id, b.id]) }))).toBe("SHORT");
    await review(b.id, { amount: 40000, ref: "KB-7731-0202" });
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id, b.id]) }))).toBe("OVER");
    // Only every slip, ticked.
    await review(b.id, { amount: 30000, ref: "KB-7731-0202" });
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id]) }))).toBe("NOT_ALL_TICKED");
    expect(await prisma.cashSettlementTransfer.count()).toBe(0);
    expect(await held()).toBe(80000);
  });

  it("a ref already in the registry (another job's confirmed transfer) is refused at review", async () => {
    await ready();
    await sale(1, guide2, job2Id); await endTour(G2, 3);
    await prepareHandIn(prisma, guide2, { jobSheetId: job2Id });
    const t = (await reportTransfer(prisma, guide2, { jobSheetId: job2Id, amountSatang: 20000, transferredAt: ago(30), bankRef: "KB-7731-0301", slip: { evidenceId: await evidence(guide2) }, requestKey: key() })).transfer;
    const s2 = await submitHandIn(prisma, guide2, { jobSheetId: job2Id, transferIds: [t.id] });
    await confirmHandIn(prisma, admin, { settlementId: s2.settlement.id, submissionNo: 1, transferIds: [t.id] });
    const sl = await upload();
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    expect(await code(review(sl.id, { amount: 20000, ref: "KB-7731-0301" }))).toBe("BANK_TRANSFER_USED");
  });

  it("STALE REVIEW (Codex): Admin A sees ฿1,000, Admin B re-records ฿800, A's tick and A's save are refused; the fresh token works", async () => {
    const { s, slips: [a] } = await sent();
    await review(a.id, { amount: 100000, ref: "KB-7731-0401" });
    const aScreen = await tokens([a.id]); // Admin A ticks what they see: version 1, ฿1,000
    await review(a.id, { amount: 80000, ref: "KB-7731-0401", who: admin2 }); // Admin B corrects it: version 2
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: aScreen }))).toBe("STALE_REVIEW");
    expect(await code(review(a.id, { amount: 100000, ref: "KB-7731-0401" }, 1))).toBe("STALE_REVIEW");
    expect(await prisma.cashSettlementTransfer.count()).toBe(0);
    const c = await confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id]) });
    expect(c.status).toBe("CONFIRMED");
    expect((await prisma.cashSettlementTransfer.findFirstOrThrow()).amountSatang).toBe(80000);
    // Each review is audited with what it replaced.
    const audits = await prisma.auditLog.findMany({ where: { action: "upsell.hand_in_slip_reviewed", entityId: a.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((x) => [(x.detail as { before: { amountSatang: number } | null }).before?.amountSatang ?? null, (x.detail as { after: { amountSatang: number; reviewVersion: number } }).after])).toEqual([
      [null, expect.objectContaining({ amountSatang: 100000, reviewVersion: 1 })], [100000, expect.objectContaining({ amountSatang: 80000, reviewVersion: 2 })]]);
  });

  it("a screen of an earlier submission cannot review the slip in a later one", async () => {
    const { s, slips: [a] } = await sent();
    await review(a.id, { amount: 70000, ref: "KB-7731-0501" });
    await returnHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, reason: "short by ฿100 — add the missing slip" });
    const b = await upload();
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [a.id, b.id] });
    const sl = await prisma.cashSettlementSlip.findUniqueOrThrow({ where: { id: a.id } });
    expect(await code(reviewHandInSlip(prisma, admin, { slipId: a.id, submissionNo: 1, reviewVersion: sl.reviewVersion, amountSatang: 80000, transferredAt: ago(40), bankRef: "KB-7731-0501", receivingAccountId: sl.shownAccountId, recipientVerified: true }))).toBe("STALE");
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id, b.id]) }))).toBe("STALE");
    await review(b.id, { amount: 10000, ref: "KB-7731-0502" });
    expect((await confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 2, slips: await tokens([a.id, b.id]) })).status).toBe("CONFIRMED");
  });

  it("two Admins confirming at once: exactly one result", async () => {
    const { s, slips: [a] } = await sent();
    await review(a.id, { amount: 80000, ref: "KB-7731-0601" });
    const t = await tokens([a.id]);
    const other = new PrismaClient();
    try {
      const rs = await Promise.allSettled([confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: t }), confirmHandIn(other, admin2, { settlementId: s.id, submissionNo: 1, slips: t })]);
      expect(rs.every((r) => r.status === "fulfilled")).toBe(true);
    } finally { await other.$disconnect(); }
    expect(await prisma.cashSettlementTransfer.count()).toBe(1);
    expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1);
    expect(await prisma.upsellPeakEvent.count({ where: { eventKind: "BANK_CLEARING" } })).toBe(1);
  });

  it("a sale reversed after Send changes what is owed: refused — return it", async () => {
    const { s, slips: [a] } = await sent();
    await review(a.id, { amount: 80000, ref: "KB-7731-0701" });
    // As if a sale were reduced meanwhile (the reversal flow refuses while sent; the ledger is the check).
    await prisma.$executeRaw`ALTER TABLE "CashCustodyEntry" DISABLE TRIGGER USER`;
    try { await prisma.cashCustodyEntry.updateMany({ where: { kind: "COLLECTED", amountSatang: 20000 }, data: { amountSatang: 10000 } }); }
    finally { await prisma.$executeRaw`ALTER TABLE "CashCustodyEntry" ENABLE TRIGGER USER`; }
    expect(await code(confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([a.id]) }))).toBe("LEDGER_CHANGED");
  });

  it("Return keeps the slips: add one, send again — the guide never re-uploads what is there", async () => {
    const { s, slips: [a] } = await sent();
    await returnHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, reason: "the slip is unreadable — add a clear one" });
    const v = await handInView(prisma, G, jobId);
    expect(v.slips.map((x) => x.status)).toEqual(["ACTIVE"]);
    const b = await upload();
    await removeHandInSlip(prisma, guide, { slipId: a.id, reason: "unreadable photo" });
    const r = await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [b.id] });
    expect(r.submission).toMatchObject({ submissionNo: 2, slipIds: [b.id], expectedSatang: 80000 });
  });
});

describe("RECEIVING ACCOUNT SNAPSHOT (Codex): the account a slip was paid into is never relabelled", () => {
  it("default account changed after review: the clearing still names the original (now retired) account, no re-review", async () => {
    await ready();
    const orig = await acctNow();
    const sl = await upload();
    const { settlement: s } = await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    await review(sl.id, { amount: 80000, ref: "KB-7731-0801" });
    await account("4321"); // the default moves on
    expect((await acctNow()).id).not.toBe(orig.id);
    await confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([sl.id]) });
    const t = await prisma.cashSettlementTransfer.findFirstOrThrow();
    expect([t.receivingAccountId, t.receivingAccountDisplay]).toEqual([orig.id, "···7890"]);
    const e = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    expect((e.payload as { receivingAccountId: string }).receivingAccountId).toBe(orig.id);
    expect(e.blockedReasons.join(" ")).not.toContain("No receiving account");
  });

  it("uploaded before the change: the slip keeps the account shown then; the Admin may record a retired known version", async () => {
    await ready();
    const orig = await acctNow();
    const sl = await upload();
    await account("4321");
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    const row = await prisma.cashSettlementSlip.findUniqueOrThrow({ where: { id: sl.id } });
    expect([row.shownAccountId, row.shownAccountDisplay]).toEqual([orig.id, "···7890"]);
    expect((await review(sl.id, { amount: 80000, ref: "KB-7731-0901" })).receivingAccountId).toBe(orig.id);
    const view = (await listHandIns(prisma))[0].slips[0];
    expect(view).toMatchObject({ shownAccount: { display: "···7890" }, reviewed: { toAccount: "···7890", accountVersion: 1 } });
  });

  it("the database refuses a slip reviewed without a verified recipient, or a review not one version on", async () => {
    await ready();
    const sl = await upload();
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    const a = await acctNow();
    const facts = { amountSatang: 80000, transferredAt: new Date(ago(30)), transferDate: TODAY, bankRef: "KB-7731-1001", receivingAccountId: a.id, receivingAccountVersion: a.version,
      receivingAccountKey: a.bankAccountKey, receivingAccountDisplay: a.accountDisplay, reviewedById: admin.userId, reviewedAt: new Date() };
    await expect(prisma.cashSettlementSlip.update({ where: { id: sl.id }, data: { ...facts, reviewVersion: 1, recipientVerified: false } })).rejects.toThrow(/reviewed_check/);
    await expect(prisma.cashSettlementSlip.update({ where: { id: sl.id }, data: { ...facts, reviewVersion: 3, recipientVerified: true } })).rejects.toThrow(/UPSELL_SLIP_REVIEW/);
    await expect(prisma.cashSettlementSlip.update({ where: { id: sl.id }, data: { ...facts, receivingAccountDisplay: "···0000", reviewVersion: 1, recipientVerified: true } })).rejects.toThrow(/UPSELL_SLIP_ACCOUNT/);
    await expect(prisma.cashSettlementSlip.update({ where: { id: sl.id }, data: { shownAccountDisplay: "···0000" } })).rejects.toThrow(/UPSELL_SLIP_KEPT/);
  });

  it("legacy: transfers reported the earlier way still send and confirm as before", async () => {
    await ready();
    await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    const t = (await reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 80000, transferredAt: ago(30), bankRef: "KB-7731-1101", slip: { evidenceId: await evidence(guide) }, requestKey: key() })).transfer;
    expect(await code(submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [] }))).toBe("TRANSFERS_REPORTED");
    const s = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [t.id] });
    expect(s.submission.kind).toBe("TRANSFERS");
    expect((await confirmHandIn(prisma, admin, { settlementId: s.settlement.id, submissionNo: 1, transferIds: [t.id] })).remittedSatang).toBe(80000);
    expect(await held()).toBe(0);
  });
});

describe("Send to Admin (owner, 20 Nov 2026): the recorded sale is in front of Admin at once", () => {
  it("listed for finance with the guide, job, bookings × guests and the hand-in state; then the slip's state", async () => {
    await ready();
    const rows = await listCashSales(prisma);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.guideId === G && r.handIn === "NOT_SENT" && r.bookings.length > 0)).toBe(true);
    expect(rows.map((r) => r.grossSatang).sort()).toEqual([20000, 60000]);
    expect(rows.reduce((n, r) => n + r.bookings.reduce((k, b) => k + b.guests, 0), 0)).toBe(4);
    const sl = await upload();
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    expect((await listCashSales(prisma)).every((r) => r.handIn === "SUBMITTED")).toBe(true);
  });
});

describe("Job Sheet + Extras cash (owner, 21 Nov 2026): find a sale again, and see where its cash is", () => {
  it("after the company receives the money the job still lists every Sale Ref, with the Hand-in Ref and the date", async () => {
    await ready();
    const sl = await upload();
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [sl.id] });
    const s = await prisma.cashSettlement.findFirstOrThrow();
    const before = await handInView(prisma, G, jobId);
    expect(before.status).toBe("SUBMITTED");
    expect(before.sales.map((x) => x.grossSatang).sort()).toEqual([20000, 60000]);
    await review(sl.id, { amount: 80000, ref: "KB-7731-0901" });
    await confirmHandIn(prisma, admin, { settlementId: s.id, submissionNo: 1, slips: await tokens([sl.id]) });
    const v = await handInView(prisma, G, jobId);
    expect(v.status).toBe("CONFIRMED");
    expect(v.heldSatang).toBe(0); // nothing left with the guide…
    expect(v.sales.map((x) => x.saleNo).sort()).toEqual(before.sales.map((x) => x.saleNo).sort()); // …and every Sale Ref still listed
    expect(v.settlementNo).toBe(s.settlementNo);
    expect(v.history.at(-1)?.confirmedAt).toBeTruthy();
    expect(v.slips.filter((x) => x.confirmed)).toHaveLength(1);
  });

  it("finance finds a sale by its Sale Ref, its Job Ref or its job's Hand-in Ref — part of one is enough", async () => {
    await ready();
    await sale(2, guide2, job2Id); // another guide's job: never in a search for G's refs
    const all = await listCashSales(prisma);
    expect(all).toHaveLength(3);
    const mine = all.filter((r) => r.guideId === G);
    const one = mine[0];
    expect((await listCashSales(prisma, 100, one.saleNo)).map((r) => r.saleNo)).toEqual([one.saleNo]);
    expect((await listCashSales(prisma, 100, one.saleNo.toLowerCase())).map((r) => r.saleNo)).toEqual([one.saleNo]);
    expect(one.jobRef).toBeTruthy();
    expect((await listCashSales(prisma, 100, one.jobRef!)).map((r) => r.saleNo).sort()).toEqual(mine.map((r) => r.saleNo).sort());
    expect(mine.every((r) => r.handInNo === null)).toBe(true);
    await upload(); // the hand-in (and its FOLK-CSH number) exists from the first slip
    const s = await prisma.cashSettlement.findFirstOrThrow({ where: { guideId: G } });
    const byHandIn = await listCashSales(prisma, 100, s.settlementNo);
    expect(byHandIn.map((r) => r.saleNo).sort()).toEqual(mine.map((r) => r.saleNo).sort());
    expect(byHandIn.every((r) => r.handInNo === s.settlementNo)).toBe(true);
    expect(await listCashSales(prisma, 100, "NO-SUCH-REF-0000")).toEqual([]);
    expect(await listCashSales(prisma, 100, "   ")).toHaveLength(3);
  });
});
