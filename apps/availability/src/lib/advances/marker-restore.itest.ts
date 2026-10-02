import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The settlement-marker restore tool, against a real database — including the rollback failure
// it exists for: code from before Phase 1B saves a settled job sheet and drops the
// `advanceSettlement` marker; the ledger still holds the live settlement; the tool puts the
// marker back from the ledger, once, and the current code protects the row again.
// All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));

import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { reverseEntry, settleFromExpenses } from "./service";
import { runMarkerRestore, type RestoreReport } from "./marker-restore";
import { PUT } from "@/app/api/jobsheet/route";
import type { Expense, GuideFee } from "@/lib/jobsheet";

const G = "G-919", DATE = "2099-10-01";
const FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };
type Row = Expense & Record<string, unknown>;
let admin = { actorId: "", actorRole: "ADMIN" };
let seq = 0;
const row = (description: string, expenseType: string, price: number, pax: number, over: Record<string, unknown> = {}): Row =>
  ({ description, expenseType, price, pax, paidBy: "advance", paidBySource: "operator", paidByBy: "u_op", paidByAt: "2099-10-01T10:00:00.000Z", ...over }) as Row;

async function settledJob(rows: Row[], settleIdx: number[], slotIdx = 0, cats = ["entrance", "meal"]) {
  seq++;
  const advance = await prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx, amount: 1000, paidAt: new Date("2099-09-30T03:00:00Z"), method: "bank", txRef: `TX-MR-${seq}`,
    advanceNo: `FOLK-ADV-209910-${String(seq).padStart(3, "0")}`, advanceDate: "2099-09-30", amountSatang: 100_000, accountingPeriod: "2099-09", allowedCategories: cats,
  } });
  const linked = rows.map((r, i) => (settleIdx.includes(i) ? { ...r, advanceId: advance.id } : r));
  const sheet = await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-MR-${seq}`, guideId: G, date: DATE, slotIdx, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED", bookings: [{ name: "Guest Example Person", bookingNo: "GYGEXAMPLEMR", bookedPax: 2 }] as never, expenses: linked as never, guideFee: FEE } });
  const s = await settleFromExpenses(prisma, { advanceId: advance.id, jobSheetId: sheet.id, sheetVersion: sheet.updatedAt.toISOString(), lines: settleIdx.map((i) => ({ index: i, identity: financialIdentity(linked[i]) })), actor: admin });
  if (!s.ok) throw new Error(s.reasons.join("; "));
  return { advance, sheetId: sheet.id, entryId: s.entryId };
}
const rowsOf = async (id: string) => (await prisma.jobSheet.findUniqueOrThrow({ where: { id } })).expenses as unknown as Row[];
/** What a save by code from before Phase 1B does to a settled sheet: its schema drops the marker. */
async function oldCodeSave(sheetId: string, change: (r: Row, i: number) => Row = (r) => r) {
  const rows = (await rowsOf(sheetId)).map((r, i) => { const { advanceSettlement: _gone, ...rest } = change(r, i); return rest as Row; });
  await prisma.jobSheet.update({ where: { id: sheetId }, data: { expenses: rows as never } });
}
const run = async (mode: "dry-run" | "apply") => runMarkerRestore(prisma, { mode, operator: "Operator Example" }) as Promise<RestoreReport>;
const codes = (r: RestoreReport) => r.refusedSheets.flatMap((s) => s.issues.map((i) => i.code));
const hashSheets = async () => (await prisma.jobSheet.findMany({ orderBy: { id: "asc" }, select: { id: true, expenses: true, updatedAt: true } })).map((s) => JSON.stringify(s));

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ADVANCE_WRITES_FROZEN;
  await resetDatabase();
  await seedGuide(G);
  const u = await prisma.user.create({ data: { email: "admin-mr@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  admin = { actorId: u.id, actorRole: "ADMIN" };
  authMock.auth.mockResolvedValue({ user: { id: u.id, role: "ADMIN" } });
});

describe("the rollback failure, end to end", () => {
  it("1–11 · marker dropped by an old save → dry run finds 1 → apply restores it → apply again changes nothing → the row is protected again", async () => {
    const { sheetId, entryId, advance } = await settledJob([row("Temple ticket", "entrance", 500, 1), row("Taxi (example)", "transport", 100, 1, { paidBy: "guide" })], [0]);
    expect((await rowsOf(sheetId))[0].advanceSettlement).toMatchObject({ entryId, advanceId: advance.id });
    const updatedBefore = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheetId } })).updatedAt;

    await oldCodeSave(sheetId);
    expect((await rowsOf(sheetId))[0].advanceSettlement).toBeUndefined();
    expect(await prisma.guideAdvanceEntry.findUniqueOrThrow({ where: { id: entryId } })).toMatchObject({ reversedByEntryId: null, amountSatang: 50_000 });

    const dry = await run("dry-run");
    expect(dry).toMatchObject({ mode: "dry-run", sheetsInspected: 1, settlementsInspected: 1, expectedMarkers: 1, correctMarkers: 0, missingMarkers: 1, restoredMarkers: 0, refusedSheets: [] });
    expect((await rowsOf(sheetId))[0].advanceSettlement).toBeUndefined(); // a dry run writes nothing

    process.env.ADVANCE_WRITES_FROZEN = "1";
    const ledgerBefore = JSON.stringify(await prisma.guideAdvanceEntry.findMany({ orderBy: { id: "asc" } })) + JSON.stringify(await prisma.guideAdvance.findMany({ orderBy: { id: "asc" } }));
    const rowsBefore = await rowsOf(sheetId);
    const versionBeforeRepair = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheetId } })).updatedAt.getTime();
    const applied = await run("apply");
    expect(applied).toMatchObject({ mode: "apply", missingMarkers: 1, restoredMarkers: 1, sheetsRepaired: 1, conflictsAtWrite: [] });
    const after = await rowsOf(sheetId);
    expect(after[0].advanceSettlement).toEqual({ entryId, advanceId: advance.id, advanceNo: advance.advanceNo });
    // Only the marker was added: every other field of every row is byte-identical, the version too.
    expect(after.map(({ advanceSettlement: _m, ...r }) => r)).toEqual(rowsBefore);
    // The old save moved the sheet's version; the repair does not (only the marker is written).
    expect(versionBeforeRepair).not.toBe(updatedBefore.getTime());
    expect((await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheetId } })).updatedAt.getTime()).toBe(versionBeforeRepair);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.settlement_markers_restored" } });
    expect(audit).toMatchObject({ actorRole: "TOOL", entityId: sheetId });
    expect(audit.detail).toMatchObject({ tool: "restore-settlement-markers", operator: "Operator Example", markersRestored: 1, settlementEntryIds: [entryId] });
    expect(JSON.stringify(audit.detail)).not.toMatch(/Guest Example Person|GYGEXAMPLEMR/);
    // The ledger and the advance were not touched.
    expect(JSON.stringify(await prisma.guideAdvanceEntry.findMany({ orderBy: { id: "asc" } })) + JSON.stringify(await prisma.guideAdvance.findMany({ orderBy: { id: "asc" } }))).toBe(ledgerBefore);

    const again = await run("apply");
    expect(again).toMatchObject({ missingMarkers: 0, correctMarkers: 1, restoredMarkers: 0, sheetsRepaired: 0 });
    expect(await prisma.auditLog.count({ where: { action: "advance.settlement_markers_restored" } })).toBe(1);

    // Rolled forward: the current save protects the settled row again.
    delete process.env.ADVANCE_WRITES_FROZEN;
    const edited = (await rowsOf(sheetId)).map((r, i) => (i === 0 ? { ...r, price: 600 } : r));
    const put = await PUT(new NextRequest("http://test.local/api/jobsheet", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses: edited, guideFee: FEE }) }));
    expect(put.status).toBe(409);
    expect(JSON.stringify(await put.json())).toMatch(new RegExp(`settlement of company advance ${advance.advanceNo}`));
  });
});

describe("what it refuses — the whole sheet, never a guess", () => {
  beforeEach(() => { process.env.ADVANCE_WRITES_FROZEN = "1"; });

  it("a reversed settlement restores nothing", async () => {
    const { sheetId, entryId } = await settledJob([row("Temple ticket", "entrance", 500, 1)], [0]);
    delete process.env.ADVANCE_WRITES_FROZEN;
    expect((await reverseEntry(prisma, { entryId, reason: "settled by mistake (example)", actor: admin })).ok).toBe(true);
    process.env.ADVANCE_WRITES_FROZEN = "1";
    const r = await run("apply");
    expect(r).toMatchObject({ settlementsInspected: 0, restoredMarkers: 0 });
    expect((await rowsOf(sheetId))[0].advanceSettlement).toBeUndefined();
  });
  for (const [code, change] of [
    ["AMOUNT_MISMATCH", (r: Row, i: number) => (i === 0 ? { ...r, pax: 2 } : r)],
    ["CATEGORY_MISMATCH", (r: Row, i: number) => (i === 0 ? { ...r, expenseType: "meal" } : r)],
    ["ADVANCE_MISMATCH", (r: Row, i: number) => (i === 0 ? { ...r, advanceId: "another-advance" } : r)],
  ] as const) {
    it(`refuses ${code}`, async () => {
      const { sheetId } = await settledJob([row("Temple ticket", "entrance", 500, 1)], [0]);
      await oldCodeSave(sheetId, change);
      const before = await hashSheets();
      const r = await run("apply");
      // An amount or category change also changes the identity, so the row is "not found" by the identity it was settled with.
      expect(codes(r).some((c) => c === code || c === "ROW_NOT_FOUND")).toBe(true);
      expect(r.restoredMarkers).toBe(0);
      expect(await hashSheets()).toEqual(before);
    });
  }
  it("refuses DUPLICATE_IDENTITY — two rows read exactly like the settled one", async () => {
    const { sheetId } = await settledJob([row("Temple ticket", "entrance", 500, 1)], [0]);
    await oldCodeSave(sheetId);
    const rows = await rowsOf(sheetId);
    await prisma.jobSheet.update({ where: { id: sheetId }, data: { expenses: [...rows, { ...rows[0] }] as never } });
    const r = await run("apply");
    expect(codes(r)).toEqual(["DUPLICATE_IDENTITY"]);
    expect((await rowsOf(sheetId)).every((x) => !x.advanceSettlement)).toBe(true);
  });
  it("refuses a CONFLICTING_MARKER — a marker for another settlement is never overwritten", async () => {
    const { sheetId } = await settledJob([row("Temple ticket", "entrance", 500, 1)], [0]);
    const rows = await rowsOf(sheetId);
    await prisma.jobSheet.update({ where: { id: sheetId }, data: { expenses: [{ ...rows[0], advanceSettlement: { entryId: "someone-else", advanceId: rows[0].advanceId, advanceNo: "FOLK-ADV-209910-999" } }] as never } });
    const r = await run("apply");
    expect(codes(r)).toContain("CONFLICTING_MARKER");
    expect((await rowsOf(sheetId))[0].advanceSettlement).toMatchObject({ entryId: "someone-else" });
  });
  it("repairs no part of a sheet when any line of it is doubtful", async () => {
    const { sheetId } = await settledJob([row("Temple ticket", "entrance", 500, 1), row("Lunch (example)", "meal", 100, 2)], [0, 1]);
    await oldCodeSave(sheetId, (r, i) => (i === 1 ? { ...r, pax: 3 } : r));
    const r = await run("apply");
    expect(r.refusedSheets).toHaveLength(1);
    expect((await rowsOf(sheetId)).every((x) => !x.advanceSettlement)).toBe(true);
  });
  it("apply refuses while advance writes are not frozen, and without an operator", async () => {
    const { sheetId } = await settledJob([row("Temple ticket", "entrance", 500, 1)], [0]);
    await oldCodeSave(sheetId);
    delete process.env.ADVANCE_WRITES_FROZEN;
    expect(await runMarkerRestore(prisma, { mode: "apply", operator: "Operator Example" })).toMatchObject({ refused: expect.stringMatching(/ADVANCE_WRITES_FROZEN is not 1/) });
    process.env.ADVANCE_WRITES_FROZEN = "1";
    expect(await runMarkerRestore(prisma, { mode: "apply", operator: " " })).toMatchObject({ refused: expect.stringMatching(/operator/) });
    expect((await rowsOf(sheetId))[0].advanceSettlement).toBeUndefined();
  });
  it("unrelated sheets and rows stay byte-identical (expenses and version)", async () => {
    const a = await settledJob([row("Temple ticket", "entrance", 500, 1), row("Taxi (example)", "transport", 100, 1, { paidBy: "guide" })], [0], 0);
    const b = await settledJob([row("Wat ticket (example)", "entrance", 300, 1)], [0], 1);
    await oldCodeSave(a.sheetId);
    const bBefore = JSON.stringify(await prisma.jobSheet.findUniqueOrThrow({ where: { id: b.sheetId } }));
    const taxiBefore = JSON.stringify((await rowsOf(a.sheetId))[1]);
    expect(await run("apply")).toMatchObject({ restoredMarkers: 1, correctMarkers: 1, sheetsRepaired: 1 });
    expect(JSON.stringify(await prisma.jobSheet.findUniqueOrThrow({ where: { id: b.sheetId } }))).toBe(bBefore);
    expect(JSON.stringify((await rowsOf(a.sheetId))[1])).toBe(taxiBefore);
  });
});

describe("privacy — no expense description in any output", () => {
  const PII = "Ticket for Somchai Example-Guest GYG987654321 tel 0812345678";
  const leaks = (text: string) => ["Somchai", "Example-Guest", "GYG987654321", "0812345678", "Guest Example Person", "GYGEXAMPLEMR"].filter((x) => text.includes(x));
  it("dry-run, refusal details, apply report, audit and the command line carry none of it", async () => {
    process.env.ADVANCE_WRITES_FROZEN = "1";
    // One sheet that will be repaired, one that will be refused (a second row reads the same).
    const ok = await settledJob([row(PII, "entrance", 500, 1)], [0], 0);
    const bad = await settledJob([row(PII, "entrance", 400, 1)], [0], 1);
    await oldCodeSave(ok.sheetId); await oldCodeSave(bad.sheetId);
    const badRows = await rowsOf(bad.sheetId);
    await prisma.jobSheet.update({ where: { id: bad.sheetId }, data: { expenses: [...badRows, { ...badRows[0] }] as never } });
    const dry = await run("dry-run");
    expect(codes(dry)).toEqual(["DUPLICATE_IDENTITY"]);
    expect(dry.refusedSheets[0].issues[0].detail).toMatch(/row 1, entrance, 40000 satang, id [0-9a-f]{10}/);
    expect(leaks(JSON.stringify(dry))).toEqual([]);
    const applied = await run("apply");
    expect(applied.restoredMarkers).toBe(1);
    expect(leaks(JSON.stringify(applied))).toEqual([]);
    expect(leaks(JSON.stringify(await prisma.auditLog.findMany({ where: { action: "advance.settlement_markers_restored" } })))).toEqual([]);
    const [id] = await prisma.$queryRaw<{ db: string; sysid: string }[]>`SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sysid`;
    const capture = (args: string[], env: Record<string, string> = {}) => {
      try { return execFileSync("npx", ["tsx", "scripts/restore-settlement-markers.ts", ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { const x = e as { stdout: string; stderr: string }; return `${x.stdout}${x.stderr}`; } // exits 1 when a sheet is refused
    };
    const outs = [capture([]), capture(["--apply", "--expect-database", id.db, "--expect-system-id", id.sysid, "--operator", "Operator Example"], { ADVANCE_WRITES_FROZEN: "1" })];
    for (const o of outs) { expect(o).toMatch(/DUPLICATE_IDENTITY/); expect(leaks(o)).toEqual([]); }
  }, 120_000);
});

describe("the command line", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try { return { code: 0, out: execFileSync("npx", ["tsx", "scripts/restore-settlement-markers.ts", ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
  };
  it("dry run by default; apply only with the database's own name + system id, an operator and frozen writes", async () => {
    const { sheetId } = await settledJob([row("Temple ticket", "entrance", 500, 1)], [0]);
    await oldCodeSave(sheetId);
    const [id] = await prisma.$queryRaw<{ db: string; sysid: string }[]>`SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sysid`;
    const dry = cli([]);
    expect(dry.out).toMatch(/mode: dry run/);
    expect(dry.out).toMatch(/"missing": 1/);
    expect(dry.out).not.toMatch(/postgres(ql)?:\/\//); // never prints the connection URL
    expect(cli(["--apply"], { ADVANCE_WRITES_FROZEN: "1" }).out).toMatch(/REFUSED: --expect-database/);
    expect(cli(["--apply", "--expect-database", id.db, "--expect-system-id", "123", "--operator", "Operator Example"], { ADVANCE_WRITES_FROZEN: "1" }).out).toMatch(/REFUSED: --expect-system-id/);
    expect(cli(["--apply", "--expect-database", id.db, "--expect-system-id", id.sysid, "--operator", "Operator Example"], { ADVANCE_WRITES_FROZEN: "0" }).out).toMatch(/REFUSED: ADVANCE_WRITES_FROZEN=1 is required/);
    expect(cli(["--apply", "--dry-run"]).out).toMatch(/REFUSED: choose --apply or --dry-run/);
    expect((await rowsOf(sheetId))[0].advanceSettlement).toBeUndefined();
    const ok = cli(["--apply", "--expect-database", id.db, "--expect-system-id", id.sysid, "--operator", "Operator Example"], { ADVANCE_WRITES_FROZEN: "1" });
    expect(ok.out).toMatch(/"restored": 1/);
    expect((await rowsOf(sheetId))[0].advanceSettlement).toBeTruthy();
    expect(cli(["--apply", "--expect-database", id.db, "--expect-system-id", id.sysid, "--operator", "Operator Example"], { ADVANCE_WRITES_FROZEN: "1" }).out).toMatch(/"restored": 0/);
  }, 120_000);
});
