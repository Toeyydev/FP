import { describe, expect, it } from "vitest";
import { driveMonth } from "@/lib/drive-month";
import { certificateFolder } from "@/lib/certificates/access";

describe("the month a document is filed under", () => {
  it("from November 2026, a year folder with its months inside", () => {
    expect(driveMonth("2026-11-01")).toEqual(["2026", "11 November"]);
    expect(driveMonth("2026-12-31")).toEqual(["2026", "12 December"]);
  });
  it("a new year is a new folder", () => {
    expect(driveMonth("2027-01-01")).toEqual(["2027", "01 January"]);
  });
  it("earlier months stay in the folder their documents are already in", () => {
    expect(driveMonth("2026-10-31")).toEqual(["2026-10 October"]);
  });
  it("certificates follow the same rule, and older ones keep their own folder", () => {
    expect(certificateFolder("2026-11-02").slice(2)).toEqual(["2026", "11 November"]);
    expect(certificateFolder("2026-10-02").slice(2)).toEqual(["2026-10"]);
  });
});
