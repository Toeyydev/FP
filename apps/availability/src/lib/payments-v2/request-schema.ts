// The shape of a Record payment request over HTTP. Shape only: every money rule lives in
// lib/payments-v2/rules.ts and is enforced by the service, not here.
import { z } from "zod";
import { ADJUSTMENT_TYPES } from "@/lib/payments-v2/rules";

export const paymentBody = z.object({
  guideId: z.string().min(1),
  jobs: z.array(z.object({ jobNo: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1).max(60),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountTransferred: z.number(),
  adjustments: z.array(z.object({ type: z.enum(ADJUSTMENT_TYPES), amount: z.number(), description: z.string().min(1).max(300), jobNo: z.string().max(64).nullish() })).max(20).optional(),
  bankRef: z.string().max(120).nullish(),
  noSlipReason: z.string().max(500).nullish(),
  mismatchReason: z.string().max(500).nullish(),
  periodOverrideReason: z.string().max(500).nullish(),
  note: z.string().max(500).nullish(),
});
