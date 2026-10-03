-- What an attached receipt file is (lib/certificates/receipt-kind), keyed by Drive file
-- id. New table only; nothing existing changes. Re-runnable.
CREATE TABLE IF NOT EXISTS "ReceiptClassification" (
    "fileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "txRef" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedBy" TEXT,
    CONSTRAINT "ReceiptClassification_pkey" PRIMARY KEY ("fileId"),
    CONSTRAINT "ReceiptClassification_kind_check" CHECK ("kind" IN ('TRANSFER_SLIP', 'DOCUMENT'))
);
