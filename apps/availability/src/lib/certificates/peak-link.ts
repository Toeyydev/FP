import type { Prisma, PrismaClient, ExpenseCertificate } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

// Which PEAK expense document a certificate's job belongs to.
//
// The cardinality is not symmetric, and getting it backwards is the whole risk here:
//
//   one job sheet   → at most one EXP, and at most one ACTIVE certificate
//   one EXP         → many job sheets, and therefore many certificates
//
// The second line is what a combined payment is. Six of a guide's jobs paid in one
// transfer share one EXP, and each of those six sheets may have its own certificate
// covering its own unreceipted rows. A rule of one certificate per EXP would leave five
// of them with no evidence; splitting the EXP per sheet would undo the combined payment,
// cost a PEAK document each, and is the fragmentation this company already fixed once.
//
// So nothing here creates, splits or amends a PEAK document. It reads which document a
// job sheet's money went out in, and writes that down.
//
// IDENTITY, and only identity. The chain is:
//
//   certificate.jobSheetId
//     → JobSheet (guideId, date, slotIdx)              — a unique key
//       → TourPayment.peakPaymentRef                   — set when the payment is CLAIMED
//         → GuidePaymentDocument.paymentRef            — unique
//           → peakDocumentNo / peakDocumentId
//
// or, for a sheet posted to PEAK on its own, JobSheet.peakDocumentNo directly. A guide's
// name is never compared, a nearby date is never compared, and nothing is matched by its
// position in a list.

/** Documents that still hold their jobs. FAILED and VOIDED have released them. */
const HOLDS_JOBS = ["CREATING", "CREATE_UNCERTAIN", "AWAITING_PAYMENT", "PAYING", "PAYMENT_UNCERTAIN", "PAID"];

export type PeakLink = {
  paymentRef: string | null;
  documentNo: string | null;
  documentId: string | null;
  documentLink: string | null;
  /** Which arrangement this job's accounting is in. */
  source: "COMBINED_PAYMENT" | "JOB_SHEET_SYNC";
  /** The date the money actually moved, when it has. */
  paidDate: string | null;
  /** How many job sheets share this document. One EXP, many jobs, many certificates. */
  jobCount: number;
};

export type LinkLookup =
  | { found: true; link: PeakLink }
  | { found: false; reason: string }
  | { found: false; conflict: string; reason: string };

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The PEAK document for one job sheet, or why there is not exactly one.
 *
 * A job sheet may be in a combined payment or posted on its own, never both — the
 * payment path refuses a sheet that already carries its own EXP. If both are somehow
 * present, that is an anomaly with a real accounting meaning (the job may be booked
 * twice), and this refuses to choose between them rather than picking the one that
 * happens to be checked first.
 */
export async function peakDocumentForJob(
  job: { guideId: string; date: string; slotIdx: number },
  db: Db = prisma,
): Promise<LinkLookup> {
  const [sheet, tourPay] = await Promise.all([
    db.jobSheet.findUnique({
      where: { guideId_date_slotIdx: job },
      select: { peakDocumentNo: true, peakDocumentId: true, paymentDate: true },
    }),
    db.tourPayment.findUnique({
      where: { guideId_date_slotIdx: job },
      select: { peakPaymentRef: true, paidAt: true },
    }),
  ]);

  const ownDocNo = (sheet?.peakDocumentNo ?? "").trim();
  const paymentRef = (tourPay?.peakPaymentRef ?? "").trim();

  const combined = paymentRef
    ? await db.guidePaymentDocument.findUnique({
        where: { paymentRef },
        select: { paymentRef: true, status: true, peakDocumentNo: true, peakDocumentId: true, peakDocumentLink: true, paymentDate: true, jobs: true },
      })
    : null;
  const live = combined && HOLDS_JOBS.includes(combined.status) ? combined : null;

  // One job sheet, one EXP. Two is not something to resolve by preference.
  if (ownDocNo && live?.peakDocumentNo && live.peakDocumentNo !== ownDocNo) {
    return {
      found: false,
      conflict: "two-documents",
      reason: `This job sheet names two PEAK documents — ${ownDocNo} from its own sync and ${live.peakDocumentNo} from ${live.paymentRef}. One job belongs in one document, so which one this certificate accompanies cannot be answered until that is sorted out in PEAK.`,
    };
  }

  if (live?.peakDocumentId || live?.peakDocumentNo) {
    return {
      found: true,
      link: {
        paymentRef: live.paymentRef,
        documentNo: live.peakDocumentNo,
        documentId: live.peakDocumentId,
        documentLink: live.peakDocumentLink,
        source: "COMBINED_PAYMENT",
        paidDate: live.status === "PAID" ? live.paymentDate ?? null : null,
        jobCount: Array.isArray(live.jobs) ? live.jobs.length : 0,
      },
    };
  }

  if (ownDocNo) {
    return {
      found: true,
      link: {
        paymentRef: null,
        documentNo: ownDocNo,
        documentId: (sheet?.peakDocumentId ?? "").trim() || null,
        documentLink: null,
        source: "JOB_SHEET_SYNC",
        paidDate: tourPay?.paidAt ? tourPay.paidAt.toISOString().slice(0, 10) : sheet?.paymentDate ?? null,
        jobCount: 1,
      },
    };
  }

  return {
    found: false,
    reason: paymentRef
      ? `This job is claimed by ${paymentRef}, which has no PEAK document number yet. The certificate stands on its own until that document exists.`
      : "This job is not in a PEAK document yet. The certificate stands on its own until it is.",
  };
}

