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
import { CertificateRefused, createCertificate, linkCertificate, attestCertificate, uploadCertificate, UPLOAD_LEASE_MS, voidCertificate, type Actor, type Deps } from "@/lib/certificates/service";
import { DuplicateCertificateFile, type CertificateDrive, type PutAttemptInput } from "@/lib/certificates/drive";
import { checkEvidenceBeforePaying } from "@/lib/certificates/gate";
import { checkFiledDocument } from "@/lib/certificates/service";
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
 * A Drive that behaves the way the real one does in the ways that matter: files are
 * found by the markers on them, a folder may hold two files with the same NAME, each
 * attempt owns its own file, and a file that has been settled on is never rewritten.
 */
type FakeFile = {
  id: string; name: string; folder: string; certificateId: string; environment: string;
  attemptToken: string | null; state: "TEMP" | "ACTIVE" | "RETIRED" | "QUARANTINED" | null;
  bytes: Buffer; revisionId: string; readOnly?: boolean; forensic?: Record<string, string>;
};
const drive = {
  files: [] as FakeFile[],
  revisions: 0,
  reset() { this.files = []; this.revisions = 0; this.failPut = null; this.corruptOnRead = false; },
  failPut: null as null | string,
  corruptOnRead: false,
  live() { return this.files.filter((f) => f.state === "TEMP" || f.state === "ACTIVE"); },
  active() { return this.files.filter((f) => f.state === "ACTIVE"); },
  shape(f: FakeFile) { return { id: f.id, name: f.name, link: `https://drive.example.test/file/${f.id}`, attemptToken: f.attemptToken, state: f.state, revisionId: f.revisionId, md5: null, readOnly: f.readOnly }; },
};

