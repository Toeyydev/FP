import { vi, describe, it, expect, beforeEach } from "vitest";

// Renders the Google Doc exactly as saveJobSheetToDrive builds it; only the database and
// the Drive upload are mocked. All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  tour: { findUnique: vi.fn() },
  guideAdvance: { findMany: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn() },
  guideAdvanceEntry: { findMany: vi.fn(async () => []) },
  guideAdvanceReceipt: { findMany: vi.fn(async () => []) },
}));
const saveHtml = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: async () => "refresh-token", saveHtmlToDrive: saveHtml }));

import { saveJobSheetToDrive } from "./jobsheet-drive";

const ROWS = [
  { description: "Row blank", price: 10, pax: 2, expenseType: "meal" },                          // no Paid By
  { description: "Row unknown", price: 20, pax: 1, expenseType: "transport", paidBy: "cash" },    // unrecognised
  { description: "Row guide", price: 30, pax: 1, expenseType: "transport", paidBy: "guide" },
  { description: "Row company", price: 40, pax: 1, expenseType: "entrance", paidBy: "company" },
  { description: "Row advance", price: 50, pax: 1, expenseType: "meal", paidBy: "advance" },
];

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: ROWS, guideFee: { price: 1200, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z"), certifiedAt: null });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.user.findUnique.mockResolvedValue({ fullName: "Guide A", displayName: "Guide A" });
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Test Tour", time: "08:30" });
  prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  saveHtml.mockResolvedValue({ id: "doc-1", link: "https://docs.example/doc-1" });
});

const paidByCell = (html: string, description: string) => {
  const row = html.split("<tr>").find((r) => r.includes(`<td>${description}</td>`))!;
  return row.match(/<td>([^<]*)<\/td><td style="text-align:right">/)![1];
};

describe("the Google Doc in Drive names who paid each expense", () => {
  it("shows 'not specified' for a blank or unrecognised Paid By, and keeps the known labels", async () => {
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBe("https://docs.example/doc-1");
    const { html } = saveHtml.mock.calls[0][0];
    expect(paidByCell(html, "Row blank")).toBe("Not specified / ยังไม่ระบุผู้จ่าย");
    expect(paidByCell(html, "Row unknown")).toBe("Not specified / ยังไม่ระบุผู้จ่าย");
    expect(paidByCell(html, "Row guide")).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย");
    expect(paidByCell(html, "Row company")).toBe("Company Direct / บริษัทชำระโดยตรง");
    expect(paidByCell(html, "Row advance")).toBe("Guide Advance / ชำระจากเงินทดรองจ่าย");
    expect(html.match(/Company Direct/g)).toHaveLength(1); // only the row the company actually paid
  });

  it("does not change any figure: reimbursement is still only the guide-paid row", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    const { html } = saveHtml.mock.calls[0][0];
    expect(html).toMatch(/Reimbursement Due[\s\S]*?฿30\.00/);
  });
});
