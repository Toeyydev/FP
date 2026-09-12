import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  accessRequest: { findFirst: vi.fn(), create: vi.fn() },
  accessRequestDocument: { create: vi.fn() },
  notification: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue({ sent: false }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { audit } from "@/lib/audit";
vi.mock("bcryptjs", () => ({ default: { hashSync: (v: string) => `bcrypt(${v})` } }));
// Encryption is exercised by its own tests; here we only need to prove the route
// never stores a raw value, so the stubs make that visible in the assertions.
vi.mock("@/lib/crypto", () => ({
  encrypt: (v: string) => `enc(${v})`,
  encOpt: (v?: string | null) => (v && v.trim() ? `enc(${v.trim()})` : null),
  encryptBuffer: (b: Buffer) => Buffer.concat([Buffer.from("enc:"), b]),
}));

import { POST } from "./route";
import { __resetRateLimit } from "@/lib/rate-limit";

const GOOD_ID = "1101700207366";

function file(name: string, type: string, bytes = 1024) {
  return new File([new Uint8Array(bytes)], name, { type });
}

function application(over: Record<string, string> = {}, docs = true) {
  const fd = new FormData();
  const base: Record<string, string> = {
    fullNameThai: "สมชาย ใจดี",
    fullNameEnglish: "Somchai Jaidee",
    nationalId: GOOD_ID,
    phone: "0812345678",
    email: "somchai@example.com",
    licenseNo: "11-12345",
    licenseExpiry: "31/12/2570",
    bankName: "Kasikorn",
    bankAccountName: "Somchai Jaidee",
    bankAccountNo: "1234567890",
    password: "correct horse battery",
    preferredLanguage: "th",
    medicalConditionStatus: "NONE",
    privacyVersion: "2026-09-06",
    privacyConsentAt: "2026-09-04T10:00:00.000Z",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== "") fd.set(k, v);
  if (docs) {
    fd.set("ID_CARD", file("id.jpg", "image/jpeg"));
    fd.set("GUIDE_LICENSE", file("lic.jpg", "image/jpeg"));
    fd.set("BANK_BOOK", file("bank.pdf", "application/pdf"));
  }
  return fd;
}

function req(fd: FormData, ip = "1.2.3.4") {
  return new Request("https://ops.folkpaths.com/api/request", {
    method: "POST", body: fd, headers: { "x-forwarded-for": ip },
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimit();
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.accessRequest.findFirst.mockResolvedValue(null);
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  prismaMock.accessRequest.create.mockResolvedValue({ id: "req_1" });
  prismaMock.accessRequestDocument.create.mockResolvedValue({});
  prismaMock.notification.create.mockResolvedValue({});
});

describe("POST /api/request — mobile application", () => {
  it("creates a PENDING request and returns its id", async () => {
    const res = await POST(req(application()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, requestId: "req_1" });
    expect(prismaMock.accessRequestDocument.create).toHaveBeenCalledTimes(3);
  });

  it("encrypts the national id and bank details, and stores no password", async () => {
    await POST(req(application()));
    const data = prismaMock.accessRequest.create.mock.calls[0][0].data;
    expect(data.nationalId).toBe(`enc(${GOOD_ID})`);
    expect(data.bankAccountNo).toBe("enc(1234567890)");
    expect(data.bankAccountName).toBe("enc(Somchai Jaidee)");
    expect(data.bankName).toBe("enc(Kasikorn)");
    expect(data.passwordHash).toBe("bcrypt(correct horse battery)");
    // The plain text must not survive anywhere on the row.
    expect(JSON.stringify(data)).not.toContain("correct horse battery\"");
    // The Buddhist year became a real Gregorian date.
    expect((data.licenseExpiry as Date).getUTCFullYear()).toBe(2027);
  });

  it("stores documents encrypted, never as raw bytes", async () => {
    await POST(req(application()));
    for (const call of prismaMock.accessRequestDocument.create.mock.calls) {
      const bytes = Array.from(call[0].data.data as ArrayLike<number>).slice(0, 4);
      expect(String.fromCharCode(...bytes)).toBe("enc:");
    }
  });

  it("rejects a password under 8 characters and stores nothing", async () => {
    const res = await POST(req(application({ password: "short" })));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.password).toBe("invalid");
    expect(prismaMock.accessRequest.create).not.toHaveBeenCalled();
  });

  it("rejects an application with no password at all", async () => {
    const fd = application();
    fd.delete("password");
    const res = await POST(req(fd));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.password).toBe("invalid");
  });

  it("ignores confirmPassword if a client ever sends it", async () => {
    const fd = application();
    fd.set("confirmPassword", "something else");
    const res = await POST(req(fd));
    expect(res.status).toBe(200);
    const data = prismaMock.accessRequest.create.mock.calls[0][0].data;
    expect(JSON.stringify(data)).not.toContain("something else");
  });

  it("rejects a bad national id with 400 and names the field", async () => {
    const res = await POST(req(application({ nationalId: "1234567890123" })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation");
    expect(body.fields.nationalId).toBe("invalid");
    expect(prismaMock.accessRequest.create).not.toHaveBeenCalled();
  });

  it("rejects an expired licence", async () => {
    const res = await POST(req(application({ licenseExpiry: "01/01/2560" })));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.licenseExpiry).toBe("expired");
  });

  it("refuses an application with a document missing", async () => {
    const fd = application({}, false);
    fd.set("ID_CARD", file("id.jpg", "image/jpeg"));
    const res = await POST(req(fd));
    expect(res.status).toBe(400);
    expect((await res.json())).toMatchObject({ error: "missing-document", kind: "GUIDE_LICENSE" });
  });

  it("refuses a disallowed file type", async () => {
    const fd = application();
    fd.set("ID_CARD", file("id.heic", "image/heic"));
    const res = await POST(req(fd));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad-type");
  });

  it("refuses an oversized file with 413", async () => {
    const fd = application();
    fd.set("ID_CARD", file("huge.jpg", "image/jpeg", 9 * 1024 * 1024));
    const res = await POST(req(fd));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too-large");
  });

  it("returns 409 when the email already has an ACTIVE account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ state: "ACTIVE" });
    const res = await POST(req(application()));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("account-exists");
    expect(prismaMock.accessRequest.create).not.toHaveBeenCalled();
  });

  it("returns 409 when an application is already pending for that email", async () => {
    prismaMock.accessRequest.findFirst.mockResolvedValue({ id: "req_0" });
    const res = await POST(req(application()));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("request-pending");
  });

  it("lets an INVITED account re-apply — they are not active yet", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ state: "INVITED" });
    const res = await POST(req(application()));
    expect(res.status).toBe(200);
  });

  it("rate-limits a caller hammering the form", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await POST(req(application(), "9.9.9.9"))).status).toBe(200);
    }
    const res = await POST(req(application(), "9.9.9.9"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("POST /api/request — health data", () => {
  it("accepts NONE and encrypts even the status", async () => {
    const res = await POST(req(application({ medicalConditionStatus: "NONE" })));
    expect(res.status).toBe(200);
    const data = prismaMock.accessRequest.create.mock.calls[0][0].data;
    expect(data.medicalConditionStatus).toBe("enc(NONE)");
    expect(data.medicalConditionDetails).toBeNull();
  });

  it("accepts HAS_CONDITION and stores the details encrypted, not as plain text", async () => {
    const detail = "Asthma, carries an inhaler";
    await POST(req(application({ medicalConditionStatus: "HAS_CONDITION", medicalConditionDetails: detail })));
    const data = prismaMock.accessRequest.create.mock.calls[0][0].data;
    expect(data.medicalConditionDetails).toBe(`enc(${detail})`);
    expect(data.medicalConditionDetails).not.toBe(detail);
  });

  it("encrypts optional emergency instructions", async () => {
    await POST(req(application({ emergencyInstructions: "Call my sister first" })));
    const data = prismaMock.accessRequest.create.mock.calls[0][0].data;
    expect(data.emergencyInstructions).toBe("enc(Call my sister first)");
  });

  it("refuses HAS_CONDITION with no details and stores nothing", async () => {
    const res = await POST(req(application({ medicalConditionStatus: "HAS_CONDITION" })));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.medicalConditionDetails).toBe("required");
    expect(prismaMock.accessRequest.create).not.toHaveBeenCalled();
  });

  it("refuses a status outside the closed set", async () => {
    const res = await POST(req(application({ medicalConditionStatus: "MAYBE" })));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.medicalConditionStatus).toBe("invalid");
  });

  it("keeps health data out of the audit entry", async () => {
    const detail = "Epilepsy, medication in her day bag";
    await POST(req(application({ medicalConditionStatus: "HAS_CONDITION", medicalConditionDetails: detail })));
    const entry = (audit as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain("Epilepsy");
    expect(JSON.stringify(entry)).not.toContain("HAS_CONDITION");
  });

  it("refuses a superseded privacy notice version", async () => {
    const res = await POST(req(application({ privacyVersion: "2026-09-01" })));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.privacyVersion).toBe("unsupported");
  });

  it("refuses an application with no consent timestamp", async () => {
    const fd = application();
    fd.delete("privacyConsentAt");
    const res = await POST(req(fd));
    expect(res.status).toBe(400);
    expect((await res.json()).fields.privacyConsentAt).toBe("required");
  });
});
