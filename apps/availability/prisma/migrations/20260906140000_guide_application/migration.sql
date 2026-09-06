-- Guide application from FolkOPS Mobile: the applicant's details, their
-- AES-encrypted identity/bank/health fields, and the documents supporting a
-- pending request. Every column is nullable and every table is new, so this
-- adds to existing rows without rewriting or dropping anything.

-- AlterTable
ALTER TABLE "AccessRequest" ADD COLUMN     "bankAccountName" TEXT,
ADD COLUMN     "bankAccountNo" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "emergencyInstructions" TEXT,
ADD COLUMN     "fullNameEnglish" TEXT,
ADD COLUMN     "fullNameThai" TEXT,
ADD COLUMN     "licenseExpiry" TIMESTAMP(3),
ADD COLUMN     "licenseNo" TEXT,
ADD COLUMN     "medicalConditionDetails" TEXT,
ADD COLUMN     "medicalConditionStatus" TEXT,
ADD COLUMN     "nationalId" TEXT,
ADD COLUMN     "preferredLanguage" TEXT,
ADD COLUMN     "privacyConsentAt" TIMESTAMP(3),
ADD COLUMN     "privacyVersion" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emergencyInstructions" TEXT,
ADD COLUMN     "fullNameEnglish" TEXT,
ADD COLUMN     "fullNameThai" TEXT,
ADD COLUMN     "licenseExpiry" TIMESTAMP(3),
ADD COLUMN     "medicalConditionDetails" TEXT,
ADD COLUMN     "medicalConditionStatus" TEXT,
ADD COLUMN     "nationalId" TEXT;

-- CreateTable
CREATE TABLE "AccessRequestDocument" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRequestDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessRequestDocument_requestId_idx" ON "AccessRequestDocument"("requestId");

-- AddForeignKey
ALTER TABLE "AccessRequestDocument" ADD CONSTRAINT "AccessRequestDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

