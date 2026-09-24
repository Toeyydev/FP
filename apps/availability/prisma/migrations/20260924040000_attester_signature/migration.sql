-- The image of an attester's handwritten signature, kept per person and per version.
--
-- Additive: one new table, and three nullable columns on ExpenseCertificate recording
-- which signature was on a document. No existing row is read, written or moved.
--
-- The unique index on "activeUserId" keeps one live signature per person. It holds the
-- user id while current and NULL once retired, and Postgres does not compare NULLs in a
-- unique index — so retiring one frees that person for a replacement without a partial
-- index, which Prisma cannot declare and the schema-drift gate would delete.

-- AlterTable
ALTER TABLE "ExpenseCertificate" ADD COLUMN     "signatureSha256" TEXT,
ADD COLUMN     "signatureUserId" TEXT,
ADD COLUMN     "signatureVersion" INTEGER;

-- CreateTable
CREATE TABLE "AttesterSignature" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "activeUserId" TEXT,
    "driveFileId" TEXT NOT NULL,
    "driveUrl" TEXT,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "retireReason" TEXT,

    CONSTRAINT "AttesterSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttesterSignature_activeUserId_key" ON "AttesterSignature"("activeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AttesterSignature_driveFileId_key" ON "AttesterSignature"("driveFileId");

-- CreateIndex
CREATE INDEX "AttesterSignature_userId_idx" ON "AttesterSignature"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AttesterSignature_userId_version_key" ON "AttesterSignature"("userId", "version");

