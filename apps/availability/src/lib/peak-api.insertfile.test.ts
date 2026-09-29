import { describe, it, expect, vi, afterEach } from "vitest";
import { insertFileBody, insertFileEncodingRejected, insertFileSucceeded } from "./peak-api";

// Expenses/insertfile documents success as resCode "200" — the opposite of the list
// endpoints, where any non-zero code is an error. Reading it with peakCodeIsError would
// report every attached slip as a failure.

describe("insertFileSucceeded", () => {
  it("accepts PEAK's documented success", () => {
    expect(insertFileSucceeded(200, { resCode: "200", resDesc: "Success" })).toEqual({ ok: true, desc: "Success" });
  });

  it("accepts the same reply inside a peakExpenses wrapper", () => {
    expect(insertFileSucceeded(200, { peakExpenses: { resCode: "200", resDesc: "Success" } }).ok).toBe(true);
  });

  it("reports PEAK's documented error, which arrives with HTTP 200", () => {
    expect(insertFileSucceeded(200, { resCode: "400", resDesc: "Bad Json Request : Missing Transaction Code or UUID" }))
      .toEqual({ ok: false, desc: "Bad Json Request : Missing Transaction Code or UUID" });
  });

  it("does not call a reply with no result code a success", () => {
    expect(insertFileSucceeded(200, {}).ok).toBe(false);
  });

  it("fails on a transport error status even with a success code", () => {
    expect(insertFileSucceeded(502, { resCode: "200" }).ok).toBe(false);
  });
});

describe("insertFileBody — how the slip travels", () => {
  const input = { transactionId: "doc-42", transactionCode: "EXP-TEST-0042", fileName: "EXP-TEST-0042-slip.jpg", base64: "/9j/4AAQSkZJRg==", fileType: "image" as const, mime: "image/jpeg" };

  it("sends a data URI first — plain base64 was refused by PEAK as 'Invalid Base64 string.'", () => {
    expect(insertFileBody(input, "data-uri")).toEqual({ peakExpenses: { transactionId: "doc-42", transactionCode: "EXP-TEST-0042", file: { fileName: "EXP-TEST-0042-slip.jpg", rawString: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", fileType: "image" } } });
  });
  it("can send plain base64, and never doubles a prefix that is already there", () => {
    expect(insertFileBody(input, "plain").peakExpenses.file.rawString).toBe("/9j/4AAQSkZJRg==");
    expect(insertFileBody({ ...input, base64: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }, "data-uri").peakExpenses.file.rawString).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  });
  it("without a MIME type there is no data URI to build", () => {
    expect(insertFileBody({ ...input, mime: null }, "data-uri").peakExpenses.file.rawString).toBe("/9j/4AAQSkZJRg==");
  });
});

describe("insertFileEncodingRejected — only an encoding refusal is worth the other encoding", () => {
  it("recognises PEAK's base64 refusal", () => {
    expect(insertFileEncodingRejected("Invalid Base64 string.")).toBe(true);
    expect(insertFileEncodingRejected("The input is not a valid Base-64 string")).toBe(true);
  });
  it("treats anything else as final", () => {
    expect(insertFileEncodingRejected("Bad Json Request : Missing Transaction Code or UUID")).toBe(false);
    expect(insertFileEncodingRejected(undefined)).toBe(false);
  });
});

describe("insertExpenseFile — how many times it goes to PEAK", () => {
  const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  const TOKEN = reply({ peakClientToken: { token: "ct-fresh" } });
  const BAD_BASE64 = reply({ resCode: "400", resDesc: "Invalid Base64 string." });
  const OK = reply({ resCode: "200", resDesc: "Success" });
  const input = { transactionId: "doc-42", transactionCode: "EXP-TEST-0042", fileName: "EXP-TEST-0042-slip.jpg", base64: "/9j/4AAQ", fileType: "image" as const, mime: "image/jpeg" };

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
  const sent = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/Expenses/insertfile"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).peakExpenses.file.rawString);
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  it("attaches with a data URI in one call when PEAK accepts it", async () => {
    const { mod, fetchMock } = await withPeak(TOKEN, OK);
    expect(await mod.insertExpenseFile(input)).toEqual({ ok: true, desc: "Success" });
    expect(sent(fetchMock)).toEqual(["data:image/jpeg;base64,/9j/4AAQ"]);
  });

  it("tries plain base64 once when PEAK refuses the data URI's encoding", async () => {
    const { mod, fetchMock } = await withPeak(TOKEN, BAD_BASE64, OK);
    expect((await mod.insertExpenseFile(input)).ok).toBe(true);
    expect(sent(fetchMock)).toEqual(["data:image/jpeg;base64,/9j/4AAQ", "/9j/4AAQ"]);
  });

  it("reports both refusals and stops after two tries", async () => {
    const { mod, fetchMock } = await withPeak(TOKEN, BAD_BASE64, BAD_BASE64);
    const r = await mod.insertExpenseFile(input);
    expect(r).toEqual({ ok: false, desc: "Invalid Base64 string. (data URI); Invalid Base64 string. (plain base64)" });
    expect(sent(fetchMock)).toHaveLength(2);
  });

  it("does not try again after any other error — it may not be about the file at all", async () => {
    const { mod, fetchMock } = await withPeak(TOKEN, reply({ resCode: "400", resDesc: "Bad Json Request : Missing Transaction Code or UUID" }));
    expect((await mod.insertExpenseFile(input)).ok).toBe(false);
    expect(sent(fetchMock)).toHaveLength(1);
  });
});
