import { afterEach, describe, expect, it, vi } from "vitest";
import { clearingJournal, journalMatches, recognitionJournal, saleReceipt, upsellPeakAdapter, upsellPeakConfig, type PeakJournalClient, type UpsellPeakConfig } from "./peak-adapter";
import { GUIDE_CASH_HELD, UNEARNED_REVENUE } from "./peak-outbox";

// Invented data only (the repo is public).
const CONFIG: UpsellPeakConfig = { clearingJournalTypeId: "jt-9", clearingContactId: "ct-9", receivingAccounts: { "pm-kb": { accountCode: "111203", accountSubId: "sub-kb" } } };
const PAYLOAD = {
  reference: "FOLK-CSH-TEST-0001/1/2026-11-20", memo: "FOLK-CSH-TEST-0001", settlementNo: "FOLK-CSH-TEST-0001", jobRef: "FOLK-BKK-TEST-1", guideId: "G-900",
  transferDate: "2026-11-20", description: "Extras hand-in FOLK-CSH-TEST-0001 · FOLK-BKK-TEST-1 · G-900 · UPS-TEST-1", totalSatang: 90000, saleRefs: ["UPS-TEST-1"],
};
const SNAPSHOT = { accounts: { [GUIDE_CASH_HELD]: { code: "213900" } }, receivingAccount: { peakPaymentMethodId: "pm-kb" } };
const EVENT = { id: "ev1", eventKind: "BANK_CLEARING" as const, eventDate: "2026-11-20", payload: PAYLOAD, mappingSnapshot: SNAPSHOT };

describe("upsellPeakConfig — never a default", () => {
  it("refuses when unset or not JSON", () => {
    expect(() => upsellPeakConfig("")).toThrow("PEAK_UPSELL_CONFIG is not set");
    expect(() => upsellPeakConfig("{")).toThrow("not valid JSON");
  });
  it("keeps only complete receiving accounts", () => {
    const c = upsellPeakConfig(JSON.stringify({ clearingJournalTypeId: "jt", clearingContactId: "ct", receivingAccounts: { a: { accountCode: "111", accountSubId: "s" }, b: { accountCode: "111" } } }));
    expect(c.receivingAccounts).toEqual({ a: { accountCode: "111", accountSubId: "s" } });
  });
});

describe("clearingJournal", () => {
  it("Dr the receiving bank, Cr guide cash held; the hand-in code is the reference and leads the description", () => {
    const r = clearingJournal(PAYLOAD, SNAPSHOT, CONFIG);
    if (!("journal" in r)) throw new Error(r.error);
    expect(r.journal).toMatchObject({ issuedDate: "20261120", journalTypeId: "jt-9", contactId: "ct-9", reference: PAYLOAD.reference });
    expect(r.journal.description.startsWith("FOLK-CSH-TEST-0001 · ")).toBe(true);
    expect(r.journal.description).toContain("UPS-TEST-1");
    expect(r.journal.journalEntries.map((e) => [e.accountCode, e.accountSubId ?? null, e.debit, e.credit])).toEqual([["111203", "sub-kb", "900.00", "0.00"], ["213900", null, "0.00", "900.00"]]);
  });
  it.each([
    ["no journal type", { ...CONFIG, clearingJournalTypeId: "" }, SNAPSHOT, "journal type"],
    ["no contact", { ...CONFIG, clearingContactId: "" }, SNAPSHOT, "PEAK contact"],
    ["no bank mapping for the receiving account — never the advance bank", { ...CONFIG, receivingAccounts: {} }, SNAPSHOT, "never assume it"],
    ["no guide-cash-held account frozen on the event", CONFIG, { ...SNAPSHOT, accounts: {} }, GUIDE_CASH_HELD],
    ["no receiving account on the event", CONFIG, { ...SNAPSHOT, receivingAccount: null }, "no receiving account"],
  ])("refuses with %s", (_n, cfg, snap, msg) => {
    const r = clearingJournal(PAYLOAD, snap, cfg as UpsellPeakConfig);
    expect("error" in r && r.error).toContain(msg);
  });
  it("refuses a reference longer than PEAK allows and a missing amount", () => {
    expect("error" in clearingJournal({ ...PAYLOAD, reference: "X".repeat(33) }, SNAPSHOT, CONFIG)).toBe(true);
    expect("error" in clearingJournal({ ...PAYLOAD, totalSatang: 0 }, SNAPSHOT, CONFIG)).toBe(true);
  });
});

