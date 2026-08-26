-- Account chart mapping: which PEAK account each FolkOPS expense category books to.
--
-- A NEW table only — no existing table or column is touched, so this is safe to
-- apply while the app is running and rolling it back loses only the mappings.
-- An empty table means "chart not configured", which is exactly the state the app
-- reports today, so behaviour is unchanged until an operator saves a mapping.
--
-- folkopsCategory is UNIQUE: one row per category, updated in place. That is what
-- stops repeated saves accumulating duplicate mappings for the same category.
-- peakAccountCode is nullable because a row may exist while still unmapped
-- (e.g. OTHER_TOUR_COST, which is deliberately left for per-job review).
CREATE TABLE "PeakAccountMapping" (
    "id"              TEXT NOT NULL,
    "folkopsCategory" TEXT NOT NULL,
    "peakAccountCode" TEXT,
    "peakAccountName" TEXT,
    "isActive"        BOOLEAN NOT NULL DEFAULT true,
    "updatedById"     TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PeakAccountMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PeakAccountMapping_folkopsCategory_key" ON "PeakAccountMapping"("folkopsCategory");
