import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
// The slip goes to Drive and the voucher is filed there; neither is what is tested here.
const uploads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/advance-slip", async (orig) => ({
  ...(await orig<typeof import("@/lib/advance-slip")>()),
  uploadSlip: vi.fn(async () => { uploads.count++; return { url: `https://example.test/slip-${uploads.count}`, fileId: `file-${uploads.count}` }; }),
}));
vi.mock("@/lib/advances/voucher-issue", () => ({ issueVoucherFor: vi.fn(async () => null) }));

import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { reportService, requireTestDatabase, resetDatabase, seedGuide, workerMatchesEnv } from "@/test/db";
import { kbizSlipPdf } from "@/test/kbiz-pdf";
import { issueAdvance } from "./service";
import { txRefKey } from "./tx-ref";
import { syncAdvanceBatch } from "./peak-sync";
import { checkLinkSafety } from "./peak-link";
import { accountingWriteRefusal } from "./write-guard";
import { POST as createAdvance } from "@/app/api/advances/route";
import { POST as slipCheckRoute } from "@/app/api/advances/slip-check/route";

// P0 PEAK safety, against a real database: one transfer is one advance (the partial unique
// index and the trigger that derives its key), the slip check on the record route, and the
// interlock between the sender and the linker across the two services' reports.
//
// Every name, number and reference below is invented.

const CONFIG = {
  advanceAccountCode: "111100", advanceAccountSubId: "sub-advance",
  bankName: "Company account", bankAccountCode: "111300", bankAccountSubId: "sub-bank",
  journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {},
};
const GUIDE = "G-990";
const OTHER = "G-991";
const actor = { actorId: "u_op", actorRole: "OPERATOR" };
const base = { guideId: GUIDE, advanceDate: "2099-03-09", amount: 1500, today: "2099-03-10", method: "bank", bankAccount: "sub-bank", actor };

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify(CONFIG));
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
  await resetDatabase();
  await workerMatchesEnv();
  authMock.auth.mockResolvedValue({ user: { id: "u_op", role: "OPERATOR" } });
  uploads.count = 0;
});
afterEach(() => vi.unstubAllEnvs());

async function guides() {
  await seedGuide(GUIDE);
  await prisma.user.update({ where: { guideId: GUIDE }, data: { fullNameEnglish: "Somchai Jaideemaksakul", bankAccountNo: encrypt("1234543210") } });
  await prisma.user.create({ data: { email: "g991@example.test", displayName: "Ying Example", guideId: OTHER, role: "GUIDE", state: "ACTIVE", fullNameEnglish: "Somying Rakdee", bankAccountNo: encrypt("9876567890") } });
}

describe("the transfer key is the same in the database and in the app", () => {
  it("folk_tx_ref_key agrees with txRefKey on every shape a reference arrives in", async () => {
    const inputs = ["TRXX99031012345", " trxx 9903-1012 345 ", "TRXX/9903.1012_345", "ＴＲＸＸ９９０３", "TRXX๙๙๐๓", "  -  ", "", "ab-cd é ü"];
    for (const v of inputs) {
      const [{ k }] = await prisma.$queryRaw<{ k: string | null }[]>`SELECT folk_tx_ref_key(${v}) AS k`;
      expect(k, JSON.stringify(v)).toBe(txRefKey(v));
    }
  });

  it("the trigger fills the key on insert and on a change of reference — the app never writes it", async () => {
    await seedGuide(GUIDE);
    const a = await prisma.guideAdvance.create({ data: { guideId: GUIDE, date: "2099-03-09", slotIdx: -1, amount: 1, paidAt: new Date(), txRef: "trxx 0001", advanceNo: "FOLK-ADV-209903-901", advanceDate: "2099-03-09", amountSatang: 100, accountingPeriod: "2099-03" } });
    expect((await prisma.guideAdvance.findUniqueOrThrow({ where: { id: a.id } })).txRefKey).toBe("TRXX0001");
    await prisma.guideAdvance.update({ where: { id: a.id }, data: { txRef: "TRXX-0002" } });
    expect((await prisma.guideAdvance.findUniqueOrThrow({ where: { id: a.id } })).txRefKey).toBe("TRXX0002");
    await prisma.guideAdvance.update({ where: { id: a.id }, data: { txRefKey: "SOMETHING-ELSE" } });
    expect((await prisma.guideAdvance.findUniqueOrThrow({ where: { id: a.id } })).txRefKey).toBe("TRXX0002");
  });
});

