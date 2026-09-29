import { vi, describe, it, expect, beforeEach } from "vitest";

// ensureJobRef with a mocked database: the rolling-deploy collision and the never-replace rules.
// The PostgreSQL behaviour of the counter itself is covered by jobref.integration.test.ts.
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  jobSheet: { findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
import { ensureJobRef } from "./jobref";

let seq = 0; let stored: string | null = null;
beforeEach(() => {
  vi.clearAllMocks(); seq = 4; stored = null;
  db.$queryRaw.mockImplementation(async () => [{ lastSeq: BigInt(++seq) }]);
  db.jobSheet.findUniqueOrThrow.mockImplementation(async () => ({ ref: stored }));
  db.jobSheet.updateMany.mockImplementation(async ({ where, data }) => {
    const matches = where.OR ? stored == null || stored === "" : stored === where.ref;
    if (matches) stored = data.ref;
    return { count: matches ? 1 : 0 };
  });
  db.jobSheet.count.mockResolvedValue(0);
});

describe("ensureJobRef", () => {
  it("never replaces a number a sheet already has, even one another sheet shares", async () => {
    stored = "FOLK-BKK-20300101-02";
    expect(await ensureJobRef("s1", "2030-01-01")).toBe("FOLK-BKK-20300101-02");
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.jobSheet.updateMany).not.toHaveBeenCalled();
  });

  it("numbers an unnumbered sheet", async () => {
    expect(await ensureJobRef("s1", "2030-01-01")).toBe("FOLK-BKK-20300101-05");
  });

  it("takes a fresh number when an older instance wrote the same one meanwhile", async () => {
    db.jobSheet.count.mockResolvedValueOnce(1).mockResolvedValue(0); // -05 turned out to be held by another sheet
    expect(await ensureJobRef("s1", "2030-01-01")).toBe("FOLK-BKK-20300101-06");
    expect(db.jobSheet.updateMany).toHaveBeenLastCalledWith({ where: { id: "s1", ref: "FOLK-BKK-20300101-05" }, data: { ref: "FOLK-BKK-20300101-06" } });
  });

  it("does not re-check or change a number another request attached first", async () => {
    db.jobSheet.updateMany.mockImplementationOnce(async () => { stored = "FOLK-BKK-20300101-09"; return { count: 0 }; });
    expect(await ensureJobRef("s1", "2030-01-01")).toBe("FOLK-BKK-20300101-09");
    expect(db.jobSheet.count).not.toHaveBeenCalled();
  });
});