const fakeClient = (over: Partial<PeakJournalClient> = {}): PeakJournalClient & { created: unknown[] } => {
  const created: unknown[] = [];
  return {
    created,
    createDailyJournal: over.createDailyJournal ?? (async (j) => { created.push(j); return { ok: true, id: "pj-1", code: "JV-TEST-1" }; }),
    getDailyJournal: over.getDailyJournal ?? (async () => ({ ok: true, notFound: true })),
  };
};

describe("upsellPeakAdapter.post", () => {
  it("posts BANK_CLEARING and returns PEAK's id and code", async () => {
    const c = fakeClient();
    expect(await upsellPeakAdapter(c, () => CONFIG).post(EVENT)).toEqual({ ok: true, peakId: "pj-1", peakCode: "JV-TEST-1" });
    expect(c.created).toHaveLength(1);
  });
  it("refuses unbuilt kinds and missing config without calling PEAK", async () => {
    const c = fakeClient();
    const a = upsellPeakAdapter(c, () => CONFIG);
    for (const kind of ["SALE_CANCELLED", "SALE_REFUNDED"] as const) {
      expect(await a.post({ ...EVENT, eventKind: kind })).toMatchObject({ ok: false, outcome: "REJECTED" });
    }
    expect(await upsellPeakAdapter(c, () => upsellPeakConfig("")).post(EVENT)).toMatchObject({ ok: false, outcome: "REJECTED", error: "PEAK_UPSELL_CONFIG is not set" });
    expect(c.created).toHaveLength(0);
  });
  it("an explicit refusal is REJECTED; a maybe-sent answer or a throw is UNKNOWN", async () => {
    const post = (r: Awaited<ReturnType<PeakJournalClient["createDailyJournal"]>> | Error) =>
      upsellPeakAdapter(fakeClient({ createDailyJournal: async () => { if (r instanceof Error) throw r; return r; } }), () => CONFIG).post(EVENT);
    expect(await post({ ok: false, uncertain: false, desc: "Bad account" })).toMatchObject({ outcome: "REJECTED", error: "Bad account" });
    expect(await post({ ok: false, uncertain: true, desc: "timeout" })).toMatchObject({ outcome: "UNKNOWN" });
    expect(await post({ ok: false, desc: "?" })).toMatchObject({ outcome: "UNKNOWN" });
    expect(await post({ ok: true })).toMatchObject({ outcome: "UNKNOWN" });
    expect(await post(new Error("socket"))).toMatchObject({ outcome: "UNKNOWN" });
  });
});

describe("upsellPeakAdapter.readBack — by code only, verified", () => {
  const live = { id: "pj-7", code: "JV-TEST-7", journalTypeId: 9, contactId: "ct-9", isVoid: false, issuedDate: "2026-11-20",
    entries: [{ accountCode: "111203", accountSubId: "sub-kb", accountSubCode: null, debit: 900, credit: 0, description: null }, { accountCode: "213900", accountSubId: null, accountSubCode: null, debit: 0, credit: 900, description: null }] };
  const read = (j: unknown, peakCode: string | null = "JV-TEST-7") =>
    upsellPeakAdapter(fakeClient({ getDailyJournal: async () => j as Awaited<ReturnType<PeakJournalClient["getDailyJournal"]>> }), () => CONFIG).readBack({ ...EVENT, peakCode });
  it("without a code there is nothing to ask — unknown, never 'absent'", async () => {
    expect(await read({ ok: true, journal: live }, null)).toMatchObject({ unknown: true });
  });
  it("a matching live journal is found", async () => {
    expect(await read({ ok: true, journal: live })).toEqual({ found: true, peakId: "pj-7", peakCode: "JV-TEST-7" });
  });
  it("a code PEAK does not have, a void, other lines or another date stay unknown", async () => {
    expect(await read({ ok: true, notFound: true })).toMatchObject({ unknown: true });
    expect(await read({ ok: true, journal: { ...live, isVoid: true } })).toMatchObject({ unknown: true, error: expect.stringContaining("void") });
    expect(await read({ ok: true, journal: { ...live, entries: [{ ...live.entries[0], debit: 800 }, live.entries[1]] } })).toMatchObject({ unknown: true });
    expect(await read({ ok: true, journal: { ...live, issuedDate: "2026-11-21" } })).toMatchObject({ unknown: true });
    expect(await read({ ok: false, desc: "HTTP 500" })).toMatchObject({ unknown: true });
  });
  it("journalMatches ignores line order", () => {
    const built = clearingJournal(PAYLOAD, SNAPSHOT, CONFIG);
    if (!("journal" in built)) throw new Error();
    expect(journalMatches({ ...live, entries: [live.entries[1], live.entries[0]] }, built.journal)).toBeNull();
  });
});

