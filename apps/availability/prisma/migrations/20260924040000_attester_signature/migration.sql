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
    "driveFileId" TEXT,
    "driveUrl" TEXT,
    "driveEnvironment" TEXT,
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

