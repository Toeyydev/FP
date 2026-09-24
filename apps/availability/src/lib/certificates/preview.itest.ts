import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Proving the draft preview changes nothing — by running it and looking, not by reading
// the source.
//
// A source scan says the words `prisma.create` do not appear. It cannot say that a
// transitive call did not write a row, that Drive was never reached, or that a job
// sheet's `updatedAt` did not move. Those are facts about a running system, and the only
// way to have them is to run it and compare before with after.
//
// The renderer here is the real one, so these also exercise the path that actually
// produces the bytes. Drive and the accounting client are mocked as COUNTERS rather than
// stubs: the assertion is that they were never called at all.
//
// All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

// Every way out to somebody else's computer, counted.
const drive = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/google-drive", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const count = (name: string) => (...args: unknown[]) => { drive.calls++; return (actual[name] as (...a: unknown[]) => unknown)(...args); };
  return { ...actual, folkpathsDriveToken: count("folkpathsDriveToken"), saveBufferToDrive: count("saveBufferToDrive"), downloadDriveFile: count("downloadDriveFile"), saveHtmlToDrive: count("saveHtmlToDrive") };
});
const peak = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/peak-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return new Proxy(actual, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => { peak.calls++; return (v as (...a: unknown[]) => unknown)(...args); };
    },
  });
});
// The real renderer, wrapped so the number of renders can be counted too.
const render = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/certificates/pdf", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    renderPdf: async (html: string) => { render.calls++; return (actual.renderPdf as (h: string) => Promise<Buffer>)(html); },
  };
});

import { prisma } from "@/lib/db";
import { NextRequest } from "next/server";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { pdfRendererAvailable } from "@/lib/certificates/pdf";
import { GET as draftGet } from "@/app/api/jobsheet/certificate/draft/route";

const GUIDE = "G-900";
const DATE = "2099-04-01";
const ADMIN = { id: "u_admin", name: "Anong Testsuite", role: "ADMIN" };

type Row = Record<string, unknown>;
const e = (description: string, price: number, over: Row = {}): Row =>
  ({ description, price, pax: 5, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

const url = (over: Record<string, string> = {}) =>
  new NextRequest(`https://ops.example.test/api/jobsheet/certificate/draft?${new URLSearchParams({ guideId: GUIDE, date: DATE, slotIdx: "0", ...over })}`);

async function seedSheet(expenses: Row[], guideExpensesAt: Date | null) {
  return prisma.jobSheet.create({
    data: {
      ref: "FOLK-TEST-20990401-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900",
      status: "Confirmed", approvalStatus: "APPROVED", guideExpensesAt,
      expenses: expenses as never, guideFee: { price: 1500, time: 1, whtPct: 3 },
    },
  });
}

/** Everything that must be identical afterwards. */
async function snapshot() {
  const [certificates, audits, sheets] = await Promise.all([
    prisma.expenseCertificate.count(),
    prisma.auditLog.count(),
    prisma.jobSheet.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { certificates, audits, sheets: JSON.stringify(sheets) };
}

const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

// A browser is needed for a real render. Skipping locally is fine; skipping in CI would
// be a green tick that meant nothing, so there it must run.
const ready = pdfRendererAvailable();
const describeRenderer = ready || process.env.CI ? describe : describe.skip;

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(GUIDE);
  drive.calls = 0; peak.calls = 0; render.calls = 0;
  authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: ADMIN.role } });
});

