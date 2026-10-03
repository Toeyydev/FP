import { describe, expect, it } from "vitest";
import { duplicateTransferBody, duplicateTransferReasons, txRefKey, type ExistingAdvance } from "./tx-ref";

// All data invented.
const existing: ExistingAdvance = { id: "adv_1", advanceNo: "FOLK-ADV-209903-001", guideId: "G-990", jobNo: "FOLK-BKK-20990310-01", advanceDate: "2099-03-09", amount: 1500, txRef: "TRXX99031012345" };

describe("a transfer's identity", () => {
  it.each([
    ["TRXX99031012345", "TRXX99031012345"],
    [" trxx 9903-1012 345 ", "TRXX99031012345"],
    ["TRXX/9903.1012_345", "TRXX99031012345"],
    ["ＴＲＸＸ９９０３１０１２３４５", "TRXX99031012345"], // full-width, pasted from a chat
    ["TRXX๙๙๐๓๑๐๑๒๓๔๕", "TRXX99031012345"], // Thai digits
  ])("%j is the transfer %s", (typed, key) => expect(txRefKey(typed)).toBe(key));

  it("nothing identifying is no key — never a match on the empty string", () => {
    for (const v of ["", "   ", " - / . ", null, undefined]) expect(txRefKey(v)).toBeNull();
  });

  it("different transfers stay different", () => {
    expect(txRefKey("TRXX99031012345")).not.toBe(txRefKey("TRXX99031012346"));
  });
});

describe("the refusal names the advance that holds the transfer", () => {
  it("says which advance, in Thai and English, and how to correct a wrong one", () => {
    const r = duplicateTransferReasons(existing, { amount: 1500, advanceDate: "2099-03-09" });
    expect(r[0]).toContain("FOLK-ADV-209903-001");
    expect(r[1]).toContain("already recorded as advance FOLK-ADV-209903-001 (G-990 · FOLK-BKK-20990310-01 · 2099-03-09 · ฿1,500.00)");
    expect(r.some((x) => /reverse it with a reason/.test(x))).toBe(true);
    expect(r.some((x) => /different/.test(x))).toBe(false);
  });

  it("a different amount or date under the same reference is called a typo, not a second transfer", () => {
    const r = duplicateTransferReasons(existing, { amount: 1600, advanceDate: "2099-03-10" });
    expect(r.join("\n")).toContain("amount ฿1,600.00 vs ฿1,500.00 and date 2099-03-10 vs 2099-03-09");
  });

  it("the body carries the code and the existing record for the screen to open", () => {
    const b = duplicateTransferBody(existing, {});
    expect(b).toMatchObject({ error: "duplicate-transfer", code: "DUPLICATE_BANK_REFERENCE", duplicateOf: { id: "adv_1", advanceNo: "FOLK-ADV-209903-001" } });
  });
});