describe("one bank transfer is one advance", () => {
  it("the same reference typed differently, on another job, another day: 409 naming the advance that holds it", async () => {
    await seedGuide(GUIDE);
    const first = await issueAdvance(prisma, { ...base, bankRef: "TRXX99031012345" });
    expect(first.ok).toBe(true);
    const again = await issueAdvance(prisma, { ...base, bankRef: " trxx-9903 1012345 ", advanceDate: "2099-03-10", amount: 1600, jobNo: null });
    expect(again).toMatchObject({ ok: false, status: 409, code: "DUPLICATE_BANK_REFERENCE", duplicateOf: { advanceNo: (first as { advance: { advanceNo: string } }).advance.advanceNo } });
    expect((again as { reasons: string[] }).reasons.join("\n")).toMatch(/different amount ฿1,600.00 vs ฿1,500.00 and date 2099-03-10 vs 2099-03-09/);
    expect(await prisma.guideAdvance.count()).toBe(1);
  });

  it("two requests at the same moment: exactly one advance, the other told which", async () => {
    await seedGuide(GUIDE);
    const results = await Promise.all([1, 2, 3].map(() => issueAdvance(prisma, { ...base, bankRef: "TRXX99031012345" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ status: 409, code: "DUPLICATE_BANK_REFERENCE" });
    expect(await prisma.guideAdvance.count()).toBe(1);
    expect(await prisma.advancePeakSync.count()).toBe(1); // one queued journal, not three
  });

  it("the database refuses a second live row even from a path that never asks first", async () => {
    await seedGuide(GUIDE);
    const row = (n: string, ref: string) => ({ guideId: GUIDE, date: "2099-03-09", slotIdx: -1, amount: 1, paidAt: new Date(), txRef: ref, advanceNo: n, advanceDate: "2099-03-09", amountSatang: 100, accountingPeriod: "2099-03" });
    await prisma.guideAdvance.create({ data: row("FOLK-ADV-209903-901", "TRXX0001") });
    await expect(prisma.guideAdvance.create({ data: row("FOLK-ADV-209903-902", "trxx 0001") })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("a reversed advance leaves the rule: the transfer recorded against the wrong guide can be recorded again", async () => {
    await seedGuide(GUIDE);
    const first = await issueAdvance(prisma, { ...base, bankRef: "TRXX99031012345" });
    await prisma.guideAdvance.update({ where: { id: (first as { advance: { id: string } }).advance.id }, data: { reversedAt: new Date(), reversalReason: "recorded against the wrong guide" } });
    expect((await issueAdvance(prisma, { ...base, bankRef: "TRXX99031012345" })).ok).toBe(true);
  });

  it("no reference (cash) is never a duplicate of anything", async () => {
    await seedGuide(GUIDE);
    expect((await issueAdvance(prisma, { ...base, method: "cash", bankRef: null })).ok).toBe(true);
    expect((await issueAdvance(prisma, { ...base, method: "cash", bankRef: null })).ok).toBe(true);
  });
});

describe("the record route: duplicate first, then the slip, then the upload", () => {
  async function sheet() {
    await prisma.jobSheet.create({ data: { guideId: GUIDE, date: "2025-03-10", slotIdx: 0, tourId: "T-900", status: "Confirmed", ref: "FOLK-BKK-20250310-01", bookings: [], expenses: [] } });
  }
  const post = (over: Record<string, string> = {}, pdf?: Uint8Array<ArrayBuffer>) => {
    const fd = new FormData();
    const fields = { guideId: GUIDE, advanceDate: "2025-03-09", amount: "1500", jobNo: "FOLK-BKK-20250310-01", bankRef: "TRXX99031012345", bankAccount: "sub-bank", allowedCategories: "entrance", ...over };
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const bytes = pdf ?? kbizSlipPdf({ id: "TRXX99031012345", date: "09/03/2025", amount: "1,500.00", to: "MR. SOMCHAI JAIDEEMAKSAKUL", account: "xxx-x-x4321-x" });
    fd.set("file", new File([bytes], "slip.pdf", { type: "application/pdf" }));
    return createAdvance(new Request("http://localhost/api/advances", { method: "POST", body: fd }) as unknown as NextRequest);
  };

  it("MATCH records with nothing more to say, and keeps the result — results only, no names", async () => {
    await guides(); await sheet();
    const res = await post();
    expect(res.status).toBe(200);
    const a = await prisma.guideAdvance.findFirstOrThrow();
    expect(a.slipCheckResult).toBe("MATCH");
    expect(a.slipCheckConfirmedById).toBeNull();
    expect(JSON.stringify(a.slipCheck)).not.toMatch(/SOMCHAI|JAIDEE/);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.slip_checked" } });
    expect(audit.detail).toMatchObject({ result: "MATCH" });
  });

  it("PARTIAL (a bank-cut surname) is refused until confirmed with a reason — then kept with who and why", async () => {
    await guides(); await sheet();
    const cut = kbizSlipPdf({ id: "TRXX99031012345", date: "09/03/2025", amount: "1,500.00", to: "MR. SOMCHAI JAIDEEMA", account: "xxx-x-x4321-x" });
    const refused = await post({}, cut);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "SLIP_CHECK_PARTIAL", slipCheck: { result: "PARTIAL" } });
    expect(uploads.count).toBe(0); // nothing uploaded for a refused record
    const ok = await post({ slipCheckConfirmed: "1", slipCheckReason: "bank prints the surname cut short" }, cut);
    expect(ok.status).toBe(200);
    expect(await prisma.guideAdvance.findFirstOrThrow()).toMatchObject({ slipCheckResult: "PARTIAL", slipCheckConfirmedById: "u_op", slipCheckReason: "bank prints the surname cut short" });
  });

  it("MISMATCH (another guide's account) is refused for an operator even when ticked; an ADMIN overrides with a reason", async () => {
    await guides(); await sheet();
    const theirs = kbizSlipPdf({ id: "TRXX99031012345", date: "09/03/2025", amount: "1,500.00", to: "MS. SOMYING RAKDEE", account: "xxx-x-x6789-x" });
    const op = await post({ slipCheckConfirmed: "1", slipCheckOverride: "1", slipCheckReason: "I am sure it is right" }, theirs);
    expect(op.status).toBe(422);
    const body = await op.json();
    expect(body).toMatchObject({ code: "SLIP_CHECK_MISMATCH", slipCheck: { checks: { otherGuideId: OTHER } } });
    authMock.auth.mockResolvedValue({ user: { id: "u_admin", role: "ADMIN" } });
    const admin = await post({ slipCheckOverride: "1", slipCheckReason: "guide asked us to pay their sister's account" }, theirs);
    expect(admin.status).toBe(200);
    expect(await prisma.guideAdvance.findFirstOrThrow()).toMatchObject({ slipCheckResult: "MISMATCH", slipCheckConfirmedById: "u_admin" });
  });

  it("a picture is UNKNOWN: refused until a person ticks that they checked it", async () => {
    await guides(); await sheet();
    const fd = (confirm: boolean) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ guideId: GUIDE, advanceDate: "2025-03-09", amount: "1500", jobNo: "FOLK-BKK-20250310-01", bankRef: "TRXX99031012345", bankAccount: "sub-bank" })) f.set(k, v);
      if (confirm) f.set("slipCheckConfirmed", "1");
      f.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "slip.png", { type: "image/png" }));
      return createAdvance(new Request("http://localhost/api/advances", { method: "POST", body: f }) as unknown as NextRequest);
    };
    expect((await fd(false)).status).toBe(422);
    expect((await fd(true)).status).toBe(200);
    expect((await prisma.guideAdvance.findFirstOrThrow()).slipCheckResult).toBe("UNKNOWN");
  });

  it("a duplicate is refused before the slip is checked or uploaded, with the existing advance to open", async () => {
    await guides(); await sheet();
    expect((await post()).status).toBe(200);
    const res = await post({ bankRef: "trxx 9903 1012 345" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "DUPLICATE_BANK_REFERENCE", duplicateOf: { guideId: GUIDE, jobNo: "FOLK-BKK-20250310-01" } });
    expect(uploads.count).toBe(1);
    expect(await prisma.guideAdvance.count()).toBe(1);
  });

  it("the screen's check endpoint writes nothing and says when the transfer is already recorded", async () => {
    await guides(); await sheet();
    expect((await post()).status).toBe(200);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ guideId: GUIDE, advanceDate: "2025-03-09", amount: "1500", bankRef: "TRXX99031012345" })) fd.set(k, v);
    fd.set("file", new File([kbizSlipPdf({ id: "TRXX99031012345", date: "09/03/2025", amount: "1,500.00", to: "MR. SOMCHAI JAIDEEMAKSAKUL", account: "xxx-x-x4321-x" })], "s.pdf", { type: "application/pdf" }));
    const res = await slipCheckRoute(new Request("http://localhost/api/advances/slip-check", { method: "POST", body: fd }) as unknown as NextRequest);
    const body = await res.json();
    expect(body).toMatchObject({ check: { result: "MATCH" }, duplicate: { code: "DUPLICATE_BANK_REFERENCE" } });
    expect(await prisma.guideAdvance.count()).toBe(1);
    expect(uploads.count).toBe(1);
  });
});