// The adapter on the real lib/peak-api client, with PEAK's HTTP faked: errors arrive inside 200.
describe("contract — real peak-api client, faked HTTP", () => {
  const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  const TOKEN = reply({ peakClientToken: { token: "ct-fresh" } });
  async function withPeak(...replies: (Response | Error)[]) {
    vi.resetModules();
    vi.stubEnv("PEAK_CONNECT_ID", "cid"); vi.stubEnv("PEAK_CONNECT_KEY", "ckey"); vi.stubEnv("PEAK_USER_TOKEN", "utok");
    vi.stubEnv("PEAK_API_BASE_URL", "https://peak.test/api/v1");
    const fetchMock = vi.fn();
    for (const r of replies) r instanceof Error ? fetchMock.mockRejectedValueOnce(r) : fetchMock.mockResolvedValueOnce(r);
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("@/lib/peak-api");
    const { upsellPeakAdapter: make } = await import("./peak-adapter");
    return { adapter: make(api, () => CONFIG), fetchMock };
  }
  const journalCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).includes("/DailyJournals"));
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  it("sends one POST in PEAK's request shape and reads the capitalised reply", async () => {
    const { adapter, fetchMock } = await withPeak(TOKEN, reply({ PeakDailyJournals: { resCode: "200", dailyJournals: [{ resCode: "200", id: "pj-1", code: "JV-TEST-1" }] } }));
    expect(await adapter.post(EVENT)).toEqual({ ok: true, peakId: "pj-1", peakCode: "JV-TEST-1" });
    const calls = journalCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body.peakDailyJournals.dailyJournals[0]).toMatchObject({ reference: PAYLOAD.reference, journalTypeId: "jt-9", contactId: "ct-9" });
  });
  it("a refusal inside HTTP 200 is REJECTED and never retried", async () => {
    const { adapter, fetchMock } = await withPeak(TOKEN, reply({ PeakDailyJournals: { resCode: "200", dailyJournals: [{ resCode: "400", resDesc: "Account code not found" }] } }));
    expect(await adapter.post(EVENT)).toMatchObject({ ok: false, outcome: "REJECTED", error: expect.stringContaining("Account code not found") });
    expect(journalCalls(fetchMock)).toHaveLength(1);
  });
  it("a 5xx or a dropped connection after sending is UNKNOWN and never retried", async () => {
    for (const r of [reply({}, 502), new Error("ECONNRESET")]) {
      const { adapter, fetchMock } = await withPeak(TOKEN, r);
      expect(await adapter.post(EVENT)).toMatchObject({ ok: false, outcome: "UNKNOWN" });
      expect(journalCalls(fetchMock)).toHaveLength(1);
    }
  });
  it("reads a journal back by code and checks its lines", async () => {
    const { adapter } = await withPeak(TOKEN, reply({ PeakDailyJournals: { resCode: "200", dailyJournals: [
      { id: "pj-7", code: "JV-TEST-7", issuedDate: "2026-11-20", journalEntries: [{ accountCode: "111203", accountSubId: "sub-kb", debit: "900.00", credit: "0" }, { accountCode: "213900", debit: "0", credit: "900.00" }] },
    ] } }));
    expect(await adapter.readBack({ ...EVENT, peakCode: "JV-TEST-7" })).toEqual({ found: true, peakId: "pj-7", peakCode: "JV-TEST-7" });
  });
});

// ── Receipts and revenue recognition ────────────────────────────────────────────────────────
const RCFG: UpsellPeakConfig = { ...CONFIG, receiptContactId: "ct-walkin", recognitionJournalTypeId: "5", receiptPayment: { mode: "ACCOUNT_CODE" } };
const RPAY = { reference: "FOLK-UPS-209911-001", saleId: "s1", jobRef: "FOLK-BKK-20991101-01", productCode: "RTE-WPWA", version: 1, guests: 1, grossSatang: 20000,
  paymentDate: "2099-11-01", serviceDate: "2099-11-01", credit: "UPSELL_ROUTE_REVENUE", deferred: false };
const RSNAP = { accounts: { UPSELL_ROUTE_REVENUE: { code: "410299" }, [GUIDE_CASH_HELD]: { code: "113999" }, [UNEARNED_REVENUE]: { code: "213800" }, TOUR_SERVICE_REVENUE: { code: "410199" } },
  taxProfile: { status: "CONFIRMED", vatRegistration: "NOT_REGISTERED", peakDocumentKind: "RECEIPT_NO_VAT" } };
