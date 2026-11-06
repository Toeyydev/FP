import { describe, it, expect } from "vitest";
import { checkFile, receiptFileName, MAX_ATTACHMENT_BYTES, safeOriginalName, sniff } from "@/lib/expense-attachments/validate";
import { jpegInfo, jpegToPdf } from "@/lib/expense-attachments/image-pdf";
import { ensureRowIds, isRowId } from "@/lib/expense-row-id";
import { canAdd, canRemove, canView, mirrorRow } from "@/lib/expense-attachments/service";

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\n..."));

describe("what a file is, from its bytes", () => {
  it("knows JPEG, PNG, WebP and PDF", () => {
    expect([sniff(JPG), sniff(PNG), sniff(WEBP), sniff(PDF)]).toEqual(["jpg", "png", "webp", "pdf"]);
    expect(sniff(new Uint8Array(Buffer.from("<html>")))).toBeNull();
  });
  it("accepts a file whose bytes, type and name agree", () => {
    const r = checkFile(PDF, "application/pdf", "ticket.pdf");
    expect(r).toMatchObject({ ok: true, kind: { ext: "pdf" }, name: "ticket.pdf" });
    expect(r.ok && r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses a script renamed to .jpg, a PNG labelled PDF, an empty file and one over the limit", () => {
    expect(checkFile(new Uint8Array(Buffer.from("<script>")), "image/jpeg", "a.jpg")).toEqual({ ok: false, error: "bad-type" });
    expect(checkFile(PNG, "application/pdf", "a.pdf")).toEqual({ ok: false, error: "type-mismatch" });
    expect(checkFile(PNG, "image/png", "a.exe")).toEqual({ ok: false, error: "type-mismatch" });
    expect(checkFile(new Uint8Array(), "image/png", "a.png")).toEqual({ ok: false, error: "empty" });
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1); big.set(JPG);
    expect(checkFile(big, "image/jpeg", "a.jpg")).toEqual({ ok: false, error: "too-large" });
  });
});

describe("file names", () => {
  it("keeps the person's name for display, never a path", () => {
    expect(safeOriginalName("../../etc/passwd.jpg", "jpg")).toBe("passwd.jpg");
    expect(safeOriginalName("C:\\\\Users\\\\x\\\\สลิป ค่าตั๋ว.png", "png")).toBe("สลิป ค่าตั๋ว.png");
    expect(safeOriginalName("..hidden\u0000.pdf", "pdf")).toBe("hidden.pdf");
    expect(safeOriginalName("", "pdf")).toBe("receipt.pdf");
    expect(safeOriginalName("a".repeat(300) + ".jpg", "jpg")).toHaveLength(120);
  });
  it("names the Drive file from server values only, numbered in the job", () => {
    expect(receiptFileName({ seq: 3, description: "Grand Palace (ticket) ../../x", sha256: "ab12cd34ef", ext: "pdf" })).toBe("Receipt_03_Grand-Palace-ticket-x_ab12cd34.pdf");
    expect(receiptFileName({ seq: 1, description: "ค่าเรือ", sha256: "00ff00ff99", ext: "pdf" })).toBe("Receipt_01_ค่าเรือ_00ff00ff.pdf");
    expect(receiptFileName({ seq: 12, description: "", sha256: "1234567890", ext: "pdf" })).toBe("Receipt_12_Expense_12345678.pdf");
  });
});

