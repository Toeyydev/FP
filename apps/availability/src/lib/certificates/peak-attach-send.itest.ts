import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { fileHash } from "@/lib/certificates/payload";
import type { CertificateDrive } from "@/lib/certificates/drive";
import type { PeakExpenseState } from "@/lib/peak-api";
import { attachCertificateToPeak, attachNextCertificate, resetAttachBackoff, retryRefusedAttachment, type SendDeps } from "@/lib/certificates/peak-attach-send";
import { certificatePeakView, peakDocumentForJob } from "@/lib/certificates/peak-link";

// Sending a filed certificate's PDF to its EXP in PEAK — PEAK and Drive faked, the
// database real. What must hold: PEAK is read before anything is sent; a void, missing
// or reused document gets nothing; one certificate is sent once however many times it
// is asked for; only a refusal of the encoding is sent again by itself; an advance
// certificate is never sent to the guide payment's EXP.
//
// All data invented — this repo is public.

const GUIDE = "G-901";
const ADMIN = { actorId: "u_admin", actorRole: "ADMIN" };
const EXP = "EXP-TEST-20990500001";
const DOC_ID = "peak-doc-id-test-0501";
const PDF = Buffer.from("%PDF-1.4 invented certificate");

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(GUIDE);
  resetAttachBackoff();
  process.env.CERTIFICATE_PEAK_ATTACH = "1";
});
afterEach(() => { delete process.env.CERTIFICATE_PEAK_ATTACH; });

const expense = (over: Partial<PeakExpenseState> = {}): PeakExpenseState => ({
  id: DOC_ID, code: EXP, reference: null, contactId: null, status: "Approve", statusId: null, isVoid: false,
  netAmount: 1000, whtAmount: 30, paymentAmount: 970, remainAmount: 0, remainWhtAmount: 0, lineWhtAmount: 30,
  documentLink: "https://peak.example.test/exp/0501", payments: 1, ...over,
});

function fakes(opts: { expense?: PeakExpenseState | null; replies?: { code: string; desc: string }[]; sent?: boolean; bytes?: Buffer } = {}) {
  const calls: { encoding: string; fileName: string; transactionId?: string | null; rawStart: string }[] = [];
  const reads: { id?: string | null; code: string }[] = [];
  const replies = [...(opts.replies ?? [{ code: "200", desc: "Success" }])];
  const deps: SendDeps = {
    readExpense: async (ref) => { reads.push(ref); return opts.expense === null ? { ok: true, notFound: true } : { ok: true, expense: opts.expense ?? expense() }; },
    insert: async (input, encoding) => {
      calls.push({ encoding, fileName: input.fileName, transactionId: input.transactionId, rawStart: input.base64.slice(0, 8) });
      if (opts.sent === false) return { sent: false, httpStatus: 0, body: null, transportError: "could not obtain PEAK client token" };
      const r = replies.shift() ?? { code: "200", desc: "Success" };
      return { sent: true, httpStatus: 200, body: { peakExpenses: { resCode: r.code, resDesc: r.desc } }, transportError: null };
    },
    checkFile: async () => ({ ok: true, reasons: [] }),
    drive: { read: async () => opts.bytes ?? PDF } as unknown as CertificateDrive,
  };
  return { deps, calls, reads };
}

const job = (n: number) => ({ guideId: GUIDE, date: `2099-05-0${n}`, slotIdx: 0 });

async function seed(n: number, opts: { sheetExp?: string; recordedExp?: string; cert?: Record<string, unknown> } = {}) {
  const sheet = await prisma.jobSheet.create({
    data: { ...job(n), ref: `FOLK-TEST-2099050${n}-01`, tourId: "T-900", status: "Confirmed", expenses: [], guideFee: {},
      ...(opts.sheetExp ? { peakDocumentNo: opts.sheetExp, peakDocumentId: DOC_ID } : {}) },
  });
  if (opts.recordedExp) await prisma.tourPayment.create({ data: { ...job(n), tourId: "T-900", status: "PAID", paidAt: new Date(), peakRef: opts.recordedExp } });
  return prisma.expenseCertificate.create({
    data: {
      certificateNo: `CERT-FOLK-TEST-2099050${n}-01-01`, jobSheetId: sheet.id, activeJobSheetId: sheet.id,
      guideId: GUIDE, jobRef: sheet.ref, tourDate: job(n).date, slotIdx: 0,
      status: "LINKED", payload: {}, payloadHash: `hash${n}`.padEnd(64, "0"), coveredRows: [], totalSatang: 32400,
      sourceSheetUpdatedAt: new Date(), pdfHash: fileHash(PDF), driveFileId: `drive-file-${n}`, linkedAt: new Date(),
      ...opts.cert,
    },
  });
}

