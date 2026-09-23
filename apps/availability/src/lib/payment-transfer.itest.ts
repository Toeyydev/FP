import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { normalizeBankRef, paymentPayloadHash } from "./payment-transfer";

// The transfer evidence against a real database, because what this adds is database
// shape: six columns and an index that has to exist after `prisma migrate deploy`, not
// after `prisma db push`. A unit test cannot tell the difference; a deploy can.
//
// Every guide, figure and document number below is invented.

const REF = "FOLK-PAY-209901-07";
const EXP = "EXP-20990100042";

beforeAll(requireTestDatabase);
beforeEach(resetDatabase);

const document = (over: Record<string, unknown> = {}) => ({
  paymentRef: REF, guideId: "G-901",
  jobs: [{ date: "2099-01-05", slotIdx: 0, ref: "FOLK-BKK-20990105-01", payout: 2584 }],
  lines: [{ description: "Guide fee", jobRef: "FOLK-BKK-20990105-01", date: "2099-01-05", slotIdx: 0, kind: "GUIDE_FEE", category: null, accountCode: "510111", price: 2000, wht: 60 }],
  total: 2584, status: "AWAITING_PAYMENT", ...over,
});

/** A document that has been given a transfer reference, typed as the operator typed it. */
const withRef = (paymentRef: string, typed: string, paymentMethodId: string | null = "pm-company-kbank") =>
  prisma.guidePaymentDocument.create({
    data: document({ paymentRef, paymentMethodId, bankRef: typed, bankRefNormalized: normalizeBankRef(typed) }),
  });

describe("the columns the transfer is recorded in", () => {
  it("round-trips the evidence, what PEAK said, and the payload fingerprint", async () => {
    const hash = paymentPayloadHash({ reference: REF, products: [{ accountCode: "510111", price: 2000 }] });
    const posted = new Date("2099-01-05T03:00:00.000Z");
    await prisma.guidePaymentDocument.create({
      data: document({
        peakDocumentNo: EXP, peakDocumentId: "peak-doc-42", peakDocumentStatus: "OPEN",
        peakPostedAt: posted, peakPayloadHash: hash,
        bankRef: "KB209901051234", slipAmount: 2584, slipUploadedAt: posted, slipUrl: "https://drive.example.test/s",
      }),
    });
    const row = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: REF } });
    expect(row).toMatchObject({
      peakDocumentStatus: "OPEN", peakPayloadHash: hash, bankRef: "KB209901051234", slipAmount: 2584,
    });
    expect(row!.peakPostedAt?.toISOString()).toBe(posted.toISOString());
    expect(row!.slipUploadedAt?.toISOString()).toBe(posted.toISOString());
  });

  it("leaves every one of them null on a document made the old way — nothing is backfilled", async () => {
    await prisma.guidePaymentDocument.create({ data: document({ status: "CREATING" }) });
    const row = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: REF } });
    expect([row!.bankRef, row!.slipAmount, row!.slipUploadedAt, row!.peakDocumentStatus, row!.peakPostedAt, row!.peakPayloadHash]).toEqual([null, null, null, null, null, null]);
  });

  it("can find a transfer by the bank's own reference", async () => {
    await prisma.guidePaymentDocument.create({ data: document({ bankRef: "KB209901051234" }) });
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: "FOLK-PAY-209901-08", bankRef: "KB209901059999" }) });
    const found = await prisma.guidePaymentDocument.findMany({ where: { bankRef: "KB209901051234" }, select: { paymentRef: true } });
    expect(found).toEqual([{ paymentRef: REF }]);
  });

  it("the index the lookup needs is really in the database, not only in the schema file", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'GuidePaymentDocument' AND indexdef LIKE '%bankRef%'`;
    expect(rows.map((r) => r.indexname)).toContain("GuidePaymentDocument_bankRef_idx");
    expect(rows.map((r) => r.indexname)).toContain("GuidePaymentDocument_bankRefNormalized_idx");
    // The one that actually refuses a duplicate. `prisma db push` would not create it.
    expect(rows.map((r) => r.indexname)).toContain("GuidePaymentDocument_bank_ref_once");
  });
});

describe("one bank reference settles one document", () => {
  it("refuses a second document for the same transfer", async () => {
    await withRef(REF, "TRBS209901071234");
    await expect(withRef("FOLK-PAY-209901-08", "TRBS209901071234")).rejects.toMatchObject({ code: "P2002" });
  });

  it("a reference typed in another case, or with spaces, is the same transfer", async () => {
    await withRef(REF, "TRBS209901071234");
    await expect(withRef("FOLK-PAY-209901-08", " trbs 2099 0107 1234 ")).rejects.toMatchObject({ code: "P2002" });
  });

  it("the same reference from a different account is a different transfer", async () => {
    // Reference numbers are only unique within a bank.
    await withRef(REF, "1234567890", "pm-company-kbank");
    await expect(withRef("FOLK-PAY-209901-08", "1234567890", "pm-company-scb")).resolves.toMatchObject({ paymentRef: "FOLK-PAY-209901-08" });
  });

  it("a document with no payment method yet cannot slip past the rule through a null", async () => {
    await withRef(REF, "TRBS209901071234", null);
    await expect(withRef("FOLK-PAY-209901-08", "TRBS209901071234", null)).rejects.toMatchObject({ code: "P2002" });
  });

  it("documents with no reference yet do not collide with each other", async () => {
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: REF }) });
    await expect(prisma.guidePaymentDocument.create({ data: document({ paymentRef: "FOLK-PAY-209901-08" }) })).resolves.toBeTruthy();
  });

  it("two people recording the same transfer at the same moment: exactly one wins", async () => {
    // The race an application check cannot win — both read, both see nothing, both write.
    // The database decides instead.
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: REF, paymentMethodId: null }) });
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: "FOLK-PAY-209901-08", paymentMethodId: null }) });
    const claim = (paymentRef: string) =>
      prisma.guidePaymentDocument.update({
        where: { paymentRef },
        data: { status: "PAYING", paymentMethodId: "pm-company-kbank", bankRef: "TRBS209901071234", bankRefNormalized: normalizeBankRef("TRBS209901071234") },
      });
    const results = await Promise.allSettled([claim(REF), claim("FOLK-PAY-209901-08")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const paying = await prisma.guidePaymentDocument.findMany({ where: { bankRefNormalized: "TRBS209901071234" }, select: { paymentRef: true } });
    expect(paying).toHaveLength(1);
  });

  it("names the payment a reference is already recorded on", async () => {
    await withRef(REF, "TRBS209901071234");
    const clash = await prisma.guidePaymentDocument.findFirst({
      where: { bankRefNormalized: normalizeBankRef("trbs 2099 0107 1234"), paymentMethodId: "pm-company-kbank" },
      select: { paymentRef: true },
    });
    expect(clash).toEqual({ paymentRef: REF });
  });
});
