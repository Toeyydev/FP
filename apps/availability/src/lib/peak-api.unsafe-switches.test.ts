import { afterEach, describe, expect, it, vi } from "vitest";

// Every write to PEAK goes through lib/peak-api. With both PEAK switches on in this service
// (lib/peak-switches: UNSAFE), each write function refuses BEFORE any request is made —
// not "uncertain": nothing left the process. Reads are untouched.
async function client(autoSync: string, links: string) {
  vi.resetModules();
  vi.stubEnv("PEAK_CONNECT_ID", "cid"); vi.stubEnv("PEAK_CONNECT_KEY", "ckey"); vi.stubEnv("PEAK_USER_TOKEN", "utok");
  vi.stubEnv("PEAK_API_BASE_URL", "https://peak.test/api/v1");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", autoSync); vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", links);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return { mod: await import("@/lib/peak-api"), fetchMock };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("PEAK writes while the switches are unsafe", () => {
  it("every write refuses and nothing is sent", async () => {
    const { mod, fetchMock } = await client("1", "1");
    const results = [
      await mod.createExpenseAllInOne({}),
      await mod.insertExpenseFile({ transactionId: "t", fileName: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") } as never),
      await mod.payExistingExpense({ documentNo: "EXP-1", paymentDate: "20990309", paymentMethodId: "m", amount: 1 }),
      await mod.createContact({ name: "Example", prefixNameType: 5, taxNumber: "0000000000000" }),
      await mod.createDailyJournal({ issuedDate: "20990309", journalTypeId: "5", contactId: "c", reference: "r", journalEntries: [] } as never),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.desc).toBe(mod.PEAK_WRITE_UNSAFE);
      expect((r as { uncertain?: boolean }).uncertain ?? false).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("one switch on is not unsafe: the write is attempted", async () => {
    const { mod, fetchMock } = await client("1", "0");
    await mod.createDailyJournal({ issuedDate: "20990309", journalTypeId: "5", contactId: "c", reference: "r", journalEntries: [] } as never);
    expect(fetchMock).toHaveBeenCalled();
  });
});
