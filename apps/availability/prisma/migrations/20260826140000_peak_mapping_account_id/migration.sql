-- Reserved column for PEAK's internal account id.
--
-- PEAK's chart endpoint (/api/v1/DailyJournals/accountcode) returns only
-- { code, name, nameEn } — there is no id in the payload — so this column stays
-- NULL until PEAK exposes one. It is added now so the stored model matches the
-- agreed shape rather than being retrofitted later; nothing reads it yet and
-- nothing invents a value for it.
--
-- Additive and nullable: existing mapping rows are untouched.
ALTER TABLE "PeakAccountMapping" ADD COLUMN "peakAccountId" TEXT;
