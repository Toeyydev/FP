import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const drive = vi.hoisted(() => ({ files: new Map<string, { base64: string; mime: string; name: string }>() }));
vi.mock("@/lib/google-drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-drive")>()),
  folkpathsDriveToken: vi.fn(async () => "refresh-token"),
  downloadDriveFile: vi.fn(async (_t: string, link: string) => drive.files.get(link) ?? null),
}));
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { kbizSlipPdf } from "@/test/kbiz-pdf";
import { checkSheetAttachments, classifyBytes } from "./receipt-kind";
import { createCertificate } from "./service";

// A ticket row "receipted" with the advance's transfer slip: the admin's check finds the
// slip, and the row then needs a certificate in lieu of receipt. All data invented.
const KEY = { guideId: "G-990", date: "2025-03-09", slotIdx: 0 };
const op = { paidBySource: "operator", paidByAt: "2025-03-09T12:00:00Z", paidByBy: "u_op" };
const slip = kbizSlipPdf({ id: "TRXX99031012345", date: "09/03/2025", amount: "1,000.00", to: "MR. EXAMPLE GUIDE", account: "xxx-x-x4321-x" });

beforeAll(requireTestDatabase);
beforeEach(async () => { await resetDatabase(); await seedGuide("G-990"); drive.files.clear(); });

describe("checking what an advance-paid row's attachment is", () => {
  it("a K BIZ slip is a transfer slip; a picture is a document", async () => {
    expect(await classifyBytes(slip, "application/pdf", "slip.pdf")).toEqual({ kind: "TRANSFER_SLIP", txRef: "TRXX99031012345" });
    expect((await classifyBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/jpeg", "ticket.jpg")).kind).toBe("DOCUMENT");
  });

  it("the admin's check records the slip, and the ticket then gets an advance-paid certificate", async () => {
    await prisma.tour.upsert({ where: { id: "T-950" }, update: {}, create: { id: "T-950", name: "Riverside Temples", time: "13:30", durationMin: 180 } });
    drive.files.set("https://drive.example.test/slip", { base64: Buffer.from(slip).toString("base64"), mime: "application/pdf", name: "Advance slip.pdf" });
    drive.files.set("https://drive.example.test/ticket", { base64: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"), mime: "image/jpeg", name: "ticket.jpg" });
    await prisma.jobSheet.create({ data: { ...KEY, tourId: "T-950", status: "Confirmed", ref: "FOLK-TEST-CERT-03", bookings: [], expenses: [
      { description: "Temple A ticket", price: 500, pax: 1, expenseType: "entrance", paidBy: "advance", receiptUrl: "https://drive.example.test/slip", receiptFileId: "f-slip", ...op },
      { description: "Temple B ticket", price: 300, pax: 1, expenseType: "entrance", paidBy: "advance", receiptUrl: "https://drive.example.test/ticket", receiptFileId: "f-ticket", ...op },
    ] } });
    const r = await checkSheetAttachments(prisma, KEY, { actorId: "u_admin", actorRole: "ADMIN" });
    expect(r).toMatchObject({ ok: true, checked: 2, transferSlips: 1 });
    expect(await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: KEY } }).then((s) => JSON.stringify(s.expenses))).not.toMatch(/TRANSFER_SLIP/); // the sheet is untouched
    const cert = await createCertificate(KEY, { id: "u_admin", name: "Admin Example", role: "ADMIN" }, {}, "ADMIN_RECORDED", "COMPANY_ADVANCE");
    expect((cert.coveredRows as { description: string }[]).map((x) => x.description)).toEqual(["Temple A ticket"]);
    expect(await checkSheetAttachments(prisma, KEY, { actorId: "u_admin", actorRole: "ADMIN" })).toMatchObject({ checked: 0 }); // nothing left to check
  });
});
