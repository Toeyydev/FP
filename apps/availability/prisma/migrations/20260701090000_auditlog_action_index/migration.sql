-- Speed up action-filtered "last X" audit lookups (Bokun health / sync throttle).
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
