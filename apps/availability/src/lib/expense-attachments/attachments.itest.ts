import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Files behind Tour Expense rows, on a real database; Google Drive is a fake. All data invented.
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { attachmentsFor, mirrorAll, removeAttachment, uploadAttachment, type Actor, type DriveSaver } from "@/lib/expense-attachments/service";
import { computeTotals, type Expense } from "@/lib/jobsheet";

const G = "G-981";
const DATE = "2099-11-06";
const KEY = { guideId: G, date: DATE, slotIdx: 0 };
const pdf = (n: number) => new Uint8Array(Buffer.from(`%PDF-1.7\n% receipt ${n}\n`));
let guide: Actor, otherGuide: Actor, op: Actor, accountant: Actor;
let saved: { name: string; folderPath: string[] }[] = [];
let failNext = 0;
const drive: DriveSaver = {
  token: vi.fn(async () => "fake-refresh-token"),
  save: vi.fn(async (o) => {
    if (failNext > 0) { failNext--; throw new Error("drive-upload 503: {\"error\":\"secret-ish body\"}"); }
    saved.push({ name: o.name, folderPath: o.folderPath });
    const id = `file_${saved.length}_${o.name.slice(-12)}`;
    return { id, link: `https://drive.example/${id}`, folderId: "folder_receipts" };
  }),
};
const rows = async () => ((await prisma.jobSheet.findFirstOrThrow()).expenses as unknown as (Expense & { receiptFileId?: string; receiptUrl?: string })[]);
const up = (actor: Actor, n: number, over: Partial<Parameters<typeof uploadAttachment>[0]> = {}) =>
  uploadAttachment({ drive, actor, sheet: KEY, expenseIndex: 0, file: { bytes: pdf(n), mime: "application/pdf", name: `ticket-${n}.pdf` }, ...over });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  saved = []; failNext = 0;
  await seedGuide(G, { displayName: "Fon Example" });
  const g = await prisma.user.findFirstOrThrow({ where: { guideId: G } });
  await seedGuide("G-982", { displayName: "Other Example", email: "g982@example.test" });
  const g2 = await prisma.user.findFirstOrThrow({ where: { guideId: "G-982" } });
  const o = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  const a = await prisma.user.create({ data: { email: "acc@example.test", displayName: "Acc Example", role: "ACCOUNTANT", state: "ACTIVE" } });
  guide = { id: g.id, role: "GUIDE", guideId: G }; otherGuide = { id: g2.id, role: "GUIDE", guideId: "G-982" };
  op = { id: o.id, role: "OPERATOR" }; accountant = { id: a.id, role: "ACCOUNTANT" };
  await prisma.jobSheet.create({ data: { ref: "FOLK-BKK-20991106-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [] as never,
    expenses: [{ description: "Grand Palace ticket", price: 500, pax: 2, paidBy: "guide" }, { description: "Water", price: 10, pax: 3, paidBy: "guide", receiptUrl: "https://drive.example/legacy", receiptFileId: "legacy" }] as never } });
});

describe("who may attach", () => {
  it("the guide on their own job; files land in the job's own folder in its month", async () => {
    const r = await up(guide, 1);
    expect(r.ok).toBe(true);
    expect(saved[0].folderPath).toEqual(["Folkpaths Job Sheets", "2099", "11 November", "FOLK-BKK-20991106-01", "Receipts"]);
    expect(saved[0].name).toMatch(/^FOLK-BKK-20991106-01_r_[0-9a-f]{12}_\d{8}-\d{4}_[0-9a-f]{8}\.pdf$/);
  });
  it("not another guide, not an accountant — and nothing is sent to Drive", async () => {
    expect(await up(otherGuide, 1)).toMatchObject({ ok: false, status: 403 });
    expect(await up(accountant, 1)).toMatchObject({ ok: false, status: 403 });
    expect(saved).toHaveLength(0);
  });
  it("an accountant and the operator see the files; another guide sees none", async () => {
    await up(guide, 1);
    const sheet = await prisma.jobSheet.findFirstOrThrow();
    expect(Object.values(await attachmentsFor(prisma, sheet, accountant)).flat()).toHaveLength(1);
    expect(Object.values(await attachmentsFor(prisma, sheet, op)).flat()).toHaveLength(1);
    expect(await attachmentsFor(prisma, sheet, otherGuide)).toEqual({});
  });
});

describe("several files per row", () => {
  it("each is kept; the row gets a stable id and its first file as the receipt link", async () => {
    const a = await up(op, 1), b = await up(op, 2);
    expect(a.ok && b.ok).toBe(true);
    const [row] = await rows();
    expect(row.rowId).toMatch(/^r_[0-9a-f]{12}$/);
    expect(await prisma.expenseAttachment.count({ where: { expenseRowId: row.rowId, status: "UPLOADED" } })).toBe(2);
    expect(row.receiptFileId).toBe(a.ok ? a.attachment.driveFileId : "");
  });
  it("the same file twice on one job is refused and audited", async () => {
    await up(op, 1);
    const again = await up(op, 1, { expenseIndex: 1 });
    expect(again).toMatchObject({ ok: false, status: 409, error: "duplicate" });
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.attachment_duplicate" } })).toBe(1);
  });
  it("a receipt attached before files had a table still reads, and is not replaced", async () => {
    await up(op, 3, { expenseIndex: 1 });
    expect((await rows())[1]).toMatchObject({ receiptFileId: "legacy", receiptUrl: "https://drive.example/legacy" });
  });
});

