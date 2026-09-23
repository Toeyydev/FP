import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The save path, against a real database. The session is the only thing stubbed.
//
// This suite exists because of a data-loss bug that shipped and was invisible: an
// operator opening a job sheet and pressing Save — changing nothing — wiped every
// receipt waiver an admin had granted on it and re-pointed every payer stamp at
// themselves. Nothing failed. `expenseZ` simply did not list those fields, so zod
// dropped them out of the request and the row written back was the row without them.
//
// A unit test cannot catch this one: the fields were lost between the wire and the
// database, and both ends type-checked.
//
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { PUT } from "./route";

const GUIDE = "G-900";
const DATE = "2099-04-01";
const REF = "FOLK-BKK-20990401-01";
const WAIVER = { by: "u_admin", at: "2099-04-01T03:00:00.000Z", reason: "the ferry operator issues no printed ticket" };
const STAMP = { paidByBy: "u_admin", paidByAt: "2099-04-01T03:00:00.000Z" };

type Row = Record<string, unknown>;
const ferry = (over: Row = {}): Row => ({ description: "Ferry", price: 11, pax: 4, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });
const bus = (over: Row = {}): Row => ({ description: "Bus", price: 15, pax: 4, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

const asOperator = (id = "u_ops") => authMock.auth.mockResolvedValue({ user: { id, role: "OPERATOR" } });

const save = async (expenses: Row[], over: Record<string, unknown> = {}) => {
  const res = await PUT(new Request("https://ops.example.test/api/jobsheet", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, expenses, ...over }),
  }) as unknown as Parameters<typeof PUT>[0]);
  return { status: res.status, body: await res.json() };
};

const seedSheet = async (expenses: Row[]) =>
  prisma.jobSheet.create({ data: { ref: REF, guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, expenses: expenses as object[] } });

const rowsNow = async (): Promise<Row[]> =>
  ((await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } }))!.expenses as unknown as Row[]);

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
  asOperator();
});

describe("an ordinary save keeps what the server owns", () => {
  it("the waiver survives the save intact", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), bus()]);
    const { status } = await save([ferry(), bus()]); // what the browser sends back after zod stripped it
    expect(status).toBe(200);
    const rows = await rowsNow();
    expect(rows[0].evidenceWaiver).toEqual(WAIVER);
  });

  it("the payer stamp survives, and the person saving does not replace the person who recorded it", async () => {
    await seedSheet([ferry(STAMP)]);
    asOperator("u_someone_else");
    await save([ferry()]);
    const rows = await rowsNow();
    expect(rows[0].paidByBy).toBe("u_admin");
    expect(rows[0].paidByAt).toBe("2099-04-01T03:00:00.000Z");
  });

  it("a row with no stamp still gets one, from whoever saved", async () => {
    await seedSheet([ferry()]);
    await save([ferry()]);
    expect((await rowsNow())[0].paidByBy).toBe("u_ops");
  });

  it("everything else on the sheet still saves normally", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER })]);
    await save([ferry(), { description: "Snacks", price: 40, pax: 4, expenseType: "meal", paidBy: "guide", paidBySource: "operator" }], { operatorNote: "added a snack stop" });
    const rows = await rowsNow();
    expect(rows).toHaveLength(2);
    expect(rows[0].evidenceWaiver).toEqual(WAIVER);
  });
});