const fakeDrive = (): CertificateDrive => {
  const key = (folderPath: string[]) => folderPath.join("/");
  const mine = (o: { certificateId: string; environment: string; folderPath: string[] }) =>
    drive.files.filter((f) => (f.state === "TEMP" || f.state === "ACTIVE") && f.certificateId === o.certificateId && f.environment === o.environment && f.folder === key(o.folderPath));
  const make = (o: PutAttemptInput, state: "TEMP" | "ACTIVE"): FakeFile => {
    const file: FakeFile = {
      id: `drive_${drive.files.length + 1}`, name: o.name, folder: key(o.folderPath),
      certificateId: o.certificateId, environment: o.environment, attemptToken: o.attemptToken,
      state, bytes: o.bytes, revisionId: `rev_${++drive.revisions}`, readOnly: state === "ACTIVE",
    };
    drive.files.push(file);
    return file;
  };
  return {
    async findAll(o) { return mine(o).map((f) => drive.shape(f)); },
    async findActive(o) { return mine(o).filter((f) => f.state === "ACTIVE").map((f) => drive.shape(f)); },
    async findAttempt(o) { return mine(o).filter((f) => f.attemptToken === o.attemptToken && f.state === "TEMP").map((f) => drive.shape(f)); },
    async findActiveByAttempt(o) { return mine(o).filter((f) => f.attemptToken === o.attemptToken && f.state === "ACTIVE").map((f) => drive.shape(f)); },
    async putAttempt(o) {
      if (drive.failPut) throw new Error(drive.failPut);
      const own = mine(o).filter((f) => f.attemptToken === o.attemptToken && f.state === "TEMP");
      if (own.length > 1) throw new DuplicateCertificateFile(o.certificateId, "TEMP", own.map((f) => f.id));
      if (own.length === 1) {
        if (own[0].state !== "TEMP") throw new Error("drive-immutable: only a TEMP candidate is ever written to");
        own[0].bytes = o.bytes; own[0].name = o.name; own[0].revisionId = `rev_${++drive.revisions}`;
        return drive.shape(own[0]);
      }
      return drive.shape(make(o, "TEMP"));
    },
    /** A new file every time — there is no update path. */
    async createActive(o) { return drive.shape(make(o, "ACTIVE")); },
    async retire({ fileId, certificateId, attemptToken, at, reason }) {
      const f = drive.files.find((x) => x.id === fileId);
      if (!f) return;
      f.state = "RETIRED"; f.certificateId = ""; f.attemptToken = null; f.name = `RETIRED ${f.name}`;
      f.forensic = { certificateId, attemptToken, at, reason };
    },
    async read({ fileId }) {
      const f = drive.files.find((x) => x.id === fileId);
      if (!f) return null;
      return drive.corruptOnRead ? Buffer.concat([f.bytes, Buffer.from("tampered")]) : f.bytes;
    },
    async quarantine({ fileId, reason, certificateId, attemptToken, at }) {
      const f = drive.files.find((x) => x.id === fileId);
      if (!f) return;
      f.state = "QUARANTINED"; f.certificateId = ""; f.attemptToken = null; f.readOnly = false;
      f.name = `QUARANTINED ${f.name}`;
      f.forensic = { certificateId, attemptToken, at, reason };
    },
  };
};

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
    // The recorded file is the DOCUMENT, which is a different file from the candidate
    // that was written to — nothing was ever in flight towards this id.
    expect(up.driveFileId).not.toBe("drive_1");
    expect(drive.files.find((f) => f.id === up.driveFileId)!.state).toBe("ACTIVE");
    expect(drive.files.find((f) => f.id === "drive_1")!.state).toBe("RETIRED");
    expect(up.pdfHash).toMatch(/^[0-9a-f]{64}$/);
    expect(up.driveEnvironment).toBe(ENV);
    expect(up.uploadStartedAt).toBeNull();          // the claim is released
    expect(up.uploadClaimToken).toBeNull();
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
    const decoy = { id: "drive_decoy", name: `${c.certificateNo}.pdf`, folder: "Folkpaths Job Sheets/2099-04 April/Expense Certificates", certificateId: "some_other_certificate", environment: ENV, bytes: Buffer.from("SOMEBODY ELSE'S DOCUMENT"), attemptToken: "someone-elses-attempt", state: "ACTIVE" as const, revisionId: "rev_x" };
    drive.files.push(decoy);
    await uploadCertificate(c.id, ADMIN, deps());
    expect(decoy.bytes.toString()).toBe("SOMEBODY ELSE'S DOCUMENT");
    expect(drive.live()).toHaveLength(2);
  });

  it("a file with the same marker from another environment is never touched", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const other = { id: "drive_prod", name: `${c.certificateNo}.pdf`, folder: "Folkpaths Job Sheets/2099-04 April/Expense Certificates", certificateId: c.id, environment: "production", bytes: Buffer.from("PRODUCTION COPY"), attemptToken: "prod-attempt", state: "ACTIVE" as const, revisionId: "rev_p" };
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
      { id: "dup_a", name: "a.pdf", folder, certificateId: c.id, environment: ENV, bytes: Buffer.from("A"), attemptToken: "dup-token", state: "TEMP" as const, revisionId: "rev_a" },
      { id: "dup_b", name: "b.pdf", folder, certificateId: c.id, environment: ENV, bytes: Buffer.from("B"), attemptToken: "dup-token", state: "TEMP" as const, revisionId: "rev_b" },
    );
    expect((await refusal(() => uploadCertificate(c.id, ADMIN, deps({ newToken: () => "dup-token" }))))[0]).toContain("Drive holds 2 TEMP files");
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
    expect(after!.uploadClaimToken).toBeNull();
    expect(after!.lastUploadError).toContain("drive-upload");
    expect(after!.uploadAttempts).toBe(1);
    drive.failPut = null;
    expect((await uploadCertificate(c.id, ADMIN, deps())).status).toBe("UPLOADED");
  });

  it("a retry under the SAME token reuses that attempt's own file", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    // The file reaches Drive; everything after it blows up, the way a crash would.
    const crashing = fakeDrive();
    const put = crashing.putAttempt.bind(crashing);
    crashing.putAttempt = async (o) => { await put(o); throw new Error("process died after the upload"); };
    await expect(uploadCertificate(c.id, ADMIN, deps({ drive: crashing, newToken: () => "token-A" }))).rejects.toThrow();
    expect(drive.live()).toHaveLength(1);
    const fileId = drive.live()[0].id;

    const retried = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    expect(retried.driveFileId).not.toBe(fileId);   // the candidate is never the document
    expect(drive.files.find((f) => f.id === fileId)!.state).toBe("RETIRED");
    expect(drive.active()).toHaveLength(1);         // exactly one document
  });

  it("a retry under a NEW token files its own candidate and puts the old one away", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const first = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    const second = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-B" }));
    expect(second.driveFileId).not.toBe(first.driveFileId);
    expect(drive.active()).toHaveLength(1);                       // exactly one document
    expect(drive.active()[0].id).toBe(second.driveFileId);
    expect(drive.files.find((f) => f.id === first.driveFileId)!.state).toBe("QUARANTINED");
  });

  it("a claim already held refuses the second request rather than filing twice", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const slow = fakeDrive();
    const put = slow.putAttempt.bind(slow);
    slow.putAttempt = async (o) => { await new Promise((r) => setTimeout(r, 120)); return put(o); };
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
    await prisma.expenseCertificate.update({ where: { id: c.id }, data: { uploadStartedAt: new Date(Date.now() - UPLOAD_LEASE_MS - 1000), uploadClaimToken: "a-token-nobody-will-release", uploadLeaseUntil: new Date(Date.now() - 1000) } });
    expect((await uploadCertificate(c.id, ADMIN, deps())).status).toBe("UPLOADED");
  });

  it("bytes that read back wrong are moved to quarantine, not left looking right", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    drive.corruptOnRead = true;
    expect((await refusal(() => uploadCertificate(c.id, ADMIN, deps())))[0]).toContain("moved to Quarantine");
    expect(drive.files[0].state).toBe("QUARANTINED");
    expect(drive.files[0].forensic!.reason).toContain("read-back hash did not match");
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
    expect((await refusal(() => linkCertificate(c.id, ADMIN, deps()))).join(" ")).toContain("has changed since the certificate was attested");
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

describe("a request that loses its lease while it is working", () => {
  // The case a timeout alone cannot handle: A claims, stalls, B takes over and files the
  // document properly, and then A wakes up. The two never meet — each believes it owns
  // the upload — so A has to be stopped by what it finds, not by what it remembers.
  const attested = async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    return c;
  };
  const held = (id: string) => prisma.expenseCertificate.findUnique({ where: { id } });

  it("A is fenced out, and B's document is the only one that counts", async () => {
    const c = await attested();

    // A claims, then goes away for longer than its own lease.
    const slowDrive = fakeDrive();
    const put = slowDrive.putAttempt.bind(slowDrive);
    slowDrive.putAttempt = async (o) => { await new Promise((r) => setTimeout(r, 400)); return put(o); };
    const a = uploadCertificate(c.id, ADMIN, deps({ drive: slowDrive, leaseMs: 60, heartbeatMs: 10_000, newToken: () => "token-A" }));

    // B waits for A's lease to lapse, then takes over and files properly.
    await new Promise((r) => setTimeout(r, 150));
    const bDone = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-B" }));
    expect(bDone.status).toBe("UPLOADED");

    // A comes back and must change nothing.
    await expect(a).rejects.toMatchObject({ reasons: [expect.stringContaining("took over filing")] });

    const after = await held(c.id);
    expect(after!.status).toBe("UPLOADED");
    expect(after!.driveFileId).toBe(bDone.driveFileId);   // B's file, not A's
    expect(after!.pdfHash).toBe(bDone.pdfHash);
    expect(after!.uploadClaimToken).toBeNull();           // B released it; A did not clear it
    // A's bytes DID land after B's — a call to Drive already in the air cannot be
    // recalled. They landed in A's OWN file, which is the point of one file per attempt:
    // B's document was never writable by A at all.
    expect(drive.active()).toHaveLength(1);
    expect(drive.active()[0].id).toBe(bDone.driveFileId);
    expect(drive.active()[0].attemptToken).toBe("token-B");
    const aFile = drive.files.find((f) => f.forensic?.attemptToken === "token-A");
    expect(aFile!.state).toBe("QUARANTINED");

    // And the document can be used, because nothing touched it.
    expect((await linkCertificate(c.id, ADMIN, deps())).status).toBe("LINKED");

    const fenced = await prisma.auditLog.findFirst({ where: { action: "certificate.upload_fenced" } });
    expect((fenced!.detail as { attemptToken: string }).attemptToken).toBe("token-A");
  });

  it("A cannot make its own file the evidence", async () => {
    const c = await attested();
    const slowDrive = fakeDrive();
    const put = slowDrive.putAttempt.bind(slowDrive);
    slowDrive.putAttempt = async (o) => { await new Promise((r) => setTimeout(r, 400)); return put(o); };
    const a = uploadCertificate(c.id, ADMIN, deps({ drive: slowDrive, leaseMs: 60, heartbeatMs: 10_000, newToken: () => "token-A" }));
    await new Promise((r) => setTimeout(r, 150));
    const bDone = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-B" }));
    await expect(a).rejects.toThrow();

    // What becomes evidence is B's file, and the bytes in it hash to what B recorded.
    const linked = await linkCertificate(c.id, ADMIN, deps());
    expect(linked.driveFileId).toBe(bDone.driveFileId);
    const onDisk = drive.files.find((f) => f.id === bDone.driveFileId)!;
    expect(fileHash(onDisk.bytes)).toBe(bDone.pdfHash);
    const rows = await rowsNow();
    expect(rows[0].evidenceWaiver?.certificateId).toBe(c.id);
  });

  it("A does not clear the claim of whoever holds it now", async () => {
    const c = await attested();
    const slowDrive = fakeDrive();
    const put = slowDrive.putAttempt.bind(slowDrive);
    slowDrive.putAttempt = async (o) => { await new Promise((r) => setTimeout(r, 300)); return put(o); };
    const a = uploadCertificate(c.id, ADMIN, deps({ drive: slowDrive, leaseMs: 50, heartbeatMs: 10_000, newToken: () => "token-A" }));
    await new Promise((r) => setTimeout(r, 120));
    // B claims and keeps hold of it — it has not finished.
    await prisma.expenseCertificate.updateMany({
      where: { id: c.id, OR: [{ uploadClaimToken: null }, { uploadLeaseUntil: { lt: new Date() } }] },
      data: { uploadClaimToken: "token-B", uploadLeaseUntil: new Date(Date.now() + 60_000) },
    });
    await expect(a).rejects.toThrow();
    expect((await held(c.id))!.uploadClaimToken).toBe("token-B");   // still B's
  });

  it("the heartbeat keeps a long upload from being taken over", async () => {
    const c = await attested();
    const slowDrive = fakeDrive();
    const put = slowDrive.putAttempt.bind(slowDrive);
    slowDrive.putAttempt = async (o) => { await new Promise((r) => setTimeout(r, 300)); return put(o); };
    // A lease far shorter than the work, renewed often enough to survive it.
    const done = await uploadCertificate(c.id, ADMIN, deps({ drive: slowDrive, leaseMs: 80, heartbeatMs: 25, newToken: () => "token-A" }));
    expect(done.status).toBe("UPLOADED");
    expect(drive.live()[0].attemptToken).toBe("token-A");
  });

  it("a settled document edited behind the application's back is refused at the point of use", async () => {
    const c = await attested();
    // The lease holds, but the file underneath is replaced by a different attempt
    // between writing it and confirming it.
    const meddling = fakeDrive();
    await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    // Someone replaces the settled document behind the application's back.
    const active = drive.active()[0];
    active.bytes = Buffer.from("A DIFFERENT DOCUMENT ENTIRELY");
    active.revisionId = "rev_tampered";
    expect((await refusal(() => linkCertificate(c.id, ADMIN, deps({ drive: meddling }))))[0]).toMatch(/edited since|not the one that was filed/);
    expect((await held(c.id))!.status).toBe("UPLOADED");
  });
});

