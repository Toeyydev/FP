import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Job Sheet Record advance", () => {
  it("lets an operator open the existing advance form directly on the sheet", () => {
    const ui = readFileSync(join(process.cwd(), "src/components/JobSheetEditor.tsx"), "utf8");
    // On the Company advance line itself, visible without opening Details (owner, 2026-11-07).
    expect(ui).toContain('className="btn sm js-advance-record"');
    expect(ui).toContain('setAdvKind("advance")');
    expect(ui).toContain(">+ Record advance</button>");
    expect(ui).toContain('onClick={() => submitAdvance(advKind)}');
    expect(ui).toContain('<SlipCheckPanel');
  });
});
