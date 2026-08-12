-- Certification timestamp: the job sheet's FIRST successful operator save,
-- printed under the authorized signature. Additive + nullable — historical
-- sheets stay NULL (display falls back to approvedAt) until their next save.
ALTER TABLE "JobSheet" ADD COLUMN "certifiedAt" TIMESTAMP(3);
