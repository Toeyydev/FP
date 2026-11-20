import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The guest QR for a walk-in seat against a real database (mockup pr4q approved with Codex's
// corrections). A registration is never money; only the guide's cash confirmation makes the sale.
// Every name, number and reference is invented.

import QRCode from "qrcode";
import jsQR from "jsqr";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { UpsellSaleError, recordWalkInSale } from "./sales";
import {
  WalkInQrError, confirmRegistrationCash, currentQr, guestCancel, guestRegistrationView, guideDecline, guideRegistrations, openQr, publicQrView,
  qrOrigin, registerFromQr, stopQr, sweepWalkInRegistrations, type QrActor,
} from "./walk-in-qr";
import { confirmHandIn, decideReversal, errorAffirmationText, prepareHandIn, reportTransfer, requestErrorReversal, requestRefundReversal, setReceivingAccount, submitHandIn } from "./settlement";
import { syncUpsellPeakBatch } from "./peak-sync";
import { upsellPeakAdapter, type PeakJournalClient } from "./peak-adapter";
import { GUIDE_CASH_HELD } from "./peak-outbox";

const TODAY = bangkokToday();
const G = "G-981", G2 = "G-982", TOUR = "T-001";
let guide: QrActor & { guideId: string }, other: QrActor & { guideId: string }, admin: QrActor;
let jobId = "", seq = 0;
const key = () => `qr-key-${String(++seq).padStart(4, "0")}-${Math.random().toString(36).slice(2, 12)}`;
async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof WalkInQrError || e instanceof UpsellSaleError ? e.code : `UNEXPECTED: ${String((e as Error).message).slice(0, 300)}`; }
}
const tokenOf = (url: string) => url.split("/w/")[1];
const financial = async () => ({
  sales: await prisma.upsellSale.count(), payments: await prisma.upsellPayment.count(), custody: await prisma.cashCustodyEntry.count(),
  walkInBookings: await prisma.booking.count({ where: { source: "walk-in" } }), peak: await prisma.upsellPeakEvent.count(),
});
const register = (token: string, guests = 2, extra: Record<string, unknown> = {}) => registerFromQr(prisma, token, { requestKey: key(), guests, ...extra });

