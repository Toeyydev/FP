import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { serviceAccountConfig, serviceAccountAssertion, serviceAccountAccessToken, resetServiceAccountTokenCache, SERVICE_ACCOUNT_SCOPE, TOKEN_URL } from "./drive-service-account";

// A key made for this test run only — no real credential is in this repo (it is public).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
const EMAIL = "folkops-drive@example-project.iam.gserviceaccount.com";
const ENV = { GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: EMAIL, GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") };
const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString());

beforeEach(() => { resetServiceAccountTokenCache(); Object.assign(process.env, ENV); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL; delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY; });

describe("service account configuration", () => {
  it("reads both variables and turns the stored \\n escapes back into a PEM", () => {
    expect(serviceAccountConfig(ENV)).toEqual({ email: EMAIL, privateKey: PEM });
  });
  it("is null when either is missing or is not a service account key", () => {
    expect(serviceAccountConfig({})).toBeNull();
    expect(serviceAccountConfig({ ...ENV, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: "" })).toBeNull();
    expect(serviceAccountConfig({ ...ENV, GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: "" })).toBeNull();
    expect(serviceAccountConfig({ ...ENV, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: "admin@folkpaths.example" })).toBeNull(); // a person, not a service account
    expect(serviceAccountConfig({ ...ENV, GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: "not-a-key" })).toBeNull();
  });
});

describe("the signed assertion", () => {
  it("is RS256, for the token endpoint, the drive scope, one hour, signed by the key", () => {
    const jwt = serviceAccountAssertion(serviceAccountConfig(ENV)!, 1_900_000_000);
    expect(part(jwt, 0)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(part(jwt, 1)).toEqual({ iss: EMAIL, scope: SERVICE_ACCOUNT_SCOPE, aud: TOKEN_URL, iat: 1_900_000_000, exp: 1_900_003_600 });
    const [h, c, sig] = jwt.split(".");
    const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
  it("impersonates nobody: no sub claim, so no domain-wide delegation", () => {
    expect(part(serviceAccountAssertion(serviceAccountConfig(ENV)!), 1)).not.toHaveProperty("sub");
  });
});

describe("minting an access token", () => {
  it("exchanges the assertion with the jwt-bearer grant, then reuses the token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "sa-token-1", expires_in: 3599 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await serviceAccountAccessToken()).toBe("sa-token-1");
    expect(await serviceAccountAccessToken()).toBe("sa-token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(part(form.get("assertion")!, 1).iss).toBe(EMAIL);
  });
  it("refuses without configuration, before any request", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY;
    await expect(serviceAccountAccessToken()).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a refusal from Google never carries the key or the assertion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    const err = await serviceAccountAccessToken().catch((e: Error) => e);
    expect((err as Error).message).toBe("drive-service-account: token refused (400 invalid_grant)");
    expect((err as Error).message).not.toContain("PRIVATE KEY");
  });
});
