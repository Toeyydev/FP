// Read-only production check for the newly-live slip matcher. Writes NOTHING.
// - Confirms recent job sheets have valid FOLK-BKK refs and computes each expected
//   amount exactly as the app does (mirrors src/lib/jobsheet.ts computeTotals).
// - Shows the current TourPayment status so a test can be verified against a known state.
// - Reports whether any PaymentEvidence/PaymentTransaction rows exist yet (should be 0
//   before the first real slip is processed).
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const grandTotal = (expenses, fee) => {
  const te = (expenses ?? []).reduce((s, e) => s + n(e.price) * n(e.pax), 0);
  const gross = n(fee?.price) * n(fee?.time);
  const net = gross - gross * (n(fee?.whtPct) / 100);
  return te + net;
};
const RE_JOB = /\bFOLK-BKK-\d{8}-\d{1,}\b/;

try {
  const [evCount, txCount] = await Promise.all([
    prisma.paymentEvidence.count(),
    prisma.paymentTransaction.count(),
  ]);
  console.log(`PaymentEvidence rows: ${evCount}   PaymentTransaction rows: ${txCount}  (expect 0 before the first real slip)\n`);

  const sheets = await prisma.jobSheet.findMany({
    where: { ref: { not: null } },
    select: { ref: true, guideId: true, date: true, slotIdx: true, tourId: true, expenses: true, guideFee: true },
    orderBy: { date: "desc" },
    take: 6,
  });

  console.log("Real job sheets you could test against (dry — nothing written):");
  for (const s of sheets) {
    const expected = grandTotal(s.expenses, s.guideFee);
    const refOk = RE_JOB.test((s.ref ?? "").toUpperCase());
    const tp = await prisma.tourPayment.findUnique({
      where: { guideId_date_slotIdx: { guideId: s.guideId, date: s.date, slotIdx: s.slotIdx } },
      select: { status: true },
    });
    console.log(
      `  ${s.ref}  guide=${s.guideId}  ${s.date} slot${s.slotIdx}  ` +
      `expected=THB ${expected.toFixed(2)}  refValid=${refOk ? "yes" : "NO"}  currentPay=${tp?.status ?? "none"}`,
    );
  }
  console.log(
    "\nTo test: pick a sheet whose currentPay is NOT already PAID, upload its slip with memo = its\n" +
    "ref and amount = its expected total. The matcher should mark that one tour PAID. Re-run this\n" +
    "script after to confirm currentPay flipped to PAID and exactly one PaymentTransaction exists.",
  );
} finally {
  await prisma.$disconnect();
}
