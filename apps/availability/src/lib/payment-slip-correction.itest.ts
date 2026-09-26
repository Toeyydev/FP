import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Taking a slip off the job it was wrongly attached to — against a real database.
//
// What is proved: only the named row moves, and only if it is still exactly what was
// investigated; the rightful guide's row is untouched to the byte; only this guide's unread
// notices linking that slip are withdrawn; the audit row carries the previous values and
// commits with the change; the Drive file is renamed in place and never deleted; and nobody
// but an ADMIN gets anywhere.
//
// All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/google-drive", async (orig) => ({ ...(await orig<typeof import("@/lib/google-drive")>()), folkpathsDriveToken: vi.fn(async () => "refresh-test") }));
vi.mock("@/lib/google-calendar", async (orig) => ({ ...(await orig<typeof import("@/lib/google-calendar")>()), googleAccessToken: vi.fn(async () => "access-test") }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { detachMisattributedSlip, planSlipDetach, retrySlipRename, SlipCorrectionRefused, type CorrectionInput, type DriveOps } from "@/lib/payment-slip-correction";
import { GET, POST } from "@/app/api/admin/payment-corrections/detach-slip/route";

const DATE = "2026-07-15";
const WRONG_FILE = "fileWrongCopy0000000001";
const RIGHT_FILE = "fileRightful00000000002";
const OTHER_FILE = "fileSomethingElse000003";
const link = (id: string) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;
const MD5 = "0123456789abcdef0123456789abcdef";

let sick: { id: string }, rightful: { id: string }, admin: { id: string };
let wrongRow: { id: string }, rightRow: { id: string };

function fakeDrive(over: Partial<Record<string, { name: string; md5Checksum: string | null; trashed?: boolean }>> = {}) {
  const files: Record<string, { name: string; md5Checksum: string | null; trashed?: boolean }> = {
    [WRONG_FILE]: { name: "G-901 Nok Example — 2026-07-15 (1 tour) — abc — e-slip.pdf", md5Checksum: MD5 },
    [RIGHT_FILE]: { name: "G-902 Somchai Sample — 2026-07-15 (1 tour) — def — e-slip.pdf", md5Checksum: MD5 },
    [OTHER_FILE]: { name: "other.pdf", md5Checksum: "ffffffffffffffffffffffffffffffff" },
    ...over,
  };
  const calls = { renamed: [] as { id: string; name: string; description: string; committedFirst: boolean }[], failNext: 0 };
  const drive: DriveOps = {
    async meta(id) { const f = files[id]; return f ? { id, name: f.name, md5Checksum: f.md5Checksum, trashed: Boolean(f.trashed) } : null; },
    async rename(id, name, description) {
      // The correction must already be committed when Drive is touched.
      const committedFirst = (await prisma.auditLog.count({ where: { action: "pay.slip_detached" } })) > 0;
      if (calls.failNext > 0) { calls.failNext--; throw new Error("Drive rename failed: HTTP 500"); }
      calls.renamed.push({ id, name, description, committedFirst }); files[id] = { ...files[id], name };
      return { id, name, md5Checksum: files[id].md5Checksum, trashed: false };
    },
  };
  return { drive, calls, files };
}

const input = (over: Partial<CorrectionInput> = {}): CorrectionInput => ({
  guideId: "G-901", date: DATE, slotIdx: 2, tourPaymentId: wrongRow.id, driveFileId: WRONG_FILE,
  rightfulGuideId: "G-902", reason: "สลิปของ G-902 ถูกแนบผิดกับงานของ G-901 (ทดสอบ)", ...over,
});
const target = () => { const { reason: _r, ...t } = input(); return t; };
// The actor is whoever the database says they are; the name passed in is not trusted.
let actor: { id: string; name: string; role: string };

async function snapshot() {
  const [pays, notices, audits] = await Promise.all([
    prisma.tourPayment.findMany({ orderBy: { id: "asc" } }),
    prisma.notification.findMany({ orderBy: { id: "asc" } }),
    prisma.auditLog.count(),
  ]);
  return JSON.stringify({ pays, notices, audits });
}

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  await resetDatabase();
  sick = await seedGuide("G-901", { displayName: "Nok Example" });
  rightful = await prisma.user.create({ data: { email: "g902@example.test", displayName: "Somchai Sample", guideId: "G-902", role: "GUIDE", state: "ACTIVE" } });
  admin = await prisma.user.create({ data: { email: "admin@example.test", displayName: "Malee Testsuite", fullName: "Malee Testsuite", role: "ADMIN", state: "ACTIVE" } });
  actor = { id: admin.id, name: "Name The Caller Made Up", role: "ADMIN" };
  const paidAt = new Date("2026-08-20T07:07:11Z");
  wrongRow = await prisma.tourPayment.create({ data: { guideId: "G-901", date: DATE, slotIdx: 2, tourId: "T-900", status: "PAID", paidAt, approvedBy: admin.id, eslipUrl: link(WRONG_FILE) } });
  rightRow = await prisma.tourPayment.create({ data: { guideId: "G-902", date: DATE, slotIdx: 2, tourId: "T-900", status: "PAID", paidAt, approvedBy: admin.id, eslipUrl: link(RIGHT_FILE), peakRef: "EXP-20990700001" } });
  await prisma.notification.createMany({ data: [
    { userId: sick.id, kind: "job-change", message: `💸 Your payment has been transferred for 1 tour.\n\nBank slip: ${link(WRONG_FILE)}` },
    { userId: sick.id, kind: "job-change", message: `💸 older notice, already read — ${link(WRONG_FILE)}`, readAt: new Date("2026-08-21T00:00:00Z") },
    { userId: sick.id, kind: "job-change", message: "An unrelated unread notice" },
    { userId: rightful.id, kind: "job-change", message: `💸 Your payment has been transferred — ฿1,700.00.\n\nBank slip: ${link(RIGHT_FILE)}` },
  ] });
});

