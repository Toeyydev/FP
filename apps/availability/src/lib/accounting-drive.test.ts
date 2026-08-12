import { describe, it, expect } from "vitest";
import { accountingFolderPath, enforceExtension, MONTH_CODES } from "@/lib/accounting-drive";

describe("accounting Drive folder tree", () => {
  it("Category → Year → Month(NNMMM) → Job No.", () => {
    expect(accountingFolderPath("advance", new Date("2026-08-11T15:19:00+07:00"), "FOLK-BKK-20260811-01"))
      .toEqual(["Folkpaths Accounting", "Advance", "2026", "08AUG", "FOLK-BKK-20260811-01"]);
    expect(accountingFolderPath("advance_return", new Date("2026-08-11T19:47:00+07:00"), "FOLK-BKK-20260811-01"))
      .toEqual(["Folkpaths Accounting", "Return", "2026", "08AUG", "FOLK-BKK-20260811-01"]);
  });
  it("month comes from the TRANSACTION date, Bangkok time — not the tour date", () => {
    expect(accountingFolderPath("advance", new Date("2026-07-31T17:30:00Z"), "FOLK-BKK-20260731-01")[3]).toBe("08AUG");
    expect(accountingFolderPath("advance", new Date("2026-07-31T16:30:00Z"), "FOLK-BKK-20260731-01")[3]).toBe("07JUL");
  });
  it("Gregorian year, uppercase month codes only", () => {
    expect(accountingFolderPath("guide_payment", new Date("2026-01-05T12:00:00+07:00"), "X")[2]).toBe("2026");
    for (const m of MONTH_CODES) expect(m).toMatch(/^\d{2}[A-Z]{3}$/);
  });
  it("rename keeps the true file type", () => {
    expect(enforceExtension("Advance Nareerart 1000", "image/png")).toBe("Advance Nareerart 1000.png");
    expect(enforceExtension("Advance Nareerart 1000.jpg", "image/png")).toBe("Advance Nareerart 1000.png");
  });
});
