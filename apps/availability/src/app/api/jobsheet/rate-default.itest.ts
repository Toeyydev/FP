import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Rate-suggested payers, against a real database, the real importer, the real job-sheet save
// route and the real booking reconciliation. A booked Rate SUGGESTS who paid; only a person
// confirms it, and only a confirmed payer moves money. All data invented (public repo).

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/google-drive", async (orig) => ({ ...(await orig<typeof import("@/lib/google-drive")>()), googleDriveEnabled: false }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { PUT, GET } from "@/app/api/jobsheet/route";
import { importParsed } from "@/lib/booking-import";
import { productKey, type ParsedBooking } from "@/lib/bookings";
import { toSheetBooking } from "@/lib/sheet-bookings";
import { previewPayment } from "@/lib/payments-v2/service";
import { jobFigures } from "@/lib/payments-v2/rules";
import { jobSheetTotals } from "@/lib/peak-sync";
import { DEFAULT_EXPENSES, fillDownExpensePax, type Expense, type GuideFee } from "@/lib/jobsheet";

const G = "G-991";
const FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };
// A departure a few days ahead (slot 0), so the reconciliation treats it as upcoming.
const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const TICKETS = "Tour with all entrance tickets", GUIDED = "Tour without entrance tickets", GENERIC = "Standard rate", UNKNOWN = "Come Hungry and Get back full";

