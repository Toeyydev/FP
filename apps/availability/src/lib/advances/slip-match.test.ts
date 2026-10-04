import { describe, expect, it } from "vitest";
import { bestName, checkSlip, compareAccount, compareName, nameTokens, slipGate, storedDetail, type GuideIdentity } from "./slip-match";
import type { SlipRead } from "./slip-read";

// Every name and number here is invented.
const guide: GuideIdentity = { guideId: "G-990", names: ["สมชาย ใจดีมากสกุล", "Somchai Jaideemaksakul", null, null], accountNo: "1234543210" };
const other: GuideIdentity = { guideId: "G-991", names: ["สมหญิง รักดี", "Somying Rakdee"], accountNo: "9876567890" };
const typed = { txRef: "TRXX99031012345", amount: 1500, advanceDate: "2099-03-09" };
const slip = (over: Partial<SlipRead> & { names?: string[]; mask?: string | null } = {}): SlipRead => ({
  format: "KBIZ_PDF", transactionId: "TRXX99031012345", transferDate: "2099-03-09", amount: 1500,
  recipient: { names: over.names ?? ["นาย สมชาย ใจดีมากสกุล", "MR. SOMCHAI JAIDEEMAKSAKUL"], accountMask: over.mask === undefined ? "xxx-x-x4321-x" : over.mask },
  ...over,
});

describe("names", () => {
  it("titles are dropped, glued or spaced, Thai or English", () => {
    expect(nameTokens("นายสมชาย ใจดี")).toEqual(["สมชาย", "ใจดี"]);
    expect(nameTokens("น.ส. สมหญิง รักดี")).toEqual(["สมหญิง", "รักดี"]);
    expect(nameTokens("MR.SOMCHAI JAIDEE")).toEqual(["SOMCHAI", "JAIDEE"]);
    expect(nameTokens("Ms. Somying Rakdee (Ying)")).toEqual(["SOMYING", "RAKDEE"]);
    expect(nameTokens("MISSY LEE")).toEqual(["MISSY", "LEE"]); // not a title
  });

  it("FULL needs first AND last name; a bank-cut surname is TRUNCATED; one word is ONE_NAME", () => {
    expect(compareName(["SOMCHAI", "JAIDEEMAKSAKUL"], ["SOMCHAI", "JAIDEEMAKSAKUL"])).toBe("FULL");
    expect(compareName(["SOMCHAI", "JAIDEEMA"], ["SOMCHAI", "JAIDEEMAKSAKUL"])).toBe("TRUNCATED");
    expect(compareName(["SOMCHAI", "RAKDEE"], ["SOMCHAI", "JAIDEEMAKSAKUL"])).toBe("ONE_NAME");
    expect(compareName(["SOMCHAI"], ["SOMCHAI", "JAIDEEMAKSAKUL"])).toBe("ONE_NAME");
    expect(compareName(["SOMYING", "RAKDEE"], ["SOMCHAI", "JAIDEEMAKSAKUL"])).toBe("NONE");
  });

  it("names are compared within one script; a guide with no name in the slip's script cannot be compared", () => {
    expect(bestName(["MR. SOMCHAI JAIDEEMAKSAKUL"], ["สมชาย ใจดีมากสกุล"])).toBe("CANNOT_COMPARE");
    expect(bestName(["นาย สมชาย ใจดีมากสกุล", "MR. SOMCHAI JAIDEEMA"], guide.names)).toBe("FULL");
  });
});

describe("accounts", () => {
  it("visible digits are compared position by position", () => {
    expect(compareAccount("xxx-x-x4321-x", "1234543210")).toBe("MATCH");
    expect(compareAccount("xxx-x-x4322-x", "1234543210")).toBe("MISMATCH");
    expect(compareAccount("xxx-x-x4321-x", "12345432100")).toBe("CANNOT_COMPARE"); // another format
    expect(compareAccount("xxx-x-x4321-x", null)).toBe("CANNOT_COMPARE");
    expect(compareAccount("xxx-x-xxx1-x", "1234543210")).toBe("CANNOT_COMPARE"); // too little to go on
  });
});

