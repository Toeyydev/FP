ALTER TABLE "GuideAdvance" ADD COLUMN "bankAccount" TEXT;
CREATE TABLE "AdvancePeakSync" (
 "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "documentId" TEXT, "documentNo" TEXT,
 "error" TEXT, "payload" JSONB, "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AdvancePeakSync_status" CHECK ("status" IN ('PENDING','BLOCKED','SENDING','UNCERTAIN','POSTED','CANCELLED'))
);
CREATE UNIQUE INDEX "AdvancePeakSync_kind_sourceId_key" ON "AdvancePeakSync"("kind","sourceId");
CREATE INDEX "AdvancePeakSync_status_nextAttemptAt_idx" ON "AdvancePeakSync"("status","nextAttemptAt");
-- Enqueue inside the SAME transaction as the ledger write, including mobile paths.
-- No historical insert-select: old documents may already have been entered by hand.
CREATE FUNCTION advance_peak_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT;
BEGIN
 IF TG_TABLE_NAME = 'GuideAdvance' THEN k := 'ADVANCE';
 ELSIF TG_TABLE_NAME = 'GuideAdvanceReceipt' THEN
   IF NEW.status <> 'VERIFIED' THEN RETURN NEW; END IF;
   k := 'RETURN';
 ELSE
   IF NEW.type <> 'EXPENSE_SETTLEMENT' THEN RETURN NEW; END IF;
   k := 'EXPENSE';
 END IF;
 INSERT INTO "AdvancePeakSync" (id,kind,"sourceId") VALUES (k || ':' || NEW.id,k,NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER advance_peak_issue AFTER INSERT ON "GuideAdvance" FOR EACH ROW EXECUTE FUNCTION advance_peak_enqueue();
CREATE TRIGGER advance_peak_return AFTER INSERT OR UPDATE OF status ON "GuideAdvanceReceipt" FOR EACH ROW EXECUTE FUNCTION advance_peak_enqueue();
CREATE TRIGGER advance_peak_expense AFTER INSERT ON "GuideAdvanceEntry" FOR EACH ROW EXECUTE FUNCTION advance_peak_enqueue();
-- Serialize a reversal against the worker's claim. Never silently undo a posted journal.
CREATE FUNCTION advance_peak_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k TEXT; s TEXT;
BEGIN
 IF TG_TABLE_NAME = 'GuideAdvance' THEN
   IF NEW."reversedAt" IS NULL THEN RETURN NEW; END IF; k := 'ADVANCE';
 ELSE
   IF NEW."reversedByEntryId" IS NULL THEN RETURN NEW; END IF; k := 'EXPENSE';
 END IF;
 SELECT status INTO s FROM "AdvancePeakSync" WHERE id=k || ':' || NEW.id FOR UPDATE;
 IF s IN ('SENDING','UNCERTAIN','POSTED') THEN
   RAISE EXCEPTION 'Reconcile the PEAK journal before reversing this ledger record';
 END IF;
 UPDATE "AdvancePeakSync" SET status='CANCELLED',"updatedAt"=CURRENT_TIMESTAMP WHERE id=k || ':' || NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER advance_peak_cancel_issue BEFORE UPDATE OF "reversedAt" ON "GuideAdvance" FOR EACH ROW EXECUTE FUNCTION advance_peak_cancel();
CREATE TRIGGER advance_peak_cancel_expense BEFORE UPDATE OF "reversedByEntryId" ON "GuideAdvanceEntry" FOR EACH ROW EXECUTE FUNCTION advance_peak_cancel();
