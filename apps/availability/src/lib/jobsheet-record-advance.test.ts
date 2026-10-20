import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Job Sheet Record advance", () => {
  it("lets an operator open the existing advance form directly on the sheet", () => {
    const ui = readFileSync(join(process.cwd(), "src/components/JobSheetEditor.tsx"), "utf8");
    expect(ui).toContain('{canEdit && <button className="btn sm"');
    expect(ui).toContain('advKind === "advance" ? "Cancel" : "+ Record advance"');
    expect(ui).toContain('onClick={() => submitAdvance(advKind)}');
    expect(ui).toContain('<SlipCheckPanel');
  });
});
