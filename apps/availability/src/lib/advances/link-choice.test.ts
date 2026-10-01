import { describe, expect, it } from "vitest";
import { linkAdvanceRows } from "./link";
import type { SheetRow } from "./settlement";

// An explicit advance choice is an instruction (Phase 1F rehearsal finding): the server honours
// it through the same eligibility checks, or refuses it — it is never silently ignored because
// the row already carries a link. Invented data.
const job = { guideId: "G-990", date: "2099-01-02", slotIdx: 0 };
const adv = (id: string, no: string, cats: string[]) => ({ id, advanceNo: no, ...job, reversedAt: null, allowedCategories: cats });
const A = adv("adv-a", "FOLK-ADV-209901-001", ["entrance"]);
const B = adv("adv-b", "FOLK-ADV-209901-002", ["entrance"]);
const M = adv("adv-m", "FOLK-ADV-209901-003", ["meal"]);
const ticket = (over: Partial<SheetRow> = {}) => ({ description: "Temple ticket", expenseType: "entrance", price: 500, pax: 1, paidBy: "advance", paidBySource: "operator", ...over }) as SheetRow;

describe("an explicit advance choice for a row that is already linked", () => {
  it("moves the link to the chosen advance when it may pay for the row", () => {
    const row = ticket({ advanceId: "adv-b" });
    const out = linkAdvanceRows([row], [row], [A, B], job, [{ index: 0, advanceId: "adv-a" }]);
    expect(out.problems).toEqual([]);
    expect(out.rows[0].advanceId).toBe("adv-a");
    expect(out.changes).toEqual([{ row: 'Row 1 "Temple ticket"', from: "FOLK-ADV-209901-002", to: "FOLK-ADV-209901-001" }]);
  });
  it("is refused, not ignored, when the chosen advance cannot pay for the row", () => {
    const row = ticket({ advanceId: "adv-b" });
    const out = linkAdvanceRows([row], [row], [A, B, M], job, [{ index: 0, advanceId: "adv-m" }]);
    expect(out.problems.join(" ")).toMatch(/that advance cannot pay for this row/);
  });
  it("is refused for a settled row when it names another advance; the same advance is fine", () => {
    const row = ticket({ advanceId: "adv-b", advanceSettlement: { entryId: "e1", advanceId: "adv-b", advanceNo: "FOLK-ADV-209901-002" } });
    expect(linkAdvanceRows([row], [row], [A, B], job, [{ index: 0, advanceId: "adv-a" }]).problems.join(" ")).toMatch(/settled against FOLK-ADV-209901-002/);
    const same = linkAdvanceRows([row], [row], [A, B], job, [{ index: 0, advanceId: "adv-b" }]);
    expect(same.problems).toEqual([]);
    expect(same.rows[0].advanceId).toBe("adv-b");
  });
  it("with no choice, an existing valid link is kept as before", () => {
    const row = ticket({ advanceId: "adv-b" });
    const out = linkAdvanceRows([row], [row], [A, B], job, []);
    expect(out.problems).toEqual([]);
    expect(out.rows[0].advanceId).toBe("adv-b");
  });
});
