import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { bankAccountKey, normalizeBankRef, paymentPayloadHash } from "./payment-transfer";

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
const KBANK = { id: "pm-kbank-transfer", accountNumber: "123-4-56789-0" };
const KBANK_QR = { id: "pm-kbank-qr", accountNumber: "1234567890" }; // same account, other channel
const SCB = { id: "pm-scb", accountNumber: "987-6-54321-0" };

const withRef = (paymentRef: string, typed: string, method: { id: string; accountNumber?: string } | null = KBANK) =>
  prisma.guidePaymentDocument.create({
    data: document({
      paymentRef, paymentMethodId: method?.id ?? null, bankAccountKey: bankAccountKey(method),
      bankRef: typed, bankRefNormalized: normalizeBankRef(typed),
    }),
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
    // The one that actually refuses a duplicate.
    expect(rows.map((r) => r.indexname)).toContain("GuidePaymentDocument_bankAccountKey_bankRefNormalized_key");
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

  it("the same reference from a different bank account is a different transfer", async () => {
    // Reference numbers are only unique within a bank.
    await withRef(REF, "TRBS209901071234", KBANK);
    await expect(withRef("FOLK-PAY-209901-08", "TRBS209901071234", SCB)).resolves.toMatchObject({ paymentRef: "FOLK-PAY-209901-08" });
  });

  it("the same reference through ANOTHER payment method on the SAME account is still one transfer", async () => {
    // The hole this closes: PEAK's payment method is a channel, so keying uniqueness on
    // it would let the same transfer be recorded twice by choosing the other channel.
    await withRef(REF, "TRBS209901071234", KBANK);
    await expect(withRef("FOLK-PAY-209901-08", "TRBS209901071234", KBANK_QR)).rejects.toMatchObject({ code: "P2002" });
  });

  it("a reference is only ever written together with the account it came from", async () => {
    // Postgres treats NULL as distinct, so two rows with no account would not collide.
    // Nothing can reach that state: a payment with no "Paid by" is refused before the
    // claim, PEAK is asked which account it is, and the two columns are written together.
    await withRef(REF, "TRBS209901071234", null);
    await expect(withRef("FOLK-PAY-209901-08", "TRBS209901071234", null)).resolves.toBeTruthy();
  });

  it("documents with no reference yet do not collide with each other", async () => {
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: REF }) });
    await expect(prisma.guidePaymentDocument.create({ data: document({ paymentRef: "FOLK-PAY-209901-08" }) })).resolves.toBeTruthy();
  });

  it("two people recording the same transfer at the same moment: exactly one wins", async () => {
    // The race an application check cannot win — both read, both see nothing, both write.
    // The database decides instead.
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: REF }) });
    await prisma.guidePaymentDocument.create({ data: document({ paymentRef: "FOLK-PAY-209901-08" }) });
    const claim = (paymentRef: string) =>
      prisma.guidePaymentDocument.update({
        where: { paymentRef },
        data: {
          status: "PAYING", paymentMethodId: KBANK.id, bankAccountKey: bankAccountKey(KBANK),
          bankRef: "TRBS209901071234", bankRefNormalized: normalizeBankRef("TRBS209901071234"),
        },
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
      where: { bankRefNormalized: normalizeBankRef("trbs 2099 0107 1234"), bankAccountKey: bankAccountKey(KBANK) },
      select: { paymentRef: true },
    });
    expect(clash).toEqual({ paymentRef: REF });
  });
});

describe("the account a transfer left from is a fact about money that has moved", () => {
  it("cannot be changed once a bank reference is recorded against it", async () => {
    await withRef(REF, "TRBS209901071234", KBANK);
    await expect(prisma.guidePaymentDocument.update({
      where: { paymentRef: REF }, data: { paymentMethodId: SCB.id, bankAccountKey: bankAccountKey(SCB) },
    })).rejects.toThrow(/recorded against another account/);
  });

  it("cannot be changed once PEAK has confirmed the payment", async () => {
    await withRef(REF, "TRBS209901071234", KBANK);
    await prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { status: "PAID" } });
    await expect(prisma.guidePaymentDocument.update({
      where: { paymentRef: REF }, data: { paymentMethodId: SCB.id, bankAccountKey: bankAccountKey(SCB) },
    })).rejects.toThrow(/is recorded/);
  });

  it("neither can the reference or the amount, once it is paid", async () => {
    await withRef(REF, "TRBS209901071234", KBANK);
    await prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { status: "PAID", slipAmount: 2584 } });
    await expect(prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { bankRefNormalized: "SOMETHINGELSE" } })).rejects.toThrow(/is recorded/);
    await expect(prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { slipAmount: 1 } })).rejects.toThrow(/is recorded/);
  });

  it("but the whole claim can still be withdrawn — that leaves nothing claimed", async () => {
    // PEAK refusing the payment, or an operator confirming no payment exists, clears the
    // reference and the account together.
    await withRef(REF, "TRBS209901071234", KBANK);
    await expect(prisma.guidePaymentDocument.update({
      where: { paymentRef: REF },
      data: { status: "AWAITING_PAYMENT", paymentMethodId: null, bankAccountKey: null, bankRef: null, bankRefNormalized: null, slipAmount: null },
    })).resolves.toBeTruthy();
    // …and the reference is free again.
    await expect(withRef("FOLK-PAY-209901-08", "TRBS209901071234", KBANK)).resolves.toBeTruthy();
  });

  it("everything else about a paid document may still be recorded", async () => {
    await withRef(REF, "TRBS209901071234", KBANK);
    await prisma.guidePaymentDocument.update({ where: { paymentRef: REF }, data: { status: "PAID" } });
    await expect(prisma.guidePaymentDocument.update({
      where: { paymentRef: REF }, data: { attachmentStatus: "ATTACHED", peakDocumentStatus: "PAID" },
    })).resolves.toBeTruthy();
  });

  it("the trigger that enforces it is really in the database", async () => {
    const rows = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = '"GuidePaymentDocument"'::regclass AND NOT tgisinternal`;
    expect(rows.map((r) => r.tgname)).toContain("guide_payment_account_frozen");
  });
});

describe("the schema file and the migrations describe the same table", () => {
  it("nothing about GuidePaymentDocument would be created or dropped by a migration", () => {
    // `prisma migrate deploy` has run; this asks Prisma whether the database it produced
    // still differs from schema.prisma. If a unique index or a column were declared in
    // only one of the two, the next `prisma migrate dev` would offer to drop or recreate
    // it — the class of surprise this PR's constraint must never become.
    //
    // Scoped to this table on purpose. The same command reports three differences
    // inherited from the advance-ledger migrations (an updatedAt default, an extra
    // foreign key on GuideAdvanceEntry.reversedByEntryId, and an index on
    // GuidePaymentAdjustment.advanceId) which are not this change's to decide.
    const diff = execFileSync("npx", [
      "prisma", "migrate", "diff",
      "--from-schema-datasource", "prisma/schema.prisma",
      "--to-schema-datamodel", "prisma/schema.prisma",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const ours = diff.split("\n").filter((l) => /GuidePaymentDocument/.test(l));
    expect(ours, `schema.prisma and the migrations disagree about GuidePaymentDocument:\n${ours.join("\n")}`).toEqual([]);
  });
});
