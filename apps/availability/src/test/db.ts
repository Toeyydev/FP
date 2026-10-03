import { prisma } from "@/lib/db";
import { localSwitches, type ServiceName } from "@/lib/peak-switches";

// Helpers for tests that use a real database. Importing this file at all is a
// declaration that the test needs one; guard() fails loudly rather than letting a
// suite pass by touching nothing.

/** Tables these tests write, in an order safe to truncate together. */
const TABLES = [
  "AuditLog", "ServiceStatus", "ReceiptClassification", "Checkin", "TourReport", "PushSubscription", "Notification",
  // The advance ledger and everything that hangs off it. Listed before JobSheet
  // and User because these rows reference them.
  "AdvancePeakDocumentLink", "AdvancePeakSync", "GuideAdvanceEntry",
  "GuideAdvanceRefund", "GuideAdvanceReceipt", "GuideAdvanceReturn", "GuideAdvance",
  // A guide's transfers, and the PEAK document each one settles. Before TourPayment,
  // which a recorded payment points back at.
  // Supplemental payments point at GuidePayment (their transfer and the payout they
  // followed), so they truncate first.
  "GuidePaymentSupplementLine", "SupplementalPayment", "Bonus",
  "GuidePaymentAdjustment", "GuidePaymentJob", "GuidePayment", "GuidePaymentDocument",
  // Certificates in lieu of receipts hang off JobSheet, so they truncate before it.
  // AttesterSignature is keyed on User and holds a unique driveFileId — left behind, it
  // makes the NEXT test collide on a file id its own fake Drive just reissued.
  "ExpenseCertificate", "AttesterSignature", "HistoricalEvidenceReview",
  "PaymentTransaction", "PaymentEvidence", "PaymentBatchItem", "PaymentBatch", "TourPayment", "PayrollStatus", "JobSheet", "Booking", "Assignment",
  "Availability", "RefreshToken", "User", "Tour",
];

export function requireTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("integration tests need DATABASE_URL (a throwaway database)");
  // A crude guard against ever pointing these at something real: they TRUNCATE.
  if (/railway|amazonaws|supabase|\.com\b/i.test(url) && !/test/i.test(url)) {
    throw new Error("DATABASE_URL looks like a real database; integration tests truncate tables and refuse to run");
  }
}

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** A tour + an active guide, the two rows almost every case needs. */
export async function seedGuide(guideId = "G-900", over: { displayName?: string; email?: string } = {}) {
  await prisma.tour.upsert({
    where: { id: "T-900" }, update: {},
    create: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 },
  });
  return prisma.user.create({
    data: {
      email: over.email ?? `${guideId.toLowerCase()}@example.test`,
      displayName: over.displayName ?? "Nok Example",
      guideId, role: "GUIDE", state: "ACTIVE",
    },
  });
}

let advanceSeq = 0;
/**
 * A company advance on record for a job — issued, live, with an invented number. What
 * entitles a row marked "From company advance" to be left out of the guide's transfer
 * (lib/advances/coverage).
 */
export async function seedAdvance(job: { guideId: string; date: string; slotIdx: number }, amount = 1000, over: { jobNo?: string | null; reversedAt?: Date | null; allowedCategories?: string[] } = {}) {
  const n = String(++advanceSeq).padStart(3, "0");
  return prisma.guideAdvance.create({ data: {
    guideId: job.guideId, date: job.date, slotIdx: job.slotIdx, amount, paidAt: new Date(`${job.date}T01:00:00Z`), method: "bank", txRef: `TX-SEED-${n}`,
    advanceNo: `FOLK-ADV-${job.date.slice(0, 4)}${job.date.slice(5, 7)}-9${n.slice(1)}${advanceSeq > 99 ? advanceSeq : ""}`, advanceDate: job.date, amountSatang: Math.round(amount * 100),
    accountingPeriod: job.date.slice(0, 7), jobNo: over.jobNo ?? null, slipUrl: "https://example.test/advance-slip",
    allowedCategories: over.allowedCategories ?? ["entrance"], reversedAt: over.reversedAt ?? null,
  } });
}

/**
 * A service's report of its own PEAK switches (lib/peak-switches), as if it had just
 * written it — or `ageMs` ago.
 */
export async function reportService(service: ServiceName, s: { autoSync: boolean; existingLinks: boolean; writesFrozen?: boolean }, ageMs = 0, version: string | null = null) {
  const at = new Date(Date.now() - ageMs);
  const data = { autoSync: s.autoSync, existingLinks: s.existingLinks, writesFrozen: s.writesFrozen ?? false, startedAt: at, lastSeenAt: at, version };
  await prisma.serviceStatus.upsert({ where: { id: service }, create: { id: service, ...data }, update: data });
}

/** payment-worker holds the same switches as this process — a deployment set up consistently. */
export const workerMatchesEnv = () => reportService("payment-worker", localSwitches());
