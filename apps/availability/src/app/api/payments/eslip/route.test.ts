import { vi, describe, it, expect, beforeEach } from "vitest";

// The monthly e-slip's Drive file name. It may lead with an EXP number only when that
// number is this payout's own — the payroll row's ref — never the first EXP found on
// some other job of the guide's month. All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  tourPayment: { findMany: vi.fn(), upsert: vi.fn() },
  payrollStatus: { findUnique: vi.fn(), upsert: vi.fn() },
  assignment: { findMany: vi.fn() },
}));
const saveMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "op_1", role: "OPERATOR" } })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: vi.fn(async () => "rt"), saveBufferToDrive: saveMock }));
vi.mock("@/lib/jobsheet-send", () => ({ sendPaymentNotice: vi.fn() }));
vi.mock("@/lib/peak-payment-server", () => ({ paymentDocumentLocksInMonth: vi.fn(async () => []) }));

import { POST } from "./route";

async function upload() {
  const fd = new FormData();
  fd.set("period", "2020-03");
  fd.set("guideId", "G-TEST");
  fd.set("file", new File([new Uint8Array([1, 2, 3])], "slip.jpg", { type: "image/jpeg" }));
  const res = await POST(new Request("https://ops.folkpaths.com/api/payments/eslip", { method: "POST", body: fd }) as unknown as Parameters<typeof POST>[0]);
  expect(res.status).toBe(200);
  return saveMock.mock.calls[0][0].name as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ link: "https://drive.test/slip" });
  prismaMock.user.findUnique.mockResolvedValue({ displayName: "Guide T", fullName: null });
  // Job A has no PEAK document; job B, paid by its own transfer, has one.
  prismaMock.jobSheet.findMany.mockResolvedValue([{ ref: "FOLK-TEST-0319-02" }, { ref: "FOLK-TEST-0321-02" }]);
  prismaMock.tourPayment.findMany.mockResolvedValue([{ peakRef: "EXP-TEST-0016" }]);
  prismaMock.payrollStatus.findUnique.mockResolvedValue(null);
  prismaMock.assignment.findMany.mockResolvedValue([]);
});

describe("POST /api/payments/eslip — slip file name", () => {
  it("does not pair the month's first job with another job's EXP", async () => {
    const name = await upload();
    expect(name).not.toContain("EXP-TEST-0016");
    expect(name).toBe("FOLK-TEST-0319-02 +1 more — Guide T — e-slip.jpg");
  });

  it("leads with the payroll row's own EXP when one was recorded for this payout", async () => {
    prismaMock.payrollStatus.findUnique.mockResolvedValue({ peakRef: "EXP-TEST-0900", status: "pending" });
    const name = await upload();
    expect(name).toBe("EXP-TEST-0900 — FOLK-TEST-0319-02 +1 more — Guide T — e-slip.jpg");
  });
});
