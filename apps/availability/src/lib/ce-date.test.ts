import { describe, expect, it } from "vitest";
import { ceDate, differsByBuddhistEra } from "@/lib/ce-date";

describe("ceDate — a พ.ศ. year typed into a date field becomes ค.ศ.", () => {
  it("turns 2569 into 2026, for a date and a date-time", () => {
    expect(ceDate("2569-10-04")).toBe("2026-10-04");
    expect(ceDate("2569-10-04T22:42")).toBe("2026-10-04T22:42");
  });
  it("leaves Gregorian dates, partial years being typed and blanks alone", () => {
    for (const v of ["2026-10-04", "2026-10-04T22:42", "0256-10-04", "", "2099-01-01"]) expect(ceDate(v)).toBe(v);
  });
  it("tells when two dates differ only by the Buddhist era", () => {
    expect(differsByBuddhistEra("2569-10-04", "2026-10-04")).toBe(true);
    expect(differsByBuddhistEra("2026-10-04", "2026-10-05")).toBe(false);
    expect(differsByBuddhistEra(null, "2026-10-04")).toBe(false);
  });
});
