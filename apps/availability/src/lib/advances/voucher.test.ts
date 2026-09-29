import { describe, expect, it, vi } from "vitest";
import { advanceVoucherHtml, saveAdvanceVoucher, thaiDate, voucherDriveFolder, voucherDriveName, type VoucherInput } from "./voucher";

// Every figure, guide and reference below is invented.
const base: VoucherInput = {
  advanceNo: "FOLK-ADV-209901-001",
  guideId: "G-901", guideName: "Nok Example",
  jobNo: "FOLK-TEST-0001", tourName: "Riverside Temples", tourDate: "2099-01-20",
  advanceDate: "2099-01-20", amountSatang: 100_000,
  method: "bank", txRef: "TRTS209901000000001", slipUrl: "https://drive.example.test/slip",
};

describe("the advance voucher", () => {
  it("says what it is, and what it is not", () => {
    const html = advanceVoucherHtml(base);
    expect(html).toContain("ใบสำคัญจ่ายเงินทดรอง");
    // An advance is the company's asset in someone's hands, so the document must
    // not read as a receipt or a tax invoice — a guide who files it as either
    // creates a tax problem out of a cash movement.
    expect(html).toContain("ไม่ใช่ใบเสร็จรับเงินและไม่ใช่ใบกำกับภาษี");
    expect(html).toContain("ไม่มีการหักภาษี ณ ที่จ่าย");
    expect(html).toContain("เดบิต เงินทดรองจ่าย - ไกด์ (สินทรัพย์)");
  });

  it("carries the amount twice — figures and words", () => {
    const html = advanceVoucherHtml(base);
    expect(html).toContain("฿1,000.00");
    expect(html).toContain("หนึ่งพันบาทถ้วน");
  });

  it("states the obligation to clear and to return the rest", () => {
    const html = advanceVoucherHtml(base);
    expect(html).toContain("คืนเงินส่วนที่เหลือภายใน 3 วันทำการ");
    expect(html).toContain("เก็บตั๋วหรือใบเสร็จทุกใบ");
  });

  it("prints the bank reference, because that is what ties it to the statement", () => {
    expect(advanceVoucherHtml(base)).toContain("TRTS209901000000001");
  });

  it("leaves out rows it has nothing for, rather than printing empty labels", () => {
    const html = advanceVoucherHtml({ ...base, txRef: null, slipUrl: null, jobNo: null, tourName: null, tourDate: null });
    expect(html).not.toContain("เลขอ้างอิงธนาคาร");
    expect(html).not.toContain("สลิปโอนเงิน");
    expect(html).not.toContain("เลขที่งาน");
  });

  it("shows the PEAK document only once there is one", () => {
    expect(advanceVoucherHtml(base)).not.toContain("เอกสารบัญชี");
    expect(advanceVoucherHtml({ ...base, peakDocumentNo: "JV-209901001" })).toContain("JV-209901001");
  });

  it("prints the guide's confirmation in place of the signature line once given", () => {
    const signed = advanceVoucherHtml({ ...base, acknowledgedAt: new Date("2099-01-20T05:00:00Z") });
    expect(signed).toContain("ยืนยันรับเงินในแอปเมื่อ");
  });

  it("falls back to the ticket purpose when none was typed", () => {
    expect(advanceVoucherHtml(base)).toContain("ค่าบัตรเข้าชมสถานที่สำหรับลูกค้า");
    expect(advanceVoucherHtml({ ...base, purpose: "ค่าอาหาร Food tour" })).toContain("ค่าอาหาร Food tour");
  });

  it("escapes what people type, so a stray bracket cannot break the document", () => {
    const html = advanceVoucherHtml({ ...base, guideName: 'A <b>bold</b> "name"' });
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("dates in the Buddhist era, as Thai documents do", () => {
    expect(thaiDate("2099-01-20")).toBe("20 ม.ค. 2642");
    expect(thaiDate("")).toBe("");
  });

  it("files itself beside the slip, in the month the money moved", () => {
    expect(voucherDriveFolder("2099-01-20")).toEqual(["Folkpaths Job Sheets", "2099-01 January", "Advances"]);
    expect(voucherDriveName({ advanceNo: "FOLK-ADV-209901-001", jobNo: "FOLK-TEST-0001" }))
      .toBe("FOLK-ADV-209901-001 — FOLK-TEST-0001 — advance voucher");
  });
});

describe("filing the voucher", () => {
  const advance = {
    id: "adv_1", advanceNo: "FOLK-ADV-209901-001", guideId: "G-901", jobNo: "FOLK-TEST-0001",
    advanceDate: "2099-01-20", amountSatang: 100_000, purpose: null, method: "bank",
    txRef: "TRTS209901000000001", slipUrl: null, peakDocumentNo: null, acknowledgedAt: null,
  };
  const dbWith = (update = vi.fn()) => ({
    guideAdvance: { findUnique: vi.fn(async () => advance), update },
    user: { findUnique: vi.fn(async () => ({ displayName: "Nok Example" })) },
    jobSheet: { findFirst: vi.fn(async () => ({ date: "2099-01-20", tourId: "T-900" })) },
    tour: { findUnique: vi.fn(async () => ({ name: "Riverside Temples" })) },
  }) as never;

  it("saves the document and records where it went", async () => {
    const update = vi.fn();
    const saveHtml = vi.fn(async () => ({ id: "file_1", link: "https://drive.example.test/voucher" }));
    const link = await saveAdvanceVoucher(dbWith(update), "adv_1", { enabled: true, token: async () => "token", saveHtml });

    expect(link).toBe("https://drive.example.test/voucher");
    expect(saveHtml.mock.calls[0][0].folderPath).toEqual(["Folkpaths Job Sheets", "2099-01 January", "Advances"]);
    expect(saveHtml.mock.calls[0][0].html).toContain("หนึ่งพันบาทถ้วน");
    expect(update.mock.calls[0][0].data).toMatchObject({ voucherUrl: "https://drive.example.test/voucher", voucherFileId: "file_1" });
  });

  it("does nothing when Drive is not connected, and says so by returning nothing", async () => {
    const saveHtml = vi.fn();
    expect(await saveAdvanceVoucher(dbWith(), "adv_1", { enabled: false, token: async () => "t", saveHtml })).toBeNull();
    expect(await saveAdvanceVoucher(dbWith(), "adv_1", { enabled: true, token: async () => null, saveHtml })).toBeNull();
    expect(saveHtml).not.toHaveBeenCalled();
  });

  it("swallows a Drive failure — recorded money must not be undone by a filing error", async () => {
    const saveHtml = vi.fn(async () => { throw new Error("drive is down"); });
    await expect(saveAdvanceVoucher(dbWith(), "adv_1", { enabled: true, token: async () => "token", saveHtml }))
      .resolves.toBeNull();
  });
});
