-- Guide leave requests (operator-approved)
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeaveRequest_guideId_idx" ON "LeaveRequest"("guideId");
CREATE INDEX "LeaveRequest_status_idx" ON "LeaveRequest"("status");
