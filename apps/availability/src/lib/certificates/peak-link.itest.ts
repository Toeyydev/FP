import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { certificatePeakView, linkCertificatesForPayment, peakDocumentForJob } from "@/lib/certificates/peak-link";
import {
  AttachRefused, claimAttachment, classifyPeakReply, recordAttempt, reclaimRefused, resolveAttachment,
} from "@/lib/certificates/peak-attach";

// One EXP, several job sheets, a certificate for each.
//
// This is the shape a combined payment actually has: six of a guide's jobs paid in one
// transfer share one PEAK expense document, and each of those job sheets may have its
// own certificate covering only its own unreceipted rows. Nothing here creates, splits
// or amends a PEAK document — it records which one a job's money went out in.
//
// All data invented — this repo is public.

const GUIDE = "G-900";
const ADMIN = { actorId: "u_admin", actorRole: "ADMIN" };
const EXP = "EXP-TEST-20990400001";
const DOC_ID = "peak-doc-id-test-0001";
const PAY_REF = "FOLK-PAY-209904-01";

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(GUIDE);
  const before = process.env.CERTIFICATE_PEAK_ATTACH;
  if (before !== undefined) delete process.env.CERTIFICATE_PEAK_ATTACH;
});
afterEach(() => { delete process.env.CERTIFICATE_PEAK_ATTACH; });

const job = (n: number) => ({ guideId: GUIDE, date: `2099-04-0${n}`, slotIdx: 0 });

async function seedSheet(n: number) {
  return prisma.jobSheet.create({
    data: { ...job(n), ref: `FOLK-TEST-2099040${n}-01`, tourId: "T-900", status: "Confirmed", expenses: [], guideFee: {} },
  });
}

async function seedCertificate(sheetId: string, n: number, over: Record<string, unknown> = {}) {
  return prisma.expenseCertificate.create({
    data: {
      certificateNo: `CERT-FOLK-TEST-2099040${n}-01-01`, jobSheetId: sheetId, activeJobSheetId: sheetId,
      guideId: GUIDE, jobRef: `FOLK-TEST-2099040${n}-01`, tourDate: `2099-04-0${n}`, slotIdx: 0,
      status: "LINKED", payload: {}, payloadHash: `hash${n}`.padEnd(64, "0"), coveredRows: [], totalSatang: 32400,
      sourceSheetUpdatedAt: new Date(), pdfHash: `pdf${n}`.padEnd(64, "a"),
      ...over,
    },
  });
}

/** A combined payment: one document, N jobs locked to it. */
async function seedCombined(jobs: number[], over: Record<string, unknown> = {}) {
  await prisma.guidePaymentDocument.create({
    data: {
      paymentRef: PAY_REF, guideId: GUIDE,
      jobs: jobs.map((n) => ({ date: `2099-04-0${n}`, slotIdx: 0, ref: `FOLK-TEST-2099040${n}-01`, payout: 324 })),
      lines: [], total: 1924, status: "AWAITING_PAYMENT",
      peakDocumentNo: EXP, peakDocumentId: DOC_ID, peakDocumentLink: "https://peak.example.test/exp/1",
      ...over,
    },
  });
  for (const n of jobs) {
    await prisma.tourPayment.create({ data: { ...job(n), tourId: "T-900", status: "APPROVED", peakPaymentRef: PAY_REF } });
  }
}

// ── the cardinality ──────────────────────────────────────────────────────────

