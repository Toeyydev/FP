-- Recording a PEAK document that already exists.
--
-- Additive only: two columns on the one advance table that had nowhere to keep a
-- document number, plus the link register. No existing row is touched, and nothing
-- is back-filled — a historical document is linked by a person, one at a time.
ALTER TABLE "GuideAdvanceReceipt" ADD COLUMN "peakDocumentNo" TEXT;
ALTER TABLE "GuideAdvanceReceipt" ADD COLUMN "peakReference" TEXT;

CREATE TABLE "AdvancePeakDocumentLink" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "documentNo" TEXT NOT NULL,
  "documentId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'EXISTING_PEAK_DOCUMENT',
  "status" TEXT NOT NULL DEFAULT 'LINKED',
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "warning" TEXT,
  "note" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvancePeakDocumentLink_kind" CHECK ("kind" IN ('ADVANCE','RETURN','EXPENSE')),
  CONSTRAINT "AdvancePeakDocumentLink_type" CHECK ("documentType" IN ('DAILY_JOURNAL','EXPENSE')),
  CONSTRAINT "AdvancePeakDocumentLink_source" CHECK ("source" = 'EXISTING_PEAK_DOCUMENT'),
  CONSTRAINT "AdvancePeakDocumentLink_note" CHECK (length(btrim("note")) >= 5)
);

-- One link per business event …
CREATE UNIQUE INDEX "AdvancePeakDocumentLink_kind_sourceId_key" ON "AdvancePeakDocumentLink"("kind","sourceId");
-- … and one event per PEAK document. The type is part of the key because PEAK
-- numbers each document type in its own series.
CREATE UNIQUE INDEX "AdvancePeakDocumentLink_documentType_documentNo_key" ON "AdvancePeakDocumentLink"("documentType","documentNo");
CREATE INDEX "AdvancePeakDocumentLink_documentNo_idx" ON "AdvancePeakDocumentLink"("documentNo");