describe("the correction", () => {
  it("puts the row back to PENDING without the slip, withdraws only that unread notice, audits it, renames in place", async () => {
    const rightBefore = JSON.stringify(await prisma.tourPayment.findUniqueOrThrow({ where: { id: rightRow.id } }));
    const { drive, calls } = fakeDrive();
    const r = await detachMisattributedSlip(input(), actor, { drive, now: () => new Date("2026-09-27T03:00:00Z") });

    const row = await prisma.tourPayment.findUniqueOrThrow({ where: { id: wrongRow.id } });
    expect(row).toMatchObject({ status: "PENDING", paidAt: null, eslipUrl: null, approvedBy: null, peakRef: null });
    expect(JSON.stringify(await prisma.tourPayment.findUniqueOrThrow({ where: { id: rightRow.id } }))).toBe(rightBefore);

    const left = await prisma.notification.findMany({ orderBy: { createdAt: "asc" } });
    expect(left.map((n) => n.message)).toEqual([
      expect.stringContaining("older notice, already read"),
      "An unrelated unread notice",
      expect.stringContaining("฿1,700.00"),
    ]);
    expect(r.revokedNotificationIds).toHaveLength(1);

    const log = await prisma.auditLog.findUniqueOrThrow({ where: { id: r.auditId } });
    expect(log).toMatchObject({ action: "pay.slip_detached", actorId: admin.id, actorRole: "ADMIN", entityType: "TourPayment", entityId: wrongRow.id });
    const d = log.detail as Record<string, any>;
    expect(d.actorName).toBe("Malee Testsuite");
    expect(d.correctedAt).toBe("2026-09-27T03:00:00.000Z");
    expect(d.reason).toMatch(/แนบผิด/);
    expect(d.before).toEqual({ status: "PAID", paidAt: "2026-08-20T07:07:11.000Z", approvedBy: admin.id, approvedAt: null, eslipUrl: link(WRONG_FILE) });
    expect(d.after).toEqual({ status: "PENDING", paidAt: null, approvedBy: null, approvedAt: null, eslipUrl: null });
    expect(d.rightful).toMatchObject({ guideId: "G-902", tourPaymentId: rightRow.id, driveFileId: RIGHT_FILE, peakRef: "EXP-20990700001", unchanged: true });
    expect(d.revokedNotifications).toHaveLength(1);
    expect(d.drive).toMatchObject({ fileId: WRONG_FILE, kept: true, oldName: "G-901 Nok Example — 2026-07-15 (1 tour) — abc — e-slip.pdf" });

    expect(calls.renamed).toHaveLength(1);
    expect(calls.renamed[0].committedFirst).toBe(true);
    expect(calls.renamed[0].id).toBe(WRONG_FILE);
    expect(calls.renamed[0].name).toBe("G-902 — 2026-07-15 slot 2 — EXP-20990700001 — e-slip (เคยแนบผิดกับ G-901 · แก้ 2026-09-27).pdf");
    expect(calls.renamed[0].description).toContain("ชื่อเดิม: G-901 Nok Example");
    expect(calls.renamed[0].description).toContain("ห้ามลบ");
    const renamed = await prisma.auditLog.findFirstOrThrow({ where: { action: "drive.slip_renamed" } });
    expect(renamed.detail).toMatchObject({ fileId: WRONG_FILE, oldName: "G-901 Nok Example — 2026-07-15 (1 tour) — abc — e-slip.pdf", newName: calls.renamed[0].name, sameFileId: true, correctionAuditId: r.auditId });
    expect(r.drive).toMatchObject({ status: "RENAMED", fileId: WRONG_FILE, error: null, retry: null });
  });

  it("the plan reads only, and shows what the page will show", async () => {
    const before = await snapshot();
    const { drive, calls } = fakeDrive();
    const plan = await planSlipDetach(target(), { drive, now: () => new Date("2026-09-27T03:00:00Z") });
    expect(await snapshot()).toBe(before);
    expect(calls.renamed).toHaveLength(0);
    expect(plan.canApply).toBe(true);
    expect(plan.before.status).toBe("PAID");
    expect(plan.after).toEqual({ status: "PENDING", paidAt: null, approvedBy: null, approvedAt: null, eslipUrl: null });
    expect(plan.notices).toHaveLength(1);
    expect(plan.proof.sameBytes).toBe(true);
    expect(plan.drive).toEqual({ fileId: WRONG_FILE, oldName: "G-901 Nok Example — 2026-07-15 (1 tour) — abc — e-slip.pdf", newName: "G-902 — 2026-07-15 slot 2 — EXP-20990700001 — e-slip (เคยแนบผิดกับ G-901 · แก้ 2026-09-27).pdf" });
  });

  it("a failed rename leaves the correction in place, says how to retry, and the retry renames the same file exactly once", async () => {
    const { drive, calls } = fakeDrive();
    calls.failNext = 1;
    const r = await detachMisattributedSlip(input(), actor, { drive, now: () => new Date("2026-09-27T03:00:00Z") });
    expect(r.drive).toMatchObject({ status: "FAILED", error: "Drive rename failed: HTTP 500" });
    expect(r.drive.retry).toMatch(/ลองเปลี่ยนชื่อไฟล์อีกครั้ง/);
    expect((await prisma.tourPayment.findUniqueOrThrow({ where: { id: wrongRow.id } })).status).toBe("PENDING");
    expect(await prisma.auditLog.count({ where: { action: "drive.slip_rename_failed" } })).toBe(1);

    const again = await retrySlipRename(wrongRow.id, actor, { drive });
    expect(again).toMatchObject({ status: "RENAMED", fileId: WRONG_FILE, newName: r.drive.newName });
    expect(calls.renamed).toHaveLength(1);
    expect(calls.renamed[0].id).toBe(WRONG_FILE);
    const renamed = await prisma.auditLog.findFirstOrThrow({ where: { action: "drive.slip_renamed" } });
    expect(renamed.detail).toMatchObject({ retry: true, correctionAuditId: r.auditId, oldName: r.drive.oldName, newName: r.drive.newName });
    // Only one correction was ever written.
    expect(await prisma.auditLog.count({ where: { action: "pay.slip_detached" } })).toBe(1);

    const e = await retrySlipRename(wrongRow.id, actor, { drive }).catch((x) => x);
    expect(e).toBeInstanceOf(SlipCorrectionRefused);
    expect(calls.renamed).toHaveLength(1);
  });

  it("a retry finds the file already renamed and only records it", async () => {
    const { drive, calls, files } = fakeDrive();
    calls.failNext = 1;
    const r = await detachMisattributedSlip(input(), actor, { drive });
    files[WRONG_FILE] = { ...files[WRONG_FILE], name: r.drive.newName };
    expect((await retrySlipRename(wrongRow.id, actor, { drive })).status).toBe("ALREADY_RENAMED");
    expect(calls.renamed).toHaveLength(0);
  });

  it("a retry refuses to overwrite a name somebody set by hand", async () => {
    const { drive, calls, files } = fakeDrive();
    calls.failNext = 1;
    await detachMisattributedSlip(input(), actor, { drive });
    files[WRONG_FILE] = { ...files[WRONG_FILE], name: "renamed by a person.pdf" };
    const e = await retrySlipRename(wrongRow.id, actor, { drive }).catch((x) => x);
    expect((e as SlipCorrectionRefused).reasons[0]).toMatch(/ไม่เขียนทับ/);
    expect(calls.renamed).toHaveLength(0);
  });

  it("there is nothing to retry before a correction", async () => {
    const e = await retrySlipRename(wrongRow.id, actor, { drive: fakeDrive().drive }).catch((x) => x);
    expect((e as SlipCorrectionRefused).status).toBe(404);
  });
});

