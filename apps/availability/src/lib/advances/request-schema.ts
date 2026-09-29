// Request shapes for the advance ledger routes. In their own file because a Next route
// may only export handlers — exporting a schema from route.ts passes tsc and then fails
// the production build.
import { z } from "zod";

const money = z.number().finite().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-17");

export const advanceBody = z.object({
  guideId: z.string().min(1),
  advanceDate: isoDate,
  bankAccount: z.string().max(120).nullish(),
  amount: money,
  jobNo: z.string().max(60).nullish(),
  purpose: z.string().max(200).nullish(),
  method: z.string().max(24).nullish(),
  bankRef: z.string().max(120).nullish(),
  note: z.string().max(500).nullish(),
  date: isoDate.optional(),
  slotIdx: z.number().int().min(0).optional(),
});

export const receiptBody = z.object({
  guideId: z.string().min(1),
  receivedDate: isoDate,
  amount: money,
  bankAccount: z.string().max(120).nullish(),
  bankRef: z.string().max(120).nullish(),
  method: z.string().max(24).nullish(),
  note: z.string().max(500).nullish(),
});

export const allocateBody = z.object({
  requestKey: z.string().min(8).max(120),
  allocations: z.array(z.object({ advanceId: z.string().min(1), amount: money })).min(1).max(20),
});
