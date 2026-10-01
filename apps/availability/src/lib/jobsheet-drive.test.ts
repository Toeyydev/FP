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
import { tourCostBreakdown } from "@/lib/peak-sync";

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
    expect(paidByCell(html, "Row advance")).toBe("Guide Advance / ชำระจากเงินทดรองจ่าย · Suggested / รอยืนยัน"); // a meal payer nobody chose
    expect(html.match(/Company Direct/g)).toHaveLength(1); // only the row the company actually paid
  });

  it("Reimbursement Due is the figure Payments v2 transfers — not a raw sum of rows stored as 'guide'", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    const { html } = saveHtml.mock.calls[0][0];
    // Payments v2 (unchanged): local transport with no recognised payer is the guide's by the
    // category rule, so "Row unknown" (฿20) is owed with "Row guide" (฿30). The document now
    // says what the transfer pays; it used to print ฿30 while the payout paid ฿50.
    expect(tourCostBreakdown(ROWS as never, { price: 1200, time: 1, whtPct: 3 }).reimbursableToGuide).toBe(50);
    expect(html).toMatch(/Reimbursement Due[\s\S]*?<b>฿50\.00<\/b>/);
  });
});

describe("the Google Doc carries approval, not a certification", () => {
  const LEGACY = [/ข้าพเจ้าขอรับรอง/, /CERTIFIED BY/i, /approver-signature/, /data:image\/png/, /ผู้จัดทำ \/ ผู้รับรอง/];
  it("shows who approved and when, with no statement, signature or signature date", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: ROWS, guideFee: { price: 1200, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z"),
      approvalStatus: "APPROVED", approvedBy: "u_approver", approvedAt: new Date("2030-05-07T07:05:00Z"), certifiedAt: new Date("2030-05-06T10:00:00Z") });
    prismaMock.user.findUnique.mockImplementation(async (a: { where: { id?: string } }) =>
      a.where.id === "u_approver" ? { fullName: "Approver Example", displayName: "Approver Example", email: null } : { fullName: "Guide A", displayName: "Guide A" });
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    const { html } = saveHtml.mock.calls[0][0];
    expect(html).toContain("อนุมัติแล้ว");
    expect(html).toContain("Approver Example");
    expect(html).toContain("7 May 2030 14:05");
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });
});

// Owner policy 2026-10-01: every payer nobody confirmed — a Rate suggestion, the after-tour
// default, a meal payer nobody chose — is awaiting confirmation on the document too.
describe("the Google Doc states only confirmed payers as fact", () => {
  const MIX = [
    { description: "Water confirmed", price: 10, pax: 5, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },              // 50 confirmed
    { description: "Ferry by Rate", price: 11, pax: 5, expenseType: "transport", paidBy: "guide", paidBySource: "rate-default" },      // 55 suggested
    { description: "Bus after tour", price: 12, pax: 5, expenseType: "transport", paidBy: "guide", paidBySource: "default-after-tour" }, // 60 default
    { description: "Snack unchosen", price: 14, pax: 5, expenseType: "meal", paidBy: "guide" },                                         // 70 nobody chose
    { description: "Ticket by Rate", price: 500, pax: 2, expenseType: "entrance", paidBy: "company", paidBySource: "rate-default" },   // 1000 suggested
    { description: "Boat confirmed", price: 100, pax: 1, expenseType: "transport", paidBy: "company", paidBySource: "operator", paidByReason: "company booked the boat (example)" },
  ];
  beforeEach(() => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: MIX, guideFee: { price: 1000, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z"), certifiedAt: null });
  });
  it("Reimbursement Due counts confirmed Guide Own Money only; the rest is shown apart as awaiting", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    const { html } = saveHtml.mock.calls[0][0];
    expect(html).toMatch(/Reimbursement Due[\s\S]*?<b>฿50\.00<\/b>/);
    expect(html).toMatch(/Awaiting payer confirmation[\s\S]*?รอยืนยันผู้ชำระ[\s\S]*?฿1,185\.00/);
    expect(html).not.toMatch(/฿235\.00/); // 50 + 55 + 60 + 70: the old raw total
    expect(html).toMatch(/Net Pay to Guide[\s\S]*?฿1,020\.00/); // 970 net fee + 50 — the payout figure
  });
  it("labels: suggestions and defaults read as suggested; confirmed payers stay definite", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    const { html } = saveHtml.mock.calls[0][0];
    expect(paidByCell(html, "Water confirmed")).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย");
    expect(paidByCell(html, "Boat confirmed")).toBe("Company Direct / บริษัทชำระโดยตรง");
    expect(paidByCell(html, "Ferry by Rate")).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย · Suggested / รอยืนยัน");
    expect(paidByCell(html, "Bus after tour")).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย · Suggested / รอยืนยัน");
    expect(paidByCell(html, "Snack unchosen")).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย · Suggested / รอยืนยัน");
    expect(paidByCell(html, "Ticket by Rate")).toBe("Company Direct / บริษัทชำระโดยตรง · Suggested / รอยืนยัน");
  });
  it("with nothing awaiting, the awaiting line is not printed", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: [MIX[0], MIX[5]], guideFee: { price: 1000, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z"), certifiedAt: null });
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    expect(saveHtml.mock.calls[0][0].html).not.toMatch(/Awaiting payer confirmation|Suggested \/ รอยืนยัน/);
  });
});