describe("Drive failing", () => {
  it("is recorded as FAILED with no Google detail; the same file again is a retry", async () => {
    failNext = 1;
    const first = await up(guide, 1);
    expect(first).toMatchObject({ ok: false, status: 502, error: "drive-503" });
    const failed = await prisma.expenseAttachment.findFirstOrThrow();
    expect(failed).toMatchObject({ status: "FAILED", errorCode: "drive-503" });
    const audits = JSON.stringify(await prisma.auditLog.findMany());
    expect(audits).not.toContain("secret-ish");
    expect(audits).not.toContain("fake-refresh-token");
    const second = await up(guide, 1);
    expect(second).toMatchObject({ ok: true, retried: true });
    expect(await prisma.expenseAttachment.findFirstOrThrow()).toMatchObject({ id: failed.id, status: "UPLOADED", attempts: 2 });
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.attachment_retry" } })).toBe(1);
  });
});

describe("at the same time", () => {
  it("two files on two rows at once both land, and neither row loses the other's link", async () => {
    // Give both rows their ids first, as a saved sheet has.
    await up(op, 9); await up(op, 10, { expenseIndex: 1 });
    const [r0, r1] = await rows();
    const res = await Promise.all([up(op, 11, { rowId: r0.rowId, expenseIndex: null }), up(guide, 12, { rowId: r1.rowId, expenseIndex: null })]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await prisma.expenseAttachment.count({ where: { status: "UPLOADED" } })).toBe(4);
    const after = await rows();
    expect(after[0].receiptFileId).toBeTruthy();
    expect(after[1].receiptFileId).toBe("legacy");
  });
  it("saving an older copy of the sheet keeps the receipt link that arrived meanwhile", async () => {
    const before = await rows(); // what an open editor holds
    await up(op, 1);
    const sheet = await prisma.jobSheet.findFirstOrThrow();
    const withId = (await rows())[0].rowId;
    const stale = before.map((r, i) => (i === 0 ? { ...r, rowId: withId } : r));
    const mirrored = await mirrorAll(prisma, sheet.id, stale);
    expect(mirrored[0].receiptFileId).toBeTruthy();
  });
});

describe("removing", () => {
  it("keeps the Drive file, records who and why, and repoints the receipt link", async () => {
    const a = await up(guide, 1), b = await up(guide, 2);
    if (!a.ok || !b.ok) throw new Error("upload failed");
    expect(await removeAttachment({ actor: guide, id: a.attachment.id, reason: "" })).toMatchObject({ ok: false, error: "reason-required" });
    expect(await removeAttachment({ actor: otherGuide, id: a.attachment.id, reason: "not mine" })).toMatchObject({ ok: false, status: 403 });
    expect(await removeAttachment({ actor: guide, id: a.attachment.id, reason: "wrong photo" })).toEqual({ ok: true });
    expect(await prisma.expenseAttachment.findUniqueOrThrow({ where: { id: a.attachment.id } })).toMatchObject({ status: "REMOVED", removedById: guide.id, removeReason: "wrong photo", driveFileId: a.attachment.driveFileId });
    expect((await rows())[0].receiptFileId).toBe(b.attachment.driveFileId);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "jobsheet.attachment_removed" } });
    expect(log.detail).toMatchObject({ driveFileKept: true, reason: "wrong photo" });
  });
  it("a guide cannot remove once the job is approved; the operator can", async () => {
    const a = await up(guide, 1);
    if (!a.ok) throw new Error("upload failed");
    await prisma.jobSheet.updateMany({ data: { approvalStatus: "APPROVED" } });
    expect(await removeAttachment({ actor: guide, id: a.attachment.id, reason: "wrong photo" })).toMatchObject({ ok: false, status: 403 });
    expect(await removeAttachment({ actor: op, id: a.attachment.id, reason: "wrong photo" })).toEqual({ ok: true });
  });
});

describe("money", () => {
  it("attaching changes no amount on the sheet and writes nothing to PEAK", async () => {
    const before = await rows();
    const peakBefore = await prisma.auditLog.count({ where: { action: { startsWith: "peak" } } });
    await up(guide, 1); await up(op, 2, { expenseIndex: 1 });
    const after = await rows();
    const fee = { price: 1000, time: 1, whtPct: 3 };
    expect(computeTotals(after, fee as never)).toEqual(computeTotals(before, fee as never));
    expect(after.map((r) => [r.description, r.price, r.pax, r.paidBy])).toEqual(before.map((r) => [r.description, r.price, r.pax, r.paidBy]));
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "peak" } } })).toBe(peakBefore);
  });
});
