-- Guide-reported expenses (separate from the operator official set) for cross-checking.
ALTER TABLE "JobSheet" ADD COLUMN "guideExpenses" JSONB;
ALTER TABLE "JobSheet" ADD COLUMN "guideExpensesAt" TIMESTAMP(3);
