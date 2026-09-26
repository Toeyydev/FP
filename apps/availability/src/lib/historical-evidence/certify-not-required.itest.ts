import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// A job the data calls NOT REQUIRED, taken on to a certificate by an admin — against a
// real database, through the campaign's own routes and the certificate service unchanged.
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
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network was called"); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); });

const oldWaiver = { evidenceWaiver: { by: "u_old_admin", at: "2026-08-03T00:00:00.000Z", reason: "ร้านริมทางไม่ออกใบเสร็จ ทดสอบ" } };
const stamped = { paidByBy: "u_ops", paidByAt: "2026-08-02T00:00:00.000Z" };
const water = () => e("Water", 10, 3, { ...stamped, ...oldWaiver });
const bus = () => e("Bus", 15, 3, { ...stamped, ...oldWaiver });
const idOf = (r: Row) => financialIdentity(r as never);
const detail = async (id: string) => (await job(id)).body.job.classification;

describe("a NOT REQUIRED job goes on to READY TO ISSUE once an admin chooses its rows", () => {
  it("select → READY_TO_ISSUE → a draft covering exactly those rows; stamped from the session, audited, no payer or amount changed", async () => {
    const s = await seedSheet([water(), bus(), e("Grand Palace", 500, 3, { expenseType: "entrance", paidBy: "advance", ...stamped })]);
    let c = await detail(s.id);
    expect(c.status).toBe("NOT_REQUIRED");
    expect(c.optInCount).toBe(2);

    const r = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(water()), certify: true }, { identity: idOf(bus()), certify: true }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.statusBefore).toBe("NOT_REQUIRED");
    expect(r.body.statusAfter).toBe("READY_TO_ISSUE");

    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[];
    const req0 = rows[0].certificateRequest as Row;
    expect(req0.by).toBe(admin.id);
    expect(req0.byName).toBe("Malee Testsuite");
    expect(req0.supersedesWaiver).toEqual(oldWaiver.evidenceWaiver);
    // Nothing else on any row moved.
    expect(rows.map(({ certificateRequest: _r, ...rest }) => rest)).toEqual([water(), bus(), e("Grand Palace", 500, 3, { expenseType: "entrance", paidBy: "advance", ...stamped })]);
    expect(rows[2].certificateRequest).toBeUndefined();

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "historical_evidence.certificate_rows_selected" } });
    expect(audit.actorId).toBe(admin.id);
    expect((audit.detail as Row).statusAfter).toBe("READY_TO_ISSUE");

    c = await detail(s.id);
    expect(c.status).toBe("READY_TO_ISSUE");
    expect(c.certifiable).toEqual({ count: 2, totalSatang: 7500 });
    const p = await act(s.id, { action: "prepare_certificate", snapshotHash: c.snapshotHash, source: "ADMIN_RECORDED" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const cert = await prisma.expenseCertificate.findUniqueOrThrow({ where: { id: p.body.certificate.id } });
    expect(cert.status).toBe("READY_TO_ATTEST");
    expect(cert.totalSatang).toBe(7500);
    expect((cert.coveredRows as Row[]).map((x) => x.identity)).toEqual([idOf(water()), idOf(bus())]);
    // Still a draft: no waiver moved, so both rows stay payable on their old waivers until LINK.
    const after = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[];
    expect(after[0].evidenceWaiver).toEqual(oldWaiver.evidenceWaiver);
  });

  it("taking a row back out is the same action, audited, and returns the job to NOT REQUIRED", async () => {
    const s = await seedSheet([water()]);
    const c = await detail(s.id);
    expect((await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(water()), certify: true }] })).status).toBe(200);
    const c2 = await detail(s.id);
    const w = await act(s.id, { action: "select_rows", snapshotHash: c2.snapshotHash, rows: [{ identity: idOf(water()), certify: false }] });
    expect(w.status).toBe(200);
    expect(w.body.statusAfter).toBe("NOT_REQUIRED");
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } })).expenses as Row[];
    expect(rows[0]).toEqual(water());
    expect(await prisma.auditLog.count({ where: { action: "historical_evidence.certificate_rows_withdrawn" } })).toBe(1);
  });

  it("a row with a receipt needs the receipt acknowledged, in the request, or nothing is written", async () => {
    const boat = e("Boat", 50, 2, { ...stamped, receiptUrl: "https://example.test/receipt-1.jpg" });
    const s = await seedSheet([boat]);
    const c = await detail(s.id);
    expect(c.rows[0].optIn).toBe("HAS_RECEIPT");
    const before = await counts();
    const no = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(boat), certify: true }] });
    expect(no.status).toBe(400);
    expect(no.body.reasons.join(" ")).toMatch(/ใบเสร็จแนบอยู่แล้ว/);
    expect(await counts()).toEqual(before);
    const yes = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(boat), certify: true, acknowledgeReceipt: true }] });
    expect(yes.status).toBe(200);
    expect(yes.body.statusAfter).toBe("READY_TO_ISSUE");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "historical_evidence.certificate_rows_selected" } });
    expect(((audit.detail as Row).rows as Row[])[0].receiptAcknowledged).toBe(true);
  });
});

