import { describe, expect, it } from "vitest";
import { parseKBizItems, readSlip, type SlipItem } from "./slip-read";

// A K BIZ slip's text items with their positions, laid out as the real PDF lays them out:
// the sender in the left column under "จาก / From", the recipient in the right column
// under "ไปยัง / To". Every name, account and number is invented.
const kbiz = (over: Partial<Record<"to" | "toEn" | "toAcct" | "from" | "total" | "fee" | "date" | "id", string>> = {}): SlipItem[] => [
  { str: "โอนเงินสำเร็จ", x: 38, y: 723 },
  { str: "Transfer Completed", x: 38, y: 703 },
  { str: "(เลขที่รายการ / Transaction ID :", x: 38, y: 690 },
  { str: over.id ?? "TRXX99031012345", x: 192, y: 690 },
  { str: ")", x: 307, y: 690 },
  { str: "วัน / เวลาทำรายการ", x: 471, y: 717 },
  { str: "Transaction Date", x: 487, y: 704 },
  { str: over.date ?? "09/03/2099 10:15 น.", x: 480, y: 685 },
  { str: "Deducted Date", x: 194, y: 647 },
  { str: "10/03/2099 10:15 น.", x: 194, y: 628 },
  { str: "จาก / From", x: 38, y: 525 },
  { str: "xxx-x-x1111-x", x: 38, y: 511 },
  { str: over.from ?? "บจก. ตัวอย่างทัวร์", x: 38, y: 496 },
  { str: "EXAMPLE TOURS CO.,LTD.", x: 38, y: 482 },
  { str: "ธนาคารกสิกรไทย", x: 38, y: 468 },
  { str: "Kasikornbank", x: 38, y: 454 },
  { str: "ไปยัง / To", x: 272, y: 525 },
  { str: over.toAcct ?? "xxx-x-x4321-x", x: 272, y: 511 },
  { str: over.to ?? "นาย สมชาย ใจดีมากสกุล", x: 272, y: 496 },
  { str: over.toEn ?? "MR. SOMCHAI JAIDEEMAKSAKUL", x: 272, y: 482 },
  { str: "ธนาคารตัวอย่าง", x: 272, y: 468 },
  { str: "Example Bank", x: 272, y: 454 },
  { str: "1,500.00", x: 520, y: 523 },
  { str: "ค่าธรรมเนียม / Fee", x: 326, y: 400 },
  { str: `${over.fee ?? "0.00"} บาท / Baht`, x: 490, y: 400 },
  { str: "ยอดรวมทั้งหมด / Total", x: 311, y: 385 },
  { str: `${over.total ?? "1,500.00"} บาท / Baht`, x: 472, y: 385 },
  { str: "บันทึกช่วยจำ / Memo", x: 38, y: 344 },
  { str: "Advance FOLK-BKK-20990310-01", x: 38, y: 322 },
  { str: "Issued by K BIZ", x: 38, y: 37 },
];

describe("reading a K BIZ slip by position", () => {
  it("reads the transaction, the date, the amount and the RECIPIENT — never the sender", () => {
    const r = parseKBizItems(kbiz());
    expect(r).toEqual({ ok: true, read: {
      format: "KBIZ_PDF", transactionId: "TRXX99031012345", transferDate: "2099-03-09", amount: 1500,
      recipient: { names: ["นาย สมชาย ใจดีมากสกุล", "MR. SOMCHAI JAIDEEMAKSAKUL"], accountMask: "xxx-x-x4321-x" },
    } });
  });

  it("the date is the Transaction Date, not the deducted date printed lower down", () => {
    const r = parseKBizItems(kbiz({ date: "08/03/2099 23:59 น." }));
    expect(r.ok && r.read.transferDate).toBe("2099-03-08");
  });

  it("the amount is what reached the recipient: Total less the Fee", () => {
    const r = parseKBizItems(kbiz({ total: "1,510.00", fee: "10.00" }));
    expect(r.ok && r.read.amount).toBe(1500);
  });

  it("a slip that is not K BIZ is not guessed at", () => {
    expect(parseKBizItems([{ str: "SCB Easy", x: 10, y: 700 }, { str: "Transfer 1,500.00", x: 10, y: 600 }])).toEqual({ ok: false, why: "not a K BIZ slip with a text layer" });
  });

  it("a picture is never read — a person checks it", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const r = await readSlip(png, "image/png", "slip.png");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/does not read pictures/);
  });

  it("a broken PDF is unreadable, not an error", async () => {
    const r = await readSlip(new TextEncoder().encode("%PDF-1.4 nonsense"), "application/pdf", "x.pdf");
    expect(r.ok).toBe(false);
  });
});
