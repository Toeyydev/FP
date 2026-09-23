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
import { CertificateRefused, createCertificate, linkCertificate, attestCertificate, uploadCertificate, UPLOAD_CLAIM_MS, voidCertificate, type Actor, type Deps } from "@/lib/certificates/service";
import { DuplicateCertificateFile, type CertificateDrive } from "@/lib/certificates/drive";
import { POST as certificatePost } from "@/app/api/jobsheet/certificate/route";
import { POST as certificateAction } from "@/app/api/jobsheet/certificate/[id]/route";

const GUIDE = "G-900";
const DATE = "2099-04-01";
const REF = "FOLK-TEST-20990401-01";
const ADMIN: Actor = { id: "u_admin", name: "Malee Testsuite", role: "ADMIN" };

type Row = Record<string, unknown>;
const e = (description: string, price: number, pax = 5, over: Row = {}): Row =>
  ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", ...over });

/**
 * A Drive that behaves the way the real one does in the way that matters: files are
 * found by the marker on them, a folder may hold two files with the same NAME, and
 * nothing is keyed on a filename anywhere.
 */
type FakeFile = { id: string; name: string; folder: string; certificateId: string; environment: string; bytes: Buffer; quarantined?: string };
const drive = {
  files: [] as FakeFile[],
  writes: 0,
  failPut: null as null | string,
  corruptOnRead: false,
  reset() { this.files = []; this.writes = 0; this.failPut = null; this.corruptOnRead = false; },
  live() { return this.files.filter((f) => !f.quarantined); },
};

const fakeDrive = (): CertificateDrive => ({
  async find({ certificateId, environment, folderPath }) {
    const key = folderPath.join("/");
    return drive.live()
      .filter((f) => f.certificateId === certificateId && f.environment === environment && f.folder === key)
      .map((f) => ({ id: f.id, name: f.name, link: `https://drive.example.test/file/${f.id}` }));
  },
  async put(o) {
    if (drive.failPut) throw new Error(drive.failPut);
    const key = o.folderPath.join("/");
    const found = drive.live().filter((f) => f.certificateId === o.certificateId && f.environment === o.environment && f.folder === key);
    if (found.length > 1) throw new DuplicateCertificateFile(o.certificateId, found.map((f) => f.id));
    drive.writes++;
    if (found.length === 1) { found[0].bytes = o.bytes; found[0].name = o.name; return { id: found[0].id, name: o.name, link: `https://drive.example.test/file/${found[0].id}` }; }
    const file: FakeFile = { id: `drive_${drive.files.length + 1}`, name: o.name, folder: key, certificateId: o.certificateId, environment: o.environment, bytes: o.bytes };
    drive.files.push(file);
    return { id: file.id, name: file.name, link: `https://drive.example.test/file/${file.id}` };
  },
  async read({ fileId }) {
    const f = drive.files.find((x) => x.id === fileId);
    if (!f) return null;
    return drive.corruptOnRead ? Buffer.concat([f.bytes, Buffer.from("tampered")]) : f.bytes;
  },
  async quarantine({ fileId, reason }) {
    const f = drive.files.find((x) => x.id === fileId);
    if (f) { f.quarantined = reason; f.certificateId = ""; f.name = `QUARANTINED ${f.name}`; }
  },
});