describe("one EXP covers many job sheets, so it carries many certificates", () => {
  it("three certificates on three job sheets all name the same EXP", async () => {
    const sheets = [await seedSheet(1), await seedSheet(2), await seedSheet(3)];
    await seedCombined([1, 2, 3]);
    for (const [i, s] of sheets.entries()) await seedCertificate(s.id, i + 1);

    const out = await linkCertificatesForPayment(PAY_REF, ADMIN);
    expect(out).toEqual({ linked: 3, unchanged: 0, conflicts: 0 });

    const certs = await prisma.expenseCertificate.findMany({ orderBy: { certificateNo: "asc" } });
    expect(certs).toHaveLength(3);
    for (const c of certs) {
      expect(c.peakDocumentNo).toBe(EXP);
      expect(c.peakDocumentId).toBe(DOC_ID);
      expect(c.peakPaymentRef).toBe(PAY_REF);
      expect(c.peakDocumentSource).toBe("COMBINED_PAYMENT");
    }
    // And one PEAK document still, because linking creates nothing.
    expect(await prisma.guidePaymentDocument.count()).toBe(1);
  });

  it("a job sheet with nothing to certify simply has no certificate", async () => {
    const [a, b] = [await seedSheet(1), await seedSheet(2)];
    await seedCombined([1, 2]);
    await seedCertificate(a.id, 1); // only one of the two needs one
    expect(await linkCertificatesForPayment(PAY_REF, ADMIN)).toEqual({ linked: 1, unchanged: 0, conflicts: 0 });
    expect(await prisma.expenseCertificate.count()).toBe(1);
    expect(b.id).toBeTruthy();
  });

  it("running it twice changes nothing the second time", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    await seedCertificate(s.id, 1);
    expect(await linkCertificatesForPayment(PAY_REF, ADMIN)).toEqual({ linked: 1, unchanged: 0, conflicts: 0 });
    expect(await linkCertificatesForPayment(PAY_REF, ADMIN)).toEqual({ linked: 0, unchanged: 1, conflicts: 0 });
  });

  it("a voided certificate is not given a document it never accompanied", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    await seedCertificate(s.id, 1, { status: "VOID", activeJobSheetId: null, voidedAt: new Date(), voidReason: "superseded by a corrected sheet" });
    expect(await linkCertificatesForPayment(PAY_REF, ADMIN)).toEqual({ linked: 0, unchanged: 0, conflicts: 0 });
    expect((await prisma.expenseCertificate.findFirst())!.peakDocumentNo).toBeNull();
  });
});

// ── identity, not resemblance ────────────────────────────────────────────────

describe("the document is found through recorded identity", () => {
  it("a certificate issued before the EXP exists reads correctly, then links when it does", async () => {
    const s = await seedSheet(1);
    await prisma.tourPayment.create({ data: { ...job(1), tourId: "T-900", status: "APPROVED", peakPaymentRef: PAY_REF } });
    await prisma.guidePaymentDocument.create({
      data: { paymentRef: PAY_REF, guideId: GUIDE, jobs: [{ date: "2099-04-01", slotIdx: 0, ref: "FOLK-TEST-20990401-01", payout: 324 }], lines: [], total: 324, status: "CREATING" },
    });
    const cert = await seedCertificate(s.id, 1);

    const before = await certificatePeakView(cert);
    expect(before.link).toBeNull();
    expect(before.reason).toContain(PAY_REF);
    expect(before.reason).toContain("no PEAK document number yet");

    // PEAK answers; the document takes its number; the certificate follows.
    await prisma.guidePaymentDocument.update({ where: { paymentRef: PAY_REF }, data: { status: "AWAITING_PAYMENT", peakDocumentNo: EXP, peakDocumentId: DOC_ID } });
    expect((await linkCertificatesForPayment(PAY_REF, ADMIN)).linked).toBe(1);
    const after = await certificatePeakView((await prisma.expenseCertificate.findUnique({ where: { id: cert.id } }))!);
    expect(after.recorded).toBe(true);
    expect(after.link!.documentNo).toBe(EXP);
  });

  it("a sheet posted to PEAK on its own links to its own EXP", async () => {
    const s = await seedSheet(1);
    await prisma.jobSheet.update({ where: { id: s.id }, data: { peakDocumentNo: "EXP-TEST-OWN-0001", peakDocumentId: "own-doc-id" } });
    const found = await peakDocumentForJob(job(1));
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.link.source).toBe("JOB_SHEET_SYNC");
    expect(found.link.documentNo).toBe("EXP-TEST-OWN-0001");
    expect(found.link.jobCount).toBe(1);
  });

  it("two documents for one job sheet refuses to choose between them", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    await prisma.jobSheet.update({ where: { id: s.id }, data: { peakDocumentNo: "EXP-TEST-OWN-0001", peakDocumentId: "own-doc-id" } });
    const found = await peakDocumentForJob(job(1));
    expect(found.found).toBe(false);
    if (found.found) return;
    expect("conflict" in found && found.conflict).toBe("two-documents");
    expect(found.reason).toContain("EXP-TEST-OWN-0001");
    expect(found.reason).toContain(EXP);
  });

  it("a released document does not lend its number to anybody", async () => {
    await seedSheet(1);
    await seedCombined([1], { status: "VOIDED" });
    const found = await peakDocumentForJob(job(1));
    expect(found.found).toBe(false);
  });

  it("a certificate already naming a different EXP is never overwritten", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    await seedCertificate(s.id, 1, { peakDocumentNo: "EXP-SOMETHING-ELSE", peakDocumentId: "other-id" });
    expect(await linkCertificatesForPayment(PAY_REF, ADMIN)).toEqual({ linked: 0, unchanged: 0, conflicts: 1 });
    expect((await prisma.expenseCertificate.findFirst())!.peakDocumentNo).toBe("EXP-SOMETHING-ELSE");
    expect(await prisma.auditLog.findFirst({ where: { action: "certificate.peak_link_conflict" } })).toBeTruthy();
  });
});

