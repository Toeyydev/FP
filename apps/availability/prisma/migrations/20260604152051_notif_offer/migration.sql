-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "offerId" TEXT;

-- CreateIndex
CREATE INDEX "Notification_offerId_idx" ON "Notification"("offerId");
