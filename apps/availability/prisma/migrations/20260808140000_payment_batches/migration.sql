-- Payment batches: group several guide tour-payouts into one bank run. Additive —
-- two brand-new tables, nothing existing is touched. A tour payout is in at most one
-- batch at a time (unique on the item's (guideId,date,slotIdx)); deleting a batch
-- cascade-deletes its items, freeing those payouts to be re-batched.

-- CreateTable
CREATE TABLE "PaymentBatch" (
    "id" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "paymentDate" TEXT,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "PaymentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL DEFAULT '',
    "ref" TEXT,
    "guideFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reimbursement" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPayable" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentBatch_batchNo_key" ON "PaymentBatch"("batchNo");

-- CreateIndex
CREATE INDEX "PaymentBatch_status_idx" ON "PaymentBatch"("status");

-- CreateIndex
CREATE INDEX "PaymentBatchItem_batchId_idx" ON "PaymentBatchItem"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentBatchItem_guideId_date_slotIdx_key" ON "PaymentBatchItem"("guideId", "date", "slotIdx");

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PaymentBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
