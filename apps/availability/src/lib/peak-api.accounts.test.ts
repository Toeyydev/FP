import { describe, it, expect } from "vitest";
import { parsePeakAccounts } from "@/lib/peak-api";

// This call has never run against PEAK, so the response parsing is the riskiest
// unverified part of the integration. These cover the documented shape, the
// casing PEAK actually uses on responses, and the silent-failure case.
describe("PEAK chart-of-accounts parsing", () => {
  const real = [
    { code: "510111", name: "ค่าจ้างมัคคุเทศก์", nameEn: "Guide fee" },
    { code: "510110", name: "ค่ารีวิวลูกค้า" },
  ];

  it("reads the documented shape", () => {
    const r = parsePeakAccounts({ peakAccountCode: { accountCode: real } });
    expect("accounts" in r && r.accounts.map((a) => a.code)).toEqual(["510111", "510110"]);
  });

  it("reads the capitalised wrapper PEAK returns on responses", () => {
    // Requests send `peakClientToken`, responses come back `PeakClientToken` —
    // the chart endpoint is expected to do the same.
    const r = parsePeakAccounts({ PeakAccountCode: { accountCode: real } });
    expect("accounts" in r && r.accounts).toHaveLength(2);
  });

  it("keeps the real Folkpaths codes and Thai names intact", () => {
    const r = parsePeakAccounts({ peakAccountCode: { accountCode: real } });
    if (!("accounts" in r)) throw new Error("expected accounts");
    expect(r.accounts[0]).toEqual({ code: "510111", name: "ค่าจ้างมัคคุเทศก์", nameEn: "Guide fee" });
    expect(r.accounts[1].name).toBe("ค่ารีวิวลูกค้า");
  });

  it("drops rows with no code rather than offering a blank option", () => {
    const r = parsePeakAccounts({ peakAccountCode: { accountCode: [...real, { code: "  ", name: "x" }, { name: "y" }] } });
    expect("accounts" in r && r.accounts).toHaveLength(2);
  });

  it("tolerates a differently-named account array", () => {
    // `accounts` instead of `accountCode` is still plainly the account list, and
    // rejecting it would be pedantry that costs a working dropdown.
    const r = parsePeakAccounts({ peakAccountCode: { accounts: real } });
    expect("accounts" in r && r.accounts).toHaveLength(2);
    expect("meta" in r && r.meta.arrayKey).toBe("accounts");
  });

  it("an unrecognised shape is an ERROR naming the keys seen, never silence", () => {
    const r = parsePeakAccounts({ peakAccountCode: { totalRecord: 2, resCode: "0000" } });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("totalRecord");
  });

  it("rows present but no usable code are REPORTED, not silently emptied", () => {
    // The reported symptom: an empty dropdown. If PEAK names the code field
    // something else, every row is filtered out and the list looks empty — so the
    // field names actually received are what gets surfaced.
    const r = parsePeakAccounts({ peakAccountCode: { accountCode: [{ accountNo: "510104", accountName: "ต้นทุนการให้บริการ" }] } });
    if (!("meta" in r)) throw new Error("expected meta");
    expect(r.accounts).toHaveLength(0);
    expect(r.meta.rawCount).toBe(1);
    expect(r.meta.droppedNoCode).toBe(1);
    expect(r.meta.sampleKeys).toEqual(["accountNo", "accountName"]);
  });

  it("the field-name diagnostic carries no values", () => {
    const r = parsePeakAccounts({ peakAccountCode: { accountCode: [{ accountNo: "510104", accountName: "ต้นทุนการให้บริการ" }] } });
    if (!("meta" in r)) throw new Error("expected meta");
    expect(r.meta.sampleKeys.join(",")).not.toContain("510104");
    expect(r.meta.sampleKeys.join(",")).not.toContain("ต้นทุน");
  });

  it("names the top-level keys when the wrapper itself is different", () => {
    const r = parsePeakAccounts({ someOtherWrapper: { accountCode: real } });
    expect("error" in r && r.error).toContain("someOtherWrapper");
  });

  it("an empty payload reports 'none' rather than throwing", () => {
    expect("error" in parsePeakAccounts({})).toBe(true);
  });

  it("never leaks values — only key names appear in the diagnostic", () => {
    const r = parsePeakAccounts({ peakAccountCode: { secretish: "ควรจะไม่ปรากฏ" } });
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error).toContain("secretish");
    expect(r.error).not.toContain("ควรจะไม่ปรากฏ");
  });
});
