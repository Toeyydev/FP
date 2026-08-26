import { z } from "zod";

// Request schemas for a job-sheet save, kept out of the route so they can be unit
// tested. This matters more than it looks: zod's z.object() STRIPS unknown keys
// silently, so any field missing from here is accepted by the API, dropped on the
// way to the database, and reappears as the old value after a reload — with no
// error anywhere. Every field on the Expense type must be listed.

// Numeric fields are .nullish() (null OR undefined -> null): imported/edge sheets can
// store gaps, and JSON.stringify drops undefined keys on re-save, so requiring a
// present number would reject an otherwise-valid save. Strings/extra keys are lenient.
const num = z.number().nullish().transform((v) => v ?? null);
const numOpt = z.number().nullable().optional(); // present → number|null; absent → omitted (not stored)
const bookingZ = z.object({ name: z.string().max(200).optional().default(""), bookingNo: z.string().max(120).optional().default(""), bookedPax: num, actualPax: num, tickets: z.string().max(20).optional().default(""), status: z.string().max(40).optional().default("") });

const expenseZ = z.object({
  description: z.string().max(160).optional().default(""), price: num, pax: num,
  unit: z.string().max(24).optional(),
  expenseType: z.string().max(40).optional(),
  paidBy: z.string().max(24).optional(),
  reimbursementRequired: z.boolean().optional(),
  estimatedAmount: numOpt,
  actualAmount: numOpt,
  receiptUrl: z.string().max(2000).optional(),
  receiptFileId: z.string().max(200).optional(),
  receiptName: z.string().max(200).optional(),
  receiptAt: z.string().max(40).optional(),
  receiptBy: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
  relatedBookingNo: z.string().max(60).optional(),
  relatedJobRef: z.string().max(60).optional(),
  // Tax presentation (display + future PEAK mapping; feeds no total).
  vat: z.string().max(16).optional(),
  wht: z.string().max(16).optional(),
  // PEAK account mapping recorded on the row.
  peakAccountCode: z.string().max(40).nullish(),
  peakAccountId: z.string().max(60).nullish(),
  peakAccountName: z.string().max(120).nullish(),
  mappingStatus: z.string().max(24).optional(),
  // Duplicate protection for costs already booked in PEAK by their own document.
  sourceDocumentType: z.string().max(24).optional(),
  sourceDocumentNo: z.string().max(64).optional(),
  peakExistingDocumentId: z.string().max(60).nullish(),
  alreadyRecordedInPeak: z.boolean().optional(),
});
const guideFeeZ = z.object({ price: num, time: num, whtPct: num }).nullish().transform((v) => v ?? { price: null, time: null, whtPct: null });

export { expenseZ, bookingZ, guideFeeZ, num, numOpt };
