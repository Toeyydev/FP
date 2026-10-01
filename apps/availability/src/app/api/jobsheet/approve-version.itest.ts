import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Approving a job sheet, then saving it, against a real database.
//
// Three things failed together on a real job, and each looked like the other:
//
//   * Approve/Unapprove writes the sheet, so its version (updatedAt) moves. The editor
//     sends the version it holds back with the next Save, and a Save built on an older
//     version is refused as stale. The approve answer now carries the new version.
//   * The job's rows had a confirmed payer, which stamps them, and a stamped row was
//     matched on its category too — so ADDING the category a PEAK document needs was
//     refused as if the expense had changed (owner decision 2026-10-01: a row protected
//     only by a payer stamp may gain or change its category).
//   * With no category, the PEAK document refused the rows and booked the fee alone.
//
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { PUT } from "@/app/api/jobsheet/route";
import { POST as APPROVE } from "@/app/api/jobsheet/approve/route";
import { GET as CANDIDATES } from "@/app/api/pay/peak-document/candidates/route";
import { guidePayoutTotal, tourCostBreakdown } from "@/lib/peak-sync";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type PaymentAccounts } from "@/lib/peak-payment-document";
import { guideFeeOrStandard, type Expense } from "@/lib/jobsheet";

const G = "G-982";
const DATE = "2025-03-10"; // in the past, so the month's payment list includes it
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 2 } };
const FEE = { price: 1500, time: 1, whtPct: 3 };
const STAMP = { paidBy: "guide", paidBySource: "operator", paidByBy: "u_ops_first", paidByAt: "2025-03-11T02:00:00.000Z" };

type Row = Record<string, unknown>;
// The shape of the real case: water, bus and ferry, the guide's own money, confirmed by an
// operator — and no category on any of them.
const ROWS: Row[] = [
  { description: "Water", price: 10, pax: 2, ...STAMP },
  { description: "Bus", price: 15, pax: 3, ...STAMP },
  { description: "Ferry", price: 5.5, pax: 4, ...STAMP },
];
const CATEGORY: Record<string, string> = { Water: "meal", Bus: "transport", Ferry: "transport" };
// What the browser sends back: the server-owned stamp never travels over the wire.
const wire = (rows: Row[]) => rows.map(({ paidByBy: _b, paidByAt: _a, ...r }) => r);
const withCategories = (rows: Row[]) => rows.map((r) => ({ ...r, expenseType: CATEGORY[r.description as string] }));

const ACCOUNTS: PaymentAccounts = {
  guideFee: { code: "590001" }, reviewReward: { code: "590002" },
  categories: { transport: { code: "590003" }, meal: { code: "590004" } },
};

const sheetNow = () => prisma.jobSheet.findUniqueOrThrow({ where: KEY });
const iso = (d: Date | string) => new Date(d).toISOString();

async function save(expenses: Row[], baseUpdatedAt?: string, over: Record<string, unknown> = {}) {
  const r = await PUT(new NextRequest("http://test.local/api/jobsheet", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [], expenses, guideFee: FEE, ...(baseUpdatedAt ? { baseUpdatedAt } : {}), ...over }) }));
  return { status: r.status, body: await r.json() };
}
async function approve(on: boolean) {
  const r = await APPROVE(new NextRequest("http://test.local/api/jobsheet/approve", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 2, approve: on }) }));
  return { status: r.status, body: await r.json() };
}
async function monthList() {
  const r = await CANDIDATES(new NextRequest(`http://test.local/api/pay/peak-document/candidates?guideId=${G}&date=${DATE}`));
  const d = await r.json();
  return (d.jobs as { date: string; slotIdx: number; amount: number; ready: boolean }[]).find((j) => j.date === DATE && j.slotIdx === 2)!;
}
const paymentJob = async () => {
  const s = await sheetNow();
  return { date: s.date, slotIdx: s.slotIdx, ref: s.ref, origin: s.origin, expenses: s.expenses as unknown as Expense[], guideFee: guideFeeOrStandard(s.guideFee as never) };
};
const buildDoc = async () => buildGuidePaymentDocument({ guideId: G, peakContactId: "contact-example", paymentRef: "FOLK-PAY-(preview)", jobs: [await paymentJob()], accounts: ACCOUNTS, certificates: {} });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G);
  authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", pax: 4 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-BKK-20250310-02", guideId: G, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses: ROWS as object[], certifiedAt: new Date("2025-03-11T01:00:00Z") } });
});

