import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// The whole certificate workflow against a real database. Only the session and Drive are
// stubbed: the state machine, the hashes, the transactions and the row linking are real.
//
// The cases here are the ones a unit test cannot reach — two people pressing certify at
// the same moment, an upload that lands while the write that records it does not, and a
// row whose evidence quietly stops counting when the document behind it is withdrawn.
//
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import type { Expense } from "@/lib/jobsheet";
import { evidenceState, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { certificateStatuses } from "@/lib/certificates/evidence";
import { fileHash } from "@/lib/certificates/payload";
import { CertificateRefused, createCertificate, linkCertificate, signCertificate, uploadCertificate, voidCertificate, type Actor, type Deps } from "@/lib/certificates/service";
import { POST as certificatePost } from "@/app/api/jobsheet/certificate/route";
import { POST as certificateAction } from "@/app/api/jobsheet/certificate/[id]/route";

const GUIDE = "G-900";
const DATE = "2099-04-01";
const REF = "FOLK-TEST-20990401-01";
const ADMIN: Actor = { id: "u_admin", name: "Malee Testsuite", role: "ADMIN" };

type Row = Record<string, unknown>;
const e = (description: string, price: number, pax = 5, over: Row = {}): Row =>
  ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

/** A stubbed renderer and Drive, so nothing leaves the machine. */
const uploads: { name: string; bytes: number }[] = [];
const driveFiles = new Map<string, string>(); // name → id, so a retry lands on the same file
let uploadFails = false;
const deps = (over: Deps = {}): Deps => ({
  renderPdf: async (html: string) => Buffer.from(`%PDF-1.4 ${html.length}`),
  uploadPdf: async ({ bytes, name }) => {
    if (uploadFails) throw new Error("drive-upload 503: unavailable");
    uploads.push({ name, bytes: bytes.length });
    const id = driveFiles.get(name) ?? `drive_${driveFiles.size + 1}`;
    driveFiles.set(name, id);
    return { id, link: `https://drive.example.test/file/${id}` };
  },
  ...over,
});

const seedSheet = async (expenses: Row[], over: Record<string, unknown> = {}) =>
  prisma.jobSheet.create({
    data: {
      ref: REF, guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
      bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 },
      expenses: expenses as object[],
      guideExpenses: expenses as object[],
      guideExpensesAt: new Date("2099-04-02T06:30:00.000Z"),
      ...over,
    },
  });

const rowsNow = async (): Promise<ExpenseWithEvidence[]> =>
  ((await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } }))!.expenses as unknown as ExpenseWithEvidence[]);

/** Take a certificate all the way to being evidence. */
const throughToLinked = async () => {
  const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
  await signCertificate(c.id, ADMIN, deps());
  await uploadCertificate(c.id, ADMIN, deps());
  return linkCertificate(c.id, ADMIN, deps());
};

const refusal = async (fn: () => Promise<unknown>): Promise<string[]> => {
  try { await fn(); throw new Error("expected a refusal"); }
  catch (err) { if (err instanceof CertificateRefused) return err.reasons; throw err; }
};

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
  uploads.length = 0; driveFiles.clear(); uploadFails = false;
  authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: "ADMIN" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("issuing one", () => {
  it("covers exactly the rows that have no receipt and are the guide's own money", async () => {
    await seedSheet([e("Ferry", 11), e("Temple", 500, 2, { paidBy: "advance", expenseType: "entrance" }), e("Bus", 15)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    expect(c.status).toBe("READY_TO_SIGN");
    expect((c.coveredRows as unknown as { description: string }[]).map((r) => r.description)).toEqual(["Ferry", "Bus"]);
    expect(c.totalSatang).toBe(11 * 5 * 100 + 15 * 5 * 100);
    expect(c.certificateNo).toBe(`CERT-${REF}-01`);
  });

  it("refuses when the guide has filed no expense report of their own", async () => {
    await seedSheet([e("Ferry", 11)], { guideExpensesAt: null });
    expect((await refusal(() => createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps())))[0])
      .toContain("no expense report from the guide");
  });

  it("refuses two rows that read the same — nothing can say which one it covers", async () => {
    await seedSheet([e("Ferry", 11), e("Ferry", 11)]);
    expect((await refusal(() => createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps())))[0])
      .toContain("appears 2 times");
  });

  it("refuses a row whose payer nobody has said", async () => {
    await seedSheet([e("Ferry", 11, 5, { paidBy: "" })]);
    expect((await refusal(() => createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps())))[0])
      .toContain("no Paid By");
  });

  it("one job sheet holds one live certificate, and the database is what enforces it", async () => {
    await seedSheet([e("Ferry", 11)]);
    await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    expect((await refusal(() => createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps())))[0])
      .toContain("already has certificate");
  });

  it("two people pressing at the same moment produce one certificate", async () => {
    await seedSheet([e("Ferry", 11)]);
    const results = await Promise.allSettled([
      createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps()),
      createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps()),
      createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.expenseCertificate.count()).toBe(1);
  });
});

