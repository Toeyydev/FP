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

  it("prefers a payment-named array over an unrelated one", () => {
    // Picking "the first array" could latch onto something else entirely and
    // quietly return the wrong list — which is indistinguishable from PEAK only
    // having one method.
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { auditTrail: [{ id: "x" }], paymentMethods: methods } });
    expect("methods" in r && r.methods.map((m) => m.id)).toEqual(["pm-1", "pm-2"]);
    expect("meta" in r && r.meta.arrayKey).toBe("paymentMethods");
  });

  it("reports raw vs kept so a short list can be diagnosed", () => {
    // The whole point: separates "PEAK has one method" from "we dropped the rest".
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { paymentMethods: [...methods, { name: "no id" }] } });
    if (!("meta" in r)) throw new Error("expected meta");
    expect(r.meta.rawCount).toBe(3);
    expect(r.meta.droppedNoId).toBe(1);
    expect(r.methods).toHaveLength(2);
  });

  it("a genuinely single-method response reports rawCount 1, nothing dropped", () => {
    const cash = [{ id: "f97fbb93-ec33-45f0-862d-2362122ae2e4", code: "CSH001", name: "เงินสด" }];
    const r = parsePeakPaymentMethods({ peakPaymentMethods: { paymentMethods: cash } });
    if (!("meta" in r)) throw new Error("expected meta");
    expect(r.meta).toMatchObject({ rawCount: 1, droppedNoId: 0 });
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
