import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/advances/voucher-issue", () => ({ issueVoucherFor: vi.fn(async () => null) }));

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { reportService, requireTestDatabase, resetDatabase, seedGuide, workerMatchesEnv } from "@/test/db";
import { issueAdvance } from "./service";
import { syncAdvanceBatch } from "./peak-sync";
import { recheckPosted, resolveUncertain, retrySync, syncHistory, type SentPayload } from "./peak-reconcile";
import type { DocumentLookup, PeakDocument } from "./peak-link";
import { POST as retryRoute } from "@/app/api/advances/peak-sync/[id]/retry/route";
import { POST as resolveRoute } from "@/app/api/advances/peak-sync/[id]/resolve/route";
import { POST as recheckRoute } from "@/app/api/advances/peak-sync/recheck/route";
import { GET as historyRoute } from "@/app/api/advances/peak-sync/[id]/history/route";

// Company ADV → PEAK reconciliation against a real database (owner 2026-11-15): the sender's
// outcomes and their history, Retry, Resolve (found / not in PEAK), the read-only re-check, races,
// and who may do what. PEAK itself is faked: `post` stands in for createDailyJournal and `lookup`
// for the read-only journal lookup. Every name, number and reference is invented.

const CONFIG = {
  advanceAccountCode: "111100", advanceAccountSubId: "sub-advance",
  bankName: "Company account", bankAccountCode: "111300", bankAccountSubId: "sub-bank",
  journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {},
};
const GUIDE = "G-980";
const ops = { actorId: "u_op", actorRole: "OPERATOR" };
const admin = { actorId: "u_admin", actorRole: "ADMIN" };

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify(CONFIG));
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
  await resetDatabase();
  await workerMatchesEnv();
  await reportService("FP", { autoSync: true, existingLinks: false });
});
afterEach(() => vi.unstubAllEnvs());

