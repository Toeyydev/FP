import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { resolvePaymentDocument } from "./peak-payment-server";

// The markDocumentPaid race (Codex, PR4-P acceptance): PEAK recorded the payment, then the
// local write failed. The document must stay visibly PAYMENT_UNCERTAIN and can never be made
// payable again — not by an operator's "payment not found", not by any other write.
// Every guide, figure and document number below is invented.

const REF = "FOLK-PAY-209902-07";
const actor = { actorId: null, actorRole: "ADMIN" };

beforeAll(requireTestDatabase);
beforeEach(resetDatabase);

const doc = (over: Record<string, unknown> = {}) => prisma.guidePaymentDocument.create({ data: {
  paymentRef: REF, guideId: "G-902", status: "PAYMENT_UNCERTAIN", peakDocumentNo: "EXP-20990200042", paymentDate: "2099-02-05",
  jobs: [{ date: "2099-02-05", slotIdx: 0, ref: "FOLK-BKK-20990205-01", payout: 2584 }], total: 2584,
  lines: [{ description: "Guide fee", jobRef: "FOLK-BKK-20990205-01", date: "2099-02-05", slotIdx: 0, kind: "GUIDE_FEE", category: null, accountCode: "510111", price: 2000, wht: 60 }],
  updatedAt: new Date("2099-01-01T00:00:00Z"), ...over } as never });

describe("PEAK confirmed a payment, then FolkOPS failed to mark the jobs", () => {
  it("'payment not found' is refused, and the document stays PAYMENT_UNCERTAIN", async () => {
    await doc({ peakPaymentConfirmedAt: new Date("2099-02-05T03:00:00Z") });
    const r = await resolvePaymentDocument(REF, { resolution: "payment-not-found" } as never, actor);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((await prisma.guidePaymentDocument.findUniqueOrThrow({ where: { paymentRef: REF } })).status).toBe("PAYMENT_UNCERTAIN");
  });

  it("the database refuses any write that makes it payable again, or clears the stamp", async () => {
    await doc({ peakPaymentConfirmedAt: new Date("2099-02-05T03:00:00Z") });
    await expect(prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { status: "AWAITING_PAYMENT" } })).rejects.toThrow(/PAYMENT_PEAK_CONFIRMED/);
    await expect(prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { peakPaymentConfirmedAt: null } })).rejects.toThrow(/PAYMENT_PEAK_CONFIRMED/);
  });

  it("without PEAK's confirmation 'payment not found' still works as before", async () => {
    await doc();
    expect(await resolvePaymentDocument(REF, { resolution: "payment-not-found" } as never, actor)).toEqual({ ok: true });
    expect((await prisma.guidePaymentDocument.findUniqueOrThrow({ where: { paymentRef: REF } })).status).toBe("AWAITING_PAYMENT");
  });
});
