import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// PR4 routes against a real database: the switch, who may do what (enforced on the server), and
// the hand-in round trip over HTTP. Invented data only.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { recordRouteExtensionSale } from "./sales";
import { setReceivingAccount } from "./settlement";
import { GET as VIEW } from "@/app/api/upsell/hand-in/[jobSheetId]/route";
import { POST as REPORT } from "@/app/api/upsell/hand-in/[jobSheetId]/transfers/route";
import { POST as PREPARE } from "@/app/api/upsell/hand-in/[jobSheetId]/prepare/route";
import { POST as SUBMIT } from "@/app/api/upsell/hand-in/[jobSheetId]/submit/route";
import { POST as CONFIRM } from "@/app/api/upsell/settlements/[id]/confirm/route";
import { GET as ACCOUNT_GET, POST as ACCOUNT_POST } from "@/app/api/upsell/receiving-account/route";

const TODAY = bangkokToday(), TOUR = "T-005";
let g1 = "", g2 = "", adminId = "", opId = "", acctId = "", jobId = "";
const as = (id: string, role: string, guideId?: string) => authMock.auth.mockResolvedValue({ user: { id, role, ...(guideId ? { guideId } : {}) } });
const req = (body?: unknown) => new NextRequest("http://test.local/x", { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const call = async (r: Response) => ({ status: r.status, body: await r.json() });
const p = <T extends string>(k: T, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<T, string>) });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
  g1 = (await seedGuide("G-981")).id;
  g2 = (await seedGuide("G-982", { email: "g982@example.test" })).id;
  for (const [id, name] of [[TOUR, "Invented Palace Tour"], ["T-001", "Invented Three Temples"], ["T-002", "Invented Three Temples PM"]]) {
    await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "14.00 PM" } });
  }
  const mk = async (role: "ADMIN" | "OPERATOR" | "ACCOUNTANT") => (await prisma.user.create({ data: { email: `${role.toLowerCase()}-r@example.test`, displayName: `${role} Example`, role, state: "ACTIVE" } })).id;
  adminId = await mk("ADMIN"); opId = await mk("OPERATOR"); acctId = await mk("ACCOUNTANT");
  await seedUpsellProducts(prisma, TODAY);
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR], activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  await prisma.assignment.create({ data: { guideId: "G-981", date: TODAY, slotIdx: 2, tourId: TOUR } });
  await prisma.booking.create({ data: { source: "manual", externalId: `bk-r-${Math.random()}`, tourId: TOUR, date: TODAY, slotIdx: 2, pax: 6, status: "ASSIGNED", customerName: "Invented Guest" } });
  jobId = (await prisma.jobSheet.create({ data: { guideId: "G-981", date: TODAY, slotIdx: 2, tourId: TOUR, bookings: [{ name: "Invented Guest", bookingNo: "INV-1", bookedPax: 6 }] } })).id;
  await recordRouteExtensionSale(prisma, { requestKey: `test-key-route-${Math.random().toString(36).slice(2, 12)}`, jobSheetId: jobId, productVersionId: v.id, guests: 2, expectedUnitPriceSatang: v.unitPriceSatang }, { userId: g1, guideId: "G-981" });
  await prisma.tourReport.create({ data: { guideId: "G-981", date: TODAY, slotIdx: 2, tourId: TOUR } });
});
afterEach(() => vi.unstubAllEnvs());