describe("only an ADMIN in the database can act — there is no system actor", () => {
  it("a SYSTEM actor, an unknown id and an OPERATOR are all refused, and nothing changes", async () => {
    const before = await snapshot();
    const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op", role: "OPERATOR", state: "ACTIVE" } });
    for (const who of [{ id: "system", name: "SYSTEM", role: "SYSTEM" }, { id: "", name: "x", role: "ADMIN" }, { id: op.id, name: "Op", role: "ADMIN" }]) {
      const e = await detachMisattributedSlip(input(), who, { drive: fakeDrive().drive }).catch((x) => x);
      expect(e).toBeInstanceOf(SlipCorrectionRefused);
      expect((e as SlipCorrectionRefused).status).toBe(403);
      const r = await retrySlipRename(wrongRow.id, who, { drive: fakeDrive().drive }).catch((x) => x);
      expect((r as SlipCorrectionRefused).status).toBe(403);
    }
    const after = JSON.parse(await snapshot());
    expect(after.pays).toEqual(JSON.parse(before).pays);
    expect(after.notices).toEqual(JSON.parse(before).notices);
  });
});

describe("refused, with nothing changed", () => {
  const refusedWith = async (fn: () => Promise<unknown>, status: number, pattern: RegExp) => {
    const before = await snapshot();
    const e = await fn().catch((x) => x);
    expect(e).toBeInstanceOf(SlipCorrectionRefused);
    expect((e as SlipCorrectionRefused).status).toBe(status);
    expect((e as SlipCorrectionRefused).reasons.join(" ")).toMatch(pattern);
    expect(await snapshot()).toBe(before);
  };

  it("a reason that is too short", async () => {
    await refusedWith(() => detachMisattributedSlip(input({ reason: "ผิด" }), actor, { drive: fakeDrive().drive }), 400, /เหตุผล/);
  });

  it("the row is not the one investigated", async () => {
    await refusedWith(() => detachMisattributedSlip(input({ tourPaymentId: "cmxxxxxxxxxxxxxxxxxxxxx" }), actor, { drive: fakeDrive().drive }), 409, /id ไม่ตรง/);
  });

  it("the slip on the row is a different file", async () => {
    await refusedWith(() => detachMisattributedSlip(input({ driveFileId: OTHER_FILE }), actor, { drive: fakeDrive().drive }), 409, /ไม่ใช่ไฟล์ที่ตรวจไว้/);
  });

  it("the row is no longer PAID", async () => {
    await prisma.tourPayment.update({ where: { id: wrongRow.id }, data: { status: "PENDING" } });
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, /PAID/);
  });

  it("the two slips are not the same bytes", async () => {
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive({ [RIGHT_FILE]: { name: "x", md5Checksum: "ffffffffffffffffffffffffffffffff" } }).drive }), 409, /md5/);
  });

  it("the rightful guide's row points at the same file — detaching would take their evidence", async () => {
    await prisma.tourPayment.update({ where: { id: rightRow.id }, data: { eslipUrl: link(WRONG_FILE) } });
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, /ไฟล์เดียวกัน/);
  });

  it("the row changed between the checks and the write", async () => {
    const { drive } = fakeDrive();
    const meta = drive.meta;
    drive.meta = async (id) => { await prisma.tourPayment.update({ where: { id: wrongRow.id }, data: { tourId: "T-901" } }); return meta(id); };
    const e = await detachMisattributedSlip(input(), actor, { drive }).catch((x) => x);
    expect(e).toBeInstanceOf(SlipCorrectionRefused);
    expect((e as SlipCorrectionRefused).reasons[0]).toMatch(/เปลี่ยนไประหว่างตรวจ/);
    const row = await prisma.tourPayment.findUniqueOrThrow({ where: { id: wrongRow.id } });
    expect(row.status).toBe("PAID");
    expect(row.eslipUrl).toBe(link(WRONG_FILE));
    expect(await prisma.notification.count()).toBe(4);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  for (const [what, data, pattern] of [
    ["a PEAK reference", { peakRef: "EXP-20990700009" }, /PEAK/],
    ["a combined PEAK payment", { peakPaymentRef: "FOLK-PAY-209907-01" }, /PEAK/],
    ["a Payments v2 payment", { guidePaymentId: "gp_test" }, /Payments v2/],
    ["a payment batch", { paidBatchNo: "FP-BATCH-TEST" }, /ชุดการจ่าย/],
  ] as const) {
    it(`the row carries ${what}`, async () => {
      await prisma.tourPayment.update({ where: { id: wrongRow.id }, data: data as never });
      await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, pattern);
    });
  }

  it("the job is in Payments v2", async () => {
    const gp = await prisma.guidePayment.create({ data: { paymentNo: "GP-TEST-1", guideId: "G-901", accountingPeriod: "2026-07", paymentDate: "2026-07-20", jobTotal: 0, adjustmentTotal: 0, amountTransferred: 0 } as never });
    await prisma.guidePaymentJob.create({ data: { paymentId: gp.id, guideId: "G-901", date: DATE, slotIdx: 2, jobNo: "FOLK-TEST-1", accountingDate: DATE, feeGross: 0, wht: 0, reimbursement: 0, reviewReward: 0, payable: 0, active: false } as never });
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, /Payments v2/);
  });

  it("the job is in a payment batch", async () => {
    const b = await prisma.paymentBatch.create({ data: { batchNo: "FP-BATCH-TEST", status: "DRAFT", totalAmount: 0 } as never });
    await prisma.paymentBatchItem.create({ data: { batchId: b.id, guideId: "G-901", date: DATE, slotIdx: 2, tourId: "T-900", guideFee: 0, reimbursement: 0, totalPayable: 0, paymentStatus: "PENDING" } as never });
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, /payment batch/);
  });

  it("the slip was recorded as bank evidence", async () => {
    await prisma.paymentEvidence.create({ data: { evidenceType: "SLIP", paymentProvider: "KBANK", googleDriveFileId: WRONG_FILE, fileHash: "h".repeat(64), processingStatus: "DONE" } as never });
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, /PaymentEvidence/);
  });

  it("the job sheet has a PEAK document", async () => {
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-20260715-01", guideId: "G-901", date: DATE, slotIdx: 2, tourId: "T-900", expenses: [] as never, peakDocumentNo: "EXP-20990700002" } });
    await refusedWith(() => detachMisattributedSlip(input(), actor, { drive: fakeDrive().drive }), 409, /PEAK/);
  });
});