describe("the sender and the linker can never both act", () => {
  async function readyAdvance() {
    await seedGuide(GUIDE);
    await prisma.user.update({ where: { guideId: GUIDE }, data: { peakContactId: "contact-1" } });
    const r = await issueAdvance(prisma, { ...base, bankRef: "TRXX99031012345", jobNo: "FOLK-BKK-20990310-01", date: "2099-03-10", slotIdx: 0, slipUrl: "https://example.test/slip" });
    const id = (r as { advance: { id: string } }).advance.id;
    // The local test database's now() runs on local time; make the item due regardless.
    await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${id}` }, data: { nextAttemptAt: new Date(0) } });
    return id;
  }
  const fakePost = () => vi.fn(async () => ({ ok: true as const, id: "doc-1", code: "JV-209903001" }));

  it("the worker posts when both services agree on automatic posting", async () => {
    const id = await readyAdvance();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
    await reportService("FP", { autoSync: true, existingLinks: false });
    const post = fakePost();
    expect(await syncAdvanceBatch(prisma, post)).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await prisma.advancePeakSync.findUnique({ where: { id: `ADVANCE:${id}` } })).toMatchObject({ status: "POSTED" });
  });

  it("the worker does NOT post while FP reports linking on — nothing sent, nothing claimed", async () => {
    const id = await readyAdvance();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
    await reportService("FP", { autoSync: false, existingLinks: true });
    const post = fakePost();
    expect(await syncAdvanceBatch(prisma, post)).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(await prisma.advancePeakSync.findUnique({ where: { id: `ADVANCE:${id}` } })).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("the worker does not post while FP disagrees (FP's sender off)", async () => {
    await readyAdvance();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
    await reportService("FP", { autoSync: false, existingLinks: false });
    const post = fakePost();
    expect(await syncAdvanceBatch(prisma, post)).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("both switches on in the worker's own environment: nothing is posted", async () => {
    await readyAdvance();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1"); vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
    const post = fakePost();
    expect(await syncAdvanceBatch(prisma, post)).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("linking needs the worker's own recent word that its sender is off", async () => {
    vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
    await prisma.serviceStatus.deleteMany({ where: { id: "payment-worker" } });
    expect(await checkLinkSafety(prisma)).toMatchObject({ ok: false, status: 409 });            // never reported
    await reportService("payment-worker", { autoSync: false, existingLinks: true }, 10 * 60_000);
    expect(await checkLinkSafety(prisma)).toMatchObject({ ok: false, status: 409 });            // too long ago
    await reportService("payment-worker", { autoSync: true, existingLinks: false });
    const posting = await checkLinkSafety(prisma);
    expect(posting).toMatchObject({ ok: false, status: 409 });                                  // the worker is posting
    expect((posting as { reasons: string[] }).reasons.join(" ")).toMatch(/One service posts to PEAK automatically while the other lets an admin link/);
    await reportService("payment-worker", { autoSync: false, existingLinks: true });
    expect(await checkLinkSafety(prisma)).toBeNull();                                           // both reconciling
  });

  it("unsafe switches stop new accounting entries; consistent ones do not", async () => {
    expect(await accountingWriteRefusal(prisma)).toBeNull();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1"); vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
    const local = await accountingWriteRefusal(prisma);
    expect(local).toMatchObject({ status: 503, body: { code: "PEAK_SWITCHES_UNSAFE" } });
    vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
    await reportService("payment-worker", { autoSync: false, existingLinks: true });
    expect(await accountingWriteRefusal(prisma)).toMatchObject({ status: 503 });                // across services
    await reportService("payment-worker", { autoSync: true, existingLinks: false });
    expect(await accountingWriteRefusal(prisma)).toBeNull();
  });

  it("the record route answers 503 while unsafe, and records nothing", async () => {
    await guides();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1"); vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
    const fd = new FormData(); fd.set("guideId", GUIDE);
    const res = await createAdvance(new Request("http://localhost/api/advances", { method: "POST", body: fd }) as unknown as NextRequest);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PEAK_SWITCHES_UNSAFE" });
    expect(await prisma.guideAdvance.count()).toBe(0);
  });
});
