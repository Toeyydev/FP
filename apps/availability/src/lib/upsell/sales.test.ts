import { describe, expect, it } from "vitest";
import { CLIENT_REF_FIELDS, grossOf, parseSaleRequest, UpsellSaleError } from "./sales";

// The sale request (PR3) — pure parts. The database behaviour is in route-extension.itest.ts.

const ok = { requestKey: "0f6b1c2e-4a3d-4b9e-9c1a-2d7e5f8a9b10", jobSheetId: "job1", productVersionId: "v1", guests: 3, expectedUnitPriceSatang: 20000 };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof UpsellSaleError ? e.code : String(e); } return "OK"; };

describe("the sale request", () => {
  it("takes exactly the five fields", () => {
    expect(parseSaleRequest(ok)).toEqual(ok);
    expect(code(() => parseSaleRequest({ ...ok, unitPriceSatang: 1 }))).toBe("UNKNOWN_FIELD");
    expect(code(() => parseSaleRequest({ ...ok, paymentMethod: "CASH" }))).toBe("UNKNOWN_FIELD");
    expect(code(() => parseSaleRequest({ ...ok, guests: 0 }))).toBe("BAD_REQUEST");
    expect(code(() => parseSaleRequest({ ...ok, guests: 2.5 }))).toBe("BAD_REQUEST");
    expect(code(() => parseSaleRequest({ ...ok, requestKey: "short" }))).toBe("BAD_REQUEST");
    expect(code(() => parseSaleRequest(null))).toBe("BAD_REQUEST");
  });
  it("refuses every system ref, whatever its value — never strips it quietly (P3-10)", () => {
    expect(CLIENT_REF_FIELDS).toEqual(["saleNo", "jobRef", "jobSheetRef", "settlementNo"]);
    for (const f of CLIENT_REF_FIELDS) for (const v of ["", "FOLK-UPS-202611-001", null, undefined]) {
      expect(code(() => parseSaleRequest({ ...ok, [f]: v })), `${f}=${String(v)}`).toBe("CLIENT_SUPPLIED_REF");
    }
  });
  it("gross: guests × unit per guest, the unit per group", () => {
    expect(grossOf("PER_GUEST", 3, 20000)).toBe(60000);
    expect(grossOf("PER_GROUP", 3, 20000)).toBe(20000);
  });
});