const same = (a: string | null, b: string | null) => (a ?? "") === (b ?? "");

/**
 * Write the document onto the certificate.
 *
 * Idempotent and conditional: the update matches only a row that is unstamped or already
 * carries this exact document, so running it twice changes nothing and a race produces
 * one stamp rather than two. A certificate already stamped with a DIFFERENT document is
 * never overwritten — that is an anomaly worth a person's attention, not a value to
 * refresh.
 */
export async function stampPeakLink(
  cert: Pick<ExpenseCertificate, "id" | "certificateNo" | "peakDocumentNo" | "peakDocumentId">,
  link: PeakLink,
  actor: { actorId?: string | null; actorRole?: string | null },
  db: Db = prisma,
): Promise<"stamped" | "unchanged" | "conflict"> {
  if (cert.peakDocumentNo && !same(cert.peakDocumentNo, link.documentNo)) {
    await audit({ ...actor, action: "certificate.peak_link_conflict", entityType: "ExpenseCertificate", entityId: cert.id,
      detail: { certificateNo: cert.certificateNo, recorded: cert.peakDocumentNo, found: link.documentNo, paymentRef: link.paymentRef,
        note: "the certificate already names a different PEAK document; nothing was changed" } });
    return "conflict";
  }

  const wrote = await db.expenseCertificate.updateMany({
    where: {
      id: cert.id,
      status: { not: "VOID" },
      OR: [{ peakDocumentNo: null }, { peakDocumentNo: link.documentNo }],
    },
    data: {
      peakPaymentRef: link.paymentRef,
      peakDocumentNo: link.documentNo,
      peakDocumentId: link.documentId,
      peakDocumentLink: link.documentLink,
      peakDocumentSource: link.source,
      peakPaidDate: link.paidDate,
      peakLinkedAt: new Date(),
    },
  });
  if (wrote.count === 0) return "conflict";

  // Already carrying exactly this document: the write refreshed the paid date and
  // nothing else, and an audit row for every one of those would bury the rows that say
  // something happened.
  if (same(cert.peakDocumentNo, link.documentNo) && same(cert.peakDocumentId, link.documentId)) return "unchanged";

  await audit({ ...actor, action: "certificate.peak_linked", entityType: "ExpenseCertificate", entityId: cert.id,
    detail: { certificateNo: cert.certificateNo, paymentRef: link.paymentRef, documentNo: link.documentNo, documentId: link.documentId,
      source: link.source, jobsInDocument: link.jobCount, paidDate: link.paidDate,
      note: "recorded which PEAK document this job's accounting is in; no PEAK document was created, amended or split" } });
  return "stamped";
}

/**
 * Link every active certificate whose job sheet is in this payment document.
 *
 * Called when the EXP is created and again when it is paid, so a certificate issued
 * before either still ends up pointing at the right document without anyone matching
 * anything by hand. Jobs are found through `TourPayment.peakPaymentRef` — the lock the
 * payment itself wrote — not through the document's `jobs` snapshot, because the lock is
 * what is true now and the snapshot is what was claimed then.
 */