// ── the attachment ledger ────────────────────────────────────────────────────

describe("one certificate is attached to one document once", () => {
  const claimFor = async (certId: string, certNo: string, hash: string) =>
    claimAttachment({ certificateId: certId, certificateNo: certNo, peakDocumentId: DOC_ID, peakDocumentNo: EXP, peakPaymentRef: PAY_REF, pdfHash: hash, fileName: `${certNo}.pdf` }, ADMIN.actorId);

  const linked = async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    const c = await seedCertificate(s.id, 1);
    await linkCertificatesForPayment(PAY_REF, ADMIN);
    process.env.CERTIFICATE_PEAK_ATTACH = "1";
    return c;
  };

  it("with the flag off nothing is claimed and no row is written", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    const c = await seedCertificate(s.id, 1);
    await expect(claimFor(c.id, c.certificateNo, c.pdfHash!)).rejects.toThrow(AttachRefused);
    expect(await prisma.peakAttachment.count()).toBe(0);
    // …and linking went on working regardless.
    expect((await linkCertificatesForPayment(PAY_REF, ADMIN)).linked).toBe(1);
  });

  it("a second claim finds the first rather than making another", async () => {
    const c = await linked();
    const first = await claimFor(c.id, c.certificateNo, c.pdfHash!);
    expect(first.claimed).toBe(true);
    const second = await claimFor(c.id, c.certificateNo, c.pdfHash!);
    expect(second.claimed).toBe(false);
    expect(second.token).toBeNull();
    expect(second.row.id).toBe(first.row.id);
    expect(await prisma.peakAttachment.count()).toBe(1);
  });

  it("a different PDF under the same certificate is a contradiction, not an update", async () => {
    const c = await linked();
    await claimFor(c.id, c.certificateNo, c.pdfHash!);
    await expect(claimFor(c.id, c.certificateNo, "b".repeat(64))).rejects.toThrow(/does not change/);
    expect(await prisma.peakAttachment.count()).toBe(1);
  });

  it("what PEAK said is written down, not inferred later", async () => {
    const c = await linked();
    const { row, token } = await claimFor(c.id, c.certificateNo, c.pdfHash!);
    const at = new Date("2099-04-10T03:00:00.000Z");
    const saved = await recordAttempt(row.id, token!, { encoding: "DATA_URI_BASE64", at }, classifyPeakReply({ httpStatus: 200, body: { resCode: "200", resDesc: "Success" } }), ADMIN);
    expect(saved!.state).toBe("PEAK_ACCEPTED");
    expect(saved!.requestEncoding).toBe("DATA_URI_BASE64");
    expect(saved!.peakResCode).toBe("200");
    expect(saved!.attemptedAt!.toISOString()).toBe(at.toISOString());
    expect(await prisma.auditLog.findFirst({ where: { action: "certificate.peak_attach_peak_accepted" } })).toBeTruthy();
  });

  it("an attempt that lost its claim records nothing", async () => {
    const c = await linked();
    const { row, token } = await claimFor(c.id, c.certificateNo, c.pdfHash!);
    await recordAttempt(row.id, token!, { encoding: "PLAIN_BASE64", at: new Date() }, classifyPeakReply({ httpStatus: 200, body: { resCode: "200" } }), ADMIN);
    // The same token again: the row has moved on, so this must change nothing.
    const again = await recordAttempt(row.id, token!, { encoding: "PLAIN_BASE64", at: new Date() }, classifyPeakReply({ httpStatus: 500, body: null }), ADMIN);
    expect(again).toBeNull();
    expect((await prisma.peakAttachment.findUnique({ where: { id: row.id } }))!.state).toBe("PEAK_ACCEPTED");
  });
});

