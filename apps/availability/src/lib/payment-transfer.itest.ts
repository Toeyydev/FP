import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { paymentPayloadHash } from "./payment-transfer";

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
  });
});