describe("a photo becomes a one-page PDF", () => {
  // A real 2×1 baseline JPEG (RGB), made once with a canvas.
  const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
  it("reads the size from the frame header", () => {
    expect(jpegInfo(new Uint8Array(JPEG))).toMatchObject({ width: 2, height: 1, components: 1 });
    expect(jpegInfo(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
  it("embeds the JPEG unchanged in a valid single-page PDF", () => {
    const pdf = jpegToPdf(new Uint8Array(JPEG), "ตั๋ว (receipt).jpg")!;
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 1");
    expect(text).toContain("/Filter /DCTDecode");
    expect(Buffer.from(pdf).indexOf(JPEG)).toBeGreaterThan(0);
    // xref offsets point at their objects.
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offs = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
    expect(jpegToPdf(new Uint8Array(Buffer.from("%PDF-1.4")))).toBeNull();
  });
});

describe("row ids", () => {
  it("gives rows without one an id, and a copied id a new one, changing nothing else", () => {
    const rows = [{ description: "Ticket", price: 500, pax: 2 }, { description: "Water", price: 10, pax: 3, rowId: "r_aaaaaaaaaaaa" }, { description: "Copy", price: 10, pax: 3, rowId: "r_aaaaaaaaaaaa" }];
    const { rows: out, added } = ensureRowIds(rows);
    expect(added).toBe(2);
    expect(out.every((r) => isRowId(r.rowId))).toBe(true);
    expect(new Set(out.map((r) => r.rowId)).size).toBe(3);
    expect(out[1]).toBe(rows[1]);
    expect(out.map(({ description, price, pax }) => [description, price, pax])).toEqual(rows.map(({ description, price, pax }) => [description, price, pax]));
  });
});

describe("the legacy receipt fields follow the files", () => {
  const file = (id: string) => ({ driveFileId: id, driveLink: `https://drive.example/${id}`, originalName: `${id}.jpg`, uploadedAt: new Date("2099-01-01T00:00:00Z"), uploadedById: "u1" });
  it("a row with no receipt takes the first file", () => {
    expect(mirrorRow({ description: "T", price: 1, pax: 1 }, [file("f1"), file("f2")], new Set())).toMatchObject({ receiptFileId: "f1", receiptUrl: "https://drive.example/f1" });
  });
  it("a receipt from before files had a table is left alone", () => {
    const row = { description: "T", price: 1, pax: 1, receiptFileId: "old", receiptUrl: "https://drive.example/old" };
    expect(mirrorRow(row, [file("f1")], new Set())).toBe(row);
  });
  it("a removed file is replaced by the next one, or cleared", () => {
    const row = { description: "T", price: 1, pax: 1, receiptFileId: "f1", receiptUrl: "https://drive.example/f1", receiptName: "f1.jpg" };
    expect(mirrorRow(row, [file("f2")], new Set(["f1"]))).toMatchObject({ receiptFileId: "f2" });
    const cleared = mirrorRow(row, [], new Set(["f1"]));
    expect(cleared.receiptFileId).toBeUndefined();
    expect(cleared.receiptUrl).toBeUndefined();
    expect(cleared.price).toBe(1);
  });
});

describe("who may do what", () => {
  const g = { id: "u-g1", role: "GUIDE", guideId: "G-1" };
  it("a guide on their own job only", () => {
    expect(canView(g, "G-1") && canAdd(g, "G-1")).toBe(true);
    expect(canView(g, "G-2") || canAdd(g, "G-2")).toBe(false);
  });
  it("an accountant sees but never adds or removes", () => {
    const a = { id: "u-a", role: "ACCOUNTANT" };
    expect(canView(a, "G-1")).toBe(true);
    expect(canAdd(a, "G-1")).toBe(false);
    expect(canRemove(a, { guideId: "G-1", approvalStatus: null }, { uploadedById: "u-a" })).toBe(false);
  });
  it("a guide removes only their own file, and not once the job is approved; ops any time", () => {
    expect(canRemove(g, { guideId: "G-1", approvalStatus: null }, { uploadedById: "u-g1" })).toBe(true);
    expect(canRemove(g, { guideId: "G-1", approvalStatus: null }, { uploadedById: "u-op" })).toBe(false);
    expect(canRemove(g, { guideId: "G-1", approvalStatus: "APPROVED" }, { uploadedById: "u-g1" })).toBe(false);
    for (const role of ["OPERATOR", "ADMIN"]) expect(canRemove({ id: "x", role }, { guideId: "G-1", approvalStatus: "APPROVED" }, { uploadedById: "u-g1" })).toBe(true);
  });
});
