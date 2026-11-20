import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// PR4-0b: the Admin's corrections of the bank-transaction registry, through the real routes
// and services. Every guide, reference and amount below is invented.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide, workerMatchesEnv } from "@/test/db";
import { issueAdvance } from "@/lib/advances/service";
import { GET as LIST } from "@/app/api/bank-transactions/route";
import { GET as DETAIL } from "@/app/api/bank-transactions/[id]/route";
import { POST as AMOUNT } from "@/app/api/bank-transactions/[id]/amount/route";
import { POST as REVIEW } from "@/app/api/bank-transactions/[id]/review/route";

beforeAll(requireTestDatabase);
const CONFIG = { advanceAccountCode: "111100", advanceAccountSubId: "sub-advance", bankName: "Company account", bankAccountCode: "111300", bankAccountSubId: "sub-bank", journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {} };
beforeEach(async () => {
  vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify(CONFIG));
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
  await resetDatabase();
  await workerMatchesEnv();
  await seedGuide("G-931");
});
afterEach(() => vi.unstubAllEnvs());

let seq = 0;
async function user(role: "ADMIN" | "OPERATOR" | "ACCOUNTANT" | "GUIDE", state: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const u = await prisma.user.create({ data: { email: `${role.toLowerCase()}-${++seq}@example.test`, displayName: `${role} Example`, role, state } });
  return { actorId: u.id, actorRole: role as string };
}
const as = (a: { actorId: string; actorRole: string }) => authMock.auth.mockResolvedValue({ user: { id: a.actorId, role: a.actorRole } });
const call = async (r: Response) => ({ status: r.status, body: await r.json() });
const req = (url: string, method = "GET", body?: unknown) => new NextRequest(`http://test.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function payment(bankRef: string, amount = 1000) {
  return prisma.guidePayment.create({ data: {
    paymentNo: `FOLK-PMT-209901-${String(++seq).padStart(3, "0")}`, guideId: "G-931", accountingPeriod: "2099-01", paymentDate: "2099-01-10",
    jobTotal: amount, adjustmentTotal: 0, amountTransferred: amount, bankRef } });
}
async function evidence() {
  const n = Math.random().toString(36).slice(2, 12);
  return (await prisma.paymentEvidence.create({ data: { googleDriveFileId: `drive-${n}`, fileHash: `hash-${n}`, driveLink: `https://example.test/evidence-${n}`, evidenceType: "BANK_STATEMENT" } })).id;
}
const versionOf = async (id: string) => (await prisma.bankTransaction.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
const txOf = async (paymentId: string) => (await prisma.bankTransactionUse.findFirstOrThrow({ where: { sourceId: paymentId } })).transactionId;

describe("Payments › Bank transfers: read for finance, written by an Admin only", () => {
  it("lists needing review first, with the document numbers; a guide sees nothing", async () => {
    const p = await payment("BANK");
    await payment("KB-2099-0601");
    as(await user("ACCOUNTANT"));
    const all = await call(await LIST(req("/api/bank-transactions")));
    expect(all.status).toBe(200);
    expect(all.body.rows).toHaveLength(2);
    expect(all.body.rows[0]).toMatchObject({ reviewStatus: "NEEDS_REVIEW", refRaw: "BANK", version: expect.any(String), records: [expect.objectContaining({ docNo: p.paymentNo, guideId: "G-931", role: "USE", live: true })] });
    expect((await call(await LIST(req("/api/bank-transactions?review=1")))).body.rows).toHaveLength(1);
    expect((await call(await LIST(req("/api/bank-transactions?q=2099-0601")))).body.rows).toHaveLength(1);
    const detail = await call(await DETAIL(req("/"), params(await txOf(p.id))));
    expect(detail.body).toMatchObject({ refRaw: "BANK", history: [] });
    as(await user("GUIDE"));
    expect((await LIST(req("/api/bank-transactions"))).status).toBe(403);
  });

  it("correcting an amount: Admin only, evidence and reason required, old and new kept in the audit", async () => {
    const p = await payment("KB-2099-0602", 1000);
    const id = await txOf(p.id);
    const post = (b: unknown) => AMOUNT(req(`/api/bank-transactions/${id}/amount`, "POST", b), params(id));
    const ev = await evidence();
    const good = { amount: 1200, reason: "statement shows 1,200 (example)", evidenceId: ev, expectedVersion: await versionOf(id) };
    for (const who of [await user("OPERATOR"), await user("ACCOUNTANT"), await user("ADMIN", "SUSPENDED")]) {
      as(who);
      expect((await post(good)).status).toBe(403);
    }
    const admin = await user("ADMIN");
    as(admin);
    expect((await post({ ...good, evidenceId: "not-on-file" })).status).toBe(409);
    expect((await post({ ...good, evidenceId: undefined })).status).toBe(400);
    expect((await post({ ...good, expectedVersion: "2001-01-01T00:00:00.000Z" })).status).toBe(409);
    expect((await post({ ...good, reason: "x" })).status).toBe(409);
    expect((await post({ ...good, actorId: "someone-else" })).status).toBe(400); // no actor from the body
    expect(await call(await post(good))).toMatchObject({ status: 200, body: { ok: true, amountSatang: 120000, amountSource: "CORRECTED" } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "bank_tx.amount_corrected", entityId: id } });
    expect(audit).toMatchObject({ actorId: admin.actorId, actorRole: "ADMIN" });
    expect(audit.detail).toMatchObject({ evidenceId: ev, before: { amountSatang: 100000, amountSource: "FIRST_USE" }, after: { amountSatang: 120000 } });
    // Never below what is applied.
    const low = await call(await post({ ...good, amount: 999, expectedVersion: await versionOf(id) }));
    expect(low).toMatchObject({ status: 409 });
    expect(JSON.stringify(low.body)).toMatch(/already fully recorded/);
  });

  it("marking reviewed: Admin only; clears the flag with a note, never touches the reference", async () => {
    const p = await payment("KBANK");
    const id = await txOf(p.id);
    const post = (b: unknown) => REVIEW(req(`/api/bank-transactions/${id}/review`, "POST", b), params(id));
    const body = { outcome: "NO_REFERENCE_ON_SLIP", note: "slip checked: no reference printed (example)", evidenceId: await evidence(), expectedVersion: await versionOf(id) };
    as(await user("OPERATOR"));
    expect((await post(body)).status).toBe(403);
    as(await user("ADMIN"));
    expect((await post({ ...body, outcome: "CONFIRMED_ON_SLIP" })).status).toBe(409); // a real reference is corrected on its record
    expect((await post(body)).status).toBe(200);
    expect(await prisma.bankTransaction.findUniqueOrThrow({ where: { id } })).toMatchObject({ reviewStatus: "OK", refRaw: "KBANK", refStatus: "PENDING_VERIFICATION" });
  });
});

