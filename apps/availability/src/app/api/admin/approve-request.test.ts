import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  accessRequest: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  accessRequestDocument: { findMany: vi.fn() },
  guideDocument: { create: vi.fn() },
  notification: { create: vi.fn() },
  $transaction: vi.fn(),
}));
const authMock = vi.hoisted(() => vi.fn());
const issueInviteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/provision", () => ({ issueInvite: issueInviteMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue({ sent: false }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/sessionTokens", () => ({ revokeAllForUser: vi.fn() }));
vi.mock("@/lib/line", () => ({ lineLoginEnabled: false, lineGetFollowerIds: vi.fn() }));
vi.mock("@/lib/line-contacts", () => ({ listUnlinkedContacts: vi.fn(), linkContactToGuide: vi.fn(), captureLineContact: vi.fn() }));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://ops.folkpaths.com" }));
const decryptMock = vi.hoisted(() => vi.fn((v: string | null) => (v ? String(v).replace(/^enc\(|\)$/g, "") : "")));
vi.mock("@/lib/crypto", () => ({ decrypt: decryptMock }));

import { POST } from "./route";

const application = {
  id: "req_1", state: "PENDING", email: "somchai@example.com",
  name: "Somchai Jaidee", nickname: "Somchai", phone: "0812345678",
  passwordHash: "$2a$10$hashChosenByTheApplicant",
  fullNameThai: "สมชาย ใจดี", fullNameEnglish: "Somchai Jaidee",
  nationalId: "enc(1101700207366)", licenseNo: "11-12345",
  licenseExpiry: new Date("2027-12-31T00:00:00Z"),
  bankName: "enc(Kasikorn)", bankAccountName: "enc(Somchai Jaidee)", bankAccountNo: "enc(1234567890)",
  preferredLanguage: "th",
  medicalConditionStatus: "enc(HAS_CONDITION)",
  medicalConditionDetails: "enc(Asthma, carries an inhaler)",
  emergencyInstructions: "enc(Call my sister first)",
};

const guide = { id: "u_9", guideId: "G-041", role: "GUIDE", state: "INVITED", displayName: "Somchai", phone: null };

function post(body: unknown) {
  return POST(new Request("https://ops.folkpaths.com/api/admin", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.accessRequest.findUnique.mockResolvedValue(application);
  prismaMock.user.findUnique.mockResolvedValue(null);          // no email clash
  prismaMock.user.findFirst.mockResolvedValue(guide);          // auto-matched guide record
  prismaMock.user.update.mockResolvedValue(guide);
  prismaMock.accessRequestDocument.findMany.mockResolvedValue([
    { id: "d1", requestId: "req_1", kind: "ID_CARD", filename: "id.jpg", mimeType: "image/jpeg", size: 10, data: new Uint8Array([1, 2]) },
    { id: "d2", requestId: "req_1", kind: "BANK_BOOK", filename: "b.pdf", mimeType: "application/pdf", size: 20, data: new Uint8Array([3, 4]) },
  ]);
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  issueInviteMock.mockResolvedValue({ code: "INV-CODE", selector: "sel", expiresAt: new Date() });
});

describe("approveRequest", () => {
  it("activates the account so the applicant can sign in", async () => {
    const res = await post({ action: "approveRequest", requestId: "req_1" });
    expect(res.status).toBe(200);
    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data.state).toBe("ACTIVE");
    expect(data.claimedAt).toBeInstanceOf(Date);
  });

  it("carries over the password the applicant chose at sign-up", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data.passwordHash).toBe(application.passwordHash);
  });

  it("does not issue an invite — self-sign-up has no claim step", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    expect(issueInviteMock).not.toHaveBeenCalled();
  });

  it("refuses an application with no password rather than activating an empty account", async () => {
    prismaMock.accessRequest.findUnique.mockResolvedValue({ ...application, passwordHash: null });
    const res = await post({ action: "approveRequest", requestId: "req_1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no-password");
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("moves the application fields onto the guide account", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data.fullNameThai).toBe("สมชาย ใจดี");
    expect(data.licenseNo).toBe("11-12345");
    expect(data.licenseExpiry).toEqual(application.licenseExpiry);
  });

  it("copies documents across still encrypted, without decrypting them", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    expect(prismaMock.guideDocument.create).toHaveBeenCalledTimes(2);
    const first = prismaMock.guideDocument.create.mock.calls[0][0].data;
    expect(first.userId).toBe("u_9");
    expect(first.kind).toBe("ID_CARD");
    expect(Array.from(first.data as ArrayLike<number>)).toEqual([1, 2]); // byte-for-byte, still ciphertext
  });

  it("marks the request APPROVED and links it to the account", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    const data = prismaMock.accessRequest.update.mock.calls[0][0].data;
    expect(data.state).toBe("APPROVED");
    expect(data.linkedUserId).toBe("u_9");
  });

  it("refuses a request that is not pending", async () => {
    prismaMock.accessRequest.findUnique.mockResolvedValue({ ...application, state: "APPROVED" });
    const res = await post({ action: "approveRequest", requestId: "req_1" });
    expect(res.status).toBe(400);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("is refused to a guide", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    const res = await post({ action: "approveRequest", requestId: "req_1" });
    expect(res.status).toBe(403);
  });
});

describe("rejectRequest still works unchanged", () => {
  it("marks the request REJECTED and touches no account", async () => {
    prismaMock.accessRequest.update.mockResolvedValue({});
    const res = await post({ action: "rejectRequest", requestId: "req_1", note: "licence expired" });
    expect(res.status).toBe(200);
    const data = prismaMock.accessRequest.update.mock.calls[0][0].data;
    expect(data.state).toBe("REJECTED");
    expect(data.note).toBe("licence expired");
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(issueInviteMock).not.toHaveBeenCalled();
  });
});

describe("approveRequest — health data", () => {
  it("moves it onto the account as ciphertext, never decrypting it", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data.medicalConditionStatus).toBe("enc(HAS_CONDITION)");
    expect(data.medicalConditionDetails).toBe("enc(Asthma, carries an inhaler)");
    expect(data.emergencyInstructions).toBe("enc(Call my sister first)");
    // The real proof that nothing was decrypted: the value written is the value
    // read, byte for byte, and decrypt() was never reached on this path.
    expect(data.medicalConditionDetails).toBe(application.medicalConditionDetails);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("keeps health data out of the operator's audit entry and the guide's notification", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    const notif = JSON.stringify(prismaMock.notification.create.mock.calls[0][0]);
    expect(notif).not.toContain("Asthma");
    expect(notif).not.toContain("HAS_CONDITION");
  });

  it("still activates the account with the applicant's own password", async () => {
    await post({ action: "approveRequest", requestId: "req_1" });
    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data.state).toBe("ACTIVE");
    expect(data.claimedAt).toBeInstanceOf(Date);
    expect(data.passwordHash).toBe(application.passwordHash);
  });
});