const ENV = "test-env";
const deps = (over: Deps = {}): Deps => ({
  renderPdf: async (html: string) => Buffer.from(`%PDF-1.4 ${html.length}`),
  drive: fakeDrive(),
  environment: ENV,
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
  await attestCertificate(c.id, ADMIN, deps());
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
  drive.reset();
  authMock.auth.mockResolvedValue({ user: { id: ADMIN.id, name: ADMIN.name, role: "ADMIN" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("issuing one", () => {
  it("covers exactly the rows that have no receipt and are the guide's own money", async () => {
    await seedSheet([e("Ferry", 11), e("Temple", 500, 2, { paidBy: "advance", expenseType: "entrance" }), e("Bus", 15)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    expect(c.status).toBe("READY_TO_ATTEST");
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
    const signed = await attestCertificate(c.id, ADMIN, deps());
    expect(signed.status).toBe("ATTESTED");
    expect(signed.attestedByUserId).toBe("u_admin");
    expect(signed.attestedByName).toBe("Malee Testsuite");
    expect(signed.attestedByRole).toBe("ADMIN");
    expect(signed.attestedAt).toBeTruthy();
    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.attested" } });
    expect(log!.actorId).toBe("u_admin");
    expect(String((log!.detail as Record<string, unknown>).approval)).toContain("no cryptographic signature");
  });

  it("refuses once the sheet has moved under it", async () => {
    await seedSheet([e("Ferry", 11), e("Bus", 15)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await prisma.jobSheet.update({ where: { id: c.jobSheetId }, data: { expenses: [e("Ferry", 25), e("Bus", 15)] as object[] } });
    const why = await refusal(() => attestCertificate(c.id, ADMIN, deps()));
    expect(why[0]).toContain("has changed since the certificate was prepared");
    expect((await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!.status).toBe("READY_TO_ATTEST");
  });

  it("only one of two simultaneous approvals succeeds", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    const results = await Promise.allSettled([attestCertificate(c.id, ADMIN, deps()), attestCertificate(c.id, ADMIN, deps())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "certificate.attested" } })).toBe(1);
  });
});

describe("filing it, and Drive's actual behaviour", () => {
  it("hashes the bytes it filed, and records where they went", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const up = await uploadCertificate(c.id, ADMIN, deps());
    expect(up.status).toBe("UPLOADED");
    expect(up.driveFileId).toBe("drive_1");
    expect(up.pdfHash).toMatch(/^[0-9a-f]{64}$/);
    expect(up.driveEnvironment).toBe(ENV);
    expect(up.uploadStartedAt).toBeNull();          // the claim is released
  });

  it("the file hash is of the bytes that are actually in Drive", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const up = await uploadCertificate(c.id, ADMIN, deps());
    expect(up.pdfHash).toBe(fileHash(drive.files[0].bytes));
  });

  it("a file with the SAME NAME but another certificate's marker is never touched", async () => {
    // Drive allows two files in one folder to share a name. Keying on the name would
    // have updated this one.
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const decoy = { id: "drive_decoy", name: `${c.certificateNo}.pdf`, folder: "Folkpaths Job Sheets/2099-04 April/Expense Certificates", certificateId: "some_other_certificate", environment: ENV, bytes: Buffer.from("SOMEBODY ELSE'S DOCUMENT") };
    drive.files.push(decoy);
    await uploadCertificate(c.id, ADMIN, deps());
    expect(decoy.bytes.toString()).toBe("SOMEBODY ELSE'S DOCUMENT");
    expect(drive.live()).toHaveLength(2);
  });

  it("a file with the same marker from another environment is never touched", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const other = { id: "drive_prod", name: `${c.certificateNo}.pdf`, folder: "Folkpaths Job Sheets/2099-04 April/Expense Certificates", certificateId: c.id, environment: "production", bytes: Buffer.from("PRODUCTION COPY") };
    drive.files.push(other);
    await uploadCertificate(c.id, ADMIN, deps());
    expect(other.bytes.toString()).toBe("PRODUCTION COPY");
  });

  it("two files carrying this certificate's marker fail closed, naming both", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const folder = "Folkpaths Job Sheets/2099-04 April/Expense Certificates";
    drive.files.push(
      { id: "dup_a", name: "a.pdf", folder, certificateId: c.id, environment: ENV, bytes: Buffer.from("A") },
      { id: "dup_b", name: "b.pdf", folder, certificateId: c.id, environment: ENV, bytes: Buffer.from("B") },
    );
    expect((await refusal(() => uploadCertificate(c.id, ADMIN, deps())))[0]).toContain("Drive holds 2 files");
    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.drive_duplicate" } });
    expect((log!.detail as { fileIds: string[] }).fileIds.sort()).toEqual(["dup_a", "dup_b"]);
    expect((await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!.status).toBe("ATTESTED");
  });

  it("an upload that fails leaves it attested, claim released, and retryable", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    drive.failPut = "drive-upload 503: unavailable";
    await expect(uploadCertificate(c.id, ADMIN, deps())).rejects.toThrow(/drive-upload/);
    const after = await prisma.expenseCertificate.findUnique({ where: { id: c.id } });
    expect(after!.status).toBe("ATTESTED");
    expect(after!.uploadStartedAt).toBeNull();
    expect(after!.lastUploadError).toContain("drive-upload");
    expect(after!.uploadAttempts).toBe(1);
    drive.failPut = null;
    expect((await uploadCertificate(c.id, ADMIN, deps())).status).toBe("UPLOADED");
  });

  it("an upload that landed while the database write failed resumes the same file", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    // The file reaches Drive; everything after it blows up, the way a crash would.
    const crashing = fakeDrive();
    const put = crashing.put.bind(crashing);
    crashing.put = async (o) => { await put(o); throw new Error("process died after the upload"); };
    await expect(uploadCertificate(c.id, ADMIN, deps({ drive: crashing }))).rejects.toThrow();
    expect(drive.live()).toHaveLength(1);
    const fileId = drive.live()[0].id;

    const retried = await uploadCertificate(c.id, ADMIN, deps());
    expect(retried.driveFileId).toBe(fileId);       // resumed, not replaced
    expect(drive.live()).toHaveLength(1);           // and no second file
    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.uploaded" } });
    expect((log!.detail as { resumed?: string }).resumed).toContain("rather than adding a second");
  });

  it("a claim already held refuses the second request rather than filing twice", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const slow = fakeDrive();
    const put = slow.put.bind(slow);
    slow.put = async (o) => { await new Promise((r) => setTimeout(r, 120)); return put(o); };
    const [a, b] = await Promise.allSettled([
      uploadCertificate(c.id, ADMIN, deps({ drive: slow })),
      new Promise((r) => setTimeout(r, 20)).then(() => uploadCertificate(c.id, ADMIN, deps({ drive: slow }))),
    ]);
    expect([a.status, b.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(drive.live()).toHaveLength(1);
  });

  it("an abandoned claim is picked up again once it is old enough", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    // What a crashed process leaves behind: a claim nobody will ever release.
    await prisma.expenseCertificate.update({ where: { id: c.id }, data: { uploadStartedAt: new Date(Date.now() - UPLOAD_CLAIM_MS - 1000) } });
    expect((await uploadCertificate(c.id, ADMIN, deps())).status).toBe("UPLOADED");
  });

  it("bytes that read back wrong are moved to quarantine, not left looking right", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    drive.corruptOnRead = true;
    expect((await refusal(() => uploadCertificate(c.id, ADMIN, deps())))[0]).toContain("moved to Quarantine");
    expect(drive.files[0].quarantined).toContain("read-back hash did not match");
    expect(drive.live()).toHaveLength(0);
    const after = await prisma.expenseCertificate.findUnique({ where: { id: c.id } });
    expect(after!.status).toBe("ATTESTED");
    expect(after!.driveFileId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "certificate.drive_quarantined" } })).toBe(1);

    // …and the quarantined file is not found again, so the retry makes a clean one.
    drive.corruptOnRead = false;
    const ok = await uploadCertificate(c.id, ADMIN, deps());
    expect(ok.status).toBe("UPLOADED");
    expect(ok.driveFileId).not.toBe("drive_1");
  });

  it("refuses to file something nobody has attested", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    expect((await refusal(() => uploadCertificate(c.id, ADMIN, deps())))[0]).toMatch(/not been attested|cannot go from/);
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
    await attestCertificate(c.id, ADMIN, deps());
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
    await attestCertificate(c.id, ADMIN, deps());
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
    const created = await call({ guideId: GUIDE, date: DATE, slotIdx: 0, attestedByUserId: "u_someone_important", attestedByName: "Someone Else", attestedByRole: "OWNER" });
    expect(created.status).toBe(200);
    const id = (await created.json()).certificate.id;
    const res = await certificateAction(
      new Request("https://ops.example.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "attest", attestedByUserId: "u_someone_important", attestedByName: "Someone Else", attestedByRole: "OWNER" }) }) as unknown as Parameters<typeof certificateAction>[0],
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const cert = await prisma.expenseCertificate.findUnique({ where: { id } });
    expect(cert!.attestedByUserId).toBe("u_admin");
    expect(cert!.attestedByName).toBe("Malee Testsuite");
    expect(cert!.attestedByRole).toBe("ADMIN");
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
      await attestCertificate(c.id, ADMIN, deps());
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
