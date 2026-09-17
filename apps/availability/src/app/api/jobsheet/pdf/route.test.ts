import { vi, describe, it, expect, beforeEach } from "vitest";

// Renders the printable job sheet (the page the Drive PDF is made from). Only auth, the
// database and decryption are mocked. All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  tour: { findUnique: vi.fn() },
  guideAdvance: { findMany: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn() },
  guideAdvanceEntry: { findMany: vi.fn(async () => []) },
  guideAdvanceReceipt: { findMany: vi.fn(async () => []) },
  booking: { findMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/crypto", () => ({ decrypt: () => "" }));

import { GET } from "./route";

const ROWS = [
  { description: "Row blank", price: 10, pax: 2, expenseType: "meal" },
  { description: "Row unknown", price: 20, pax: 1, expenseType: "transport", paidBy: "cash" },
  { description: "Row guide", price: 30, pax: 1, expenseType: "transport", paidBy: "guide" },
  { description: "Row company", price: 40, pax: 1, expenseType: "entrance", paidBy: "company" },
  { description: "Row advance", price: 50, pax: 1, expenseType: "meal", paidBy: "advance" },
];

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.user.findUnique.mockResolvedValue({ guideId: "G-TEST", fullName: "Guide A", displayName: "Guide A" });
  prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: ROWS, guideFee: { price: 1200, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z") });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.tour.findUnique.mockResolvedValue({ id: "T-001", name: "Test Tour" });
  prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  prismaMock.booking.findMany.mockResolvedValue([]);
});

const render = async () => {
  const url = "https://ops.folkpaths.com/api/jobsheet/pdf?guideId=G-TEST&date=2030-05-06&slotIdx=0";
  const req = Object.assign(new Request(url), { nextUrl: new URL(url) });
  const res = await GET(req as unknown as Parameters<typeof GET>[0]);
  expect(res.status).toBe(200);
  return res.text();
};
const paidByCell = (html: string, description: string) => {
  const row = html.split("<tr>").find((r) => r.includes(`<td>${description}</td>`))!;
  return row.match(/<td class="c">([^<]*)<\/td><\/tr>/)![1];
};

describe("the printable job sheet names who paid each expense", () => {
  it("prints 'ยังไม่ระบุผู้จ่าย' for a blank or unrecognised Paid By, and keeps the known short labels", async () => {
    const html = await render();
    expect(paidByCell(html, "Row blank")).toBe("ยังไม่ระบุผู้จ่าย");
    expect(paidByCell(html, "Row unknown")).toBe("ยังไม่ระบุผู้จ่าย");
    expect(paidByCell(html, "Row guide")).toBe("Guide");
    expect(paidByCell(html, "Row company")).toBe("Company");
    expect(paidByCell(html, "Row advance")).toBe("Advance");
  });
});