describe("what a quarantined file says about itself", () => {
  it("carries which certificate and which attempt put it there, and when", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    drive.corruptOnRead = true;
    await refusal(() => uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" })));

    const f = drive.files.find((x) => x.forensic?.attemptToken === "token-A")!;
    expect(f.certificateId).toBe("");                 // the live marker is gone
    expect(f.attemptToken).toBeNull();
    expect(f.state).toBe("QUARANTINED");
    expect(f.forensic).toMatchObject({ certificateId: c.id, attemptToken: "token-A" });
    expect(Date.parse(f.forensic!.at)).not.toBeNaN();

    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.drive_quarantined" } });
    const d = log!.detail as Record<string, unknown>;
    expect(d.driveFileId).toBe(f.id);
    expect(d.attemptToken).toBe("token-A");
    expect(d.expectedPdfHash).not.toBe(d.actualPdfHash);
    expect(String(d.expectedPdfHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(d.actualPdfHash)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the document is checked again before money moves", () => {
  const linked = async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    return linkCertificate(c.id, ADMIN, deps());
  };
  const gate = async (d: Deps) =>
    checkEvidenceBeforePaying([await rowsNow() as Expense[]], { actorId: ADMIN.id, actorRole: ADMIN.role }, d);

  it("an untouched document passes", async () => {
    await linked();
    const g = await gate(deps());
    expect(g.ok).toBe(true);
    expect(g.stale).toEqual([]);
  });

  it("a document edited after linking blocks the payment and is marked stale", async () => {
    const cert = await linked();
    // Somebody opens the file in Drive and changes it.
    const active = drive.active()[0];
    active.bytes = Buffer.from("SOMETHING ELSE ENTIRELY");
    active.revisionId = "rev_tampered";

    const g = await gate(deps());
    expect(g.ok).toBe(false);
    expect(g.reasons.join(" ")).toContain(cert.certificateNo);
    expect(g.stale).toEqual([cert.certificateNo]);

    const after = await prisma.expenseCertificate.findUnique({ where: { id: cert.id } });
    expect(after!.status).toBe("STALE");
    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.marked_stale" } });
    expect((log!.detail as { why: string }).why).toBe("drive_changed");

    // …and every screen stops treating those rows as evidenced.
    const rows = await rowsNow();
    const state = evidenceState(rows[0], await certificateStatuses([rows as Expense[]]));
    expect(state.state).toBe("BLOCKED");
    expect(state.state === "BLOCKED" && state.reason).toContain("no longer matches the document");
  });

  it("a stale certificate can be filed again, and then it counts once more", async () => {
    const cert = await linked();
    drive.active()[0].bytes = Buffer.from("TAMPERED");
    drive.active()[0].revisionId = "rev_tampered";
    await gate(deps());
    expect((await prisma.expenseCertificate.findUnique({ where: { id: cert.id } }))!.status).toBe("STALE");

    const refiled = await uploadCertificate(cert.id, ADMIN, deps({ newToken: () => "token-B" }));
    expect(refiled.status).toBe("UPLOADED");
    expect(drive.active()).toHaveLength(1);
    expect(drive.active()[0].attemptToken).toBe("token-B");
    await linkCertificate(cert.id, ADMIN, deps());
    expect((await gate(deps())).ok).toBe(true);
  });

  it("a withdrawn certificate blocks the payment too", async () => {
    const cert = await linked();
    await voidCertificate(cert.id, "withdrawn while testing the payment gate", ADMIN, deps());
    const g = await gate(deps());
    expect(g.ok).toBe(false);
    expect(g.reasons.join(" ")).toContain("was withdrawn");
  });

  it("a missing document blocks the payment", async () => {
    await linked();
    drive.files.length = 0;
    expect((await gate(deps())).ok).toBe(false);
  });

  it("two settled documents fail closed rather than picking one", async () => {
    const cert = await linked();
    const first = drive.active()[0];
    drive.files.push({ ...first, id: "drive_clone", revisionId: "rev_clone" });
    const g = await gate(deps());
    expect(g.ok).toBe(false);
    expect(g.reasons.join(" ")).toContain("2 settled documents");
    expect(g.stale).toEqual([cert.certificateNo]);
  });

  it("rows with no certificate behind them are none of this gate's business", async () => {
    await seedSheet([e("Ferry", 11)]);
    const g = await checkEvidenceBeforePaying([await rowsNow() as Expense[]], { actorId: ADMIN.id, actorRole: ADMIN.role }, deps());
    expect(g.ok).toBe(true);
  });
});

describe("a settled document is never written again", () => {
  it("the document is a file nothing was ever written to", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const up = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    const temp = drive.files.find((f) => f.state === "RETIRED")!;
    const active = drive.files.find((f) => f.id === up.driveFileId)!;
    expect(active.id).not.toBe(temp.id);
    // There is no interface through which the application could write to it.
    expect(Object.keys(fakeDrive())).not.toContain("activate");
    expect(active.readOnly).toBe(true);
  });

  it("a candidate whose state has moved on is never written to again", async () => {
    const d = fakeDrive();
    const folderPath = ["Folkpaths Job Sheets", "2099-04 April", "Expense Certificates"];
    const input = { certificateId: "c1", certificateNo: "CERT-X-01", payloadHash: "h", environment: ENV, attemptToken: "token-A", name: "x.pdf", bytes: Buffer.from("FIRST"), folderPath };
    const made = await d.putAttempt(input);
    drive.files.find((f) => f.id === made.id)!.state = "ACTIVE";      // as if it had become the document
    const again = await d.putAttempt({ ...input, bytes: Buffer.from("SECOND") });
    expect(again.id).not.toBe(made.id);                               // a new candidate, not that one
    expect(drive.files.find((f) => f.id === made.id)!.bytes.toString()).toBe("FIRST");
  });

  it("a promoted file is marked read-only where Drive allows it", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    const up = await uploadCertificate(c.id, ADMIN, deps());
    expect(drive.active()[0].readOnly).toBe(true);
    expect(up.driveRevisionId).toBeTruthy();
  });
});

describe("a write already in the air when the document is created", () => {
  // The race the previous design could not survive: a media upload aimed at the
  // candidate, sent while it was still a candidate, arriving after the document exists.
  // Promoting the candidate in place would have let that write land on the document.
  const attested = async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    return c;
  };

  it("the late write reaches only the candidate; the document's SHA-256 is unchanged", async () => {
    const c = await attested();

    // A's write leaves, and hangs. It is aimed at the candidate file id.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = fakeDrive();
    const put = slow.putAttempt.bind(slow);
    const inFlight = (async () => {
      const first = await put({
        certificateId: c.id, certificateNo: c.certificateNo, payloadHash: c.payloadHash, environment: ENV,
        attemptToken: "token-A", name: "x.pdf", bytes: Buffer.from("%PDF-1.4 FIRST BYTES"),
        folderPath: ["Folkpaths Job Sheets", "2099-04 April", "Expense Certificates"],
      });
      await gate;                                    // still on its way…
      const f = drive.files.find((x) => x.id === first.id)!;
      if (f.state === "TEMP" || f.state === "RETIRED") { f.bytes = Buffer.from("%PDF-1.4 LATE BYTES FROM A"); f.revisionId = "rev_late"; }
      return first.id;
    })();

    // B, under the same token, reads the candidate, creates the document and links it.
    const done = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    await linkCertificate(c.id, ADMIN, deps());

    const activeId = done.driveFileId!;
    const recordedHash = done.pdfHash!;

    // …and only now does A's write land.
    release();
    const tempId = await inFlight;

    expect(activeId).not.toBe(tempId);                                   // different files
    const onDisk = drive.files.find((f) => f.id === activeId)!;
    const late = drive.files.find((f) => f.id === tempId)!;
    expect(late.bytes.toString()).toContain("LATE BYTES FROM A");         // A did land
    expect(late.state).not.toBe("ACTIVE");                                // but not on the document

    // Downloaded from Drive and hashed for real — not the database, not appProperties.
    const downloaded = await fakeDrive().read({ fileId: activeId });
    expect(fileHash(downloaded!)).toBe(recordedHash);
    expect(onDisk.state).toBe("ACTIVE");

    // And the payment gate still passes, because the document is what it was.
    const gateResult = await checkEvidenceBeforePaying([await rowsNow() as Expense[]], { actorId: ADMIN.id, actorRole: ADMIN.role }, deps());
    expect(gateResult.ok).toBe(true);
  });
});