describe("certifying it", () => {
  it("records the approver from the session, with their role and the moment", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    const signed = await signCertificate(c.id, ADMIN, deps());
    expect(signed.status).toBe("SIGNED");
    expect(signed.signerUserId).toBe("u_admin");
    expect(signed.signerName).toBe("Malee Testsuite");
    expect(signed.signerRole).toBe("ADMIN");
    expect(signed.signedAt).toBeTruthy();
    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.signed" } });
    expect(log!.actorId).toBe("u_admin");
    expect(String((log!.detail as Record<string, unknown>).approval)).toContain("no cryptographic signature");
  });

  it("refuses once the sheet has moved under it", async () => {
    await seedSheet([e("Ferry", 11), e("Bus", 15)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await prisma.jobSheet.update({ where: { id: c.jobSheetId }, data: { expenses: [e("Ferry", 25), e("Bus", 15)] as object[] } });
    const why = await refusal(() => signCertificate(c.id, ADMIN, deps()));
    expect(why[0]).toContain("has changed since the certificate was prepared");
    expect((await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!.status).toBe("READY_TO_SIGN");
  });

  it("only one of two simultaneous approvals succeeds", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    const results = await Promise.allSettled([signCertificate(c.id, ADMIN, deps()), signCertificate(c.id, ADMIN, deps())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "certificate.signed" } })).toBe(1);
  });
});

describe("filing it, and what happens when Drive does not cooperate", () => {
  it("hashes the bytes it uploaded, and records where they went", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await signCertificate(c.id, ADMIN, deps());
    const up = await uploadCertificate(c.id, ADMIN, deps());
    expect(up.status).toBe("UPLOADED");
    expect(up.driveFileId).toBe("drive_1");
    expect(up.pdfHash).toMatch(/^[0-9a-f]{64}$/);
    expect(uploads[0].name).toBe(`${c.certificateNo}.pdf`);
  });

  it("the file hash is of the bytes that were sent, not of anything else", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await signCertificate(c.id, ADMIN, deps());
    let sent: Buffer | null = null;
    const up = await uploadCertificate(c.id, ADMIN, deps({ uploadPdf: async ({ bytes }) => { sent = bytes; return { id: "d1", link: "https://drive.example.test/d1" }; } }));
    expect(up.pdfHash).toBe(fileHash(sent!));
  });

  it("an upload that fails leaves it approved and retryable, not half-filed", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await signCertificate(c.id, ADMIN, deps());
    uploadFails = true;
    await expect(uploadCertificate(c.id, ADMIN, deps())).rejects.toThrow(/drive-upload/);
    const after = await prisma.expenseCertificate.findUnique({ where: { id: c.id } });
    expect(after!.status).toBe("SIGNED");
    expect(after!.uploadStartedAt).toBeTruthy();   // the attempt is on the record
    expect(after!.driveFileId).toBeNull();
    // …and retrying finishes it.
    uploadFails = false;
    expect((await uploadCertificate(c.id, ADMIN, deps())).status).toBe("UPLOADED");
  });

  it("an upload that landed while the write failed converges on the same file, not a second", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await signCertificate(c.id, ADMIN, deps());
    // The file reaches Drive; the database write is what blows up.
    await expect(uploadCertificate(c.id, ADMIN, deps({
      uploadPdf: async ({ bytes, name }) => { uploads.push({ name, bytes: bytes.length }); driveFiles.set(name, "drive_1"); throw new Error("db write failed after upload"); },
    }))).rejects.toThrow();
    const retried = await uploadCertificate(c.id, ADMIN, deps());
    expect(retried.driveFileId).toBe("drive_1");            // the same file, replaced in place
    expect(new Set(uploads.map((u) => u.name)).size).toBe(1); // one name, so one file
  });

  it("refuses to file something nobody has certified", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    expect((await refusal(() => uploadCertificate(c.id, ADMIN, deps())))[0]).toMatch(/not been approved|cannot go from/);
  });
});