export async function linkCertificatesForPayment(
  paymentRef: string,
  actor: { actorId?: string | null; actorRole?: string | null },
  db: Db = prisma,
): Promise<{ linked: number; unchanged: number; conflicts: number }> {
  const doc = await db.guidePaymentDocument.findUnique({
    where: { paymentRef },
    select: { paymentRef: true, status: true, peakDocumentNo: true, peakDocumentId: true, peakDocumentLink: true, paymentDate: true, jobs: true },
  });
  if (!doc || !HOLDS_JOBS.includes(doc.status) || !(doc.peakDocumentNo || doc.peakDocumentId)) {
    return { linked: 0, unchanged: 0, conflicts: 0 };
  }

  const held = await db.tourPayment.findMany({
    where: { peakPaymentRef: paymentRef },
    select: { guideId: true, date: true, slotIdx: true },
  });
  if (!held.length) return { linked: 0, unchanged: 0, conflicts: 0 };

  const sheets = await db.jobSheet.findMany({
    where: { OR: held.map((h) => ({ guideId: h.guideId, date: h.date, slotIdx: h.slotIdx })) },
    select: { id: true },
  });
  if (!sheets.length) return { linked: 0, unchanged: 0, conflicts: 0 };

  // Active only. A voided certificate keeps its history and is not evidence, so it is
  // not given a document it never accompanied.
  const certs = await db.expenseCertificate.findMany({
    where: { jobSheetId: { in: sheets.map((s) => s.id) }, status: { not: "VOID" } },
    select: { id: true, certificateNo: true, peakDocumentNo: true, peakDocumentId: true },
  });

  const link: PeakLink = {
    paymentRef: doc.paymentRef,
    documentNo: doc.peakDocumentNo,
    documentId: doc.peakDocumentId,
    documentLink: doc.peakDocumentLink,
    source: "COMBINED_PAYMENT",
    paidDate: doc.status === "PAID" ? doc.paymentDate ?? null : null,
    jobCount: Array.isArray(doc.jobs) ? doc.jobs.length : 0,
  };

  const out = { linked: 0, unchanged: 0, conflicts: 0 };
  for (const c of certs) {
    const r = await stampPeakLink(c, link, actor, db);
    if (r === "stamped") out.linked++;
    else if (r === "unchanged") out.unchanged++;
    else out.conflicts++;
  }
  return out;
}

/**
 * What to show for a certificate: what was recorded, or what is true right now.
 *
 * A certificate can be issued before its EXP exists, so the panel must read correctly in
 * the meantime and start reading correctly the moment the document appears — without
 * waiting for a write. The recorded stamp wins when it is there, because it is what was
 * audited; otherwise the same chain is followed live.
 */
export async function certificatePeakView(
  cert: Pick<ExpenseCertificate, "guideId" | "tourDate" | "slotIdx" | "peakPaymentRef" | "peakDocumentNo" | "peakDocumentId" | "peakDocumentLink" | "peakDocumentSource" | "peakPaidDate" | "peakLinkedAt">,
  db: Db = prisma,
): Promise<{ link: PeakLink | null; recorded: boolean; reason: string | null; conflict: string | null }> {
  if (cert.peakDocumentNo || cert.peakDocumentId) {
    return {
      recorded: true,
      conflict: null,
      reason: null,
      link: {
        paymentRef: cert.peakPaymentRef,
        documentNo: cert.peakDocumentNo,
        documentId: cert.peakDocumentId,
        documentLink: cert.peakDocumentLink,
        source: (cert.peakDocumentSource as PeakLink["source"]) ?? "COMBINED_PAYMENT",
        paidDate: cert.peakPaidDate,
        jobCount: 0,
      },
    };
  }
  const found = await peakDocumentForJob({ guideId: cert.guideId, date: cert.tourDate, slotIdx: cert.slotIdx }, db);
  if (found.found) return { link: found.link, recorded: false, reason: null, conflict: null };
  return { link: null, recorded: false, reason: found.reason, conflict: "conflict" in found ? found.conflict : null };
}
