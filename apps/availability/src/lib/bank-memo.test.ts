import { describe, expect, it } from "vitest";
import { advanceMemo, MEMO_MAX, payMemo, refundMemo, returnMemo, reviewMemo } from "@/lib/bank-memo";

// All data invented — this repo is public.
describe("bank memo — what to type in the bank app before the money moves", () => {
  it("an advance and a guide's return name the full Job No.", () => {
    expect(advanceMemo(["FOLK-BKK-20990920-01"])).toBe("ADV FOLK-BKK-20990920-01");
    expect(returnMemo("FOLK-BKK-20990920-01")).toBe("RTN FOLK-BKK-20990920-01");
  });
  it("one job's pay names the job; with the review in the same transfer it says so", () => {
    expect(payMemo({ guideId: "G-900", jobs: [{ jobNo: "FOLK-BKK-20990920-01", date: "2099-09-20" }] })).toBe("PAY FOLK-BKK-20990920-01");
    expect(payMemo({ guideId: "G-900", jobs: [{ jobNo: "FOLK-BKK-20990920-01", date: "2099-09-20" }], withReview: true })).toBe("PAY+REV FOLK-BKK-20990920-01");
  });
  it("several jobs in one transfer: the guide and the tour dates", () => {
    expect(payMemo({ guideId: "G-900", jobs: [{ jobNo: "FOLK-BKK-20990915-01", date: "2099-09-15" }, { jobNo: "FOLK-BKK-20990901-02", date: "2099-09-01" }] })).toBe("PAY G-900 0901-0915");
    expect(advanceMemo(["FOLK-BKK-20990920-02", "FOLK-BKK-20990920-01"], "G-900")).toBe("ADV G-900 0920");
  });
  it("a review incentive and a refund", () => {
    expect(reviewMemo("G-900", "2099-09")).toBe("REV G-900 2099-09");
    expect(refundMemo("FOLK-ADV-209909-003")).toBe("RFD FOLK-ADV-209909-003");
  });
  it("never longer than the bank keeps when it can help it: FOLK- is dropped first", () => {
    const long = payMemo({ guideId: "G-900", jobs: [{ jobNo: "FOLK-CNX-20990920-01", date: "2099-09-20" }], withReview: true });
    expect(long.length).toBeLessThanOrEqual(MEMO_MAX);
    expect(advanceMemo(["FOLK-LONGERCITY-20990920-01"])).toBe("ADV LONGERCITY-20990920-01"); // 31 with FOLK-
    for (const m of [advanceMemo(["FOLK-BKK-20990920-01"]), refundMemo("FOLK-ADV-209909-003"), reviewMemo("G-900", "2099-09")]) expect(m.length).toBeLessThanOrEqual(MEMO_MAX);
  });
});
