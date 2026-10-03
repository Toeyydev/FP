-- A certificate in lieu of receipt for costs paid from a COMPANY ADVANCE, beside the
-- existing one for the guide's own money (lib/certificates/payload CertificateKind).
--
-- Additive for every existing row: each certificate issued so far is GUIDE_PAID (the
-- default fills it), and its fingerprint is computed exactly as before. The one-live-
-- certificate-per-job-sheet rule becomes one per job sheet PER KIND: the unique index on
-- activeJobSheetId is replaced by one on (activeJobSheetId, kind). Existing rows satisfy
-- it — they were unique on activeJobSheetId alone and all share one kind. Re-runnable.

ALTER TABLE "ExpenseCertificate" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'GUIDE_PAID';

ALTER TABLE "ExpenseCertificate" DROP CONSTRAINT IF EXISTS "ExpenseCertificate_kind_check";
ALTER TABLE "ExpenseCertificate" ADD CONSTRAINT "ExpenseCertificate_kind_check" CHECK ("kind" IN ('GUIDE_PAID', 'COMPANY_ADVANCE'));

CREATE UNIQUE INDEX IF NOT EXISTS "ExpenseCertificate_activeJobSheetId_kind_key" ON "ExpenseCertificate"("activeJobSheetId", "kind");
DROP INDEX IF EXISTS "ExpenseCertificate_activeJobSheetId_key";