describe("the route: ADMIN only, and the body never names the actor", () => {
  const as = (id: string | null, role: string | null) => authMock.auth.mockResolvedValue(id ? { user: { id, role } } : null);
  const call = async (body: unknown) => {
    const r = await POST(new NextRequest("http://test.local/api/admin/payment-corrections/detach-slip", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    return { status: r.status, body: await r.json() };
  };

  const get = async () => {
    const q = new URLSearchParams(Object.entries(target()).map(([k, v]) => [k, String(v)])).toString();
    const r = await GET(new NextRequest(`http://test.local/api/admin/payment-corrections/detach-slip?${q}`));
    return { status: r.status, body: await r.json() };
  };

  it("GUIDE, OPERATOR and ACCOUNTANT get 403, nobody signed in gets 401, a revoked ADMIN gets 403 — and nothing changes", async () => {
    const before = await snapshot();
    for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
      const u = await prisma.user.create({ data: { email: `${role.toLowerCase()}@example.test`, displayName: role, role: role as never, state: "ACTIVE" } });
      as(u.id, role);
      expect((await call({ action: "detach", ...input() })).status, role).toBe(403);
      expect((await call({ action: "retry_rename", tourPaymentId: wrongRow.id })).status, role).toBe(403);
      expect((await get()).status, role).toBe(403);
    }
    as(null, null);
    expect((await call({ action: "detach", ...input() })).status).toBe(401);
    expect((await get()).status).toBe(401);
    await prisma.user.update({ where: { id: admin.id }, data: { role: "OPERATOR" } });
    as(admin.id, "ADMIN");
    expect((await call({ action: "detach", ...input() })).status).toBe(403);
    expect((await get()).status).toBe(403);
    const after = JSON.parse(await snapshot());
    const was = JSON.parse(before);
    expect(after.pays).toEqual(was.pays);
    expect(after.notices).toEqual(was.notices);
  });

  it("a body that names the actor or the time is refused", async () => {
    as(admin.id, "ADMIN");
    for (const forged of [{ actorId: "u_x" }, { actorName: "Someone" }, { correctedAt: "2026-01-01T00:00:00Z" }]) {
      expect((await call({ action: "detach", ...input(), ...forged })).status).toBe(400);
    }
    expect((await prisma.tourPayment.findUniqueOrThrow({ where: { id: wrongRow.id } })).status).toBe("PAID");
  });

  it("an ADMIN runs it; the actor is the session's admin, read from the database", async () => {
    as(admin.id, "ADMIN");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      const id = u.includes(WRONG_FILE) ? WRONG_FILE : RIGHT_FILE;
      if (init?.method === "PATCH") return new Response(JSON.stringify({ id, name: JSON.parse(String(init.body)).name, md5Checksum: MD5 }), { status: 200 });
      return new Response(JSON.stringify({ id, name: `${id}.pdf`, md5Checksum: MD5, trashed: false }), { status: 200 });
    });
    try {
      const before = await snapshot();
      const g = await get();
      expect(g.status, JSON.stringify(g.body)).toBe(200);
      expect(g.body.plan.canApply).toBe(true);
      expect(g.body.correction).toBeNull();
      expect(await snapshot()).toBe(before);
      const r = await call({ action: "detach", ...input() });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.drive.status).toBe("RENAMED");
      const g2 = await get();
      expect(g2.body.correction).toMatchObject({ auditId: r.body.auditId, renamed: true });
      expect(fetchSpy.mock.calls.every(([u]) => String(u).startsWith("https://www.googleapis.com/drive/v3/files/"))).toBe(true);
      expect(fetchSpy.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    } finally { fetchSpy.mockRestore(); }
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "pay.slip_detached" } });
    expect(log.actorId).toBe(admin.id);
    expect((log.detail as Record<string, unknown>).actorName).toBe("Malee Testsuite");
  });
});
