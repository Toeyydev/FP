-- A payment made in several bank transfers keeps each one: amount, date, reference, slip.
CREATE TABLE "GuidePaymentTransfer" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "transferDate" TEXT NOT NULL,
    "bankRef" TEXT,
    "slipUrl" TEXT,
    "evidenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuidePaymentTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuidePaymentTransfer_paymentId_seq_key" ON "GuidePaymentTransfer"("paymentId", "seq");
CREATE INDEX "GuidePaymentTransfer_bankRef_idx" ON "GuidePaymentTransfer"("bankRef");
CREATE INDEX "GuidePaymentTransfer_evidenceId_idx" ON "GuidePaymentTransfer"("evidenceId");
ALTER TABLE "GuidePaymentTransfer" ADD CONSTRAINT "GuidePaymentTransfer_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "GuidePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuidePaymentTransfer" ADD CONSTRAINT "GuidePaymentTransfer_amount_check" CHECK ("amount" > 0 AND "seq" >= 1 AND "transferDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
