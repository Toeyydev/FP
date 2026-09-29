import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { resolveMatchContext } from "./resolve";
import { decideMatch } from "./match";

const ref = "FOLK-BKK-20300513-01";
const sheet = { id: "a", ref, guideId: "G-001", expenses: [], guideFee: { price: 1000, time: 1, whtPct: 0 } };
const other = { ...sheet, id: "b", guideId: "G-002" };
function db(sheets: typeof sheet[]) {
  return { jobSheet: { findMany: vi.fn().mockResolvedValue(sheets) }, paymentTransaction: { findUnique: vi.fn() } } as unknown as PrismaClient;
}
const input = { bankTransactionId: null, memoRaw: ref, transferAmount: 1000 };
describe("shared job references", () => {
  it("uses the target guide to resolve a shared reference", async () => {
    const { ctx } = await resolveMatchContext(db([sheet, other]), { ...input, targetGuideId: "G-002" });
    expect(decideMatch(ctx)).toMatchObject({ matchedJobSheetId: "b", shouldMarkPaid: true });
  });
  it("explains ambiguity and never marks an unscoped shared reference paid", async () => {
    const { ctx } = await resolveMatchContext(db([sheet, other]), input);
    expect(decideMatch(ctx)).toMatchObject({ shouldMarkPaid: false, reason: expect.stringContaining("multiple job sheets") });
  });
  it("does not silently select a different guide", async () => {
    const { ctx } = await resolveMatchContext(db([sheet]), { ...input, targetGuideId: "G-002" });
    expect(decideMatch(ctx)).toMatchObject({ shouldMarkPaid: false, memoValidationStatus: "REFERENCE_GUIDE_MISMATCH" });
  });
  it("keeps two slots for the same guide ambiguous", async () => {
    const { ctx } = await resolveMatchContext(db([sheet, { ...sheet, id: "c" }]), { ...input, targetGuideId: "G-001" });
    expect(decideMatch(ctx).shouldMarkPaid).toBe(false);
  });
});
