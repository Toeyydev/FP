import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Job Sheet company-advance payer option", () => {
  it("is always offered and is not silently cleared when the category changes", () => {
    const ui = readFileSync(join(process.cwd(), "src/components/JobSheetEditor.tsx"), "utf8");
    expect(ui).toContain("{PAYMENT_SOURCES.map((s) => <option");
    expect(ui).not.toContain('PAYMENT_SOURCES.filter((s) => s.value !== "advance"');
    expect(ui).not.toContain('paid === "GUIDE_ADVANCE" && !advancesFor(expenseType).length');
  });
});