describe("what a client sends for these fields is never stored", () => {
  it("a waiver invented by the caller is ignored", async () => {
    await seedSheet([ferry()]);
    const { status } = await save([ferry({ evidenceWaiver: { by: "u_guide", at: "2099-04-01T03:00:00.000Z", reason: "I accept my own expense, thank you" } })]);
    expect(status).toBe(200);
    expect((await rowsNow())[0].evidenceWaiver).toBeUndefined();
  });

  it("an actor and a time invented by the caller are ignored", async () => {
    await seedSheet([ferry()]);
    await save([ferry({ paidByBy: "u_someone_important", paidByAt: "2001-01-01T00:00:00.000Z" })]);
    const rows = await rowsNow();
    expect(rows[0].paidByBy).toBe("u_ops");                       // stamped by the server, from the session
    expect(rows[0].paidByAt).not.toBe("2001-01-01T00:00:00.000Z");
  });

  it("a real waiver cannot be overwritten with a more convenient one", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER })]);
    await save([ferry({ evidenceWaiver: { by: "u_guide", at: "2099-01-01T00:00:00.000Z", reason: "something easier to live with" } })]);
    expect((await rowsNow())[0].evidenceWaiver).toEqual(WAIVER);
  });

  it("the attempt is recorded, so it is not merely ignored in silence", async () => {
    await seedSheet([ferry()]);
    await save([ferry({ evidenceWaiver: WAIVER })]);
    const log = await prisma.auditLog.findFirst({ where: { action: "jobsheet.saved" }, orderBy: { createdAt: "desc" } });
    expect((log!.detail as Record<string, unknown>).ignoredClientOwnedFields).toBe(true);
  });
});

describe("a signed-for row cannot be changed by an ordinary save", () => {
  it("deleting it is refused, and nothing is written", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), bus()]);
    const { status, body } = await save([bus()]);
    expect(status).toBe(409);
    expect(body.error).toBe("protected-row");
    expect(body.reasons[0]).toContain("Ferry");
    expect(await rowsNow()).toHaveLength(2); // the sheet is untouched
  });

  it("repricing it is refused", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER })]);
    const { status, body } = await save([ferry({ price: 25 })]);
    expect(status).toBe(409);
    expect(body.reasons[0]).toContain("is not in this save");
    expect((await rowsNow())[0].price).toBe(11);
  });

  it("reordering moves the waiver with the expense it was granted for", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), bus()]);
    const { status } = await save([bus(), ferry()]);
    expect(status).toBe(200);
    const rows = await rowsNow();
    expect(rows[0].description).toBe("Bus");
    expect(rows[0].evidenceWaiver).toBeUndefined();
    expect(rows[1].evidenceWaiver).toEqual(WAIVER);
  });

  it("a row carrying only a payer stamp is protected too", async () => {
    await seedSheet([ferry(STAMP)]);
    const { status, body } = await save([ferry({ price: 99 })]);
    expect(status).toBe(409);
    expect(body.reasons[0]).toContain("recorded payer");
  });
});

describe("two people saving at once", () => {
  it("a save that would undo somebody else's is refused, not silently won", async () => {
    const sheet = await seedSheet([ferry()]);
    const stale = sheet.updatedAt.toISOString();
    await save([ferry(), bus()]);                       // somebody else saves first
    const { status, body } = await save([ferry()], { baseUpdatedAt: stale });
    expect(status).toBe(409);
    expect(body.error).toBe("stale");
    expect(await rowsNow()).toHaveLength(2);            // their row is still there
  });

  it("concurrent saves cannot lose the waiver — whichever wins, it is still there", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), bus()]);
    const results = await Promise.all([save([ferry(), bus()]), save([ferry(), bus()]), save([ferry(), bus()])]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect((await rowsNow())[0].evidenceWaiver).toEqual(WAIVER);
  });

  it("a save with no version still works — an older client is not locked out", async () => {
    await seedSheet([ferry()]);
    expect((await save([ferry(), bus()])).status).toBe(200);
  });
});