describe("dying part way through", () => {
  const attested = async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    return c;
  };

  it("dying after the document exists but before it is recorded — the retry reuses it", async () => {
    const c = await attested();
    const dying = fakeDrive();
    const create = dying.createActive.bind(dying);
    dying.createActive = async (o) => { const f = await create(o); throw Object.assign(new Error("process died"), { madeFileId: f.id }); };
    await expect(uploadCertificate(c.id, ADMIN, deps({ drive: dying, newToken: () => "token-A" }))).rejects.toThrow("process died");

    const orphan = drive.active()[0];
    expect(orphan).toBeTruthy();
    expect((await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!.driveFileId).toBeNull();

    const retried = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    expect(retried.driveFileId).toBe(orphan.id);      // the same document, not a second one
    expect(drive.active()).toHaveLength(1);
  });

  it("losing the database transition after the document exists leaves it unused", async () => {
    const c = await attested();
    const slow = fakeDrive();
    const create = slow.createActive.bind(slow);
    slow.createActive = async (o) => { const f = await create(o); await new Promise((r) => setTimeout(r, 200)); return f; };
    const a = uploadCertificate(c.id, ADMIN, deps({ drive: slow, leaseMs: 60, heartbeatMs: 10_000, newToken: () => "token-A" }));
    await new Promise((r) => setTimeout(r, 140));
    const b = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-B" }));
    await expect(a).rejects.toMatchObject({ reasons: [expect.stringContaining("took over filing")] });

    expect(drive.active()).toHaveLength(1);
    expect(drive.active()[0].id).toBe(b.driveFileId);
    const aDoc = drive.files.find((f) => f.forensic?.attemptToken === "token-A" && f.name.startsWith("QUARANTINED"));
    expect(aDoc, "A's document candidate must be put away, not left usable").toBeTruthy();
  });

  it("dying after it is recorded — nothing makes a second document", async () => {
    const c = await attested();
    const done = await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    // Whatever runs next finds it already settled and adds nothing.
    const check = await checkFiledDocument((await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!, deps(), ADMIN.id);
    expect(check.ok).toBe(true);
    expect(drive.active()).toHaveLength(1);
    expect(drive.active()[0].id).toBe(done.driveFileId);
  });

  it("no record ever points at a candidate", async () => {
    const c = await attested();
    const done = await uploadCertificate(c.id, ADMIN, deps());
    await linkCertificate(c.id, ADMIN, deps());
    const row = (await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!;
    expect(row.status).toBe("LINKED");
    expect(drive.files.find((f) => f.id === row.driveFileId)!.state).toBe("ACTIVE");
    expect(row.driveFileId).toBe(done.driveFileId);
    // Every TEMP this certificate ever had is retired or quarantined, never referenced.
    for (const f of drive.files.filter((x) => x.id !== row.driveFileId)) {
      expect(["RETIRED", "QUARANTINED"]).toContain(f.state);
    }
  });
});

describe("every gate that money passes through asks the same verifier", () => {
  const linkedCert = async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    await uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" }));
    return linkCertificate(c.id, ADMIN, deps());
  };
  const at = async (stage: "preview" | "document" | "payment", d: Deps = deps()) =>
    checkEvidenceBeforePaying([await rowsNow() as Expense[]], { actorId: ADMIN.id, actorRole: ADMIN.role }, d, stage);

  it("an edited document blocks pricing, document creation and payment alike", async () => {
    const cert = await linkedCert();
    drive.active()[0].bytes = Buffer.from("EDITED IN DRIVE");
    drive.active()[0].revisionId = "rev_edited";

    const preview = await at("preview");
    expect(preview.ok).toBe(false);
    expect(preview.stale).toEqual([cert.certificateNo]);          // marked on first sight
    // …and every later gate agrees, without needing to notice it again.
    for (const stage of ["document", "payment"] as const) {
      const g = await at(stage);
      expect(g.ok, stage).toBe(false);
      expect(g.reasons.join(" ")).toContain("no longer matching its document");
    }
    expect((await prisma.expenseCertificate.findUnique({ where: { id: cert.id } }))!.status).toBe("STALE");
  });

  it("Drive being unreadable fails closed rather than passing", async () => {
    await linkedCert();
    const broken = fakeDrive();
    broken.findActive = async () => { throw new Error("drive 503: unavailable"); };
    await expect(at("payment", deps({ drive: broken }))).rejects.toThrow(/unavailable/);
  });

  it("a document that has vanished fails closed, and is not marked stale", async () => {
    const cert = await linkedCert();
    drive.files.length = 0;
    const g = await at("payment");
    expect(g.ok).toBe(false);
    expect(g.reasons.join(" ")).toContain("no longer in Drive");
    // Missing is not the same as changed: a folder problem should not brand the
    // certificate, because the document may still be recoverable.
    expect((await prisma.expenseCertificate.findUnique({ where: { id: cert.id } }))!.status).toBe("LINKED");
  });

  it("two settled documents fail closed at every stage", async () => {
    await linkedCert();
    const first = drive.active()[0];
    drive.files.push({ ...first, id: "drive_clone", revisionId: "rev_clone" });
    for (const stage of ["preview", "document", "payment"] as const) {
      expect((await at(stage)).ok, stage).toBe(false);
    }
  });

  it("an untouched document passes every stage", async () => {
    await linkedCert();
    for (const stage of ["preview", "document", "payment"] as const) {
      const g = await at(stage);
      expect(g.ok, stage).toBe(true);
      expect(g.checked).toBe(1);
    }
  });
});

describe("what survives a failure after the document is settled", () => {
  it("cleanup failing after it is recorded leaves the evidence untouched", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());

    // Retiring the candidate and quarantining the losers both fail — the tidying up,
    // not the document.
    const messy = fakeDrive();
    messy.retire = async () => { throw new Error("drive 500: retire failed"); };
    messy.quarantine = async () => { throw new Error("drive 500: quarantine failed"); };
    const done = await uploadCertificate(c.id, ADMIN, deps({ drive: messy, newToken: () => "token-A" }));

    expect(done.status).toBe("UPLOADED");
    const active = drive.files.find((f) => f.id === done.driveFileId)!;
    expect(active.state).toBe("ACTIVE");
    expect(fileHash(active.bytes)).toBe(done.pdfHash);            // the bytes are the bytes
    expect((await linkCertificate(c.id, ADMIN, deps({ drive: messy }))).status).toBe("LINKED");
  });

  it("a certificate that is LINKED never names a candidate", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    await uploadCertificate(c.id, ADMIN, deps());
    await linkCertificate(c.id, ADMIN, deps());
    const linkedRows = await prisma.expenseCertificate.findMany({ where: { status: "LINKED" } });
    expect(linkedRows.length).toBeGreaterThan(0);
    for (const row of linkedRows) {
      const f = drive.files.find((x) => x.id === row.driveFileId);
      expect(f, `${row.certificateNo} names a file that is not in Drive`).toBeTruthy();
      expect(f!.state, `${row.certificateNo} names a ${f!.state} file`).toBe("ACTIVE");
    }
  });

  it("a reused document from an earlier attempt is checked again before it is used", async () => {
    await seedSheet([e("Ferry", 11)]);
    const c = await createCertificate({ guideId: GUIDE, date: DATE, slotIdx: 0 }, ADMIN, deps());
    await attestCertificate(c.id, ADMIN, deps());
    // The document is created, then the process dies before it is recorded.
    const dying = fakeDrive();
    const create = dying.createActive.bind(dying);
    dying.createActive = async (o) => { await create(o); throw new Error("process died"); };
    await expect(uploadCertificate(c.id, ADMIN, deps({ drive: dying, newToken: () => "token-A" }))).rejects.toThrow();
    const orphan = drive.active()[0];

    // Somebody edits that orphan before the retry finds it.
    orphan.bytes = Buffer.from("EDITED WHILE NOBODY WAS LOOKING");
    const why = await refusal(() => uploadCertificate(c.id, ADMIN, deps({ newToken: () => "token-A" })));
    expect(why[0]).toContain("did not read back");
    expect((await prisma.expenseCertificate.findUnique({ where: { id: c.id } }))!.driveFileId).toBeNull();
    expect(drive.files.find((f) => f.id === orphan.id)!.state).toBe("QUARANTINED");
  });
});