let n = 0;
async function advance(amount = 1500) {
  if (!n++ || !(await prisma.user.findUnique({ where: { guideId: GUIDE } }))) {
    await seedGuide(GUIDE);
    await prisma.user.update({ where: { guideId: GUIDE }, data: { peakContactId: "contact-1" } });
  }
  const ref = `TRXX9903${String(10000000 + Math.floor(Math.random() * 89999999))}`;
  const r = await issueAdvance(prisma, { guideId: GUIDE, advanceDate: "2099-03-09", amount, today: "2099-03-10", method: "bank", bankAccount: "sub-bank", actor: ops, bankRef: ref, jobNo: "FOLK-BKK-20990310-01", date: "2099-03-10", slotIdx: 0, slipUrl: "https://example.test/slip" });
  const id = (r as { advance: { id: string } }).advance.id;
  // The local test database's now() may run on local time; make the item due regardless.
  await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${id}` }, data: { nextAttemptAt: new Date(0) } });
  return { id, syncId: `ADVANCE:${id}` };
}
const item = (id: string) => prisma.advancePeakSync.findUniqueOrThrow({ where: { id } });
const due = (id: string) => prisma.advancePeakSync.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });

/** PEAK's copy of what FolkOPS sent, as the read API would return it. */
function docFrom(payload: SentPayload, code: string, over: Partial<PeakDocument> = {}): PeakDocument {
  return {
    code, id: `id-${code}`, documentType: "DAILY_JOURNAL", isVoid: false, contactId: payload.contactId ?? null, issuedDate: payload.issuedDate ?? null,
    entries: (payload.journalEntries ?? []).map((e) => ({ accountCode: e.accountCode, accountSubId: e.accountSubId ?? null, debit: Number(e.debit), credit: Number(e.credit) })),
    ...over,
  };
}
const lookupOf = (docs: Record<string, PeakDocument>): DocumentLookup => async (no) => (docs[no] ? { ok: true, document: docs[no] } : { ok: false, notFound: true, desc: "not found" });

describe("the sender's outcomes are kept as history", () => {
  it("a refused send is FAILED (BLOCKED) with an attempt in the history; Retry brings it back; the next batch posts once", async () => {
    const { syncId } = await advance();
    const refused = vi.fn(async () => ({ ok: false as const, desc: "PEAK refused: invalid contact" }));
    await syncAdvanceBatch(prisma, refused);
    expect(await item(syncId)).toMatchObject({ status: "BLOCKED", error: "PEAK refused: invalid contact" });
    expect((await syncHistory(prisma, syncId)).map((h) => h.detail)).toEqual([expect.objectContaining({ to: "BLOCKED", error: "PEAK refused: invalid contact" })]);

    expect(await retrySync(prisma, syncId, admin)).toEqual({ ok: true });
    expect(await item(syncId)).toMatchObject({ status: "PENDING" });
    await due(syncId);
    const ok = vi.fn(async () => ({ ok: true as const, id: "d-1", code: "JV-209903001" }));
    expect(await syncAdvanceBatch(prisma, ok)).toBe(1);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(await item(syncId)).toMatchObject({ status: "POSTED", documentNo: "JV-209903001" });
    const h = await syncHistory(prisma, syncId);
    expect(h.map((x) => x.action)).toEqual(["advance.peak.attempt", "advance.peak.retry", "advance.peak.attempt"]);
    expect(h[1].by).toBe("ADMIN");
  });

  it("an answer without a document number is UNCERTAIN and is never sent again by itself", async () => {
    const { syncId } = await advance();
    const unclear = vi.fn(async () => ({ ok: true as const, id: "", code: "" }));
    await syncAdvanceBatch(prisma, unclear);
    expect(await item(syncId)).toMatchObject({ status: "UNCERTAIN" });
    await due(syncId);
    await syncAdvanceBatch(prisma, unclear);
    expect(unclear).toHaveBeenCalledTimes(1);
  });

  it("two senders at once send it once", async () => {
    await advance();
    const post = vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: true as const, id: "d-2", code: "JV-209903002" }; });
    const [a, b] = await Promise.all([syncAdvanceBatch(prisma, post), syncAdvanceBatch(prisma, post)]);
    expect(a + b).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("Retry", () => {
  it("only a FAILED item; an UNCERTAIN or Synced one is refused", async () => {
    const { syncId } = await advance();
    await syncAdvanceBatch(prisma, async () => ({ ok: true as const, id: "", code: "" }));
    expect(await retrySync(prisma, syncId, admin)).toMatchObject({ ok: false, status: 409, reasons: [expect.stringMatching(/reconciliation, not a retry/)] });
    const b = await advance(700);
    await syncAdvanceBatch(prisma, async () => ({ ok: true as const, id: "d-3", code: "JV-209903003" }));
    expect(await retrySync(prisma, b.syncId, admin)).toMatchObject({ ok: false, status: 409 });
  });
  it("two retries at once: one wins, the other is told it changed", async () => {
    const { syncId } = await advance();
    await syncAdvanceBatch(prisma, async () => ({ ok: false as const, desc: "down" }));
    const results = await Promise.all([retrySync(prisma, syncId, admin), retrySync(prisma, syncId, admin)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("Resolve a journal that needs reconciliation", () => {
  async function uncertain(amount = 1500) {
    const a = await advance(amount);
    await syncAdvanceBatch(prisma, async () => ({ ok: true as const, id: "", code: "" }));
    const row = await item(a.syncId);
    expect(row.status).toBe("UNCERTAIN");
    return { ...a, payload: row.payload as SentPayload };
  }

  it("FOUND: PEAK's journal is exactly what was sent → Synced, the advance stamped, history kept", async () => {
    const { id, syncId, payload } = await uncertain();
    const r = await resolveUncertain(prisma, { id: syncId, outcome: "FOUND", documentNo: "jv-209903010", reason: "Found it in PEAK journal list", actor: admin }, lookupOf({ "JV-209903010": docFrom(payload, "JV-209903010") }));
    expect(r).toMatchObject({ ok: true, status: "POSTED", documentNo: "JV-209903010" });
    expect(await item(syncId)).toMatchObject({ status: "POSTED", documentNo: "JV-209903010", documentId: "id-JV-209903010" });
    expect(await prisma.guideAdvance.findUnique({ where: { id } })).toMatchObject({ peakDocumentNo: "JV-209903010", peakRef: "JV-209903010" });
    expect((await syncHistory(prisma, syncId)).at(-1)).toMatchObject({ action: "advance.peak.resolve", by: "ADMIN", detail: expect.objectContaining({ outcome: "FOUND", reason: "Found it in PEAK journal list" }) });
  });

  it("FOUND is refused when PEAK's journal differs (amount), is void, or is not there — nothing changes", async () => {
    const { syncId, payload } = await uncertain();
    const wrong = docFrom(payload, "JV-209903011", { entries: [{ accountCode: "111100", accountSubId: "sub-advance", debit: 1400, credit: 0 }, { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 1400 }] });
    const lookup = lookupOf({ "JV-209903011": wrong, "JV-209903012": docFrom(payload, "JV-209903012", { isVoid: true }) });
    const reason = "Checked PEAK journal list";
    expect(await resolveUncertain(prisma, { id: syncId, outcome: "FOUND", documentNo: "JV-209903011", reason, actor: admin }, lookup)).toMatchObject({ ok: false, status: 409 });
    expect(await resolveUncertain(prisma, { id: syncId, outcome: "FOUND", documentNo: "JV-209903012", reason, actor: admin }, lookup)).toMatchObject({ ok: false, status: 409 });
    expect(await resolveUncertain(prisma, { id: syncId, outcome: "FOUND", documentNo: "JV-209903099", reason, actor: admin }, lookup)).toMatchObject({ ok: false, status: 404 });
    expect(await item(syncId)).toMatchObject({ status: "UNCERTAIN", documentNo: null });
  });

  it("FOUND is refused for a journal another FolkOPS record already owns", async () => {
    const a = await advance(500);
    await syncAdvanceBatch(prisma, async () => ({ ok: true as const, id: "d-x", code: "JV-209903020" }));
    expect((await item(a.syncId)).status).toBe("POSTED");
    const { syncId, payload } = await uncertain(500);
    const r = await resolveUncertain(prisma, { id: syncId, outcome: "FOUND", documentNo: "JV-209903020", reason: "Looks like this one", actor: admin }, lookupOf({ "JV-209903020": docFrom(payload, "JV-209903020") }));
    expect(r).toMatchObject({ ok: false, status: 409, reasons: [expect.stringMatching(/already belongs/)] });
  });

  it("a reason is required", async () => {
    const { syncId } = await uncertain();
    expect(await resolveUncertain(prisma, { id: syncId, outcome: "NOT_IN_PEAK", reason: "no", actor: admin })).toMatchObject({ ok: false, status: 400 });
  });

  it("NOT_IN_PEAK: back to the sender, which then posts it once", async () => {
    const { syncId } = await uncertain();
    expect(await resolveUncertain(prisma, { id: syncId, outcome: "NOT_IN_PEAK", reason: "Searched PEAK for the amount and date, nothing", actor: admin })).toMatchObject({ ok: true, status: "PENDING" });
    await due(syncId);
    const post = vi.fn(async () => ({ ok: true as const, id: "d-4", code: "JV-209903004" }));
    await syncAdvanceBatch(prisma, post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await item(syncId)).toMatchObject({ status: "POSTED", documentNo: "JV-209903004" });
  });

  it("two people resolving at once: one wins", async () => {
    const { syncId, payload } = await uncertain();
    const lookup = lookupOf({ "JV-209903030": docFrom(payload, "JV-209903030") });
    const results = await Promise.all([
      resolveUncertain(prisma, { id: syncId, outcome: "FOUND", documentNo: "JV-209903030", reason: "Found it in PEAK", actor: admin }, lookup),
      resolveUncertain(prisma, { id: syncId, outcome: "NOT_IN_PEAK", reason: "Not found in PEAK", actor: admin }, lookup),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("only an UNCERTAIN item can be resolved", async () => {
    const { syncId } = await advance();
    expect(await resolveUncertain(prisma, { id: syncId, outcome: "NOT_IN_PEAK", reason: "Nothing in PEAK", actor: admin })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the read-only re-check", () => {
  it("flags a match, a mismatch and a journal PEAK no longer has — and writes nothing", async () => {
    const a = await advance(1000); const b = await advance(2000); const c = await advance(3000);
    let k = 0;
    await syncAdvanceBatch(prisma, async () => ({ ok: true as const, id: `d-${++k}`, code: `JV-20990304${k}` }));
    const rows = await prisma.advancePeakSync.findMany({ where: { id: { in: [a.syncId, b.syncId, c.syncId] } } });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    const docs: Record<string, PeakDocument> = {
      [by[a.syncId].documentNo!]: docFrom(by[a.syncId].payload as SentPayload, by[a.syncId].documentNo!),
      [by[b.syncId].documentNo!]: docFrom(by[b.syncId].payload as SentPayload, by[b.syncId].documentNo!, { isVoid: true }),
    };
    const before = (await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } })).map((r) => r.updatedAt.getTime());
    const out = await recheckPosted(prisma, lookupOf(docs));
    const res = Object.fromEntries(out.map((r) => [r.id, r.result]));
    expect(res).toEqual({ [a.syncId]: "MATCH", [b.syncId]: "MISMATCH", [c.syncId]: "NOT_FOUND" });
    expect((await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } })).map((r) => r.updatedAt.getTime())).toEqual(before);
  });
});

describe("who may do what (routes)", () => {
  const as = (role: string, guideId?: string) => authMock.auth.mockResolvedValue({ user: { id: `u_${role}`, role, guideId } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id: encodeURIComponent(id) }) });
  const req = (body?: unknown) => new Request("http://localhost/x", { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }) as unknown as NextRequest;

  it("OPERATOR and GUIDE are refused Retry, Resolve and Re-check; a GUIDE cannot read the history", async () => {
    const { syncId } = await advance();
    await syncAdvanceBatch(prisma, async () => ({ ok: false as const, desc: "down" }));
    for (const role of ["OPERATOR", "GUIDE"]) {
      as(role, role === "GUIDE" ? GUIDE : undefined);
      expect((await retryRoute(req(), ctx(syncId))).status).toBe(403);
      expect((await resolveRoute(req({ outcome: "NOT_IN_PEAK", reason: "trying it anyway" }), ctx(syncId))).status).toBe(403);
      expect((await recheckRoute()).status).toBe(403);
    }
    as("GUIDE", GUIDE);
    expect((await historyRoute(req(), ctx(syncId))).status).toBe(403);
    expect(await item(syncId)).toMatchObject({ status: "BLOCKED" });
  });

  it("the ACCOUNTANT can retry", async () => {
    const { syncId } = await advance();
    await syncAdvanceBatch(prisma, async () => ({ ok: false as const, desc: "down" }));
    as("ACCOUNTANT");
    expect((await retryRoute(req(), ctx(syncId))).status).toBe(200);
    expect(await item(syncId)).toMatchObject({ status: "PENDING" });
    expect((await syncHistory(prisma, syncId)).at(-1)).toMatchObject({ by: "ACCOUNTANT" });
  });
});
