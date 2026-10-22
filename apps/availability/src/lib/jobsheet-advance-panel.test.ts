import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Job Sheet advance panel", () => {
  it("stays visible to an operator before the job has an advance", () => {
    const ui = readFileSync(join(process.cwd(), "src/components/JobSheetEditor.tsx"), "utf8");
    expect(ui).toContain("advanceLoaded && (canEdit || hasAdvance)");
    expect(ui).toContain("No advance recorded for this job");
    expect(ui).not.toContain("(hasAdvance || (canEdit && advRows > 0))");
  });
});