describe("a sheet shaped like the one this was found on", () => {
  // Six jobs, fifteen waived rows and eight payer stamps between them — the shape of
  // the real case, with invented guides, dates and amounts.
  const SHEETS = [
    { slot: 0, rows: 3, stamps: 1 }, { slot: 1, rows: 1, stamps: 0 }, { slot: 2, rows: 2, stamps: 1 },
    { slot: 3, rows: 3, stamps: 3 }, { slot: 4, rows: 3, stamps: 3 }, { slot: 5, rows: 3, stamps: 0 },
  ];
  const rowsFor = (n: number, stamps: number): Row[] =>
    Array.from({ length: n }, (_, i) => ferry({ description: `Local fare ${i + 1}`, price: 10 + i, evidenceWaiver: WAIVER, ...(i < stamps ? STAMP : {}) }));

  it("saving all six changes nothing about the evidence", async () => {
    for (const s of SHEETS) {
      await prisma.jobSheet.create({ data: { guideId: GUIDE, date: DATE, slotIdx: s.slot, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, expenses: rowsFor(s.rows, s.stamps) as object[] } });
    }
    for (const s of SHEETS) {
      const body = { guideId: GUIDE, date: DATE, slotIdx: s.slot, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, expenses: rowsFor(s.rows, 0).map((r) => { const { evidenceWaiver, ...rest } = r; void evidenceWaiver; return rest; }) };
      const res = await PUT(new Request("https://ops.example.test/api/jobsheet", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as unknown as Parameters<typeof PUT>[0]);
      expect(res.status).toBe(200);
    }
    const after = await prisma.jobSheet.findMany({ where: { guideId: GUIDE, date: DATE } });
    const all = after.flatMap((s) => s.expenses as unknown as Row[]);
    expect(all.filter((r) => r.evidenceWaiver).length).toBe(15);
    expect(all.filter((r) => r.paidByBy === "u_admin").length).toBe(8);
    // …and not one of the eight recorded decisions was re-attributed to whoever saved.
    expect(all.some((r) => r.paidByAt === STAMP.paidByAt && r.paidByBy !== "u_admin")).toBe(false);
  });
});

describe("two rows that say the same thing", () => {
  const OTHER = { by: "u_other_admin", at: "2099-05-09T08:00:00.000Z", reason: "a second fare on the return leg, also unreceipted" };

  it("two protected rows reading alike, carrying different waivers, are refused", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), ferry({ evidenceWaiver: OTHER })]);
    const { status, body } = await save([ferry(), ferry()]);
    expect(status).toBe(409);
    expect(body.error).toBe("protected-row");
    expect(body.reasons).toHaveLength(1);
    expect(body.reasons[0]).toContain("duplicate protected expense identity");
    expect(body.reasons[0]).toContain(REF);                   // which job sheet
    expect(body.reasons[0]).not.toContain("unreceipted");     // not the reason anybody wrote
    const rows = await rowsNow();
    expect(rows[0].evidenceWaiver).toEqual(WAIVER);           // both untouched
    expect(rows[1].evidenceWaiver).toEqual(OTHER);
  });

  it("a duplicate on the saved sheet alone is refused", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), ferry()]);
    const { status, body } = await save([ferry()]);
    expect(status).toBe(409);
    expect(body.reasons[0]).toContain("duplicate protected expense identity");
  });

  it("a duplicate in this save alone is refused, and nothing is attached to either row", async () => {
    await seedSheet([ferry({ evidenceWaiver: WAIVER })]);
    const { status, body } = await save([ferry(), ferry()]);
    expect(status).toBe(409);
    expect(body.reasons[0]).toContain("duplicate protected expense identity");
    expect(await rowsNow()).toHaveLength(1);
  });

  it("duplicates nobody signed for still save", async () => {
    await seedSheet([ferry(), ferry()]);
    const { status } = await save([ferry(), ferry(), ferry()]);
    expect(status).toBe(200);
    expect(await rowsNow()).toHaveLength(3);
  });

  it("distinct protected rows all reorder, each keeping its own record", async () => {
    const water = (over: Row = {}) => ferry({ description: "Water", price: 10, ...over });
    await seedSheet([ferry({ evidenceWaiver: WAIVER }), bus({ evidenceWaiver: OTHER }), water(STAMP)]);
    const { status } = await save([water(), bus(), ferry()]);
    expect(status).toBe(200);
    const rows = await rowsNow();
    expect(rows[0].paidByBy).toBe("u_admin");
    expect(rows[1].evidenceWaiver).toEqual(OTHER);
    expect(rows[2].evidenceWaiver).toEqual(WAIVER);
  });
});