describe("putting it to use", () => {
  it("writes the waiver onto the rows it covers, naming itself", async () => {
    await seedSheet([e("Ferry", 11), e("Temple", 500, 2, { paidBy: "advance", expenseType: "entrance" }), e("Bus", 15)]);
    const cert = await throughToLinked();
    expect(cert.status).toBe("LINKED");
    const rows = await rowsNow();
    expect(rows[0].evidenceWaiver?.certificateNo).toBe(cert.certificateNo);
    expect(rows[1].evidenceWaiver).toBeUndefined();   // the advance row was never its business
    expect(rows[2].evidenceWaiver?.certificateId).toBe(cert.id);
  });

  it("and only then do those rows count as evidenced", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await signCertificate(c.id, ADMIN, deps());
    await uploadCertificate(c.id, ADMIN, deps());
    // Approved and filed, but not yet linked: the row has no waiver at all.
    expect(evidenceState((await rowsNow())[0], await certificateStatuses([await rowsNow() as Expense[]])).state).toBe("BLOCKED");
    await linkCertificate(c.id, ADMIN, deps());
    const rows = await rowsNow();
    expect(evidenceState(rows[0], await certificateStatuses([rows as Expense[]])).state).toBe("WAIVED");
  });

  it("refuses if the sheet moved between filing and linking", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await signCertificate(c.id, ADMIN, deps());
    await uploadCertificate(c.id, ADMIN, deps());
    await prisma.jobSheet.update({ where: { id: c.jobSheetId }, data: { expenses: [e("Ferry", 11), e("Water", 10)] as object[] } });
    expect((await refusal(() => linkCertificate(c.id, ADMIN, deps()))).join(" ")).toContain("has changed since the certificate was approved");
  });
});

describe("withdrawing it", () => {
  it("needs a reason", async () => {
    await seedSheet([e("Ferry", 11)]);
    const cert = await throughToLinked();
    expect((await refusal(() => voidCertificate(cert.id, "oops", ADMIN, deps())))[0]).toContain("Say why");
  });

  it("stops the rows counting, without editing a single row", async () => {
    await seedSheet([e("Ferry", 11)]);
    const cert = await throughToLinked();
    const before = JSON.stringify(await rowsNow());
    await voidCertificate(cert.id, "the ferry fare turned out to have a receipt after all", ADMIN, deps());
    const rows = await rowsNow();
    expect(JSON.stringify(rows)).toBe(before);                        // the sheet is untouched
    const state = evidenceState(rows[0], await certificateStatuses([rows as Expense[]]));
    expect(state.state).toBe("BLOCKED");
    expect(state.state === "BLOCKED" && state.reason).toContain("withdrawn");
  });

  it("frees the sheet for a replacement, and the new one is numbered after it", async () => {
    await seedSheet([e("Ferry", 11)]);
    const first = await throughToLinked();
    await voidCertificate(first.id, "reissued after the fare was corrected", ADMIN, deps());
    const second = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    expect(second.certificateNo).toBe(`CERT-${REF}-02`);
    expect((await prisma.expenseCertificate.findUnique({ where: { id: first.id } }))!.activeJobSheetId).toBeNull();
  });

  it("a withdrawn certificate never comes back", async () => {
    await seedSheet([e("Ferry", 11)]);
    const cert = await throughToLinked();
    await voidCertificate(cert.id, "withdrawn for a reason worth recording", ADMIN, deps());
    expect((await refusal(() => linkCertificate(cert.id, ADMIN, deps())))[0]).toContain("withdrawn");
  });
});

