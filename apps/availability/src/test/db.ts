import { prisma } from "@/lib/db";

// Helpers for tests that use a real database. Importing this file at all is a
// declaration that the test needs one; guard() fails loudly rather than letting a
// suite pass by touching nothing.

/** Tables these tests write, in an order safe to truncate together. */
const TABLES = [
  "AuditLog", "Checkin", "TourReport", "PushSubscription", "Notification",
  // The advance ledger and everything that hangs off it. Listed before JobSheet
  // and User because these rows reference them.
  "AdvancePeakDocumentLink", "AdvancePeakSync", "GuideAdvanceEntry",
  "GuideAdvanceReceipt", "GuideAdvanceReturn", "GuideAdvance",
  // A guide's transfers, and the PEAK document each one settles. Before TourPayment,
  // which a recorded payment points back at.
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