describe("only a person can say the file is there", () => {
  const uncertain = async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    const c = await seedCertificate(s.id, 1);
    await linkCertificatesForPayment(PAY_REF, ADMIN);
    process.env.CERTIFICATE_PEAK_ATTACH = "1";
    const { row, token } = await claimAttachment({ certificateId: c.id, certificateNo: c.certificateNo, peakDocumentId: DOC_ID, peakDocumentNo: EXP, peakPaymentRef: PAY_REF, pdfHash: c.pdfHash!, fileName: `${c.certificateNo}.pdf` }, ADMIN.actorId);
    await recordAttempt(row.id, token!, { encoding: "DATA_URI_BASE64", at: new Date() }, classifyPeakReply({ httpStatus: 504, body: null, transportError: "gateway timeout" }), ADMIN);
    return row;
  };

  it("an uncertain attempt waits for somebody to look", async () => {
    const row = await uncertain();
    expect((await prisma.peakAttachment.findUnique({ where: { id: row.id } }))!.state).toBe("ATTACHMENT_UNCERTAIN");
  });

  it("an admin who saw it makes it confirmed, with their name and the time", async () => {
    const row = await uncertain();
    const out = await resolveAttachment(row.id, "FOUND_IN_PEAK", { id: "u_admin", role: "ADMIN" }, "opened EXP in PEAK, the PDF is on it");
    expect(out.state).toBe("ATTACHED_CONFIRMED");
    expect(out.resolvedById).toBe("u_admin");
    expect(out.resolvedAt).toBeTruthy();
    const log = await prisma.auditLog.findFirst({ where: { action: "certificate.peak_attach_resolved" } });
    expect((log!.detail as { finding: string }).finding).toBe("FOUND_IN_PEAK");
  });

  it("an admin who did not see it says so, and that is not attached", async () => {
    const row = await uncertain();
    const out = await resolveAttachment(row.id, "NOT_FOUND_IN_PEAK", { id: "u_admin", role: "ADMIN" }, null);
    expect(out.state).toBe("NOT_FOUND_IN_PEAK");
  });

  it("an uncertain attempt is never sent again — it is settled by looking", async () => {
    const row = await uncertain();
    await expect(reclaimRefused(row.id, { id: "u_admin", role: "ADMIN" })).rejects.toThrow(/settled by looking/);
    expect(await prisma.peakAttachment.count()).toBe(1);
  });

  it("a refused attempt is sent again on the same row, never a new one", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    const c = await seedCertificate(s.id, 1);
    await linkCertificatesForPayment(PAY_REF, ADMIN);
    process.env.CERTIFICATE_PEAK_ATTACH = "1";
    const { row, token } = await claimAttachment({ certificateId: c.id, certificateNo: c.certificateNo, peakDocumentId: DOC_ID, peakDocumentNo: EXP, peakPaymentRef: PAY_REF, pdfHash: c.pdfHash!, fileName: `${c.certificateNo}.pdf` }, ADMIN.actorId);
    await recordAttempt(row.id, token!, { encoding: "PLAIN_BASE64", at: new Date() }, classifyPeakReply({ httpStatus: 200, body: { resCode: "400", resDesc: "Invalid Base64 string." } }), ADMIN);
    expect((await prisma.peakAttachment.findUnique({ where: { id: row.id } }))!.state).toBe("REFUSED");

    const again = await reclaimRefused(row.id, { id: "u_admin", role: "ADMIN" });
    expect(again.row.id).toBe(row.id);
    expect(again.row.state).toBe("CLAIMED");
    expect(await prisma.peakAttachment.count()).toBe(1);
  });
});

describe("attaching changes nothing about the money", () => {
  it("the EXP's total, status and paid state are untouched by the whole ledger", async () => {
    const s = await seedSheet(1);
    await seedCombined([1]);
    const c = await seedCertificate(s.id, 1);
    const before = (await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: PAY_REF } }))!;

    await linkCertificatesForPayment(PAY_REF, ADMIN);
    process.env.CERTIFICATE_PEAK_ATTACH = "1";
    const { row, token } = await claimAttachment({ certificateId: c.id, certificateNo: c.certificateNo, peakDocumentId: DOC_ID, peakDocumentNo: EXP, peakPaymentRef: PAY_REF, pdfHash: c.pdfHash!, fileName: "x.pdf" }, ADMIN.actorId);
    await recordAttempt(row.id, token!, { encoding: "DATA_URI_BASE64", at: new Date() }, classifyPeakReply({ httpStatus: 200, body: { resCode: "200" } }), ADMIN);
    await resolveAttachment(row.id, "FOUND_IN_PEAK", { id: "u_admin", role: "ADMIN" }, null);

    const after = (await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: PAY_REF } }))!;
    expect(after.total).toBe(before.total);
    expect(after.status).toBe(before.status);
    expect(after.peakDocumentNo).toBe(before.peakDocumentNo);
    expect(after.paymentDate).toBe(before.paymentDate);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    // And the job is exactly as unpaid as it was.
    expect((await prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: job(1) } }))!.status).toBe("APPROVED");
  });
});