describe("who may do any of this", () => {
  const call = (body: object) => certificatePost(new Request("https://ops.example.test/api/jobsheet/certificate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as unknown as Parameters<typeof certificatePost>[0]);

  it("an operator cannot issue one", async () => {
    await seedSheet([e("Ferry", 11)]);
    authMock.auth.mockResolvedValue({ user: { id: "u_ops", name: "Ops", role: "OPERATOR" } });
    expect((await call({ guideId: GUIDE, date: DATE, slotIdx: 0 })).status).toBe(403);
    expect(await prisma.expenseCertificate.count()).toBe(0);
  });

  it("a guide certainly cannot", async () => {
    await seedSheet([e("Ferry", 11)]);
    authMock.auth.mockResolvedValue({ user: { id: "u_guide", name: "Guide", role: "GUIDE" } });
    expect((await call({ guideId: GUIDE, date: DATE, slotIdx: 0 })).status).toBe(403);
  });

  it("a client naming somebody else as the approver is ignored — the session decides", async () => {
    await seedSheet([e("Ferry", 11)]);
    const created = await call({ guideId: GUIDE, date: DATE, slotIdx: 0, signerUserId: "u_someone_important", signerName: "Someone Else", signerRole: "OWNER" });
    expect(created.status).toBe(200);
    const id = (await created.json()).certificate.id;
    const res = await certificateAction(
      new Request("https://ops.example.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sign", signerUserId: "u_someone_important", signerName: "Someone Else", signerRole: "OWNER" }) }) as unknown as Parameters<typeof certificateAction>[0],
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const cert = await prisma.expenseCertificate.findUnique({ where: { id } });
    expect(cert!.signerUserId).toBe("u_admin");
    expect(cert!.signerName).toBe("Malee Testsuite");
    expect(cert!.signerRole).toBe("ADMIN");
  });
});

describe("what a payment makes of it", () => {
  // Six jobs, fifteen unreceipted rows, one certificate each. Invented throughout.
  const SHEETS = [
    { slot: 0, rows: ["Water", "Ferry", "Bus"] }, { slot: 1, rows: ["Water"] },
    { slot: 2, rows: ["Water", "Bus"] }, { slot: 3, rows: ["Water", "Ferry", "Bus"] },
    { slot: 4, rows: ["Water", "Ferry", "Bus"] }, { slot: 5, rows: ["Water", "Ferry", "Bus"] },
  ];
  const price: Record<string, number> = { Water: 10, Ferry: 11, Bus: 15 };

  const seedSix = async () => {
    for (const s of SHEETS) {
      await prisma.jobSheet.create({ data: {
        ref: `FOLK-TEST-20990401-0${s.slot + 1}`, guideId: GUIDE, date: DATE, slotIdx: s.slot, tourId: "T-900", status: "Confirmed",
        bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 },
        expenses: s.rows.map((r) => e(r, price[r], 2)) as object[],
        guideExpensesAt: new Date("2099-04-02T06:30:00.000Z"),
      } });
    }
  };

  it("every row is evidenced once all six certificates are in use, and not before", async () => {
    await seedSix();
    const certs = [];
    for (const s of SHEETS) {
      const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: s.slot }, ADMIN, deps());
      await signCertificate(c.id, ADMIN, deps());
      await uploadCertificate(c.id, ADMIN, deps());
      certs.push(c);
    }
    const sheetsOf = async () => (await prisma.jobSheet.findMany({ where: { guideId: GUIDE } })).map((s) => (s.expenses as unknown as ExpenseWithEvidence[]));
    const blocked = async () => {
      const all = await sheetsOf();
      const statuses = await certificateStatuses(all as Expense[][]);
      return all.flat().filter((r) => evidenceState(r, statuses).state === "BLOCKED").length;
    };
    expect(await blocked()).toBe(15);                  // filed, but not one is in use yet
    for (const c of certs.slice(0, 5)) await linkCertificate(c.id, ADMIN, deps());
    expect(await blocked()).toBe(3);                   // one sheet still short
    await linkCertificate(certs[5].id, ADMIN, deps());
    expect(await blocked()).toBe(0);

    // Withdraw one and its three rows stop counting again — nothing else moves.
    await voidCertificate(certs[0].id, "withdrawn to test that evidence follows the document", ADMIN, deps());
    expect(await blocked()).toBe(3);
  });
});
