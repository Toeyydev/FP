import { describe, it, expect, vi, afterEach } from "vitest";
import { clientTokenRejected } from "@/lib/peak-api";

// The client token is cached for 50 minutes and nothing noticed when PEAK stopped
// accepting it: every real call then failed with "Invalid Client Token" until the
// cache aged out, while "Test connection" kept passing because it forces a fresh
// token. That is what left zero guides mapped and no job sheet postable.
//
// These count fetch calls rather than read the code, because the thing worth pinning
// down is how many times we go to PEAK — once for a healthy read, twice when the
// token was stale, and NEVER twice for a write.

const reply = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const TOKEN = { peakClientToken: { token: "ct-fresh" } };
// PEAK answers application errors with HTTP 200, so a rejection looks like this.
const REJECTED = { peakContacts: { resCode: "4001", resDesc: "Invalid Client Token" } };
const CONTACTS = { peakContacts: { contacts: [{ id: "ct-1", name: "สมชาย ใจดี", taxNumber: "1234567890123" }] } };

/** A fresh copy of the module, so the cached token from one test cannot leak. */
async function withPeak(...replies: Response[]) {
  vi.resetModules();
  vi.stubEnv("PEAK_CONNECT_ID", "cid");
  vi.stubEnv("PEAK_CONNECT_KEY", "ckey");
  vi.stubEnv("PEAK_USER_TOKEN", "utok");
  vi.stubEnv("PEAK_API_BASE_URL", "https://peak.test/api/v1");
  const fetchMock = vi.fn();
  for (const r of replies) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  const mod = await import("@/lib/peak-api");
  return { mod, fetchMock };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("clientTokenRejected", () => {
  it("recognises PEAK's own wording", () => {
    expect(clientTokenRejected(200, "4001", "Invalid Client Token")).toBe(true);
    expect(clientTokenRejected(200, null, "client token expired")).toBe(true);
    expect(clientTokenRejected(200, "TOKEN_UNAUTHORIZED", null)).toBe(true);
  });

  it("treats an HTTP 401 as a rejection whatever the body says", () => {
    expect(clientTokenRejected(401, null, null)).toBe(true);
  });

  it("is not fooled by other failures — retrying those would be pointless", () => {
    expect(clientTokenRejected(200, "4002", "Invalid API Validate Data. (TimeStamp)")).toBe(false);
    expect(clientTokenRejected(200, null, "No contact found")).toBe(false);
    expect(clientTokenRejected(500, null, "Internal error")).toBe(false);
    expect(clientTokenRejected(200, null, null)).toBe(false);
  });
});

describe("a read whose token went stale", () => {
  it("mints a new token and succeeds on the second attempt", async () => {
    const { mod, fetchMock } = await withPeak(
      reply(TOKEN),     // 1. mint
      reply(REJECTED),  // 2. read → token rejected
      reply(TOKEN),     // 3. mint again
      reply(CONTACTS),  // 4. read → data
    );
    const r = await mod.getContacts();
    expect(r.ok).toBe(true);
    expect(r.contacts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after ONE retry rather than looping against PEAK", async () => {
    const { mod, fetchMock } = await withPeak(
      reply(TOKEN), reply(REJECTED), reply(TOKEN), reply(REJECTED),
    );
    const r = await mod.getContacts();
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not re-mint when the read simply worked", async () => {
    const { mod, fetchMock } = await withPeak(reply(TOKEN), reply(CONTACTS));
    const r = await mod.getContacts();
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure that has nothing to do with the token", async () => {
    const { mod, fetchMock } = await withPeak(
      reply(TOKEN),
      reply({ peakContacts: { resCode: "4002", resDesc: "Invalid API Validate Data. (TimeStamp)" } }),
    );
    const r = await mod.getContacts();
    expect(r.ok).toBe(false);
    expect(r.desc).toContain("TimeStamp");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("a write", () => {
  it("is never sent twice, even when the token is rejected", async () => {
    // The point of the whole design: replaying a write can book a SECOND expense
    // document if the first reached PEAK and only the reply was lost. One extra
    // handshake beforehand is the cost of never having to guess.
    const { mod, fetchMock } = await withPeak(
      reply(TOKEN),
      reply({ peakExpenses: { expenses: [{ resCode: "4001", resDesc: "Invalid Client Token" }] } }),
    );
    const r = await mod.createExpenseAllInOne({ issuedDate: "20260912" });
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // mint + one post. Never a third.
  });

  it("mints a token immediately before posting, never reusing a cached one", async () => {
    const { mod, fetchMock } = await withPeak(
      reply(TOKEN), reply(CONTACTS),                                    // a read warms the cache
      reply(TOKEN),                                                     // the write mints anyway
      reply({ peakExpenses: { expenses: [{ code: "EXP-1", id: "d1" }] } }),
    );
    await mod.getContacts();
    const r = await mod.createExpenseAllInOne({ issuedDate: "20260912" });
    expect(r).toMatchObject({ ok: true, code: "EXP-1" });
    // 4 calls: the read's mint + read, then a FRESH mint + the post.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((fetchMock.mock.calls[2][0] as string)).toContain("/ClientToken");
    expect((fetchMock.mock.calls[3][0] as string)).toContain("/Expenses/allinone");
  });
});