describe("Issue advance: re-recording a reversed advance's transfer (wrong guide)", () => {
  const adv = (bankRef: string, actor: { actorId: string; actorRole: string }, over: Record<string, unknown> = {}) =>
    issueAdvance(prisma, { guideId: "G-931", advanceDate: "2099-03-09", amount: 1000, today: "2099-03-10", method: "bank", bankAccount: "sub-bank", bankRef, actor, ...over });

  it("refused without the Admin's hand-on; with it, the share goes to the new advance by name — once", async () => {
    const op = await user("OPERATOR"), admin = await user("ADMIN");
    const first = await adv("KB-2099-0701", op);
    if (!first.ok) throw new Error(JSON.stringify(first));
    await prisma.guideAdvance.update({ where: { id: first.advance.id }, data: { reversedAt: new Date(), reversalReason: "recorded against the wrong guide (example)" } });
    expect(await adv("KB-2099-0701", op)).toMatchObject({ ok: false, status: 409 });
    // An Operator cannot hand it on.
    expect(await adv("KB-2099-0701", op, { reuseReversed: { advanceId: first.advance.id, reason: "right guide now (example)" } })).toMatchObject({ ok: false, status: 409 });
    // A different reference is not the same money.
    expect(await adv("KB-2099-0799", admin, { reuseReversed: { advanceId: first.advance.id, reason: "right guide now (example)" } })).toMatchObject({ ok: false, status: 409 });
    const again = await adv("KB-2099-0701", admin, { reuseReversed: { advanceId: first.advance.id, reason: "right guide now (example)" } });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const release = await prisma.bankTransactionRelease.findFirstOrThrow();
    expect(release).toMatchObject({ kind: "REALLOCATION", targetTable: "GuideAdvance", targetId: again.ok ? again.advance.id : "" });
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: release.auditLogId! } })).toMatchObject({ action: "bank_tx.reallocated", actorId: admin.actorId });
    // Handed on once: neither a third advance nor a second hand-on can use it.
    expect(await adv("KB-2099-0701", op)).toMatchObject({ ok: false, status: 409 });
    expect(await adv("KB-2099-0701", admin, { reuseReversed: { advanceId: first.advance.id, reason: "again (example)" } })).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.guideAdvance.count()).toBe(2);
  });

  it("the new advance must name the same central transfer — the same reference on another company account is refused", async () => {
    const op = await user("OPERATOR"), admin = await user("ADMIN");
    vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify({ ...CONFIG, bankAccountKey: "ACC:1111111111" }));
    const first = await adv("KB-2099-0702", op);
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect((await prisma.bankTransaction.findFirstOrThrow()).accountKey).toBe("ACC:1111111111");
    await prisma.guideAdvance.update({ where: { id: first.advance.id }, data: { reversedAt: new Date(), reversalReason: "wrong guide (example)" } });
    // The configured bank is now another account: the same reference there is another transfer.
    vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify({ ...CONFIG, bankAccountKey: "ACC:2222222222" }));
    const r = await adv("KB-2099-0702", admin, { reuseReversed: { advanceId: first.advance.id, reason: "right guide now (example)" } });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(r)).toMatch(/another company account/);
    expect(await prisma.bankTransactionRelease.count()).toBe(0);
    expect(await prisma.guideAdvance.count()).toBe(1);
  });
});
