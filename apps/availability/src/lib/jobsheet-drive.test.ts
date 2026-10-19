import { vi, describe, it, expect, beforeEach } from "vitest";

// Renders the job sheet exactly as saveJobSheetToDrive builds it; only the database, the PDF
// renderer and the Drive upload are mocked. All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  tour: { findUnique: vi.fn() },
  guideAdvance: { findMany: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn() },
  guideAdvanceEntry: { findMany: vi.fn(async () => []) },
  guideAdvanceReceipt: { findMany: vi.fn(async () => []) },
  // The save's cross-instance lock (lib/jobsheet-drive): a transaction that only holds it.
  $queryRaw: vi.fn(async () => []),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
}));
const saveBuffer = vi.hoisted(() => vi.fn());
const render = vi.hoisted(() => vi.fn(async (_html: string) => Buffer.from("%PDF-test")));
// The tests below read the HTML that was rendered.
const saveHtml = { mock: { get calls() { return render.mock.calls.map(([html]) => [{ html }]); } } };
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
const sharedDrive = vi.hoisted(() => ({ id: "0AExampleSharedDrive1" as string | null }));
// The admin OAuth path is present only so a test can prove it is never touched.
const oauth = vi.hoisted(() => ({ token: vi.fn(async () => "admin-refresh-token"), save: vi.fn() }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: oauth.token, saveBufferToDrive: oauth.save, folkpathsSharedDriveId: () => sharedDrive.id, saveBufferWithAccessToken: saveBuffer }));
const sa = vi.hoisted(() => ({ configured: true, token: vi.fn(async () => "sa-access-token") }));
vi.mock("@/lib/drive-service-account", () => ({ serviceAccountConfig: () => (sa.configured ? { email: "x@p.iam.gserviceaccount.com", privateKey: "k" } : null), serviceAccountAccessToken: sa.token }));
vi.mock("@/lib/certificates/pdf", () => ({ renderPdf: render }));

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
  sharedDrive.id = "0AExampleSharedDrive1";
  sa.configured = true;
  prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: ROWS, guideFee: { price: 1200, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z"), certifiedAt: null });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.user.findUnique.mockResolvedValue({ fullName: "Guide A", displayName: "Guide A" });
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Test Tour", time: "08:30" });
  prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  saveBuffer.mockResolvedValue({ id: "file-1", link: "https://drive.example/file-1" });
});

const paidByCell = (html: string, description: string) => {
  const row = html.split("<tr>").find((r) => r.includes(`<td>${description}</td>`))!;
  return row.match(/<td>([^<]*)<\/td><td style="text-align:right">/)![1];
};

describe("the Google Doc in Drive names who paid each expense", () => {
  it("shows 'not specified' for a blank or unrecognised Paid By, and keeps the known labels", async () => {
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBe("https://drive.example/file-1");
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

describe("job sheets are filed by the service account, never the admin OAuth connection", () => {
  it("uses the service account's token and never asks for the OAuth connection", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    expect(sa.token).toHaveBeenCalledTimes(1);
    expect(saveBuffer.mock.calls[0][0]).toBe("sa-access-token");
    expect(oauth.token).not.toHaveBeenCalled();
    expect(oauth.save).not.toHaveBeenCalled();
  });
  it("without the service account it saves nothing — and does not fall back to the OAuth connection or My Drive", async () => {
    sa.configured = false;
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(sa.token).not.toHaveBeenCalled();
    expect(saveBuffer).not.toHaveBeenCalled();
    expect(oauth.token).not.toHaveBeenCalled();
    expect(oauth.save).not.toHaveBeenCalled();
  });
  it("without the Shared Drive id it saves nothing either", async () => {
    sharedDrive.id = null;
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBeNull();
    expect(saveBuffer).not.toHaveBeenCalled();
    expect(oauth.save).not.toHaveBeenCalled();
  });
  it("a refused service-account token saves nothing and never throws", async () => {
    sa.token.mockRejectedValueOnce(new Error("drive-service-account: token refused (400 invalid_grant)"));
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBeNull();
    expect(saveBuffer).not.toHaveBeenCalled();
    expect(oauth.save).not.toHaveBeenCalled();
  });
});

describe("the copy in Drive is a PDF", () => {
  it("is filed in the Folkpaths Shared Drive, or nowhere — never a My Drive", async () => {
    sharedDrive.id = null;
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(saveBuffer).not.toHaveBeenCalled();
  });
  it("uploads the rendered PDF under the job sheet's name with .pdf, in the month folder", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    expect(render).toHaveBeenCalledTimes(1);
    const [token, up] = saveBuffer.mock.calls[0];
    expect(token).toBe("sa-access-token");
    expect(up.mimeType).toBe("application/pdf");
    expect(up.name).toBe("FOLK-BKK-20300506-01 — Guide A — 2030-05-06 — G-TEST — slot 0.pdf");
    expect(up.folderPath).toEqual(["Folkpaths Job Sheets", "2030-05 May"]);
    expect(up.sharedDriveId).toBe("0AExampleSharedDrive1");
    expect(Buffer.from(up.base64, "base64").toString()).toBe("%PDF-test");
  });
  it("is an A4 page set in a font with Thai, since the server has no Sarabun", async () => {
    await saveJobSheetToDrive("G-TEST", "2030-05-06", 0);
    const { html } = saveHtml.mock.calls[0][0];
    expect(html).toContain("@page{size:A4");
    expect(html).toContain("font-family:'Umpush'");
  });
  it("saves nothing — not a Google Doc either — when the PDF cannot be made", async () => {
    render.mockRejectedValueOnce(new Error("pdf-renderer-unavailable: not-installed"));
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBeNull();
    expect(saveBuffer).not.toHaveBeenCalled();
  });
  it("returns null without rendering when the sheet does not exist", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    expect(await saveJobSheetToDrive("G-TEST", "2030-05-06", 0)).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });
});

describe("saves of job sheet PDFs never overlap", () => {
  it("two saves at once run one after the other, so the second finds the first's file", async () => {
    let running = 0, peak = 0;
    saveBuffer.mockImplementation(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running--; return { id: "file-1", link: "https://drive.example/file-1" }; });
    const results = await Promise.all([saveJobSheetToDrive("G-TEST", "2030-05-06", 0), saveJobSheetToDrive("G-TEST", "2030-05-06", 0), saveJobSheetToDrive("G-TEST", "2030-05-06", 0)]);
    expect(results).toEqual(["https://drive.example/file-1", "https://drive.example/file-1", "https://drive.example/file-1"]);
    expect(saveBuffer).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });
  it("a failed save does not stop the next one", async () => {
    saveBuffer.mockRejectedValueOnce(new Error("drive-upload 500")).mockResolvedValueOnce({ id: "file-2", link: "https://drive.example/file-2" });
    const [a, b] = await Promise.all([saveJobSheetToDrive("G-TEST", "2030-05-06", 0), saveJobSheetToDrive("G-TEST", "2030-05-06", 0)]);
    expect(a).toBeNull();
    expect(b).toBe("https://drive.example/file-2");
  });
});
