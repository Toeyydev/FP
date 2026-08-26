import { describe, it, expect } from "vitest";
import { parsePeakPaymentMethods } from "@/lib/peak-api";

// PEAK's docs list the payment-method object's fields but never name the array key
// inside the PeakPaymentMethods wrapper, so this parser has to tolerate the naming
// and fail loudly rather than silently returning nothing.
describe("PEAK payment-method parsing", () => {
  const methods = [
    { id: "pm-1", code: "1001", name: "กสิกรไทย ออมทรัพย์", type: "bank", bankName: "KBank", accountNumber: "xxx-x-x1234-x" },
    { id: "pm-2", code: "1002", name: "เงินสด", type: "cash" },
  ];

  it("finds the array whatever the wrapper calls it", () => {
    for (const key of ["paymentMethods", "paymentMethod", "methods"]) {
      const r = parsePeakPaymentMethods({ peakPaymentMethods: { [key]: methods } });
      expect("methods" in r && r.methods.map((m) => m.id), `key ${key}`).toEqual(["pm-1", "pm-2"]);
    }
  });

  it("reads the capitalised wrapper PEAK returns on responses", () => {
    const r = parsePeakPaymentMethods({ PeakPaymentMethods: { paymentMethods: methods } });
    expect("methods" in r && r.methods).toHaveLength(2);
  });

  it("keeps the bank details that let an operator tell two accounts apart", () => {
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { paymentMethods: methods } });
    if (!("methods" in r)) throw new Error("expected methods");
    expect(r.methods[0]).toEqual({
      id: "pm-1", code: "1001", name: "กสิกรไทย ออมทรัพย์", type: "bank",
      bankName: "KBank", accountNumber: "xxx-x-x1234-x",
    });
  });

  it("drops entries with no id — an id is what the payout posts", () => {
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { paymentMethods: [...methods, { name: "no id" }] } });
    expect("methods" in r && r.methods).toHaveLength(2);
  });

  it("an unrecognised shape is an error naming the keys seen, never silence", () => {
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { totalMethods: 2 } });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("totalMethods");
  });

  it("never leaks values into the diagnostic", () => {
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { odd: "ควรจะไม่ปรากฏ" } });
    if (!("error" in r)) throw new Error("expected error");
    expect(r.error).toContain("odd");
    expect(r.error).not.toContain("ควรจะไม่ปรากฏ");
  });
});