describe("the version a Save is built on, after Approve", () => {
  it("approve → edit → save with the version the approval returned succeeds", async () => {
    const x = iso((await sheetNow()).updatedAt);
    const a = await approve(true);
    expect(a.status).toBe(200);
    const y = iso(a.body.updatedAt);
    expect(y).toBe(iso((await sheetNow()).updatedAt)); // the answer is the database's own version
    expect(y).not.toBe(x); // approving moved it
    const s = await save(wire(ROWS), y, { operatorNote: "checked the ferry fare" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect((await sheetNow()).operatorNote).toBe("checked the ferry fare");
  });

  it("the version from before the approval is still refused — the check is not weakened", async () => {
    const x = iso((await sheetNow()).updatedAt);
    await approve(true);
    const s = await save(wire(ROWS), x, { operatorNote: "built on the old version" });
    expect(s.status).toBe(409);
    expect(s.body.error).toBe("stale");
    expect((await sheetNow()).operatorNote).toBeNull();
  });

  it("unapprove → edit → save with the returned version succeeds", async () => {
    const a = await approve(true);
    const u = await approve(false);
    expect(u.body.approvalStatus).toBeNull();
    expect(iso(u.body.updatedAt)).not.toBe(iso(a.body.updatedAt));
    const s = await save(wire(ROWS), iso(u.body.updatedAt), { operatorNote: "after unapproving" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
  });

  it("a second tab on the old version still gets 409 stale", async () => {
    const opened = iso((await sheetNow()).updatedAt); // both tabs open here
    expect((await save(wire(ROWS), opened, { operatorNote: "tab one" })).status).toBe(200);
    const two = await save(wire(ROWS), opened, { operatorNote: "tab two" });
    expect(two.status).toBe(409);
    expect(two.body.error).toBe("stale");
    expect((await sheetNow()).operatorNote).toBe("tab one");
  });

  it("repeated approve/unapprove: the last answer's version saves, every earlier one is refused", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push(iso((await approve(i % 2 === 0)).body.updatedAt));
    expect(new Set(seen).size).toBe(seen.length); // every click is a new version
    for (const old of seen.slice(0, -1)) expect((await save(wire(ROWS), old, { operatorNote: "old" })).status).toBe(409);
    expect((await save(wire(ROWS), seen.at(-1)!, { operatorNote: "latest" })).status).toBe(200);
  });
});

describe("a confirmed payer does not stop a row getting its category", () => {
  it("categories are saved onto stamped rows, and the stamps are kept as they were", async () => {
    const s = await save(withCategories(wire(ROWS)), iso((await sheetNow()).updatedAt));
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const rows = (await sheetNow()).expenses as unknown as Row[];
    expect(rows.map((r) => r.expenseType)).toEqual(["meal", "transport", "transport"]);
    for (const r of rows) expect(r).toMatchObject({ paidBy: "guide", paidBySource: "operator", paidByBy: "u_ops_first", paidByAt: STAMP.paidByAt });
  });

  it("changing who paid on a stamped row is still refused", async () => {
    // The water row: a meal may be company-paid without a reason, so the payer rules pass
    // it and the refusal comes from the stamp.
    const rows = withCategories(wire(ROWS)).map((r, i) => (i === 0 ? { ...r, paidBy: "company" } : r));
    const s = await save(rows, iso((await sheetNow()).updatedAt));
    expect(s.status).toBe(409);
    expect(s.body.error).toBe("protected-row");
  });

  it("a row with a receipt waiver still needs the exact expense", async () => {
    await prisma.jobSheet.update({ where: KEY, data: { expenses: [{ ...ROWS[2], evidenceWaiver: { by: "u_admin", at: "2025-03-11T03:00:00.000Z", reason: "no printed ticket (example)" } }] as object[] } });
    const s = await save(withCategories(wire([ROWS[2]])), iso((await sheetNow()).updatedAt));
    expect(s.status).toBe(409);
    expect(s.body.error).toBe("protected-row");
  });
});

describe("the real case's shape: fee 1,500, water 20, bus 45, ferry 22", () => {
  it("payout is gross 1,587, reimbursement 87, net 1,542", async () => {
    const s = await sheetNow();
    const b = tourCostBreakdown(s.expenses as unknown as Expense[], FEE);
    expect({ gross: b.grossPayable, reimb: b.reimbursableToGuide, wht: b.withholding, net: b.netTransfer }).toEqual({ gross: 1587, reimb: 87, wht: 45, net: 1542 });
    expect(guidePayoutTotal(s.expenses as unknown as Expense[], FEE).payout).toBe(1542);
  });

  it("PEAK refuses the uncategorised rows, then accepts 1,587 / 45 / 1,542 once they are categorised", async () => {
    let refused: PaymentDocumentNotPostable | null = null;
    try { await buildDoc(); } catch (e) { if (e instanceof PaymentDocumentNotPostable) refused = e; else throw e; }
    expect(refused).not.toBeNull();
    expect(refused!.missingCategories.map((m) => m.description)).toEqual(["Water", "Bus", "Ferry"]);

    expect((await save(withCategories(wire(ROWS)), iso((await sheetNow()).updatedAt))).status).toBe(200);
    const doc = await buildDoc();
    expect({ gross: doc.gross, wht: doc.wht, total: doc.total }).toEqual({ gross: 1587, wht: 45, total: 1542 });
  });
});

describe("the month's payment list follows the sheet", () => {
  it("after Save the list carries the new payout; after Approve it is ready; after Unapprove it is not", async () => {
    expect(await monthList()).toMatchObject({ amount: 1542, ready: false }); // not approved yet
    // A Lotus line is added: ฿20 more owed to the guide.
    const s = await save([...wire(ROWS), { description: "Lotus", price: 20, pax: 1, paidBy: "guide", paidBySource: "operator", expenseType: "other" }], iso((await sheetNow()).updatedAt));
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await monthList()).toMatchObject({ amount: 1562, ready: false });
    await approve(true);
    expect(await monthList()).toMatchObject({ amount: 1562, ready: true });
    await approve(false);
    expect(await monthList()).toMatchObject({ amount: 1562, ready: false });
  });
});
