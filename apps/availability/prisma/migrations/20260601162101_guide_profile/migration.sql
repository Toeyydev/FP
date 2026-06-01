-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bankAccountName" TEXT,
ADD COLUMN     "bankAccountNo" TEXT,
ADD COLUMN     "bankBranch" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "idCardAddress" TEXT,
ADD COLUMN     "lineId" TEXT,
ADD COLUMN     "taxId" TEXT;

-- CreateTable
CREATE TABLE "GuideDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuideDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuideDocument_userId_idx" ON "GuideDocument"("userId");

-- AddForeignKey
ALTER TABLE "GuideDocument" ADD CONSTRAINT "GuideDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
