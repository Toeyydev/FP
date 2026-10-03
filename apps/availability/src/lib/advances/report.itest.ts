import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { advancesReportHtml, fileAdvancesReport, reportFileName, reportFolder } from "./report";

// The Company advances report: built from the ledger, filed in the month's Advances folder
// under one name a day, audited. All data invented.
beforeAll(requireTestDatabase);
beforeEach(async () => { await resetDatabase(); await seedGuide("G-990"); });

const adv = (no: string, satang: number, over: Record<string, unknown> = {}) => prisma.guideAdvance.create({ data: {
  guideId: "G-990", date: "2099-03-09", slotIdx: -1, amount: satang / 100, paidAt: new Date(), advanceNo: no, advanceDate: "2099-03-09",
  amountSatang: satang, accountingPeriod: "2099-03", jobNo: "FOLK-TEST-REPORT-01", ...over } });

describe("the Company advances report", () => {
  it("lists every advance with what guides still hold, and is filed once a day in the month's Advances folder", async () => {
    await adv("FOLK-ADV-209903-901", 100000);
    await adv("FOLK-ADV-209903-902", 50000, { reversedAt: new Date(), reversalReason: "wrong guide (example)" });
    const save = vi.fn(async () => ({ id: "drive-1", link: "https://drive.example.test/report" }));
    const render = vi.fn(async (html: string) => Buffer.from(html));
    const r = await fileAdvancesReport(prisma, { render, save, now: () => new Date("2099-03-10T03:00:00Z") }, { actorId: "u_op", actorRole: "OPERATOR" });
    expect(r).toMatchObject({ link: "https://drive.example.test/report", name: "Company advances 2099-03-10.pdf", advances: 1 });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: reportFileName("2099-03-10"), mimeType: "application/pdf", folderPath: reportFolder("2099-03-10") }));
    expect(reportFolder("2099-03-10")).toEqual(["Folkpaths Job Sheets", "2099-03 March", "Advances"]);
    const html = render.mock.calls[0][0];
    expect(html).toContain("FOLK-ADV-209903-901");
    expect(html).toContain("1 outstanding · ฿1,000.00 with guides");
    expect(html).toContain('class="rev"'); // the reversed one is shown struck through, and left out of the totals
    expect(await prisma.auditLog.count({ where: { action: "advances.report_filed" } })).toBe(1);
    expect(await prisma.guideAdvance.count()).toBe(2); // nothing written to the ledger
  });

  it("an empty ledger still makes a report that says so", () => {
    expect(advancesReportHtml([], "2099-03-10 10:00")).toContain("No advance has been recorded.");
  });
});