describe("Extras cash routes", () => {
  it("do not exist while the master switch is off", async () => {
    vi.stubEnv("UPSELL_ENABLED", "0");
    as(g1, "GUIDE", "G-981");
    expect((await VIEW(req(), p("jobSheetId", jobId))).status).toBe(404);
    expect((await ACCOUNT_GET()).status).toBe(404);
  });

  it("the receiving account: finance reads, only an Admin sets (resolved against PEAK, here unreachable → refused)", async () => {
    as(acctId, "ACCOUNTANT");
    expect(await call(await ACCOUNT_GET())).toMatchObject({ status: 200, body: { current: null } });
    expect((await ACCOUNT_POST(req({ peakPaymentMethodId: "pm-1", label: "Extras (example)", confirmSuitable: true }))).status).toBe(403);
    as(opId, "OPERATOR");
    expect((await ACCOUNT_POST(req({ peakPaymentMethodId: "pm-1", label: "Extras (example)", confirmSuitable: true }))).status).toBe(403);
    as(adminId, "ADMIN");
    expect((await ACCOUNT_POST(req({ peakPaymentMethodId: "pm-1", label: "Extras (example)", confirmSuitable: true }))).status).toBe(409); // PEAK not configured in tests: fails closed
  });

  it("the round trip over HTTP; another guide, an Operator and an Accountant cannot write", async () => {
    await setReceivingAccount(prisma, { userId: adminId }, { peakPaymentMethodId: "pm-1", label: "Extras (example)", confirmSuitable: true }, async (id) => ({ id, name: "Invented Bank", bankAccountKey: "ACC:999007890", accountDisplay: "···7890" }));
    const ev = await prisma.paymentEvidence.create({ data: { googleDriveFileId: "drive-route-1", fileHash: "hash-route-1", driveLink: "https://example.test/slip-99", guideId: "G-981", slipUploadedBy: g1 } });
    const report = { amountSatang: 40000, transferredAt: new Date(Date.now() - 600_000).toISOString(), bankRef: "KB-7731-0099", slip: { evidenceId: ev.id }, requestKey: "route-transfer-key-0001" };
    as(g2, "GUIDE", "G-982");
    expect((await REPORT(req(report), p("jobSheetId", jobId))).status).toBe(403);
    expect((await VIEW(req(), p("jobSheetId", jobId))).status).toBe(403);
    as(opId, "OPERATOR");
    expect((await REPORT(req(report), p("jobSheetId", jobId))).status).toBe(403);
    expect((await VIEW(req(), p("jobSheetId", jobId))).status).toBe(200); // read only
    as(g1, "GUIDE", "G-981");
    // The code first — read-only GET makes none; prepare does, the same one every time.
    expect((await call(await VIEW(req(), p("jobSheetId", jobId)))).body).toMatchObject({ settlementNo: null });
    const code = await call(await PREPARE(req({}), p("jobSheetId", jobId)));
    expect(code).toMatchObject({ status: 200, body: { settlementNo: expect.stringMatching(/^FOLK-CSH-/), memo: expect.stringMatching(/^FOLK-CSH-/) } });
    expect((await call(await PREPARE(req({}), p("jobSheetId", jobId)))).body.settlementNo).toBe(code.body.settlementNo);
    as(opId, "OPERATOR");
    expect((await PREPARE(req({}), p("jobSheetId", jobId))).status).toBe(403);
    as(g1, "GUIDE", "G-981");
    const r = await call(await REPORT(req(report), p("jobSheetId", jobId)));
    expect(r).toMatchObject({ status: 200, body: { ok: true, seq: 1 } });
    expect((await call(await SUBMIT(req({ transferIds: ["someone-else"] }), p("jobSheetId", jobId)))).status).toBe(409);
    const s = await call(await SUBMIT(req({ transferIds: [r.body.transferId] }), p("jobSheetId", jobId)));
    expect(s).toMatchObject({ status: 200, body: { submissionNo: 1 } });
    const settlement = await prisma.cashSettlement.findFirstOrThrow();
    const confirm = req({ submissionNo: 1, transferIds: [r.body.transferId] });
    for (const [id, role] of [[g1, "GUIDE"], [opId, "OPERATOR"], [acctId, "ACCOUNTANT"]]) {
      as(id, role, role === "GUIDE" ? "G-981" : undefined);
      expect((await CONFIRM(req({ submissionNo: 1, transferIds: [r.body.transferId] }), p("id", settlement.id))).status).toBe(403);
    }
    as(adminId, "ADMIN");
    expect(await call(await CONFIRM(confirm, p("id", settlement.id)))).toMatchObject({ status: 200, body: { status: "CONFIRMED" } });
    // Pressed again: answered as confirmed; still one remittance.
    expect(await call(await CONFIRM(req({ submissionNo: 1, transferIds: [r.body.transferId] }), p("id", settlement.id)))).toMatchObject({ status: 200, body: { status: "CONFIRMED" } });
    expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1);
    as(g1, "GUIDE", "G-981");
    expect((await call(await VIEW(req(), p("jobSheetId", jobId)))).body).toMatchObject({ heldSatang: 0, status: "CONFIRMED", transfers: [expect.objectContaining({ status: "CONFIRMED", toAccount: "···7890" })] });
  });
});