describe("what is refused, with nothing written", () => {
  it("no rows / zero amount: nothing to select, and no certificate can be prepared", async () => {
    const blank = [e("Water", 10, null), e("Ferry", 11, null)];
    const s = await seedSheet(blank);
    const c = await detail(s.id);
    expect(c.status).toBe("NOT_REQUIRED");
    expect(c.certificatePath.join(" ")).toMatch(/ยอดศูนย์/);
    const before = await counts();
    const sel = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(blank[0]), certify: true }] });
    expect(sel.status).toBe(400);
    expect(sel.body.reasons.join(" ")).toMatch(/ยอดศูนย์/);
    const p = await act(s.id, { action: "prepare_certificate", snapshotHash: c.snapshotHash, source: "ADMIN_RECORDED" });
    expect(p.status).toBe(409);
    expect(await counts()).toEqual(before);
    expect(await prisma.expenseCertificate.count()).toBe(0);
  });

  it("a payer nobody confirmed: the row cannot be selected and no certificate is prepared", async () => {
    // The rules filled "guide" in; no person said so.
    const ferry = e("Ferry", 11, 4, { paidBySource: undefined, ...oldWaiver });
    const s = await seedSheet([ferry]);
    const c = await detail(s.id);
    expect(c.status).toBe("NEEDS_REVIEW");
    const before = await counts();
    const sel = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(ferry), certify: true }] });
    expect(sel.status).toBe(400);
    expect(sel.body.reasons.join(" ")).toMatch(/Paid By/);
    expect((await act(s.id, { action: "prepare_certificate", snapshotHash: c.snapshotHash, source: "ADMIN_RECORDED" })).status).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it("the sheet changed after the page was opened: refused, nothing written", async () => {
    const s = await seedSheet([water()]);
    const c = await detail(s.id);
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: [water(), e("Bus", 15, 1, stamped)] as never } });
    const before = await counts();
    const r = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(water()), certify: true }] });
    expect(r.status).toBe(409);
    expect(r.body.reasons.join(" ")).toMatch(/เปลี่ยนไปหลังจากที่เปิดดู/);
    expect(await counts()).toEqual(before);
  });

  it("GUIDE, OPERATOR and ACCOUNTANT get 403 and the sheet is untouched", async () => {
    const s = await seedSheet([water()]);
    const c = await detail(s.id);
    const before = (await counts()).sheets;
    for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
      const u = await prisma.user.create({ data: { email: `${role.toLowerCase()}@example.test`, displayName: `Test ${role}`, role: role as never, state: "ACTIVE", ...(role === "GUIDE" ? { guideId: `G-${role}` } : {}) } });
      as(u.id, role);
      expect((await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(water()), certify: true }] })).status, role).toBe(403);
    }
    expect((await counts()).sheets).toBe(before);
  });

  it("a body that tries to name who asked, or when, is refused", async () => {
    const s = await seedSheet([water()]);
    const c = await detail(s.id);
    for (const forged of [{ by: "u_x" }, { byName: "Someone" }, { at: "2026-01-01T00:00:00.000Z" }]) {
      const r = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity: idOf(water()), certify: true, ...forged }] });
      expect(r.status).toBe(400);
    }
    expect(await prisma.auditLog.count({ where: { action: "historical_evidence.certificate_rows_selected" } })).toBe(0);
  });

  it("a job whose certificate is already LINKED is never given a second one", async () => {
    const rows = [e("Ferry", 15, 2, stamped)];
    const s = await seedSheet(rows);
    const identity = idOf(rows[0]);
    const cert = await prisma.expenseCertificate.create({ data: {
      certificateNo: "CERT-FOLK-TEST-20260801-01-01", jobSheetId: s.id, activeJobSheetId: s.id, guideId: GUIDE, jobRef: s.ref, tourDate: DATE, slotIdx: 0,
      status: "LINKED", payload: {} as never, payloadHash: "a".repeat(64), coveredRows: [{ index: 0, identity, description: "Ferry", pax: 2, price: 15, amountSatang: 3000, category: "transport" }] as never,
      totalSatang: 3000, source: "ADMIN_RECORDED", sourceSheetUpdatedAt: s.updatedAt, pdfHash: "b".repeat(64), driveFileId: "drive_existing", linkedAt: new Date("2026-09-20T00:00:00.000Z"),
    } });
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: [{ ...rows[0], evidenceWaiver: { by: admin.id, at: "2026-09-20T00:00:00.000Z", reason: "ใบรับรองแทนใบเสร็จ ทดสอบ", certificateId: cert.id, certificateNo: cert.certificateNo } }] as never } });
    const c = await detail(s.id);
    expect(c.status).toBe("LINKED");
    expect(c.optInCount).toBe(0);
    const before = await counts();
    const sel = await act(s.id, { action: "select_rows", snapshotHash: c.snapshotHash, rows: [{ identity, certify: true }] });
    expect(sel.status).toBe(409);
    expect(sel.body.reasons.join(" ")).toMatch(/ไม่สร้างซ้ำ/);
    expect((await act(s.id, { action: "prepare_certificate", snapshotHash: c.snapshotHash, source: "ADMIN_RECORDED" })).status).toBe(409);
    expect(await counts()).toEqual(before);
    expect(await prisma.expenseCertificate.count()).toBe(1);
  });
});
