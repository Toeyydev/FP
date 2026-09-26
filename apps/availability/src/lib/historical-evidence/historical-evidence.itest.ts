import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// The historical evidence campaign against a real database, through its own routes.
//
// What is being proved is mostly what does NOT happen: a page load writes nothing and
// calls nothing outside; a non-admin gets nothing; a browser cannot name the decider, the
// recorder or the time; a stale view cannot decide; a payer is found by what the row says,
// never where it sits; and a certificate is prepared only through the service that has
// always prepared them.
//
// All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
// Nothing in this feature may reach Drive. If anything tries, it fails loudly here.
vi.mock("@/lib/google-drive", async (orig) => {
  const real = await orig<typeof import("@/lib/google-drive")>();
  const boom = () => { throw new Error("Drive was called"); };
  return { ...real, folkpathsDriveToken: vi.fn(boom), saveHtmlToDrive: vi.fn(boom), saveBufferToDrive: vi.fn(boom), downloadDriveFile: vi.fn(boom) };
});

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { GET as listGET } from "@/app/api/admin/historical-evidence/route";
import { GET as jobGET, POST as jobPOST } from "@/app/api/admin/historical-evidence/[id]/route";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { attachEnabled } from "@/lib/certificates/peak-attach";

const GUIDE = "G-900";
const DATE = "2026-08-01";
type Row = Record<string, unknown>;
const e = (description: string, price: number | null, pax: number | null, over: Row = {}): Row =>
  ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

let admin: { id: string };
const as = (id: string | null, role: string | null) => authMock.auth.mockResolvedValue(id ? { user: { id, role, name: "Session Name From Cookie" } } : null);

async function seedSheet(expenses: Row[], over: Partial<{ slotIdx: number; date: string; approvalStatus: string | null; ref: string; guideExpenses: Row[] | null; guideExpensesAt: Date | null }> = {}) {
  return prisma.jobSheet.create({
    data: {
      ref: over.ref ?? `FOLK-TEST-${(over.date ?? DATE).replace(/-/g, "")}-0${(over.slotIdx ?? 0) + 1}`,
      guideId: GUIDE, date: over.date ?? DATE, slotIdx: over.slotIdx ?? 0, tourId: "T-900",
      expenses: expenses as never, approvalStatus: over.approvalStatus === undefined ? "APPROVED" : over.approvalStatus,
      guideExpenses: (over.guideExpenses ?? undefined) as never, guideExpensesAt: over.guideExpensesAt ?? null,
    },
  });
}

