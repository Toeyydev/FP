// The shape of a supplemental-payment request over HTTP. Shape only: every money rule lives
// in lib/supplemental-payments/rules.ts and is enforced by the service.
import { z } from "zod";
import { SUPPLEMENTAL_TYPES } from "@/lib/supplemental-payments/rules";

export const supplementalBody = z.object({
  guideId: z.string().min(1).max(40),
  type: z.enum(SUPPLEMENTAL_TYPES),
  grossAmount: z.number(),
  whtPct: z.number().nullish(),
  accountingCategory: z.string().max(40).nullish(),
  reason: z.string().max(300),
  note: z.string().max(500).nullish(),
  jobs: z.array(z.object({ jobNo: z.string().min(1).max(64), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).max(20).default([]),
  originalPaymentId: z.string().max(64).nullish(),
  duplicateOverrideReason: z.string().max(500).nullish(),
  requestKey: z.string().max(80).nullish(),
  legacyBonusId: z.string().max(64).nullish(),
});