describe("sending one certificate", () => {
  it("reads PEAK, sends the filed PDF once as a data URI, and records PEAK's 200 as accepted — not as attached", async () => {
    const cert = await seed(1, { sheetExp: EXP });
    const f = fakes();
    const r = await attachCertificateToPeak(cert.id, ADMIN, f.deps);
    expect(r).toMatchObject({ ok: true, state: "PEAK_ACCEPTED", documentNo: EXP, replayed: false });
    expect(f.reads).toHaveLength(1);
    expect(f.calls).toEqual([{ encoding: "data-uri", fileName: expect.stringContaining(cert.certificateNo), transactionId: DOC_ID, rawStart: PDF.toString("base64").slice(0, 8) }]);
    const row = await prisma.peakAttachment.findFirstOrThrow({ where: { certificateId: cert.id } });
    expect(row).toMatchObject({ state: "PEAK_ACCEPTED", peakDocumentId: DOC_ID, peakDocumentNo: EXP, requestEncoding: "DATA_URI_BASE64", peakResCode: "200" });
  });

  it("asked twice (a double click, or the loop racing the button) sends once", async () => {
    const cert = await seed(1, { sheetExp: EXP });
    const f = fakes();
    const [a, b] = await Promise.all([attachCertificateToPeak(cert.id, ADMIN, f.deps), attachCertificateToPeak(cert.id, ADMIN, f.deps)]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(f.calls).toHaveLength(1);
    expect(await prisma.peakAttachment.count()).toBe(1);
    const again = await attachCertificateToPeak(cert.id, ADMIN, f.deps);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(f.calls).toHaveLength(1);
  });

  it("an EXP that is void, missing, or a reused number for another document gets nothing", async () => {
    const cases: [number, PeakExpenseState | null][] = [[1, expense({ isVoid: true })], [2, null], [3, expense({ id: "some-other-document" })]];
    for (const [n, e] of cases) {
      const cert = await seed(n, { sheetExp: EXP });
      const f = fakes({ expense: e });
      const r = await attachCertificateToPeak(cert.id, ADMIN, f.deps);
      expect(r.ok).toBe(false);
      expect(f.calls).toHaveLength(0);
    }
    expect(await prisma.peakAttachment.count()).toBe(0);
  });

  it("a PDF in Drive that is not the one filed is not sent", async () => {
    const cert = await seed(1, { sheetExp: EXP });
    const f = fakes({ bytes: Buffer.from("%PDF-1.4 something else") });
    const r = await attachCertificateToPeak(cert.id, ADMIN, f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("only a refusal of the encoding is sent again, in the other encoding; any other refusal waits for an admin", async () => {
    const a = await seed(1, { sheetExp: EXP });
    const f1 = fakes({ replies: [{ code: "400", desc: "Invalid Base64 string." }, { code: "200", desc: "Success" }] });
    expect(await attachCertificateToPeak(a.id, ADMIN, f1.deps)).toMatchObject({ ok: true, state: "PEAK_ACCEPTED" });
    expect(f1.calls.map((c) => c.encoding)).toEqual(["data-uri", "plain"]);
    expect((await prisma.peakAttachment.findFirstOrThrow({ where: { certificateId: a.id } })).requestEncoding).toBe("PLAIN_BASE64");

    const b = await seed(2, { sheetExp: EXP });
    const f2 = fakes({ sent: false });
    expect(await attachCertificateToPeak(b.id, ADMIN, f2.deps)).toMatchObject({ ok: true, state: "REFUSED" });
    expect(f2.calls).toHaveLength(1);
    const row = await prisma.peakAttachment.findFirstOrThrow({ where: { certificateId: b.id } });
    // The admin's retry reuses the same row.
    const f3 = fakes();
    expect(await retryRefusedAttachment(row.id, { id: "u_admin", role: "ADMIN" }, f3.deps)).toMatchObject({ ok: true, state: "PEAK_ACCEPTED", rowId: row.id });
    expect(await prisma.peakAttachment.count({ where: { certificateId: b.id } })).toBe(1);
  });

  it("an answer nobody can read is uncertain and is never sent again by itself", async () => {
    const cert = await seed(1, { sheetExp: EXP });
    const f = fakes({ replies: [{ code: "", desc: "" }] });
    expect(await attachCertificateToPeak(cert.id, ADMIN, f.deps)).toMatchObject({ ok: true, state: "ATTACHMENT_UNCERTAIN" });
    const row = await prisma.peakAttachment.findFirstOrThrow();
    expect((await retryRefusedAttachment(row.id, { id: "u_admin", role: "ADMIN" }, f.deps)).ok).toBe(false);
    expect(await attachNextCertificate(prisma, f.deps, Date.now() + 120_000)).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("switched off, nothing is read or sent", async () => {
    delete process.env.CERTIFICATE_PEAK_ATTACH;
    const cert = await seed(1, { sheetExp: EXP });
    const f = fakes();
    expect((await attachCertificateToPeak(cert.id, ADMIN, f.deps)).ok).toBe(false);
    expect(await attachNextCertificate(prisma, f.deps)).toBeNull();
    expect(f.reads.length + f.calls.length).toBe(0);
  });
});

describe("which document", () => {
  it("an EXP recorded by hand with Record EXP… is found, read in PEAK, and its id written down", async () => {
    const cert = await seed(1, { recordedExp: EXP });
    const look = await peakDocumentForJob(job(1));
    expect(look).toMatchObject({ found: true, link: { documentNo: EXP, documentId: null, source: "RECORDED_EXP" } });
    const f = fakes();
    expect(await attachCertificateToPeak(cert.id, ADMIN, f.deps)).toMatchObject({ ok: true, state: "PEAK_ACCEPTED" });
    expect(f.reads[0]).toEqual({ id: null, code: EXP });
    expect(await prisma.expenseCertificate.findUniqueOrThrow({ where: { id: cert.id } })).toMatchObject({ peakDocumentNo: EXP, peakDocumentId: DOC_ID, peakDocumentSource: "RECORDED_EXP" });
  });

  it("an EXP recorded by hand that disagrees with the system's is a conflict, and nothing is sent", async () => {
    const cert = await seed(1, { sheetExp: EXP, recordedExp: "EXP-TEST-20990500009" });
    expect(await peakDocumentForJob(job(1))).toMatchObject({ found: false, conflict: "two-documents" });
    const f = fakes();
    expect((await attachCertificateToPeak(cert.id, ADMIN, f.deps)).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("an advance certificate never names the guide payment's EXP and is never sent to it", async () => {
    const cert = await seed(1, { recordedExp: EXP, cert: { kind: "COMPANY_ADVANCE" } });
    expect((await certificatePeakView(cert)).link).toBeNull();
    const f = fakes();
    const r = await attachCertificateToPeak(cert.id, ADMIN, f.deps);
    expect(r.ok).toBe(false);
    expect(f.reads.length + f.calls.length).toBe(0);
  });

  it("only a LINKED certificate is sent", async () => {
    const cert = await seed(1, { sheetExp: EXP, cert: { status: "UPLOADED" } });
    const f = fakes();
    expect((await attachCertificateToPeak(cert.id, ADMIN, f.deps)).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("the background step", () => {
  it("sends one a minute, oldest first, and skips one that cannot be sent yet without writing anything", async () => {
    const noExp = await seed(1, { cert: { linkedAt: new Date("2099-01-01T00:00:00Z") } });
    const first = await seed(2, { sheetExp: EXP, cert: { linkedAt: new Date("2099-01-02T00:00:00Z") } });
    const second = await seed(3, { sheetExp: EXP, cert: { linkedAt: new Date("2099-01-03T00:00:00Z") } });
    const f = fakes();
    const t0 = Date.now();
    expect(await attachNextCertificate(prisma, f.deps, t0)).toMatchObject({ ok: true });
    expect((await prisma.peakAttachment.findMany()).map((r) => r.certificateId)).toEqual([first.id]);
    // Within the minute: nothing.
    expect(await attachNextCertificate(prisma, f.deps, t0 + 1_000)).toBeNull();
    // A minute later: the next one. The certificate with no EXP is not retried for an hour.
    await prisma.peakAttachment.updateMany({ data: { createdAt: new Date(t0 - 61_000) } });
    expect(await attachNextCertificate(prisma, f.deps, t0 + 61_000)).toMatchObject({ ok: true });
    expect((await prisma.peakAttachment.findMany({ orderBy: { createdAt: "asc" } })).map((r) => r.certificateId)).toEqual([first.id, second.id]);
    expect(await prisma.peakAttachment.count({ where: { certificateId: noExp.id } })).toBe(0);
    expect(f.calls).toHaveLength(2);
  });
});