describe("the result", () => {
  it("MATCH: full name, account, reference, amount and date all agree", () => {
    const c = checkSlip(slip(), null, typed, guide, [other]);
    expect(c.result).toBe("MATCH");
    expect(c.checks).toEqual({ transactionId: "SAME", amount: "SAME", date: "SAME", name: "FULL", account: "MATCH", otherGuideId: null });
  });

  it("one matching word is never a MATCH — first name plus a bank-cut surname, and no Thai name on file, is PARTIAL", () => {
    // The shape of a real case: the slip prints the full Thai name and a cut English one;
    // the guide's record holds only the English name, in full.
    const englishOnly: GuideIdentity = { guideId: "G-990", names: [null, null, "Somchai Jaideemaksakul", null], accountNo: null };
    const c = checkSlip(slip({ names: ["นาย สมชาย ใจดีมากสกุล", "SOMC JAIDEEMA"] }), null, typed, englishOnly, [other]);
    expect(c.result).toBe("PARTIAL");
    const c2 = checkSlip(slip({ names: ["นาย สมชาย ใจดีมากสกุล", "SOMCHAI JAIDEEMA"] }), null, typed, englishOnly, [other]);
    expect(c2.result).toBe("PARTIAL");
    expect(c2.checks?.name).toBe("TRUNCATED");
    expect(c2.reasons.join(" ")).toMatch(/cut short/);
  });

  it("a full name but no account on file is PARTIAL, not MATCH", () => {
    expect(checkSlip(slip(), null, typed, { ...guide, accountNo: null }, []).result).toBe("PARTIAL");
  });

  it("MISMATCH: another account", () => {
    const c = checkSlip(slip({ mask: "xxx-x-x9999-x" }), null, typed, guide, []);
    expect(c.result).toBe("MISMATCH");
    expect(c.checks?.account).toBe("MISMATCH");
  });

  it("MISMATCH: the slip shows another guide — named by ID, never by name", () => {
    const c = checkSlip(slip({ names: ["น.ส. สมหญิง รักดี", "MS. SOMYING RAKDEE"], mask: "xxx-x-x6789-x" }), null, typed, guide, [other]);
    expect(c.result).toBe("MISMATCH");
    expect(c.checks?.otherGuideId).toBe("G-991");
    expect(c.reasons.join(" ")).toContain("G-991");
  });

  it("MISMATCH: a different reference, amount or date than the one typed", () => {
    expect(checkSlip(slip(), null, { ...typed, txRef: "TRXX99031099999" }, guide, []).result).toBe("MISMATCH");
    expect(checkSlip(slip(), null, { ...typed, amount: 1600 }, guide, []).result).toBe("MISMATCH");
    expect(checkSlip(slip(), null, { ...typed, advanceDate: "2099-03-10" }, guide, []).result).toBe("MISMATCH");
    // A พ.ศ. year typed into the Gregorian field: still a mismatch, but it says why.
    const be = checkSlip(slip(), null, { ...typed, advanceDate: "2642-03-09" }, guide, []);
    expect(be.result).toBe("MISMATCH");
    expect(be.reasons.join(" ")).toMatch(/Buddhist-era year/);
    // An amount not typed yet is said as such — not blamed on the slip.
    const empty = checkSlip(slip(), null, { ...typed, amount: null }, guide, []);
    expect(empty.reasons.join(" ")).toMatch(/The amount is not typed yet/);
    expect(empty.reasons.join(" ")).not.toMatch(/could not all be read from the slip/);
  });

  it("the reference is compared by its key: spaces and case do not make it different", () => {
    expect(checkSlip(slip(), null, { ...typed, txRef: " trxx 9903 1012 345" }, guide, []).checks?.transactionId).toBe("SAME");
  });

  it("UNKNOWN: an unreadable slip", () => {
    const c = checkSlip(null, "an image — FolkOPS does not read pictures; check the slip by eye", typed, guide, []);
    expect(c.result).toBe("UNKNOWN");
    expect(c.reasons[1]).toMatch(/Check the recipient, account, amount, date and reference by eye/);
  });

  it("what is kept on the advance holds results and masked digits — no names", () => {
    const d = storedDetail(checkSlip(slip(), null, typed, guide, [other]));
    expect(JSON.stringify(d)).not.toMatch(/SOMCHAI|สมชาย|JAIDEE/);
    expect(d.accountMask).toBe("xxx-x-x4321-x");
  });
});

describe("what a person must do before it is recorded", () => {
  const no = { confirmed: false, override: false, reason: null };
  it("MATCH records as it is", () => expect(slipGate("MATCH", no, "OPERATOR")).toBeNull());
  it("PARTIAL needs the tick AND a reason", () => {
    expect(slipGate("PARTIAL", no, "OPERATOR")).not.toBeNull();
    expect(slipGate("PARTIAL", { ...no, confirmed: true }, "OPERATOR")).not.toBeNull();
    expect(slipGate("PARTIAL", { ...no, confirmed: true, reason: "short" }, "OPERATOR")).not.toBeNull();
    expect(slipGate("PARTIAL", { ...no, confirmed: true, reason: "bank cut the surname" }, "OPERATOR")).toBeNull();
  });
  it("UNKNOWN needs the tick", () => {
    expect(slipGate("UNKNOWN", no, "OPERATOR")).not.toBeNull();
    expect(slipGate("UNKNOWN", { ...no, confirmed: true }, "OPERATOR")).toBeNull();
  });
  it("MISMATCH: never for an operator; an ADMIN overrides only with a reason", () => {
    expect(slipGate("MISMATCH", { confirmed: true, override: true, reason: "checked with the bank statement" }, "OPERATOR")).not.toBeNull();
    expect(slipGate("MISMATCH", { ...no, override: true }, "ADMIN")).not.toBeNull();
    expect(slipGate("MISMATCH", { ...no, override: true, reason: "checked with the bank statement" }, "ADMIN")).toBeNull();
  });
});
