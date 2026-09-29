import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  parse: vi.fn(), ensure: vi.fn(),
  db: { tour: { findUnique: vi.fn() }, user: { findFirst: vi.fn(), findMany: vi.fn() }, assignment: { upsert: vi.fn() }, jobSheet: { upsert: vi.fn() } },
}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "op", role: "ADMIN" } }) }));
vi.mock("@/lib/db", () => ({ prisma: mocks.db }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn() }));
vi.mock("@/lib/jobsheet-xlsx", () => ({ parseJobSheetXlsx: mocks.parse }));
vi.mock("@/lib/jobref", () => ({ ensureJobRef: mocks.ensure }));
import { POST } from "./route";
const savedRef = "FOLK-BKK-20300513-02";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue({ tourId: "T-001", guideId: "G-002", date: "2030-05-13", slotIdx: 0, ref: "FOLK-BKK-20300101-01", bookings: [], expenses: [], guideFee: {} });
  mocks.db.tour.findUnique.mockResolvedValue({ id: "T-001", name: "Tour" });
  mocks.db.user.findFirst.mockResolvedValue({ id: "u", guideId: "G-002" });
  mocks.db.jobSheet.upsert.mockResolvedValue({ id: "sheet", ref: savedRef });
  mocks.ensure.mockResolvedValue(savedRef);
});
async function post() {
  const form = new FormData();
  form.append("file", new Blob(["xlsx"]), "old.xlsx");
  return POST(new Request("http://localhost/api/jobsheet/import", { method: "POST", body: form }) as Parameters<typeof POST>[0]);
}
it("ignores the file ref on create and preserves the saved ref on re-import", async () => {
  const result = await (await post()).json();
  expect(result.imported).toBe(1);
  expect(result.results[0].ref).toBe(savedRef);
  const args = mocks.db.jobSheet.upsert.mock.calls[0][0];
  expect(args.create.ref).toBeNull();                 // never the file's number
  expect(args.update).not.toHaveProperty("ref");      // a saved number is never overwritten
  expect(mocks.ensure).toHaveBeenCalledWith("sheet", "2030-05-13");
  expect(result.results[0].detail).toContain("file says FOLK-BKK-20300101-01"); // the paper stays traceable
});
it("does not copy a source ref when a guide is remapped by name", async () => {
  mocks.parse.mockResolvedValue({ ...(await mocks.parse()), guideId: "OLD", guideName: "Guide Name Test" });
  mocks.db.user.findFirst.mockResolvedValue(null);
  mocks.db.user.findMany.mockResolvedValue([{ id: "u", guideId: "G-002", fullName: "Guide Name Test", displayName: "Guide Name Test" }]);
  const result = await (await post()).json();
  expect(result.imported).toBe(1);
  expect(mocks.db.jobSheet.upsert.mock.calls[0][0].create).toMatchObject({ guideId: "G-002", ref: null });
});
