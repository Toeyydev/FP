import { describe, it, expect } from "vitest";
import { insertFileSucceeded } from "./peak-api";

// Expenses/insertfile documents success as resCode "200" — the opposite of the list
// endpoints, where any non-zero code is an error. Reading it with peakCodeIsError would
// report every attached slip as a failure.

describe("insertFileSucceeded", () => {
  it("accepts PEAK's documented success", () => {
    expect(insertFileSucceeded(200, { resCode: "200", resDesc: "Success" })).toEqual({ ok: true, desc: "Success" });
  });

  it("accepts the same reply inside a peakExpenses wrapper", () => {
    expect(insertFileSucceeded(200, { peakExpenses: { resCode: "200", resDesc: "Success" } }).ok).toBe(true);
  });

  it("reports PEAK's documented error, which arrives with HTTP 200", () => {
    expect(insertFileSucceeded(200, { resCode: "400", resDesc: "Bad Json Request : Missing Transaction Code or UUID" }))
      .toEqual({ ok: false, desc: "Bad Json Request : Missing Transaction Code or UUID" });
  });

  it("does not call a reply with no result code a success", () => {
    expect(insertFileSucceeded(200, {}).ok).toBe(false);
  });

  it("fails on a transport error status even with a success code", () => {
    expect(insertFileSucceeded(502, { resCode: "200" }).ok).toBe(false);
  });
});
