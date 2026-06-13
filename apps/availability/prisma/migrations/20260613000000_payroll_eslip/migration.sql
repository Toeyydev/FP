-- Add e-slip (payment-evidence) Drive link to monthly payroll status
ALTER TABLE "PayrollStatus" ADD COLUMN "eslipUrl" TEXT;
