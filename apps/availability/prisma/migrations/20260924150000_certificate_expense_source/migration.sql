-- AlterTable
ALTER TABLE "ExpenseCertificate" ADD COLUMN     "recordedAt" TIMESTAMP(3),
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "recordedByName" TEXT,
ADD COLUMN     "recordedByRole" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'GUIDE_REPORTED';