const REVENT = { id: "ev-r", eventKind: "RECEIPT" as const, eventDate: "2099-11-01", payload: RPAY, mappingSnapshot: RSNAP };

describe("saleReceipt — not VAT-registered, the guest's total", () => {
  it("฿200 route extension: no VAT, not a tax invoice, Sale Ref + Job Ref, paid into guide cash held", () => {
    const r = saleReceipt(RPAY, RSNAP, RCFG);
    if (!("receipt" in r)) throw new Error(r.error);
    expect(r.receipt).toMatchObject({ issuedDate: "20991101", contactId: "ct-walkin", reference: RPAY.reference, taxStatus: 2, isTaxInvoice: 0, status: "Approve" });
    expect(r.receipt.remark).toContain("FOLK-BKK-20991101-01");
    expect(r.receipt.products).toEqual([expect.objectContaining({ accountCode: "410299", quantity: 1, price: 200, vatType: 1 })]);
    expect(r.receipt.paidPayments).toEqual({ paymentDate: "20991101", payments: [expect.objectContaining({ amount: 200, accountCode: "113999" })] });
  });
  it("฿700 full walk-in seat (2 guests ฿1,400) books Tour Service Revenue, priced per guest, nothing added", () => {
    const r = saleReceipt({ ...RPAY, productCode: "THREE-TEMPLES-ONSITE", version: 2, guests: 2, grossSatang: 140000, credit: "TOUR_SERVICE_REVENUE" }, RSNAP, RCFG);
    if (!("receipt" in r)) throw new Error(r.error);
    expect(r.receipt.products[0]).toMatchObject({ accountCode: "410199", quantity: 2, price: 700, vatType: 1 });
    expect(r.receipt.paidPayments.payments[0].amount).toBe(1400);
  });
  it("a service still to come credits unearned revenue", () => {
    const r = saleReceipt({ ...RPAY, serviceDate: "2099-11-05", credit: UNEARNED_REVENUE, deferred: true }, RSNAP, RCFG);
    expect("receipt" in r && r.receipt.products[0].accountCode).toBe("213800");
  });
  it("payment by a PEAK payment method when configured that way", () => {
    const r = saleReceipt(RPAY, RSNAP, { ...RCFG, receiptPayment: { mode: "PAYMENT_METHOD", paymentMethodId: "pm-cash" } });
    expect("receipt" in r && r.receipt.paidPayments.payments[0]).toMatchObject({ paymentMethodId: "pm-cash" });
  });
  it.each([
    ["tax profile unconfirmed", RPAY, { ...RSNAP, taxProfile: { ...RSNAP.taxProfile, status: "DRAFT" } }, RCFG, "not confirmed"],
    ["a VAT-registered company (not built)", RPAY, { ...RSNAP, taxProfile: { ...RSNAP.taxProfile, vatRegistration: "REGISTERED" } }, RCFG, "not VAT-registered only"],
    ["no document type", RPAY, { ...RSNAP, taxProfile: { ...RSNAP.taxProfile, peakDocumentKind: null } }, RCFG, "document type"],
    ["no revenue account", RPAY, { ...RSNAP, accounts: { [GUIDE_CASH_HELD]: { code: "113999" } } }, RCFG, "UPSELL_ROUTE_REVENUE"],
    ["no guide-cash-held account", RPAY, { ...RSNAP, accounts: { UPSELL_ROUTE_REVENUE: { code: "410299" } } }, RCFG, GUIDE_CASH_HELD],
    ["no payment mode", RPAY, RSNAP, { ...RCFG, receiptPayment: undefined }, "receiptPayment"],
  ])("refuses with %s", (_n, pay, snap, cfg, msg) => {
    const r = saleReceipt(pay, snap, cfg as UpsellPeakConfig);
    expect("error" in r && r.error).toContain(msg);
  });
});

describe("recognitionJournal", () => {
  it("Dr unearned, Cr revenue on the service date", () => {
    const r = recognitionJournal({ reference: RPAY.reference, amountSatang: 20000, serviceDate: "2099-11-05", from: UNEARNED_REVENUE, to: "UPSELL_ROUTE_REVENUE" }, RSNAP, RCFG);
    if (!("journal" in r)) throw new Error(r.error);
    expect(r.journal).toMatchObject({ issuedDate: "20991105", journalTypeId: "5", reference: `${RPAY.reference}-REV` });
    expect(r.journal.journalEntries.map((e) => [e.accountCode, e.debit, e.credit])).toEqual([["213800", "200.00", "0.00"], ["410299", "0.00", "200.00"]]);
  });
  it("refuses without its journal type", () => {
    expect("error" in recognitionJournal({ reference: "X", amountSatang: 1, serviceDate: "2099-11-05", to: "UPSELL_ROUTE_REVENUE" }, RSNAP, { ...RCFG, recognitionJournalTypeId: undefined })).toBe(true);
  });
});