describeRenderer("the draft preview reads, and changes nothing", () => {
  const cases = [
    { name: "GUIDE_REPORTED", filed: new Date("2099-04-02T06:30:00.000Z"), source: "GUIDE_REPORTED" },
    { name: "ADMIN_RECORDED with no guide report", filed: null, source: "ADMIN_RECORDED" },
    { name: "ADMIN_RECORDED when the guide DID report", filed: new Date("2099-04-02T06:30:00.000Z"), source: "ADMIN_RECORDED" },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: returns a PDF and leaves the database untouched`, async () => {
      await seedSheet([e("Ferry", 11), e("Bus", 15)], c.filed);
      const before = await snapshot();

      const res = await draftGet(url({ source: c.source }));
      // The body is read ONCE, below. Reading it here for a failure message would
      // consume it and make the real assertion fail for the wrong reason.
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);

      // A PDF, inline, uncached.
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain("inline");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const pdf = Buffer.from(await res.arrayBuffer());
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");

      // Nothing was created, written, or reached for.
      const after = await snapshot();
      expect(after.certificates).toBe(before.certificates);
      expect(after.certificates).toBe(0);
      expect(after.audits).toBe(before.audits);
      // Every job-sheet field, including expenses and updatedAt, byte for byte.
      expect(after.sheets).toBe(before.sheets);
      expect(drive.calls, "Drive was called").toBe(0);
      expect(peak.calls, "the accounting client was called").toBe(0);
      expect(render.calls).toBe(1);

      // No waiver and no certificate id was written onto a row.
      const sheet = (await prisma.jobSheet.findFirst())!;
      const json = JSON.stringify(sheet.expenses);
      expect(json).not.toContain("evidenceWaiver");
      expect(json).not.toContain("certificateId");
    });
  }

  it("a two-page draft is still only a read, and is two pages", async () => {
    await seedSheet(Array.from({ length: 24 }, (_, i) => e(`รายการที่ ${i + 1}`, 11 + i)), null);
    const before = await snapshot();
    const res = await draftGet(url({ source: "ADMIN_RECORDED" }));
    expect(res.status).toBe(200);
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pages(pdf)).toBeGreaterThanOrEqual(2);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(drive.calls + peak.calls).toBe(0);
  });

  it("the draft names no attester and carries no audit reference", async () => {
    const sheet = await seedSheet([e("Ferry", 11)], null);
    const res = await draftGet(url({ source: "ADMIN_RECORDED" }));
    const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
    // The id would be the audit reference on a real document; a draft has none.
    expect(text).not.toContain(sheet.id);
    expect(await prisma.expenseCertificate.count()).toBe(0);
  });
});

describe("who may ask for one", () => {
  for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
    it(`a ${role} is refused before the renderer or anything external runs`, async () => {
      await seedSheet([e("Ferry", 11)], null);
      authMock.auth.mockResolvedValue({ user: { id: `u_${role}`, name: role, role } });
      const before = await snapshot();

      const res = await draftGet(url({ source: "ADMIN_RECORDED" }));
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");

      // The refusal came first: no render was started, nothing external was reached.
      expect(render.calls, "the renderer ran for a non-admin").toBe(0);
      expect(drive.calls + peak.calls).toBe(0);

      // Only the denial audit row is added; nothing else moved.
      const after = await snapshot();
      expect(after.certificates).toBe(before.certificates);
      expect(after.sheets).toBe(before.sheets);
      const denial = await prisma.auditLog.findFirst({ where: { action: "certificate.access_denied" } });
      expect(denial).toBeTruthy();
      expect(JSON.stringify(denial!.detail)).not.toContain("CERT-");
    });
  }

  it("an unreadable source is refused without rendering", async () => {
    await seedSheet([e("Ferry", 11)], null);
    const res = await draftGet(url({ source: "WHATEVER_I_LIKE" }));
    expect(res.status).toBe(400);
    expect(render.calls).toBe(0);
  });

  it("claiming the guide reported, when they did not, is refused without rendering", async () => {
    await seedSheet([e("Ferry", 11)], null);
    const res = await draftGet(url({ source: "GUIDE_REPORTED" }));
    expect(res.status).toBe(409);
    expect((await res.json()).reasons[0]).toContain("ไกด์ยังไม่ได้ส่งรายงาน");
    expect(render.calls).toBe(0);
  });

  it("a sheet with nothing to certify is refused in Thai, without rendering", async () => {
    await seedSheet([e("Van", 1200, { paidBy: "company" })], null);
    const res = await draftGet(url({ source: "ADMIN_RECORDED" }));
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("ไม่มีรายการใดในใบงานนี้");
    expect(render.calls).toBe(0);
  });

  it("rows that cannot be told apart are refused, without rendering", async () => {
    await seedSheet([e("Ferry", 11), e("Ferry", 11)], null);
    const res = await draftGet(url({ source: "ADMIN_RECORDED" }));
    expect(res.status).toBe(409);
    expect(render.calls).toBe(0);
  });
});