type Row = Expense & { paidByBy?: string; paidByAt?: string; paidByReason?: string; rateBasis?: string; certificateRequest?: unknown };
const sheetKey = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } };
const rowsNow = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: sheetKey })).expenses as unknown as Row[];
const byDesc = (rows: Row[], d: string) => rows.find((e) => e.description.startsWith(d))!;
const versionNow = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: sheetKey })).updatedAt.toISOString();
const wire = (rows: Row[]) => rows.map(({ paidByBy: _b, paidByAt: _a, certificateRequest: _c, ...r }) => r);
const put = async (expenses: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const r = await PUT(new NextRequest("http://test.local/api/jobsheet", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses, guideFee: FEE, ...extra }) }));
  return { status: r.status, body: await r.json() };
};
const get = async () => (await GET(new NextRequest(`http://test.local/api/jobsheet?guideId=${G}&date=${DATE}&slotIdx=0`))).json();
const parsed = (ref: string, pax: number, rateTitle: string | null, over: Partial<ParsedBooking> = {}): ParsedBooking =>
  ({ externalRef: ref, confirmationCode: `GET-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, pax, productName: "Riverside Temples", ...(rateTitle ? { rateTitle } : {}), ...over });
const importIt = (p: ParsedBooking, cancelled = false) => importParsed(p, { source: "GetYourGuide", cancelled, via: "webhook" });

/** Bookings on the departure, assigned to the guide, and a saved job sheet with the standard lines for their guests. */
async function departure(bookings: [string, number, string | null][], expenses?: Row[]) {
  for (const [ref, pax, rate] of bookings) await importIt(parsed(ref, pax, rate));
  const guests = bookings.reduce((s, [, p]) => s + p, 0);
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: guests } });
  await prisma.booking.updateMany({ where: { date: DATE, slotIdx: 0, status: "PENDING" }, data: { status: "OFFERED", tourId: "T-900" } });
  const live = await prisma.booking.findMany({ where: { date: DATE, slotIdx: 0, status: "OFFERED" }, orderBy: { createdAt: "asc" } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-RATE-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", guideFee: FEE,
    bookings: live.map(toSheetBooking) as never, expenses: (expenses ?? fillDownExpensePax(DEFAULT_EXPENSES, guests)) as never } });
}

let opId = "";
beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G);
  await prisma.tour.update({ where: { id: "T-900" }, data: { name: "Riverside Temples" } });
  await prisma.productMap.deleteMany({});
  await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
  const op = await prisma.user.create({ data: { email: "op-rate@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  opId = op.id;
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("12, 18 · the Rate reaches the booking, and is never overwritten by a payload without one", () => {
  it("stored on import; a later payload with no Rate keeps it; a stale live payload for a cancelled booking changes nothing", async () => {
    await importIt(parsed("GYGRATE001", 2, TICKETS));
    const b = () => prisma.booking.findFirstOrThrow({ where: { externalRef: "GYGRATE001" } });
    expect((await b()).rateTitle).toBe(TICKETS);
    await importIt(parsed("GYGRATE001", 2, null));
    expect((await b()).rateTitle).toBe(TICKETS);
    await importIt(parsed("GYGRATE001", 2, TICKETS), true); // cancelled
    await importIt(parsed("GYGRATE001", 2, GUIDED));         // a stale live copy arriving after the cancel
    expect(await b()).toMatchObject({ status: "CANCELLED", rateTitle: TICKETS });
  });
});

describe("1–7 · what the save suggests, and what it never touches", () => {
  it("1 · ticket-inclusive: tickets suggested as Company Resource ('company'), never Company Advance; nothing stamped", async () => {
    await departure([["GYGT1", 2, TICKETS], ["GYGT2", 2, TICKETS]]);
    expect((await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() })).status).toBe(200);
    const rows = await rowsNow();
    for (const t of ["Grand Palace", "Wat Pho", "Wat Arun"]) expect(byDesc(rows, t)).toMatchObject({ paidBy: "company", paidBySource: "rate-default", rateBasis: "TICKET_INCLUDED" });
    expect(rows.some((e) => e.paidBy === "advance")).toBe(false);
    expect(byDesc(rows, "Water").paidBy ?? "").toBe(""); // operational rows: only a guided Rate suggests
    for (const e of rows) expect(e.paidByBy).toBeUndefined();
  });
  it("2 · guided experience: water, bus, lotus suggested as Guide Own Money; tickets get nothing", async () => {
    await departure([["GYGG1", 3, GUIDED]]);
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    const rows = await rowsNow();
    for (const d of ["Water", "Bus", "Lotus"]) expect(byDesc(rows, d)).toMatchObject({ paidBy: "guide", paidBySource: "rate-default", rateBasis: "GUIDED_EXPERIENCE" });
    expect(byDesc(rows, "Grand Palace").paidBy ?? "").toBe("");
  });
  it("3–4 · an unknown Rate suggests nothing, and the page lists it for review", async () => {
    await departure([["GYGU1", 2, UNKNOWN]]);
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    for (const e of await rowsNow()) expect(e.paidBy ?? "").toBe("");
    expect((await get()).rates).toEqual({ kinds: ["UNKNOWN"], titles: [{ title: UNKNOWN, kind: "UNKNOWN", bookings: 1 }] });
  });
  it("5, 22 · mixed Rates (production-like: 4 ticket-inclusive + 4 standard): the 8-ticket rows are NOT Company Resource", async () => {
    await departure([["GYGMIXT1", 4, TICKETS], ["GYGMIXG2", 4, GUIDED]]);
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    const rows = await rowsNow();
    expect(byDesc(rows, "Grand Palace")).toMatchObject({ pax: 8 });
    expect(byDesc(rows, "Grand Palace").paidBy ?? "").toBe("");
    expect(byDesc(rows, "Water").paidBy ?? "").toBe("");
    expect((await get()).rates.kinds).toEqual(["GUIDED_EXPERIENCE", "TICKET_INCLUDED"]);
  });
  it("6–7, 13–14 · a suggestion stays unconfirmed; Confirm payer stamps it; confirmed and evidence-backed rows are never rewritten", async () => {
    await departure([["GYGG2", 3, GUIDED]]);
    const start = await rowsNow();
    // Water confirmed by the operator as company — against the guided suggestion, so with its reason; Bus stamped earlier by someone else.
    await prisma.jobSheet.update({ where: sheetKey, data: { expenses: start.map((e) => e.description.startsWith("Bus") ? { ...e, paidBy: "company", paidBySource: "operator", paidByReason: "the company bought bus passes (example)", paidByBy: "u_earlier", paidByAt: "2099-01-01T00:00:00Z" } : e) as never } });
    const first = await put(wire(await rowsNow()).map((e) => e.description.startsWith("Water") ? { ...e, paidBy: "company", paidBySource: "operator", paidByReason: "company bought water in bulk (example)" } : e), { baseUpdatedAt: await versionNow() });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    let rows = await rowsNow();
    expect(byDesc(rows, "Water")).toMatchObject({ paidBy: "company", paidBySource: "operator" });
    expect(byDesc(rows, "Bus")).toMatchObject({ paidBy: "company", paidByBy: "u_earlier" });
    expect(byDesc(rows, "Lotus")).toMatchObject({ paidBy: "guide", paidBySource: "rate-default" });
    expect(byDesc(rows, "Lotus").paidByBy).toBeUndefined();
    await put(wire(rows).map((e) => e.description.startsWith("Lotus") ? { ...e, paidBySource: "operator" } : e), { baseUpdatedAt: await versionNow() });
    rows = await rowsNow();
    expect(byDesc(rows, "Lotus")).toMatchObject({ paidBy: "guide", paidBySource: "operator", paidByBy: opId, rateBasis: "GUIDED_EXPERIENCE" });
    expect(byDesc(rows, "Lotus").paidByAt).toBeTruthy();
  });
});

describe("8–12 · override reasons survive editor → API → database → reload, and are audited", () => {
  it("10, 12 · a guide-paid ticket on a ticket-inclusive job saves with its reason; without one it is refused", async () => {
    await departure([["GYGT3", 2, TICKETS]]);
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    const gp = (reason?: string) => put(wire(fillDownExpensePax(DEFAULT_EXPENSES, 2) as Row[]).map((e) => e.description === "Grand Palace" ? { ...e, paidBy: "guide", paidBySource: "operator", ...(reason ? { paidByReason: reason } : {}) } : e));
    const refused = await gp();
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("payer-rule");
    expect(refused.body.reasons[0]).toMatch(/the booked Rate suggests it is paid by the company/);
    const ok = await gp("the guide bought these at the gate (example)");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(byDesc(await rowsNow(), "Grand Palace")).toMatchObject({ paidBy: "guide", paidBySource: "operator", paidByReason: "the guide bought these at the gate (example)", paidByBy: opId });
    const reloaded = (await get()).sheet.expenses as Row[];
    expect(byDesc(reloaded, "Grand Palace").paidByReason).toBe("the guide bought these at the gate (example)");
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "jobsheet.saved" }, orderBy: { createdAt: "desc" } });
    expect(a.detail).toMatchObject({ payerReasons: [{ row: "Grand Palace", paidBy: "guide", reason: "the guide bought these at the gate (example)" }] });
  });
  it("11 · company-paid transport on a guided job saves with its reason; without one it is refused", async () => {
    await departure([["GYGG3", 2, GUIDED]]);
    const bus = (reason?: string) => put(wire(fillDownExpensePax(DEFAULT_EXPENSES, 2) as Row[]).map((e) => e.description.startsWith("Bus") ? { ...e, paidBy: "company", paidBySource: "operator", ...(reason ? { paidByReason: reason } : {}) } : e));
    expect((await bus()).status).toBe(409);
    expect((await bus("company booked a private van (example)")).status).toBe(200);
    expect(byDesc(await rowsNow(), "Bus")).toMatchObject({ paidBy: "company", paidByReason: "company booked a private van (example)" });
  });
  it("11 · departing from a suggestion on WATER needs a reason too; a row with no expectation needs none", async () => {
    await departure([["GYGG8", 2, GUIDED]]);
    const water = (reason?: string) => put(wire(fillDownExpensePax(DEFAULT_EXPENSES, 2) as Row[]).map((e) => e.description.startsWith("Water") ? { ...e, paidBy: "company", paidBySource: "operator", ...(reason ? { paidByReason: reason } : {}) } : e));
    const refused = await water();
    expect(refused.status).toBe(409);
    expect(refused.body.reasons[0]).toMatch(/Water.*the booked Rate suggests it is fronted by the guide/);
    expect((await water("company bought water in bulk (example)")).status).toBe(200);
    expect(byDesc(await rowsNow(), "Water")).toMatchObject({ paidBy: "company", paidBySource: "operator", paidByReason: "company bought water in bulk (example)" });
  });
  it("\"Standard rate\" suggests nothing: rows stay blank, and choosing any payer for water needs no reason", async () => {
    await departure([["GYGS1", 3, GENERIC]]);
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    const rows = await rowsNow();
    for (const d of ["Water", "Bus", "Lotus", "Grand Palace"]) expect(byDesc(rows, d)?.paidBySource ?? "", d).not.toBe("rate-default");
    expect((await get()).rates).toEqual({ kinds: ["UNKNOWN"], titles: [{ title: GENERIC, kind: "UNKNOWN", bookings: 1 }] });
    const ok = await put(wire(await rowsNow()).map((e) => e.description.startsWith("Water") ? { ...e, paidBy: "company", paidBySource: "operator" } : e));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
  it("8–9, 21 · the summary, Payments v2 and the transfer agree: a suggestion is shown as awaiting, not owed", async () => {
    await departure([["GYGG4", 3, GUIDED]]);
    await prisma.jobSheet.update({ where: sheetKey, data: { approvalStatus: "APPROVED", approvedBy: opId, approvedAt: new Date() } });
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    const rows = await rowsNow();
    const t = jobSheetTotals(rows, FEE);
    expect(t.reimbursementDue).toBe(0);
    expect(t.awaitingConfirmationTotal).toBe(40 + 40 + 60); // water, lotus (4 each: 3 + guide) and bus (4 × 15)
    const preview = await previewPayment(prisma, { guideId: G, jobs: [{ jobNo: "FOLK-TEST-RATE-01", date: DATE, slotIdx: 0 }], paymentDate: DATE, amountTransferred: jobFigures(rows, FEE).payable, source: "MANUAL", noSlipReason: "example only", actor: { actorId: opId, actorRole: "OPERATOR" }, today: DATE });
    expect(preview.reasons.join(" ")).toMatch(/with no Paid By/); // the payment waits for the payers
    const confirmed = rows.map((e) => e.paidBySource === "rate-default" ? { ...e, paidBySource: "operator" as const } : e);
    expect(jobSheetTotals(confirmed, FEE).reimbursementDue).toBe(140);
    expect(jobFigures(confirmed, FEE).payable).toBe(jobSheetTotals(confirmed, FEE).netPayToGuide);
  });
});

describe("19–20 · #278: categories on suggested and confirmed rows; certificate-requested rows stay strict", () => {
  it("a suggested row and a stamped row may change category; a certificate-requested row may not", async () => {
    await departure([["GYGG5", 2, GUIDED]]);
    const start = await rowsNow();
    await prisma.jobSheet.update({ where: sheetKey, data: { expenses: start.map((e) => e.description.startsWith("Water") ? { ...e, paidBy: "guide", paidBySource: "operator", paidByBy: "u_earlier", paidByAt: "2099-01-01T00:00:00Z" } : e) as never } });
    await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() });
    const recat = await put(wire(await rowsNow()).map((e) => e.description.startsWith("Water") || e.description.startsWith("Lotus") ? { ...e, expenseType: "other" } : e), { baseUpdatedAt: await versionNow() });
    expect(recat.status, JSON.stringify(recat.body)).toBe(200);
    const rows = await rowsNow();
    expect(byDesc(rows, "Water")).toMatchObject({ expenseType: "other", paidByBy: "u_earlier" });
    await prisma.jobSheet.update({ where: sheetKey, data: { expenses: rows.map((e) => e.description.startsWith("Bus") ? { ...e, paidBy: "guide", paidBySource: "operator", certificateRequest: { by: "u_admin", at: "2099-01-02T00:00:00Z" } } : e) as never } });
    const strict = await put(wire(await rowsNow()).map((e) => e.description.startsWith("Bus") ? { ...e, expenseType: "other" } : e), { baseUpdatedAt: await versionNow() });
    expect(strict.status).toBe(409);
    expect(strict.body.error).toBe("protected-row");
  });
});

describe("15–17 · a late booking or a cancellation changes the Rate mix — the reconciliation keeps suggestions honest", () => {
  const suggestionsSaved = async () => { await put(wire(await rowsNow()), { baseUpdatedAt: await versionNow() }); return rowsNow(); };

  it("15 · guided → mixed after a late ticket-inclusive booking: the guide suggestions are taken off; confirmed rows untouched", async () => {
    await departure([["GYGG6", 2, GUIDED]]);
    let rows = await suggestionsSaved();
    await prisma.jobSheet.update({ where: sheetKey, data: { expenses: rows.map((e) => e.description.startsWith("Lotus") ? { ...e, paidBySource: "operator", paidByBy: opId, paidByAt: "2099-01-01T00:00:00Z" } : e) as never } });
    await importIt(parsed("GYGT6LATE", 2, TICKETS));
    rows = await rowsNow();
    expect(byDesc(rows, "Water").paidBy ?? "").toBe("");
    expect(byDesc(rows, "Bus").paidBy ?? "").toBe("");
    expect(byDesc(rows, "Lotus")).toMatchObject({ paidBy: "guide", paidBySource: "operator" }); // a person's decision: kept
    expect(byDesc(rows, "Grand Palace").paidBy ?? "").toBe(""); // mixed: no Company Resource for the 4-ticket row
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.rate_suggestions_updated" } })).toBe(1);
  });

  it("15 · ticket-inclusive → mixed after a late guided booking: the Company Resource suggestions are taken off", async () => {
    await departure([["GYGT7", 2, TICKETS]]);
    let rows = await suggestionsSaved();
    expect(byDesc(rows, "Grand Palace")).toMatchObject({ paidBy: "company", paidBySource: "rate-default" });
    await importIt(parsed("GYGG7LATE", 1, GUIDED));
    rows = await rowsNow();
    for (const t of ["Grand Palace", "Wat Pho", "Wat Arun"]) expect(byDesc(rows, t).paidBy ?? "").toBe("");
  });

  it("15 · an UNKNOWN late booking takes the guided suggestions off too", async () => {
    await departure([["GYGG8", 2, GUIDED]]);
    await suggestionsSaved();
    await importIt(parsed("GYGU8LATE", 2, null));
    expect(byDesc(await rowsNow(), "Water").paidBy ?? "").toBe("");
  });

  it("16 · a confirmed payer is never rewritten by the reconciliation, whatever the new Rates say", async () => {
    await departure([["GYGT9", 2, TICKETS]]);
    const rows = await suggestionsSaved();
    await prisma.jobSheet.update({ where: sheetKey, data: { expenses: rows.map((e) => e.description.startsWith("Grand Palace") ? { ...e, paidBySource: "operator", paidByBy: opId, paidByAt: "2099-01-01T00:00:00Z" } : e) as never } });
    await importIt(parsed("GYGG9LATE", 2, GUIDED));
    expect(byDesc(await rowsNow(), "Grand Palace")).toMatchObject({ paidBy: "company", paidBySource: "operator", paidByBy: opId });
  });

  it("15, 17 · a still-agreeing late booking keeps the suggestions; a cancellation never invents one — the next save does", async () => {
    await departure([["GYGT10", 2, TICKETS], ["GYGG10", 2, GUIDED]]);
    expect(byDesc(await suggestionsSaved(), "Grand Palace").paidBy ?? "").toBe(""); // mixed
    await importIt(parsed("GYGG10", 2, GUIDED), true); // the guided guests cancel → only ticket-inclusive left
    expect(byDesc(await rowsNow(), "Grand Palace").paidBy ?? "").toBe(""); // the reconciliation does not fill
    expect(byDesc(await suggestionsSaved(), "Grand Palace")).toMatchObject({ paidBy: "company", paidBySource: "rate-default" });
    await importIt(parsed("GYGT10B", 1, TICKETS)); // another ticket-inclusive guest: still agrees
    expect(byDesc(await rowsNow(), "Grand Palace")).toMatchObject({ paidBy: "company", paidBySource: "rate-default" });
  });
});

describe("a recorded payer can be corrected while the job is not paid (2026-10-05)", () => {
  // A ticket confirmed as company-paid, with a reason, before the advance that bought it was
  // recorded; then the advance is recorded and the operator switches the row to it.
  const ticket = (paidBy: string, extra: Record<string, unknown> = {}) => ({ description: "Temple ticket (example)", price: 500, pax: 1, expenseType: "entrance", paidBy, paidBySource: "operator", ...extra });
  async function sheetWithCompanyTicket() {
    await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 1 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-PAYER-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", guideFee: FEE, bookings: [],
      expenses: [ticket("company", { paidByReason: "waiting for the advance (example)", paidByBy: "u_someone", paidByAt: "2099-01-01T00:00:00.000Z" })] as never } });
    return prisma.guideAdvance.create({ data: { guideId: G, date: DATE, slotIdx: 0, amount: 500, paidAt: new Date(), method: "bank", txRef: "TX-PAYER-1", advanceNo: "FOLK-ADV-209910-951",
      advanceDate: DATE, amountSatang: 50000, accountingPeriod: DATE.slice(0, 7), jobNo: "FOLK-TEST-PAYER-01", allowedCategories: ["entrance"] } });
  }
  it("unpaid: switching the row to the advance saves, links it, stamps the operator and audits the change", async () => {
    const adv = await sheetWithCompanyTicket();
    const r = await put([ticket("advance")], { baseUpdatedAt: await versionNow() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await rowsNow())[0];
    expect({ paidBy: row.paidBy, advanceId: (row as { advanceId?: string }).advanceId, by: row.paidByBy }).toEqual({ paidBy: "advance", advanceId: adv.id, by: opId });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "jobsheet.saved" }, orderBy: { createdAt: "desc" } });
    expect((log.detail as { payerChanges?: unknown }).payerChanges).toEqual([{ row: "Temple ticket (example)", from: "company", to: "advance" }]);
  });
  it("paid: the recorded payer is part of what was paid and stays", async () => {
    await sheetWithCompanyTicket();
    await prisma.tourPayment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date() } });
    const r = await put([ticket("advance")], { baseUpdatedAt: await versionNow() });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/carries a recorded payer/);
    expect((await rowsNow())[0].paidBy).toBe("company");
  });
});