async function version2(price = 70000) {
  const v1 = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" }, version: 1 } });
  const { id: _id, createdAt: _c, version: _v, ...rest } = v1;
  await prisma.upsellProductVersion.update({ where: { id: v1.id }, data: { activeTo: new Date(`${addDays(TODAY, -2)}T00:00:00Z`), activeFrom: new Date(`${addDays(TODAY, -3)}T00:00:00Z`) } });
  return prisma.upsellProductVersion.create({ data: { ...rest, version: 2, unitPriceSatang: price, revenueCategory: "TOUR_SERVICE_REVENUE", activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`), activeTo: null } });
}
/** A newer version from today (a price change): the old QR and its unpaid registrations end. */
async function version3(price: number) {
  const v2 = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" }, version: 2 } });
  const { id: _id, createdAt: _c, version: _v, ...rest } = v2;
  await prisma.upsellProductVersion.update({ where: { id: v2.id }, data: { activeTo: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
  return prisma.upsellProductVersion.create({ data: { ...rest, version: 3, unitPriceSatang: price, activeFrom: new Date(`${TODAY}T00:00:00Z`), activeTo: null } });
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "1");
  vi.stubEnv("UPSELL_WALKIN_QR_ENABLED", "1");
  guide = { userId: (await seedGuide(G)).id, role: "GUIDE", guideId: G };
  other = { userId: (await seedGuide(G2, { email: "g982@example.test" })).id, role: "GUIDE", guideId: G2 };
  admin = { userId: (await prisma.user.create({ data: { email: "admin-qr@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } })).id, role: "ADMIN", guideId: null };
  for (const [id, name] of [[TOUR, "Invented Three Temples"], ["T-002", "Invented Three Temples PM"]]) await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "08.00 AM" } });
  await seedUpsellProducts(prisma, addDays(TODAY, -3));
  await prisma.upsellProduct.update({ where: { productCode: "THREE-TEMPLES-ONSITE" }, data: { active: true } });
  await version2();
  await prisma.assignment.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR, pax: 7 } });
  await prisma.booking.create({ data: { source: "bokun", externalId: `ota-${Math.random()}`, confirmationCode: "INV-OTA-9", tourId: TOUR, date: TODAY, slotIdx: 0, pax: 7, status: "ASSIGNED", customerName: "Invented OTA Guest" } });
  jobId = (await prisma.jobSheet.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR, bookings: [{ name: "Invented OTA Guest", bookingNo: "INV-OTA-9", bookedPax: 7, actualPax: null, tickets: "", status: "" }] } })).id;
});
afterEach(() => vi.unstubAllEnvs());

describe("the QR (guide of the job, or Admin)", () => {
  it("encodes exactly the canonical public URL of its token — decoded back from the QR's own modules", async () => {
    const card = await openQr(prisma, guide, jobId);
    if (!card.open) throw new Error(card.message);
    expect(card.url).toMatch(new RegExp(`^${qrOrigin().replace(/[.]/g, "\\.")}/w/[A-Za-z0-9_-]{32}$`));
    expect(card.svg).toBe(await QRCode.toString(card.url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }));
    // Render the same modules to pixels and decode them.
    const qr = QRCode.create(card.url, { errorCorrectionLevel: "M" });
    const n = qr.modules.size, scale = 6, quiet = 4, size = (n + quiet * 2) * scale;
    const px = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
    }
    expect(jsQR(px, size, size)?.data).toBe(card.url);
    // The token in it opens the public page.
    expect(await publicQrView(prisma, tokenOf(card.url))).toMatchObject({ state: "OPEN", unitPriceSatang: 70000, seatsLeft: 5, time: "08:30" });
  });

  it("only the job's own guide (or an Admin) opens it; showing it again is the same QR", async () => {
    expect(await code(openQr(prisma, other, jobId))).toBe("NOT_YOUR_JOB");
    const a = await openQr(prisma, admin, jobId);
    const again = await currentQr(prisma, guide, jobId);
    expect(again.open && a.open && again.url === a.url).toBe(true);
  });

  it("the origin is the app's https address, never a Host header; http only on localhost outside production", () => {
    expect(qrOrigin("https://ops.example.test/x")).toBe("https://ops.example.test");
    expect(() => qrOrigin("http://ops.example.test")).toThrow(WalkInQrError);
    expect(qrOrigin("http://localhost:3992", false)).toBe("http://localhost:3992");
    expect(() => qrOrigin("http://localhost:3992", true)).toThrow(WalkInQrError);
  });
});

describe("the guest page (no account)", () => {
  it("shows the tour, never a guest list, the guide's code or anyone's contact; an unknown token is 404", async () => {
    const card = await openQr(prisma, guide, jobId);
    const v = await publicQrView(prisma, tokenOf((card as { url: string }).url));
    const json = JSON.stringify(v);
    for (const secret of [G, "Invented OTA Guest", "INV-OTA-9", jobId]) expect(json).not.toContain(secret);
    expect(v).toMatchObject({ state: "OPEN", tourName: "Invented Three Temples", date: TODAY, maxGuests: 5 });
    expect(await publicQrView(prisma, "A".repeat(32))).toBeNull();
    expect(await publicQrView(prisma, "not-a-token")).toBeNull();
  });

  it("a replaced, stopped, expired or out-of-date QR says so — and registers nothing", async () => {
    const first = await openQr(prisma, guide, jobId) as { url: string };
    const second = await openQr(prisma, guide, jobId) as { url: string };
    expect(await publicQrView(prisma, tokenOf(first.url))).toMatchObject({ state: "CLOSED", message: expect.stringMatching(/no longer valid/) });
    expect(await code(register(tokenOf(first.url)))).toBe("CLOSED");
    const tomorrow = new Date(`${addDays(TODAY, 1)}T03:00:00Z`);
    expect(await publicQrView(prisma, tokenOf(second.url), tomorrow)).toMatchObject({ state: "CLOSED" });
    await version3(75000);
    expect(await publicQrView(prisma, tokenOf(second.url))).toMatchObject({ state: "CLOSED", message: expect.stringMatching(/out of date/) });
    await stopQr(prisma, guide, jobId);
    expect(await prisma.walkInRegistration.count()).toBe(0);
  });

  it("registering is PENDING only: no sale, payment, cash, booking or PEAK event; the server sets the price", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const before = await financial();
    const r = await register(tokenOf(card.url), 2, { leadName: "Invented Guest", contact: "+66 00 000 0000" });
    expect(r.reference).toMatch(/^W-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await financial()).toEqual(before);
    expect(await prisma.walkInRegistration.findFirstOrThrow()).toMatchObject({ status: "PENDING", guests: 2, unitPriceSatang: 70000, totalSatang: 140000 });
    // A guest cannot set the price, the job, a status or a ref.
    for (const bad of [{ unitPriceSatang: 1 }, { totalSatang: 1 }, { jobSheetId: "x" }, { status: "CONFIRMED" }, { saleNo: "FOLK-UPS-1" }, { paid: true }]) {
      expect(await code(register(tokenOf(card.url), 1, bad))).toBe("BAD_REQUEST");
    }
    expect(await code(register(tokenOf(card.url), 6))).toBe("TOO_MANY_GUESTS"); // 7 on the job, 12 per guide
    // The audit row carries no personal data.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "upsell.walk_in_registered" } });
    expect(JSON.stringify(audit.detail)).not.toMatch(/Invented Guest|\+66/);
    expect((await prisma.walkInRegistration.findFirstOrThrow()).contactEnc).not.toContain("+66");
  });

  it("the same request key again is the same registration; the guest sees only their own, by its token", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const k = key();
    const a = await registerFromQr(prisma, tokenOf(card.url), { requestKey: k, guests: 1 });
    const b = await registerFromQr(prisma, tokenOf(card.url), { requestKey: k, guests: 1 });
    expect(b).toEqual({ ...a, replay: true });
    const c = await register(tokenOf(card.url), 2);
    const mine = await guestRegistrationView(prisma, a.viewToken);
    expect(mine).toMatchObject({ reference: a.reference, state: "WAITING", guests: 1, totalSatang: 70000, sale: null });
    expect(JSON.stringify(mine)).not.toContain(c.reference);
    expect(await guestRegistrationView(prisma, "B".repeat(32))).toBeNull();
  });
});

describe("the guide records the cash", () => {
  it("only the job's guide; once → one sale, booking, guest-list row, custody and receipt; the guest then sees PAID", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const r = await register(tokenOf(card.url), 2, { leadName: "Invented Ana" });
    const reg = await prisma.walkInRegistration.findFirstOrThrow();
    expect(await code(confirmRegistrationCash(prisma, other, reg.id))).toBe("NOT_YOUR_JOB");
    expect(await guestRegistrationView(prisma, r.viewToken)).toMatchObject({ state: "WAITING" });
    // Two taps / two tabs at once: one financial result.
    const [x, y] = await Promise.all([confirmRegistrationCash(prisma, guide, reg.id), confirmRegistrationCash(prisma, guide, reg.id).catch((e) => e)]);
    const third = await confirmRegistrationCash(prisma, guide, reg.id);
    expect(third.sale.saleNo).toBe(x.sale.saleNo);
    expect(y instanceof Error ? String(y) : y.sale.saleNo).toBe(x.sale.saleNo);
    expect(await financial()).toMatchObject({ sales: 1, payments: 1, custody: 1, walkInBookings: 1, peak: 1 });
    expect(x.sale).toMatchObject({ kind: "WALK_IN", grossSatang: 140000, guests: 2 });
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).bookings as { name: string; bookingNo: string }[];
    expect(rows.map((b) => b.name)).toEqual(["Invented OTA Guest", "Invented Ana"]);
    expect(await guestRegistrationView(prisma, r.viewToken)).toMatchObject({ state: "PAID", sale: { saleNo: x.sale.saleNo, receipt: { state: "WAITING", peakCode: null } } });
    expect(await code(guestCancel(prisma, r.viewToken))).toBe("PAID");
    expect(await code(guideDecline(prisma, guide, reg.id))).toBe("NOT_WAITING");
  });

  it("no seat is held by registering: a full job refuses the cash confirmation (the registration keeps waiting)", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    await register(tokenOf(card.url), 3);
    const reg = await prisma.walkInRegistration.findFirstOrThrow();
    const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { version: 2, product: { productCode: "THREE-TEMPLES-ONSITE" } } });
    await recordWalkInSale(prisma, { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 4, expectedUnitPriceSatang: 70000 }, guide); // 11 now
    expect(await code(confirmRegistrationCash(prisma, guide, reg.id))).toBe("TOO_MANY_GUESTS");
    expect((await prisma.walkInRegistration.findUniqueOrThrow({ where: { id: reg.id } })).status).toBe("PENDING");
  });

  it("after the end-tour report, or a price change, the cash is refused and the registration ends — its personal data cleared", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const a = await register(tokenOf(card.url), 1, { leadName: "Invented Bo", contact: "bo@example.test" });
    await version3(75000);
    const regA = await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: a.reference } });
    expect(await code(confirmRegistrationCash(prisma, guide, regA.id))).toBe("REGISTRATION_CLOSED");
    expect(await prisma.walkInRegistration.findUniqueOrThrow({ where: { id: regA.id } })).toMatchObject({ status: "EXPIRED", leadName: null, contactEnc: null, endReason: expect.stringMatching(/details changed/) });
    expect(await guestRegistrationView(prisma, a.viewToken)).toMatchObject({ state: "ENDED" });
    expect((await financial()).sales).toBe(0);
    // The new QR, the new price; then the report closes it too.
    const fresh = await openQr(prisma, guide, jobId) as { url: string; unitPriceSatang: number };
    expect(fresh.unitPriceSatang).toBe(75000);
    const b = await register(tokenOf(fresh.url), 1, { leadName: "Invented Chai" });
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
    const regB = await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: b.reference } });
    expect(await code(confirmRegistrationCash(prisma, guide, regB.id))).toBe("REGISTRATION_CLOSED");
    expect(await prisma.walkInRegistration.findUniqueOrThrow({ where: { id: regB.id } })).toMatchObject({ status: "EXPIRED", leadName: null });
  });

  it("a new QR ends unpaid registrations of the old one, never a paid one", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const paid = await register(tokenOf(card.url), 1, { leadName: "Invented Paid" });
    const unpaid = await register(tokenOf(card.url), 1, { leadName: "Invented Unpaid", contact: "u@example.test" });
    const regPaid = await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: paid.reference } });
    const sold = await confirmRegistrationCash(prisma, guide, regPaid.id);
    await openQr(prisma, guide, jobId);
    expect(await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: unpaid.reference } })).toMatchObject({ status: "EXPIRED", leadName: null, contactEnc: null });
    expect(await guestRegistrationView(prisma, paid.viewToken)).toMatchObject({ state: "PAID", sale: { saleNo: sold.sale.saleNo } });
    expect((await prisma.booking.findFirstOrThrow({ where: { source: "walk-in" } })).status).toBe("ASSIGNED");
  });

  it("the guest cancels their own waiting registration; the guide can decline one; the sweep ends the expired ones", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const a = await register(tokenOf(card.url), 1, { contact: "a@example.test" });
    const b = await register(tokenOf(card.url), 1, { leadName: "Invented B" });
    const c = await register(tokenOf(card.url), 1, { leadName: "Invented C" });
    expect(await guestCancel(prisma, a.viewToken)).toEqual({ cancelled: true });
    expect(await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: a.reference } })).toMatchObject({ status: "CANCELLED", contactEnc: null });
    const regB = await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: b.reference } });
    expect(await code(guideDecline(prisma, other, regB.id))).toBe("NOT_YOUR_JOB");
    await guideDecline(prisma, guide, regB.id);
    const later = new Date(Date.now() + 5 * 3600_000);
    expect(await sweepWalkInRegistrations(prisma, later)).toEqual({ ended: 1, scrubbed: 0 });
    expect(await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: c.reference } })).toMatchObject({ status: "EXPIRED", leadName: null });
    const list = await guideRegistrations(prisma, guide, jobId, later);
    expect(list.map((r) => r.state)).toEqual(["ENDED", "ENDED", "ENDED"]);
    expect(list.every((r) => r.leadName === null && r.contact === null)).toBe(true);
  });

  it("the database keeps what a registration is and refuses a PAID one without its sale", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    await register(tokenOf(card.url), 1);
    const reg = await prisma.walkInRegistration.findFirstOrThrow();
    await expect(prisma.walkInRegistration.update({ where: { id: reg.id }, data: { unitPriceSatang: 1, totalSatang: 1 } })).rejects.toThrow(/WALKIN_REGISTRATION_KEPT/);
    await expect(prisma.walkInRegistration.update({ where: { id: reg.id }, data: { status: "CONFIRMED", decidedAt: new Date() } })).rejects.toThrow(/sale_check/);
    await expect(prisma.walkInRegistration.delete({ where: { id: reg.id } })).rejects.toThrow(/WALKIN_REGISTRATION_KEPT/);
  });
});

describe("end to end: scan → register → guide confirms the cash → guest PAID → guest list → hand-in code → PEAK once", () => {
  it("one receipt (Tour Service Revenue ฿1,400) and one clearing, sent by the worker", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const r = await register(tokenOf(card.url), 2);
    const reg = await prisma.walkInRegistration.findFirstOrThrow();
    const sold = await confirmRegistrationCash(prisma, guide, reg.id);
    expect(await guestRegistrationView(prisma, r.viewToken)).toMatchObject({ state: "PAID" });
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).bookings as { name: string; bookingNo: string }[];
    expect(rows.find((x) => x.bookingNo === sold.sale.saleNo)?.name).toBe(`Walk-in · ${sold.sale.saleNo}`);
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
    const prep = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(prep).toMatchObject({ owedSatang: 140000, memo: expect.stringMatching(/^FOLK-CSH-/) });
    await setReceivingAccount(prisma, admin, { peakPaymentMethodId: "pm-7890", label: "Extras (example)", confirmSuitable: true }, async (id) => ({ id, name: "Invented Bank", bankAccountKey: "ACC:999007890", accountDisplay: "···7890" }));
    const ev = (await prisma.paymentEvidence.create({ data: { googleDriveFileId: "drive-qr", fileHash: "hash-qr", driveLink: "https://example.test/slip-qr", guideId: G, slipUploadedBy: guide.userId } })).id;
    const t = (await reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 140000, transferredAt: new Date(Date.now() - 20 * 60_000).toISOString(), bankRef: "KB-QR-0001", slip: { evidenceId: ev }, requestKey: key() })).transfer;
    const sub = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [t.id] });
    await confirmHandIn(prisma, admin, { settlementId: sub.settlement.id, submissionNo: 1, transferIds: [t.id] });
    for (const [c, no] of [[GUIDE_CASH_HELD, "113999"], ["TOUR_SERVICE_REVENUE", "410199"]]) await prisma.peakAccountMapping.upsert({ where: { folkopsCategory: c }, update: { peakAccountCode: no, isActive: true }, create: { folkopsCategory: c, peakAccountCode: no } });
    await prisma.taxProfile.updateMany({ where: { code: "UPSELL-STD" }, data: { status: "CONFIRMED", peakDocumentKind: "RECEIPT", vatMode: "NONE", revenueRecognition: "AT_SERVICE", breakageOnExpiry: false, incentiveWhtMode: "NOT_WITHHELD", fixedCostWhtMode: "NOT_WITHHELD", confirmedById: admin.userId, confirmedAt: new Date() } });
    const docs: string[] = []; let n = 0; const sent: Record<string, unknown>[] = [];
    const client: PeakJournalClient = {
      async createDailyJournal(j) { docs.push("JOURNAL"); sent.push(j as never); return { ok: true, id: `pj-${++n}`, code: `JV-TEST-${n}` }; },
      async getDailyJournal() { return { ok: true, notFound: true }; },
      async createReceipt(rc) { docs.push("RECEIPT"); sent.push(rc as never); return { ok: true, id: `rc-${++n}`, code: `RE-TEST-${n}` }; },
      async getReceiptsByReference() { return { ok: true, receipts: [] }; },
    };
    const adapter = upsellPeakAdapter(client, () => ({ clearingJournalTypeId: "jt", clearingContactId: "ct", receivingAccounts: { "pm-7890": { accountCode: "111299", accountSubId: "sub" } }, receiptContactId: "ct-walkin", receiptPayment: { mode: "ACCOUNT_CODE" } }));
    for (let i = 0; i < 4; i++) await syncUpsellPeakBatch(prisma, adapter);
    expect(docs).toEqual(["RECEIPT", "JOURNAL"]);
    expect(sent[0]).toMatchObject({ reference: sold.sale.saleNo, taxStatus: 2, products: [expect.objectContaining({ accountCode: "410199", quantity: 2, price: 700, vatType: 1 })] });
    expect(JSON.stringify(sent)).not.toMatch(/Invented|@example/); // no guest data in PEAK
    expect(await guestRegistrationView(prisma, r.viewToken)).toMatchObject({ state: "PAID", sale: { receipt: { state: "SYNCED", peakCode: expect.stringMatching(/^RE-TEST-/) } } });
    await prisma.peakAccountMapping.deleteMany({ where: { folkopsCategory: { in: [GUIDE_CASH_HELD, "TOUR_SERVICE_REVENUE"] } } });
  });
});

describe("switched off, the cleanup still runs: waiting registrations end, personal data goes, paid history stays", () => {
  for (const off of ["UPSELL_WALKIN_QR_ENABLED", "UPSELL_ENABLED"]) {
    it(`with ${off} off`, async () => {
      const card = await openQr(prisma, guide, jobId) as { url: string };
      const paid = await register(tokenOf(card.url), 1, { leadName: "Invented Paid", contact: "p@example.test" });
      const unpaid = await register(tokenOf(card.url), 2, { leadName: "Invented Waiting", contact: "w@example.test" });
      const sold = await confirmRegistrationCash(prisma, guide, (await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: paid.reference } })).id);
      const before = await financial();
      vi.stubEnv(off, "0");
      expect(await sweepWalkInRegistrations(prisma)).toEqual({ ended: 1, scrubbed: 0 });
      expect(await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: unpaid.reference } })).toMatchObject({ status: "EXPIRED", leadName: null, contactEnc: null, endReason: expect.stringMatching(/switched off/) });
      expect(await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: paid.reference } })).toMatchObject({ status: "CONFIRMED", saleId: expect.any(String) });
      expect(await financial()).toEqual(before); // the cleanup makes no sale, cash, booking or PEAK event
      expect((await prisma.upsellSale.findFirstOrThrow()).saleNo).toBe(sold.sale.saleNo);
    });
  }

  it("an ended unpaid row that still carries personal data is scrubbed; a paid one keeps its name", async () => {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const a = await register(tokenOf(card.url), 1, { leadName: "Invented Left", contact: "l@example.test" });
    const reg = await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: a.reference } });
    // As an older code path might have ended it: status changed, data left behind.
    await prisma.walkInRegistration.update({ where: { id: reg.id }, data: { status: "EXPIRED", decidedAt: new Date(), endReason: "ended (example)" } });
    expect(await sweepWalkInRegistrations(prisma)).toEqual({ ended: 0, scrubbed: 1 });
    expect(await prisma.walkInRegistration.findUniqueOrThrow({ where: { id: reg.id } })).toMatchObject({ leadName: null, contactEnc: null, status: "EXPIRED" });
  });
});

describe("after the cash: an Admin's reversal shows truthfully to the guest and the guide", () => {
  async function paidRegistration(name: string) {
    const card = await openQr(prisma, guide, jobId) as { url: string };
    const r = await register(tokenOf(card.url), 2, { leadName: name });
    const reg = await prisma.walkInRegistration.findFirstOrThrow({ where: { reference: r.reference } });
    const sold = await confirmRegistrationCash(prisma, guide, reg.id);
    return { r, reg, saleNo: sold.sale.saleNo };
  }

  it("refunded by the company → REFUNDED (not 'on the tour'), references kept, readable after a new QR; nothing reopened", async () => {
    const { r, reg, saleNo } = await paidRegistration("Invented Refund");
    const asked = await requestRefundReversal(prisma, admin, { saleNo, reason: "guest left before the start (example)", paidBy: "COMPANY", evidence: { url: "https://example.test/refund-qr" } });
    await decideReversal(prisma, admin, { reversalId: asked.id, approve: true });
    const before = await financial();
    await openQr(prisma, guide, jobId); // rotation
    const v = await guestRegistrationView(prisma, r.viewToken);
    expect(v).toMatchObject({ state: "REFUNDED", reference: r.reference, sale: { saleNo } });
    expect((await guideRegistrations(prisma, guide, jobId)).find((x) => x.id === reg.id)).toMatchObject({ state: "REFUNDED", saleNo });
    expect(await prisma.walkInRegistration.findUniqueOrThrow({ where: { id: reg.id } })).toMatchObject({ status: "CONFIRMED" });
    expect((await prisma.booking.findFirstOrThrow({ where: { source: "walk-in" } })).status).toBe("CANCELLED");
    expect(await financial()).toEqual(before); // no seat, sale or receipt minted by reading or rotating
    expect(await code(guestCancel(prisma, r.viewToken))).toBe("PAID");
  });

  it("recorded in error → CANCELLED", async () => {
    const { r, saleNo } = await paidRegistration("Invented Error");
    const asked = await requestErrorReversal(prisma, guide, { saleNo, reason: "the guest never paid (example)", affirmationText: errorAffirmationText({ saleNo, grossSatang: 140000 }, (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).ref) });
    await decideReversal(prisma, admin, { reversalId: asked.id, approve: true });
    expect(await guestRegistrationView(prisma, r.viewToken)).toMatchObject({ state: "CANCELLED", sale: { saleNo } });
  });
});