const req = (url: string, body?: unknown) => new NextRequest(`http://test.local${url}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function list() { const r = await listGET(); return { status: r.status, body: await r.json() }; }
async function job(id: string) { const r = await jobGET(req(`/api/admin/historical-evidence/${id}`), params(id)); return { status: r.status, body: await r.json() }; }
async function act(id: string, body: unknown) { const r = await jobPOST(req(`/api/admin/historical-evidence/${id}`, body), params(id)); return { status: r.status, body: await r.json() }; }

async function counts() {
  const [audits, reviews, certs, sheets] = await Promise.all([
    prisma.auditLog.count(), prisma.historicalEvidenceReview.count(), prisma.expenseCertificate.count(),
    prisma.jobSheet.findMany({ select: { id: true, updatedAt: true, expenses: true }, orderBy: { id: "asc" } }),
  ]);
  return { audits, reviews, certs, sheets: JSON.stringify(sheets) };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(GUIDE, { displayName: "Nok Example" });
  admin = await prisma.user.create({ data: { email: "admin@example.test", displayName: "Malee Testsuite", fullName: "Malee Testsuite", role: "ADMIN", state: "ACTIVE" } });
  as(admin.id, "ADMIN");
  // Every outbound call — PEAK, Google, anything. None is allowed.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network was called"); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); });

describe("who may use it", () => {
  it("GUIDE, OPERATOR and ACCOUNTANT get 403 from every endpoint; nobody signed in gets 401", async () => {
    const s = await seedSheet([]);
    for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
      const u = await prisma.user.create({ data: { email: `${role.toLowerCase()}@example.test`, displayName: `Test ${role}`, role: role as never, state: "ACTIVE", ...(role === "GUIDE" ? { guideId: `G-${role}` } : {}) } });
      as(u.id, role);
      expect((await list()).status, role).toBe(403);
      expect((await job(s.id)).status, role).toBe(403);
      expect((await act(s.id, { action: "not_required", snapshotHash: "0".repeat(64), reviewVersion: 0, reasonCode: "NO_EXPENSES" })).status, role).toBe(403);
    }
    as(null, null);
    expect((await list()).status).toBe(401);
    expect(await prisma.historicalEvidenceReview.count()).toBe(0);
  });

  it("a session that still says ADMIN after the role was taken away is refused", async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { role: "OPERATOR" } });
    as(admin.id, "ADMIN");
    expect((await list()).status).toBe(403);
  });
});

describe("reading changes nothing", () => {
  it("list and detail write no row, no audit, touch no sheet, call no Drive or PEAK", async () => {
    const s = await seedSheet([e("Ferry", 15, 2, { paidBy: undefined, paidBySource: undefined })]);
    await seedSheet([], { slotIdx: 1 });
    const before = await counts();
    const l = await list();
    expect(l.status).toBe(200);
    expect(l.body.summary.total).toBe(2);
    const d = await job(s.id);
    expect(d.status).toBe(200);
    expect(d.body.job.classification.rows[0].suggestion).toBe("GUIDE_PERSONAL");
    expect(await counts()).toEqual(before);
    // A non-admin read is refused without writing, too.
    const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Test Operator", role: "OPERATOR", state: "ACTIVE" } });
    as(op.id, "OPERATOR");
    await list();
    const afterOp = await counts();
    expect(afterOp.audits).toBe(before.audits + 0);
  });

  it("only jobs before 2026-09-26 are in the campaign", async () => {
    await seedSheet([], { date: "2026-09-25", slotIdx: 0 });
    const onCutoff = await seedSheet([], { date: "2026-09-26", slotIdx: 1 });
    await seedSheet([], { date: "2026-10-01", slotIdx: 2 });
    const l = await list();
    expect(l.body.jobs.map((j: { date: string }) => j.date)).toEqual(["2026-09-25"]);
    expect((await job(onCutoff.id)).status).toBe(404);
  });

  it("the auto-attachment switch is still off", () => {
    expect(attachEnabled()).toBe(false);
  });
});

describe("NOT REQUIRED is an admin's decision about one version of the sheet", () => {
  it("records who, from the session and the database — not from the body — and audits it", async () => {
    const s = await seedSheet([]);
    const { body } = await job(s.id);
    const c = body.job.classification;
    expect(c.status).toBe("NOT_REQUIRED");
    expect(c.completed).toBe(false);
    const r = await act(s.id, { action: "not_required", snapshotHash: c.snapshotHash, reviewVersion: 0, reasonCode: "NO_EXPENSES", note: "ไม่มีค่าใช้จ่ายในงานนี้" });
    expect(r.status).toBe(200);
    const row = await prisma.historicalEvidenceReview.findUniqueOrThrow({ where: { jobSheetId: s.id } });
    expect(row).toMatchObject({ decision: "NOT_REQUIRED", reasonCode: "NO_EXPENSES", decidedById: admin.id, decidedByName: "Malee Testsuite", decidedByRole: "ADMIN", snapshotHash: c.snapshotHash, campaign: "2026-09-26" });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "historical_evidence.not_required" } });
    expect(a.actorId).toBe(admin.id);
    expect((await job(s.id)).body.job.classification.completed).toBe(true);
  });

  it("a body that tries to name the decider, the time, the role or the source is refused outright", async () => {
    const s = await seedSheet([]);
    const h = (await job(s.id)).body.job.classification.snapshotHash;
    for (const forged of [{ decidedById: "u_other" }, { decidedByName: "Somebody Else" }, { decidedAt: "2026-01-01T00:00:00.000Z" }, { role: "ADMIN" }, { decidedByRole: "ADMIN" }, { recordedBy: { id: "x" } }, { certifiedAt: "2026-01-01" }]) {
      const r = await act(s.id, { action: "not_required", snapshotHash: h, reviewVersion: 0, reasonCode: "NO_EXPENSES", ...forged });
      expect(r.status, JSON.stringify(forged)).toBe(400);
    }
    const p = await act(s.id, { action: "prepare_certificate", snapshotHash: h, source: "GUIDE_REPORTED", recordedByName: "Forged", guideReportedAt: "2026-08-01T00:00:00.000Z" });
    expect(p.status).toBe(400);
    expect(await prisma.historicalEvidenceReview.count()).toBe(0);
  });

  it("refuses a job the data says DOES need a certificate", async () => {
    const s = await seedSheet([e("Ferry", 15, 2)]);
    const h = (await job(s.id)).body.job.classification.snapshotHash;
    const r = await act(s.id, { action: "not_required", snapshotHash: h, reviewVersion: 0, reasonCode: "OTHER", note: "ไม่ต้องใช้แน่นอน เชื่อผมเถอะ" });
    expect(r.status).toBe(409);
    expect(await prisma.historicalEvidenceReview.count()).toBe(0);
  });

  it("a sheet changed after the decision reopens to NEEDS REVIEW, and the next decision records why", async () => {
    const s = await seedSheet([e("Lunch", 120, 3, { expenseType: "meal", paidBy: "company" })]);
    const h = (await job(s.id)).body.job.classification.snapshotHash;
    expect((await act(s.id, { action: "not_required", snapshotHash: h, reviewVersion: 0, reasonCode: "COMPANY_DIRECT" })).status).toBe(200);
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: [e("Lunch", 120, 4, { expenseType: "meal", paidBy: "company" })] as never } });
    const after = (await job(s.id)).body.job.classification;
    expect(after.reopened).toBe(true);
    expect(after.status).toBe("NEEDS_REVIEW");
    expect(after.completed).toBe(false);
    // Opening it wrote nothing; deciding again writes the reopening down.
    expect(await prisma.auditLog.count({ where: { action: "historical_evidence.reopened" } })).toBe(0);
    const again = await act(s.id, { action: "not_required", snapshotHash: after.snapshotHash, reviewVersion: 1, reasonCode: "COMPANY_DIRECT" });
    expect(again.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "historical_evidence.reopened" } })).toBe(1);
    expect((await job(s.id)).body.job.classification.completed).toBe(true);
  });

  it("two admins deciding at once: one wins, the other changes nothing", async () => {
    const s = await seedSheet([]);
    const h = (await job(s.id)).body.job.classification.snapshotHash;
    const [a, b] = await Promise.all([
      act(s.id, { action: "not_required", snapshotHash: h, reviewVersion: 0, reasonCode: "NO_EXPENSES" }),
      act(s.id, { action: "reviewed", snapshotHash: h, reviewVersion: 0, note: "ตรวจแล้วไม่มีค่าใช้จ่าย" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await prisma.historicalEvidenceReview.findUniqueOrThrow({ where: { jobSheetId: s.id } });
    expect(row.version).toBe(1);
  });

  it("a decision against an old view of the sheet is refused", async () => {
    const s = await seedSheet([]);
    const h = (await job(s.id)).body.job.classification.snapshotHash;
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: [e("Lunch", 120, 3, { expenseType: "meal", paidBy: "company" })] as never } });
    expect((await act(s.id, { action: "not_required", snapshotHash: h, reviewVersion: 0, reasonCode: "NO_EXPENSES" })).status).toBe(409);
    expect(await prisma.historicalEvidenceReview.count()).toBe(0);
  });
});

describe("confirming who paid", () => {
  it("a suggestion is not saved by being looked at; confirming stamps this admin, on this row, found by what it says", async () => {
    // The row to confirm is SECOND; another sits first. Position must not matter.
    const rows = [e("Lunch", 120, 3, { expenseType: "meal", paidBy: "company" }), e("Bus", 15, 3, { paidBy: undefined, paidBySource: undefined })];
    const s = await seedSheet(rows);
    const d = (await job(s.id)).body.job.classification;
    const bus = d.rows.find((r: { description: string }) => r.description === "Bus");
    expect(bus.suggestion).toBe("GUIDE_PERSONAL");
    expect(((await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[])[1].paidBy).toBeUndefined();

    const r = await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: bus.identity, payer: "GUIDE_PERSONAL" }] });
    expect(r.status).toBe(200);
    const saved = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[];
    expect(saved[0]).toEqual(rows[0]); // untouched
    expect(saved[1]).toMatchObject({ description: "Bus", paidBy: "guide", paidBySource: "operator", paidByBy: admin.id });
    expect(typeof saved[1].paidByAt).toBe("string");
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "historical_evidence.payer_confirmed" } });
    expect(JSON.stringify(a.detail)).toContain("BUSINESS_RULE");
  });

  it("an index, a stale identity, or a row that reads like another is refused", async () => {
    const s = await seedSheet([e("Water", 10, 2, { expenseType: "meal", paidBy: undefined, paidBySource: undefined }), e("Water", 10, 2, { expenseType: "meal", paidBy: undefined, paidBySource: undefined })]);
    const d = (await job(s.id)).body.job.classification;
    const dup = await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: d.rows[0].identity, payer: "COMPANY_DIRECT" }] });
    expect(dup.status).toBe(409);
    const byIndex = await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ index: 0, payer: "COMPANY_DIRECT" }] });
    expect(byIndex.status).toBe(400);
    const unknown = await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: "Nope|1|1||", payer: "COMPANY_DIRECT" }] });
    expect(unknown.status).toBe(409);
    const saved = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[];
    expect(saved.every((r) => r.paidBy === undefined)).toBe(true);
  });

  it("a meal from an advance is refused; overriding the category rule needs a reason", async () => {
    const s = await seedSheet([e("Water", 10, 2, { expenseType: "meal", paidBy: undefined, paidBySource: undefined }), e("Temple", 100, 2, { expenseType: "entrance", paidBy: undefined, paidBySource: undefined })]);
    const d = (await job(s.id)).body.job.classification;
    const water = d.rows[0].identity, temple = d.rows[1].identity;
    expect((await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: water, payer: "GUIDE_ADVANCE" }] })).status).toBe(409);
    expect((await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: temple, payer: "GUIDE_PERSONAL" }] })).status).toBe(400);
    expect((await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: temple, payer: "GUIDE_PERSONAL", reason: "counter was cash only" }] })).status).toBe(200);
  });
});

describe("preparing a certificate goes through the certificate service, and stops at a draft", () => {
  it("READY job → READY_TO_ATTEST certificate from createCertificate, audited by the service; nothing attested, filed or linked", async () => {
    const s = await seedSheet([e("Ferry", 15, 2)]);
    const d = (await job(s.id)).body.job.classification;
    expect(d.status).toBe("READY_TO_ISSUE");
    expect(d.source.suggested).toBe("ADMIN_RECORDED");
    const guideReported = await act(s.id, { action: "prepare_certificate", snapshotHash: d.snapshotHash, source: "GUIDE_REPORTED" });
    expect(guideReported.status).toBe(409); // no report from the guide — never pretend there was

    const r = await act(s.id, { action: "prepare_certificate", snapshotHash: d.snapshotHash, source: "ADMIN_RECORDED" });
    expect(r.status).toBe(200);
    const cert = await prisma.expenseCertificate.findUniqueOrThrow({ where: { id: r.body.certificate.id } });
    expect(cert).toMatchObject({ status: "READY_TO_ATTEST", source: "ADMIN_RECORDED", recordedById: admin.id, recordedByName: "Malee Testsuite", attestedAt: null, driveFileId: null, linkedAt: null });
    expect(await prisma.auditLog.count({ where: { action: "certificate.created" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "certificate.rows_recorded_by_admin" } })).toBe(1);
    const after = (await job(s.id)).body.job.classification;
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.completed).toBe(false);
    // No waiver was written: a draft is not evidence.
    const saved = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[];
    expect(saved[0].evidenceWaiver).toBeUndefined();
  });

  it("a job that is not READY cannot be prepared", async () => {
    const s = await seedSheet([e("Ferry", 15, 2)], { approvalStatus: null });
    const d = (await job(s.id)).body.job.classification;
    expect(d.status).toBe("NEEDS_REVIEW");
    expect((await act(s.id, { action: "prepare_certificate", snapshotHash: d.snapshotHash, source: "ADMIN_RECORDED" })).status).toBe(409);
    expect(await prisma.expenseCertificate.count()).toBe(0);
  });
});

describe("an existing LINKED certificate", () => {
  it("counts as done from its real state, and nothing here changes it", async () => {
    const rows = [e("Ferry", 15, 2)];
    const s = await seedSheet(rows);
    const identity = financialIdentity(rows[0] as never);
    const cert = await prisma.expenseCertificate.create({ data: {
      certificateNo: "CERT-FOLK-TEST-20260801-01-01", jobSheetId: s.id, activeJobSheetId: s.id, guideId: GUIDE, jobRef: s.ref, tourDate: DATE, slotIdx: 0,
      status: "LINKED", payload: {} as never, payloadHash: "a".repeat(64), coveredRows: [{ index: 0, identity, description: "Ferry", pax: 2, price: 15, amountSatang: 3000, category: "transport" }] as never,
      totalSatang: 3000, source: "ADMIN_RECORDED", sourceSheetUpdatedAt: s.updatedAt, pdfHash: "b".repeat(64), driveFileId: "drive_existing", linkedAt: new Date("2026-09-20T00:00:00.000Z"),
    } });
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: [{ ...rows[0], evidenceWaiver: { by: admin.id, at: "2026-09-20T00:00:00.000Z", reason: "ใบรับรองแทนใบเสร็จ ทดสอบ", certificateId: cert.id, certificateNo: cert.certificateNo } }] as never } });
    const before = JSON.stringify(await prisma.expenseCertificate.findUniqueOrThrow({ where: { id: cert.id } }));
    const sheetBefore = JSON.stringify((await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses);

    const d = (await job(s.id)).body.job.classification;
    expect(d.status).toBe("LINKED");
    expect(d.completed).toBe(true);
    expect((await list()).body.summary.completed).toBe(1);

    expect((await act(s.id, { action: "not_required", snapshotHash: d.snapshotHash, reviewVersion: 0, reasonCode: "OTHER", note: "ลองบันทึกทับใบที่ link แล้ว" })).status).toBe(409);
    expect((await act(s.id, { action: "confirm_payers", snapshotHash: d.snapshotHash, rows: [{ identity: d.rows[0].identity, payer: "COMPANY_DIRECT" }] })).status).toBe(409);
    expect((await act(s.id, { action: "prepare_certificate", snapshotHash: d.snapshotHash, source: "ADMIN_RECORDED" })).status).toBe(409);

    expect(JSON.stringify(await prisma.expenseCertificate.findUniqueOrThrow({ where: { id: cert.id } }))).toBe(before);
    expect(JSON.stringify((await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses)).toBe(sheetBefore);
    expect(await prisma.peakAttachment.count()).toBe(0);
  });
});