describe("contract — receipts through the real peak-api client, faked HTTP", () => {
  const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  const TOKEN = reply({ peakClientToken: { token: "ct-fresh" } });
  async function withPeak(...replies: (Response | Error)[]) {
    vi.resetModules();
    vi.stubEnv("PEAK_CONNECT_ID", "cid"); vi.stubEnv("PEAK_CONNECT_KEY", "ckey"); vi.stubEnv("PEAK_USER_TOKEN", "utok");
    vi.stubEnv("PEAK_API_BASE_URL", "https://peak.test/api/v1");
    const fetchMock = vi.fn();
    for (const r of replies) r instanceof Error ? fetchMock.mockRejectedValueOnce(r) : fetchMock.mockResolvedValueOnce(r);
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("@/lib/peak-api");
    const { upsellPeakAdapter: make } = await import("./peak-adapter");
    return { adapter: make(api, () => RCFG), fetchMock };
  }
  const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).includes("/Receipts"));
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  it("one POST in the documented shape; the row's id and code are read from the capitalised reply", async () => {
    const { adapter, fetchMock } = await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", resDesc: "PeakReceipts have Completed", receipts: [{ resCode: "200", resDesc: "Success", id: "rc-1", code: "RE-209911-0001" }] } }));
    expect(await adapter.post(REVENT)).toEqual({ ok: true, peakId: "rc-1", peakCode: "RE-209911-0001" });
    const c = calls(fetchMock);
    expect(c).toHaveLength(1);
    expect(String(c[0][0])).toMatch(/\/Receipts$/);
    const body = JSON.parse((c[0][1] as RequestInit).body as string);
    expect(body.peakReceipts.receipts[0]).toMatchObject({ reference: RPAY.reference, taxStatus: 2, isTaxInvoice: 0 });
  });
  it("the wrapper says 200 but the row failed (PEAK's documented error) → REJECTED, sent once", async () => {
    const { adapter, fetchMock } = await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", receipts: [{ resCode: "400", resDesc: "Bad Json Request : Missing Product Transaction" }] } }));
    expect(await adapter.post(REVENT)).toMatchObject({ ok: false, outcome: "REJECTED", error: expect.stringContaining("Missing Product") });
    expect(calls(fetchMock)).toHaveLength(1);
  });
  it("a row-level 500, an HTTP 5xx or a dropped connection → UNKNOWN, never retried", async () => {
    for (const r of [reply({ PeakReceipts: { resCode: "200", receipts: [{ resCode: "500", resDesc: "Internal" }] } }), reply({}, 503), new Error("ECONNRESET")]) {
      const { adapter, fetchMock } = await withPeak(TOKEN, r);
      expect(await adapter.post(REVENT)).toMatchObject({ ok: false, outcome: "UNKNOWN" });
      expect(calls(fetchMock)).toHaveLength(1);
    }
  });
  it("read-back by the documented reference: one live match with the same amount → found", async () => {
    const { adapter, fetchMock } = await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", receipts: [{ id: "rc-1", code: "RE-209911-0001", reference: RPAY.reference, netAmount: 200 }] } }));
    expect(await adapter.readBack(REVENT)).toEqual({ found: true, peakId: "rc-1", peakCode: "RE-209911-0001" });
    expect(String(calls(fetchMock)[0][0])).toContain(`reference=${encodeURIComponent(RPAY.reference)}`);
  });
  it("read-back: none → absent; two live or another amount → unknown; only voided → not reliably absent", async () => {
    expect(await (await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", receipts: [] } }))).adapter.readBack(REVENT)).toEqual({ found: false, reliable: true });
    const two = [{ id: "a", code: "RE-1", reference: RPAY.reference, netAmount: 200 }, { id: "b", code: "RE-2", reference: RPAY.reference, netAmount: 200 }];
    expect(await (await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", receipts: two } }))).adapter.readBack(REVENT)).toMatchObject({ unknown: true });
    expect(await (await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", receipts: [{ ...two[0], netAmount: 300 }] } }))).adapter.readBack(REVENT)).toMatchObject({ unknown: true });
    expect(await (await withPeak(TOKEN, reply({ PeakReceipts: { resCode: "200", receipts: [{ ...two[0], isVoid: 1 }] } }))).adapter.readBack(REVENT)).toEqual({ found: false, reliable: false });
  });
});
